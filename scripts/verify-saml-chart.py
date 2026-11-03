"""Verify GCR SAML Helm configuration, command/Secret scope and compiled loaders.

Requires Helm, PyYAML, OpenSSL, built @gcr/runtime and Node 22 (GCR_VERIFY_NODE).
No cluster, database, registry or IdP is contacted. All credentials are synthetic.
"""
import argparse
import base64
import copy
from datetime import datetime, timezone
import hashlib
import io
import json
import os
from pathlib import Path
import runpy
import shutil
import subprocess
import tarfile
import tempfile

import yaml

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / 'deploy/helm/git-code-reviewer'
NAMESPACE = 'git-code-reviewer'
RELEASE = 'saml-fixture'
BASE = yaml.safe_load((CHART / 'values.saml.example.yaml').read_text())
BASE['image'] = {'repository': 'registry.example.test/gcr-runtime', 'digest': 'sha256:' + '0' * 64}
BASE['retention'] = {'enabled': True}
POLICY = runpy.run_path(str(ROOT / 'scripts/verify-identity-chart.py'))


def render(values, *, chart=CHART, upgrade=False, failure=None, lint=False):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml') as handle:
        yaml.safe_dump(values, handle)
        handle.flush()
        args = ['helm', 'lint', '--strict', str(chart)] if lint else [
            'helm', 'template', RELEASE, str(chart), '--namespace', NAMESPACE]
        args += ['--values', handle.name]
        if upgrade:
            args += ['--is-upgrade']
        result = subprocess.run(args, capture_output=True, text=True, timeout=45)
    if failure:
        assert result.returncode != 0, 'Invalid SAML/identity settings rendered'
        assert failure in result.stderr or failure.replace('.', '/') in result.stderr, result.stderr
        return None
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout if lint else [d for d in yaml.safe_load_all(result.stdout) if d]


def changed(path, value):
    values = copy.deepcopy(BASE)
    parts = path.split('.')
    target = values
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = value
    return values


def resource(documents, kind, suffix):
    return next(d for d in documents if d['kind'] == kind and d['metadata']['name'].endswith(suffix))


def pod(document):
    spec = document['spec']
    if document['kind'] == 'CronJob':
        spec = spec['jobTemplate']['spec']
    return spec['template']['spec']


def verify_scope(documents, *, saml=True, bundled=False):
    identity_map = resource(documents, 'ConfigMap', '-identity')
    assert not any('SECRET' in k or 'PRIVATE_KEY' in k for k in identity_map['data'])
    primary_map = resource(documents, 'ConfigMap', RELEASE)
    assert not any(k.startswith(('SAML_', 'KEYCLOAK_', 'IDENTITY_')) for k in primary_map['data'])
    for role in ['server', 'worker']:
        document = resource(documents, 'Deployment', '-' + role)
        spec = pod(document)
        container = next(c for c in spec['containers'] if c['name'] == role)
        mounts = {m['name']: m for m in container['volumeMounts']}
        volumes = {v['name']: v for v in spec['volumes']}
        assert volumes['identity-admin']['secret'] == {
            'secretName': BASE['identity']['existingSecret'], 'defaultMode': 0o440,
            'items': [{'key': 'client-secret', 'path': 'client-secret'}]}
        assert mounts['identity-admin']['readOnly'] is True
        assert {'configMapRef': {'name': identity_map['metadata']['name']}} in container['envFrom']
        assert 'checksum/identity' in document['spec']['template']['metadata']['annotations']
        if saml:
            assert all('secretRef' not in e for e in container['envFrom'])
        environment = {e['name']: e for e in container['env']}
        assert len(environment) == len(container['env'])
        assert environment['NODE_EXTRA_CA_CERTS']['value'] == '/run/config/trust/ca.crt'
        if role == 'server' and saml:
            assert environment['SESSION_SECRET']['valueFrom']['secretKeyRef'] == {
                'name': 'git-code-reviewer-auth', 'key': 'SESSION_SECRET'}
            assert volumes['saml-sp']['secret']['secretName'] == BASE['auth']['saml']['signingSecret']
            assert volumes['saml-sp']['secret']['defaultMode'] == 0o440
            assert {e['key'] for e in volumes['saml-sp']['secret']['items']} == {'tls.key', 'tls.crt'}
            assert mounts['saml-sp']['readOnly'] is True
        else:
            assert not any(name.startswith('SAML_') for name in environment)
            assert 'saml-sp' not in volumes and 'saml-metadata' not in volumes
        for auxiliary in spec.get('initContainers', []) + [c for c in spec['containers'] if c['name'] != role]:
            text = json.dumps(auxiliary)
            assert all(name not in text for name in ['identity-admin', 'saml-sp', identity_map['metadata']['name']])
    for kind, suffix in [('Job', '-migrate-1'), ('CronJob', '-retention')]:
        spec = pod(resource(documents, kind, suffix))
        assert all(name not in json.dumps(spec) for name in [BASE['identity']['existingSecret'],
                   BASE['auth']['saml']['signingSecret'], identity_map['metadata']['name']])
    databases = [d for d in documents if d['kind'] == 'StatefulSet']
    assert len(databases) == (1 if bundled else 0)
    if bundled:
        assert databases[0]['metadata']['name'] == RELEASE + '-postgresql'


def verify_egress(documents):
    policies = [d for d in documents if d['kind'] == 'NetworkPolicy' and 'Egress' in d['spec']['policyTypes']]
    identity_labels = BASE['identity']['networkPolicy']['adminPeers'][0]['podLabels']
    decisions = 0
    for component in ['server', 'worker', 'migration', 'retention']:
        source = {'app.kubernetes.io/name': 'git-code-reviewer', 'app.kubernetes.io/instance': RELEASE,
                  'app.kubernetes.io/component': component}
        selected = [p for p in policies if POLICY['labels_match'](p['spec']['podSelector'], source)]
        assert selected, 'Expected the app default-deny policy'
        for namespace in [NAMESPACE, 'foreign']:
            for port in [443, 8080, 8443, 9000, 7800, 57800]:
                allowed = any(POLICY['allows'](p, 'egress', namespace, identity_labels, port) for p in selected)
                assert allowed == (component in ['server', 'worker'] and namespace == NAMESPACE and port == 8443)
                decisions += 1
        for address in ['192.0.2.20', '192.0.2.21']:
            for port in [80, 443, 8443]:
                allowed = any(POLICY['allows'](p, 'egress', 'external', {}, port, address=address) for p in selected)
                assert allowed == (component in ['server', 'worker'] and address == '192.0.2.20' and port == 443)
                decisions += 1
    # A sidecar shares its worker Pod's network policy; only credential/mount
    # isolation is asserted for source-sandbox in verify_scope, never L4 isolation.
    return decisions


def compiled_configuration(configurations):
    node = os.environ.get('GCR_VERIFY_NODE', 'node')
    version = subprocess.run([node, '--version'], capture_output=True, text=True, check=True).stdout.strip()
    assert version.startswith('v22.'), 'Set GCR_VERIFY_NODE to the supported Node 22 executable'
    with tempfile.TemporaryDirectory(prefix='gcr-saml-chart-') as temporary:
        directory = Path(temporary)
        certs = {}
        for name in ['sp', 'idp']:
            key, cert = directory / (name + '.key'), directory / (name + '.crt')
            subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
                            '-keyout', str(key), '-out', str(cert), '-days', '2', '-subj', '/CN=' + name,
                            '-addext', 'basicConstraints=critical,CA:FALSE'],
                           capture_output=True, text=True, timeout=45, check=True)
            key.chmod(0o600)
            certs[name] = {'key': key.read_text(), 'cert': cert.read_text(), 'certPath': str(cert)}
        issuer = BASE['auth']['saml']['idpIssuer']
        body = ''.join(line for line in certs['idp']['cert'].splitlines() if not line.startswith('---'))
        binding = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect'
        xml = (f'<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" '
               f'xmlns:ds="http://www.w3.org/2000/09/xmldsig#" entityID="{issuer}">'
               '<md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">'
               f'<md:KeyDescriptor use="signing"><ds:KeyInfo><ds:X509Data><ds:X509Certificate>{body}'
               '</ds:X509Certificate></ds:X509Data></ds:KeyInfo></md:KeyDescriptor>'
               f'<md:SingleSignOnService Binding="{binding}" Location="{issuer}/protocol/saml"/>'
               f'<md:SingleLogoutService Binding="{binding}" Location="{issuer}/protocol/saml"/>'
               '</md:IDPSSODescriptor></md:EntityDescriptor>')
        session_secret = base64.b64encode(os.urandom(48)).decode()
        secrets = {
            'git-code-reviewer-auth': {'SESSION_SECRET': session_secret,
                                      'UNRELATED_AUTH_SETTING': 'must-not-enter-saml-server',
                                      'LOCAL_BOOTSTRAP_ADMIN_USERNAME': 'fixture-admin',
                                      'LOCAL_BOOTSTRAP_ADMIN_PASSWORD': 'fixture-password-not-deployed-1234'},
            BASE['identity']['existingSecret']: {'client-secret': base64.b64encode(os.urandom(32)).decode()},
            BASE['auth']['saml']['signingSecret']: {'tls.key': certs['sp']['key'], 'tls.crt': certs['sp']['cert']},
            'git-code-reviewer-db-app': {'password': 'synthetic-app-password-never-used-to-connect'},
            'git-code-reviewer-db-migrator': {'password': 'synthetic-migrator-password-never-used-to-connect'},
            'git-code-reviewer-credential-registry': {'CREDENTIAL_ENCRYPTION_KEY': base64.b64encode(os.urandom(32)).decode()},
        }
        external_maps = {
            'git-code-reviewer-saml-metadata': {'metadata.xml': xml},
            'git-code-reviewer-runtime-ca': {'ca.crt': certs['idp']['cert']},
            'git-code-reviewer-postgresql-ca': {'ca.crt': certs['idp']['cert']},
        }
        resolved = []
        for name, documents in configurations:
            maps = {**external_maps, **{d['metadata']['name']: d['data'] for d in documents if d['kind'] == 'ConfigMap'}}
            for kind, suffix, role, command in [('Deployment', '-server', 'server', 'serve'),
                                               ('Deployment', '-worker', 'worker', 'worker'),
                                               ('Job', '-migrate-1', 'migrate', 'migrate'),
                                               ('CronJob', '-retention', 'retention', 'retention')]:
                spec = pod(resource(documents, kind, suffix))
                container = next(c for c in spec['containers'] if c['name'] == role)
                env = {}
                for source in container.get('envFrom', []):
                    env.update(maps[source['configMapRef']['name']] if 'configMapRef' in source else secrets[source['secretRef']['name']])
                for entry in container.get('env', []):
                    if 'value' in entry:
                        env[entry['name']] = entry['value']
                    else:
                        ref = entry['valueFrom']['secretKeyRef']
                        env[entry['name']] = secrets[ref['name']][ref['key']]
                mounts = {m['name']: m for m in container['volumeMounts']}
                files = {}
                for volume in spec['volumes']:
                    if volume['name'] not in mounts:
                        continue
                    source = volume.get('secret') or volume.get('configMap')
                    if source is None:
                        continue
                    data = secrets[source['secretName']] if 'secret' in volume else maps[source['name']]
                    for item in source['items']:
                        mount_path = str(Path(mounts[volume['name']]['mountPath']) / item['path'])
                        local = directory / str(len(files)) / name / role / volume['name'] / item['path']
                        local.parent.mkdir(parents=True, exist_ok=True)
                        local.write_text(data[item['key']])
                        local.chmod(0o600)
                        files[mount_path] = str(local)
                for key, value in list(env.items()):
                    if key.endswith('_FILE') or key in ['NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO']:
                        assert value in files, f'{name}/{role}: configured file lacks a mount: {key}'
                        env[key] = files[value]
                expected_mode = maps[RELEASE]['AUTH_MODE'] if role != 'migrate' else 'development'
                resolved.append({'name': name + '/' + role, 'environment': env, 'command': command,
                                 'entityId': BASE['publicBaseUrl'] + ('/saml-app' if name == 'custom-entity' else '/auth/saml/metadata'),
                                 'authMode': expected_mode, 'identityEnabled': role in ['server', 'worker'],
                                 'securityEnabled': role in ['server', 'worker'] and name != 'local-preparation',
                                 'metadataFile': bool(env.get('SAML_IDP_METADATA_FILE'))})
        fixture = directory / 'fixture.json'
        fixture.write_text(json.dumps({'configurations': resolved, 'issuer': issuer, 'metadata': xml,
                                      'entityId': BASE['publicBaseUrl'] + '/auth/saml/metadata',
                                      'adminBaseUrl': BASE['identity']['adminBaseUrl'],
                                      'expectedSessionSecret': session_secret,
                                      'idpCertificatePath': certs['idp']['certPath']}))
        fixture.chmod(0o600)
        result = subprocess.run([node, str(ROOT / 'scripts/verify-saml-chart-runtime.mjs'), str(fixture)],
                                capture_output=True, text=True, timeout=60)
        assert result.returncode == 0, result.stderr
        return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, help='Pre-SAML-chart Git revision for legacy parity')
    args = parser.parse_args()
    started = datetime.now(timezone.utc).isoformat()
    checks = []
    pinned = render(BASE)
    verify_scope(pinned)
    decisions = verify_egress(pinned)
    checks += ['server-worker-identity-and-server-only-sp-secret-scope', 'combined-network-policy-egress-matrix']
    def overlay(target, values):
        for key, value in values.items():
            if isinstance(value, dict):
                overlay(target.setdefault(key, {}), value)
            else:
                target[key] = value
    shared_overlay = ROOT / 'deploy/postgres/isolated-helm.example.yaml'
    bundled_values = yaml.safe_load(shared_overlay.read_text())
    overlay(bundled_values, copy.deepcopy(BASE))
    bundled_values['postgresql']['enabled'] = True
    bundled_values['database']['isolated']['host'] = ''
    # Bitnami's offline upgrade guard cannot read the pre-existing fixture Secret.
    bundled_values['global'] = {'postgresql': {'auth': {'password': 'fixture-render-only',
                                                      'postgresPassword': 'fixture-render-dba-only'}}}
    bundled = render(bundled_values)
    verify_scope(bundled, bundled=True)
    upgrade = render(bundled_values, upgrade=True)
    assert resource(upgrade, 'Job', '-migrate-1')['metadata']['annotations']['helm.sh/hook'] == 'pre-upgrade'
    assert 'helm.sh/hook' not in resource(bundled, 'Job', '-migrate-1')['metadata'].get('annotations', {})
    checks.append('saml-on-existing-bundled-postgresql-tls-overlay-without-second-database')
    url = render(changed('auth.saml.metadataConfigMap', ''))
    local_values = changed('auth.mode', 'local')
    local_values['identity']['securityEnabled'] = False
    local = render(local_values)
    verify_scope(local, saml=False)
    checks.append('local-auth-identity-preparation-without-sp-files')
    verify_scope(render(changed('chatAgent.enabled', True)))
    checks.append('sandbox-and-init-containers-without-identity-credentials')
    assert resource(render(changed('identity.configurationRevision', '2')), 'Deployment', '-worker')['spec']['template'] != resource(pinned, 'Deployment', '-worker')['spec']['template']
    sp_rotated = render(changed('auth.saml.configurationRevision', '2'))
    assert resource(sp_rotated, 'Deployment', '-server')['spec']['template'] != resource(pinned, 'Deployment', '-server')['spec']['template']
    assert resource(sp_rotated, 'Deployment', '-worker') == resource(pinned, 'Deployment', '-worker')
    checks.append('external-secret-revision-rollout-scoped-to-consumer')
    assert pinned == render(BASE, upgrade=True)
    render(BASE, lint=True)
    checks.append('install-upgrade-stability-and-helm-lint-strict')
    disabled = changed('identity.adminEnabled', False)
    disabled['identity']['securityEnabled'] = False
    render(disabled, failure='saml auth requires identity administration')
    checks.append('reject-saml-with-both-identity-processors-disabled')
    custom = copy.deepcopy(BASE)
    custom['auth']['saml'].update({'privateKeyKey': 'sp.pem', 'publicCertKey': 'sp.crt',
                                  'metadataKey': 'idp.xml', 'sessionSecretKey': 'session'})
    custom['identity']['clientSecretKey'] = 'machine-token-secret'
    custom['trustedCa']['key'] = 'runtime.pem'
    custom_docs = render(custom)
    for role in ['server', 'worker']:
        spec = pod(resource(custom_docs, 'Deployment', '-' + role))
        volumes = {v['name']: v for v in spec['volumes']}
        assert volumes['identity-admin']['secret']['items'] == [{'key': 'machine-token-secret', 'path': 'client-secret'}]
        assert volumes['trusted-ca']['configMap']['items'] == [{'key': 'runtime.pem', 'path': 'ca.crt'}]
        if role == 'server':
            assert volumes['saml-sp']['secret']['items'] == [{'key': 'sp.pem', 'path': 'private-key.pem'},
                                                          {'key': 'sp.crt', 'path': 'public-cert.pem'}]
            assert volumes['saml-metadata']['configMap']['items'] == [{'key': 'idp.xml', 'path': 'metadata.xml'}]
            env = {e['name']: e for e in spec['containers'][0]['env']}
            assert env['SESSION_SECRET']['valueFrom']['secretKeyRef']['key'] == 'session'
    checks.append('custom-secret-and-configmap-keys-preserve-runtime-file-paths')
    invalid = [
        ('image.digest', '', 'immutable image digest'),
        ('image.digest', 'latest', 'immutable image digest'),
        ('auth.saml.idpIssuer', '', 'non-master Keycloak'),
        ('auth.saml.idpIssuer', 'https://auth.example.test/realms/master', 'non-master Keycloak'),
        ('auth.saml.idpIssuer', 'http://auth.example.test/realms/gcr', 'auth.saml.idpIssuer'),
        ('auth.saml.idpIssuer', 'https://auth.example.test/realms/gcr?query=1', 'auth.saml.idpIssuer'),
        ('publicBaseUrl', 'http://gcr.example.test', 'HTTPS publicBaseUrl origin'),
        ('publicBaseUrl', 'https://gcr.example.test/app', 'HTTPS publicBaseUrl origin'),
        ('publicBaseUrl', 'https://gcr.example.test:443', 'URLs must be canonical'),
        ('auth.saml.entityId', 'https://gcr.example.test/../other', 'URLs must be canonical'),
        ('auth.saml.entityId', 'https://other.example.test/entity', 'Entity ID origin must match'),
        ('auth.saml.entityId', 'https://gcr.example.test', 'auth.saml.entityId'),
        ('identity.adminBaseUrl', 'https://internal.example.test:65536/admin/realms/git-code-reviewer', 'URL length or port is out of range'),
        ('auth.saml.signingSecret', '', 'server-only signing Secret'),
        ('auth.saml.signingSecret', BASE['identity']['existingSecret'], 'server-only signing Secret'),
        ('auth.saml.privateKeyKey', 'tls.crt', 'distinct Secret keys'),
        ('auth.saml.sessionSecretKey', '', 'auth.saml.sessionSecretKey'),
        ('auth.saml.metadataKey', '', 'auth.saml.metadataKey'),
        ('identity.adminEnabled', False, 'securityEnabled requires'),
        ('identity.securityEnabled', False, 'security reconciliation'),
        ('identity.clientId', 'admin-cli', 'realm service account'),
        ('identity.clientId', '', 'requires a private adminBaseUrl'),
        ('identity.adminBaseUrl', '', 'requires a private adminBaseUrl'),
        ('identity.adminBaseUrl', 'https://auth.example.test/admin/realms/git-code-reviewer', 'private origin distinct'),
        ('identity.adminBaseUrl', 'https://internal.example.test/admin/realms/wrong', 'same realm'),
        ('identity.adminBaseUrl', 'http://internal.example.test/admin/realms/git-code-reviewer', 'identity.adminBaseUrl'),
        ('identity.existingSecret', 'git-code-reviewer-db-app', 'separate from application and database Secrets'),
        ('identity.existingSecret', 'git-code-reviewer-db-migrator', 'separate from application and database Secrets'),
        ('identity.existingSecret', 'git-code-reviewer-auth', 'separate from application and database Secrets'),
        ('identity.networkPolicy.publicPeers', [], 'explicit public issuer peers'),
        ('identity.networkPolicy.adminPeers', [], 'requires a private adminBaseUrl'),
        ('identity.networkPolicy.adminPeers', [{'namespace': NAMESPACE, 'podLabels': {}}], 'identity.networkPolicy.adminPeers'),
        ('identity.networkPolicy.publicPeers', [{'cidr': '0.0.0.0/0'}], 'identity.networkPolicy.publicPeers'),
        ('networkPolicy.enabled', False, 'requires NetworkPolicy'),
        ('database.isolated.enabled', False, 'isolated shared PostgreSQL'),
        ('database.tls.mode', 'legacy', 'isolated shared PostgreSQL'),
        ('database.isolated.budget.serverPeakReplicas', 2, 'terminating server/worker Pods'),
        ('database.isolated.budget.workerPeakReplicas', 2, 'terminating server/worker Pods'),
        ('worker.databasePoolMax', 10, 'exceed the gcr_app connection budget'),
        ('auth.mode', 'development', 'local preparation or saml'),
        ('auth.autoJoinDefaultTenant', True, 'explicit account mappings'),
    ]
    for path, value, reason in invalid:
        render(changed(path, value), failure=reason)
        checks.append('reject-' + path + '-' + str(len(checks)))
    with tempfile.TemporaryDirectory(prefix='gcr-saml-baseline-') as directory:
        archived = subprocess.run(['git', 'archive', '--format=tar', args.baseline, 'deploy/helm/git-code-reviewer'],
                                  cwd=ROOT, capture_output=True, check=True)
        with tarfile.open(fileobj=io.BytesIO(archived.stdout)) as archive:
            archive.extractall(directory, filter='data')
        baseline = Path(directory) / 'deploy/helm/git-code-reviewer'
        shutil.copytree(CHART / 'charts', baseline / 'charts', dirs_exist_ok=True)
        for mode in ['development', 'local', 'oidc', 'proxy']:
            values = {'auth': {'mode': mode}}
            for upgrade in [False, True]:
                assert render(values, upgrade=upgrade) == render(values, chart=baseline, upgrade=upgrade), mode
            checks.append('legacy-install-upgrade-parity-' + mode)
    entity = render(changed('auth.saml.entityId', BASE['publicBaseUrl'] + '/saml-app'))
    assert resource(entity, 'ConfigMap', '-identity')['data']['SAML_ENTITY_ID'] == BASE['publicBaseUrl'] + '/saml-app'
    compiled = compiled_configuration([('saml-pinned', pinned), ('saml-url', url),
                                       ('local-preparation', local), ('custom-entity', entity)])
    checks.append('compiled-command-config-and-saml-trust-loaders')
    sources = [p for p in CHART.rglob('*') if p.is_file() and 'charts' not in p.relative_to(CHART).parts]
    sources += [Path(__file__), ROOT / 'scripts/verify-saml-chart-runtime.mjs', ROOT / 'scripts/verify-identity-chart.py', shared_overlay]
    print(json.dumps({'status': 'passed', 'startedAt': started, 'finishedAt': datetime.now(timezone.utc).isoformat(),
                      'baseline': args.baseline, 'checks': checks, 'checkCount': len(checks),
                      'networkDecisions': decisions, 'compiledRuntime': compiled,
                      'sourceSha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(sources)},
                      'scope': 'rendered configuration and policy semantics; fixture metadata; no real IdP/DB/cluster',
                      'clusterChanged': False, 'temporaryFixtureRemoved': True}, indent=2))


if __name__ == '__main__':
    main()

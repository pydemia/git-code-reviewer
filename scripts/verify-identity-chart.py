"""Check companion manifests and network reachability rules offline (Helm + PyYAML).

This checks rendered policy semantics, not CNI enforcement, proxy header handling,
actual certificates/Secrets, a running Keycloak, or a published image.
"""
import copy
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
from pathlib import Path
import subprocess
import tempfile

import yaml

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / 'deploy/helm/gcr-identity'
RELEASE = 'git-code-reviewer-identity'
NAMESPACE = 'git-code-reviewer'
IMAGE = 'registry.example.test/gcr-identity@sha256:' + '0' * 64
BASE = yaml.safe_load((CHART / 'values.example.yaml').read_text())
BASE['image'] = dict(zip(['repository', 'digest'], IMAGE.split('@')))


def helm(values, *, upgrade=False, failure=None, lint=False):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.yaml') as handle:
        yaml.safe_dump(values, handle)
        handle.flush()
        command = ['helm', 'lint', '--strict', str(CHART)] if lint else [
            'helm', 'template', RELEASE, str(CHART), '--namespace', NAMESPACE]
        command += ['--values', handle.name]
        if upgrade:
            command += ['--is-upgrade']
        result = subprocess.run(command, capture_output=True, text=True, timeout=45)
    if failure is not None:
        assert result.returncode != 0, 'Unsafe configuration rendered successfully'
        # Helm 3 uses dotted paths; Helm 4 reports JSON Pointer paths.
        assert failure in result.stderr or failure.replace('.', '/') in result.stderr, result.stderr
        return None
    assert result.returncode == 0, result.stdout + result.stderr
    return result.stdout if lint else [d for d in yaml.safe_load_all(result.stdout) if d]


def changed(path, value):
    values = copy.deepcopy(BASE)
    target = values
    parts = path.split('.')
    for part in parts[:-1]:
        target = target.setdefault(part, {})
    target[parts[-1]] = value
    return values


def resource(documents, kind, name=RELEASE):
    return next(d for d in documents if d['kind'] == kind and d['metadata']['name'] == name)


def labels_match(selector, labels):
    assert set(selector) <= {'matchLabels'}, 'New selector syntax needs verifier support'
    return all(labels.get(k) == v for k, v in selector.get('matchLabels', {}).items())


def peer_matches(peer, namespace, labels, address):
    if 'ipBlock' in peer:
        network = peer['ipBlock']
        return (ipaddress.ip_address(address) in ipaddress.ip_network(network['cidr'])
                and not any(ipaddress.ip_address(address) in ipaddress.ip_network(item)
                            for item in network.get('except', [])))
    if 'namespaceSelector' in peer:
        if not labels_match(peer['namespaceSelector'], {'kubernetes.io/metadata.name': namespace}):
            return False
    elif namespace != NAMESPACE:
        return False
    return labels_match(peer.get('podSelector', {}), labels)


def allows(policy, direction, namespace, labels, port, protocol='TCP', address='192.0.2.99'):
    # Policy has already been checked to select the identity Pods. Only their
    # side of a connection is modeled: peer ingress/egress policies also apply.
    peer_field = 'from' if direction == 'ingress' else 'to'
    for rule in policy['spec'].get(direction, []):
        ports = rule.get('ports', [])
        if ports and not any(p.get('protocol', 'TCP') == protocol and p['port'] == port for p in ports):
            continue
        peers = rule.get(peer_field, [])
        if not peers or any(peer_matches(p, namespace, labels, address) for p in peers):
            return True
    return False


def verify_wiring(documents):
    kinds = [d['kind'] for d in documents]
    assert sorted(kinds) == sorted(['Deployment', 'Service', 'Service', 'Service',
                                   'NetworkPolicy', 'PodDisruptionBudget'])
    assert not yaml.safe_load((CHART / 'Chart.yaml').read_text()).get('dependencies')
    deployment = resource(documents, 'Deployment')
    pod = deployment['spec']['template']['spec']
    container, = pod['containers']
    selectors = deployment['spec']['selector']['matchLabels']
    assert labels_match({'matchLabels': selectors}, deployment['spec']['template']['metadata']['labels'])
    assert selectors['app.kubernetes.io/name'] == 'gcr-identity'
    assert resource(documents, 'NetworkPolicy')['spec']['podSelector']['matchLabels'] == selectors
    assert resource(documents, 'PodDisruptionBudget')['spec']['selector']['matchLabels'] == selectors
    assert resource(documents, 'PodDisruptionBudget')['spec']['minAvailable'] == 1
    assert deployment['spec']['replicas'] == 2
    assert deployment['spec']['strategy']['rollingUpdate'] == {'maxSurge': 1, 'maxUnavailable': 0}
    assert container['image'] == IMAGE
    assert container['command'] == ['/opt/keycloak/bin/kc.sh']
    assert container['args'] == ['start', '--optimized']
    assert not pod.get('initContainers')
    assert pod['automountServiceAccountToken'] is False
    assert pod['enableServiceLinks'] is False
    assert pod['securityContext']['runAsUser'] == pod['securityContext']['runAsGroup'] == 1000
    assert pod['securityContext']['runAsNonRoot'] is True
    assert pod['securityContext']['seccompProfile'] == {'type': 'RuntimeDefault'}
    assert container['securityContext'] == {
        'allowPrivilegeEscalation': False, 'readOnlyRootFilesystem': True, 'capabilities': {'drop': ['ALL']}}
    assert container['resources']['limits']['memory'] == '2Gi'
    assert pod['affinity']['podAntiAffinity']['preferredDuringSchedulingIgnoredDuringExecution']
    assert pod['topologySpreadConstraints'][0]['labelSelector']['matchLabels'] == selectors
    environment = {e['name']: e for e in container['env']}
    assert len(environment) == len(container['env'])
    for key, value in {
        'KC_DB': 'postgres', 'KC_DB_USERNAME': 'gcr_keycloak', 'KC_DB_TLS_MODE': 'verify-server',
        'KC_DB_TLS_TRUST_STORE_FILE': '/run/config/database/ca.crt', 'KC_DB_POOL_MAX_SIZE': '6',
        'KC_HOSTNAME': BASE['hostname'], 'KC_HOSTNAME_ADMIN': BASE['adminHostname'],
        'KC_PROXY_TRUSTED_ADDRESSES': '192.0.2.10/32', 'KC_PROXY_HEADERS': 'xforwarded',
        'KC_CACHE_STACK': 'jdbc-ping', 'KC_CACHE_EMBEDDED_MTLS_ENABLED': 'true',
        'KC_HTTP_MANAGEMENT_SCHEME': 'http', 'KC_HTTP_MANAGEMENT_HEALTH_ENABLED': 'true',
        'KC_HTTP_ACCESS_LOG_ENABLED': 'false', 'KC_SERVER_ASYNC_BOOTSTRAP': 'false',
        'KC_HOSTNAME_STRICT': 'true', 'KC_HOSTNAME_BACKCHANNEL_DYNAMIC': 'false',
        'KC_TLS_HOSTNAME_VERIFIER': 'DEFAULT', 'KC_LOG_CONSOLE_OUTPUT': 'json',
    }.items():
        assert environment[key]['value'] == value, key
    secrets = [e['valueFrom']['secretKeyRef']['name'] for e in environment.values() if 'valueFrom' in e]
    assert secrets == [BASE['database']['existingSecret']]
    assert environment['KCRAW_DB_PASSWORD']['valueFrom']['secretKeyRef']['key'] == 'password'
    assert not any(k in environment for k in ['KC_DB_URL', 'KC_DB_URL_PROPERTIES', 'KC_DB_PASSWORD',
                                             'KC_BOOTSTRAP_ADMIN_PASSWORD', 'KEYCLOAK_ADMIN_PASSWORD'])
    volumes = {v['name']: v for v in pod['volumes']}
    assert {v['mountPath'] for v in container['volumeMounts'] if not v.get('readOnly')} == {
        '/tmp', '/opt/keycloak/data'}
    assert set(v['name'] for v in pod['volumes'] if 'emptyDir' in v) == {'tmp', 'data'}
    assert volumes['https']['secret']['secretName'] == BASE['tls']['existingSecret']
    assert volumes['https']['secret']['defaultMode'] == 0o440
    assert {i['key'] for i in volumes['https']['secret']['items']} == {'tls.key', 'tls.crt'}
    assert volumes['database-ca']['configMap']['name'] == BASE['database']['tls']['existingConfigMap']
    for probe, endpoint in [('startupProbe', 'started'), ('readinessProbe', 'ready'), ('livenessProbe', 'live')]:
        assert container[probe]['httpGet'] == {'path': '/health/' + endpoint, 'port': 'management'}
    assert container['startupProbe']['periodSeconds'] * container['startupProbe']['failureThreshold'] == 600
    assert pod['terminationGracePeriodSeconds'] > 10 + 60
    port_map = {p['name']: p['containerPort'] for p in container['ports']}
    for suffix, port, target in [('', 80, 8080), ('-admin', 443, 8443), ('-management', 9000, 9000)]:
        service = resource(documents, 'Service', RELEASE + suffix)
        assert service['spec']['selector'] == selectors
        assert service['spec']['type'] == 'ClusterIP'
        entry, = service['spec']['ports']
        assert entry['port'] == port and port_map[entry['targetPort']] == target


def verify_network(documents):
    policy = resource(documents, 'NetworkPolicy')
    assert set(policy['spec']['policyTypes']) == {'Ingress', 'Egress'}
    for direction, key in [('ingress', 'from'), ('egress', 'to')]:
        for rule in policy['spec'][direction]:
            assert rule.get(key) and rule.get('ports'), 'Unexpected all-peer/all-port rule'
            for peer in rule[key]:
                assert peer, 'Empty peer allows all traffic'
    gateway = BASE['networkPolicy']['proxy']['peers'][0]
    server, worker = BASE['networkPolicy']['adminPeers']
    identity_labels = resource(documents, 'Deployment')['spec']['selector']['matchLabels']
    cases = [
        (gateway['namespace'], gateway['podLabels'], {8080}),
        (NAMESPACE, gateway['podLabels'], set()),
        (NAMESPACE, server['podLabels'], {8443}),
        (NAMESPACE, worker['podLabels'], {8443}),
        ('foreign', server['podLabels'], set()),
        (NAMESPACE, {**server['podLabels'], 'app.kubernetes.io/component': 'migrator'}, set()),
        (NAMESPACE, {**server['podLabels'], 'app.kubernetes.io/component': 'retention'}, set()),
        (NAMESPACE, {'app.kubernetes.io/component': 'source-sandbox'}, set()),
        (NAMESPACE, identity_labels, {7800, 57800}),
        ('foreign', identity_labels, set()),
        (NAMESPACE, {}, set()),
    ]
    decisions = 0
    for namespace, labels, allowed in cases:
        for port in [80, 443, 8080, 8443, 9000, 7800, 57800]:
            for protocol in ['TCP', 'UDP']:
                assert allows(policy, 'ingress', namespace, labels, port, protocol) == (
                    protocol == 'TCP' and port in allowed), (namespace, labels, port, protocol)
                decisions += 1
    db = BASE['networkPolicy']['databasePeers'][0]
    destinations = [
        (db['namespace'], db['podLabels'], {(5432, 'TCP')}),
        ('foreign', db['podLabels'], set()),
        ('kube-system', {'k8s-app': 'kube-dns'}, {(53, 'UDP'), (53, 'TCP')}),
        (NAMESPACE, identity_labels, {(7800, 'TCP'), (57800, 'TCP')}),
        ('foreign', identity_labels, set()),
        (NAMESPACE, {}, set()),
    ]
    for namespace, labels, allowed in destinations:
        for port in [53, 80, 443, 587, 5432, 7800, 57800, 9000]:
            for protocol in ['TCP', 'UDP']:
                assert allows(policy, 'egress', namespace, labels, port, protocol) == ((port, protocol) in allowed)
                decisions += 1
    return decisions


def main():
    started = datetime.now(timezone.utc).isoformat()
    checks = []
    documents = helm(BASE)
    verify_wiring(documents)
    checks.append('optimized-runtime-roles-secrets-tls-probes-services-rollout')
    decisions = verify_network(documents)
    checks.append('ingress-egress-positive-and-negative-peer-matrix')
    assert helm(BASE, upgrade=True) == documents
    checks.append('repeat-install-upgrade-identical-no-bootstrap-or-import-job')
    helm(BASE, lint=True)
    checks.append('helm-lint-strict')
    route = yaml.safe_load((ROOT / 'deploy/environments/prism-dev/identity-httproute.yaml').read_text())
    assert route['spec']['hostnames'] == ['auth.pr-review.prism.ai']
    rule, = route['spec']['rules']
    assert {(m['path']['type'], m['path']['value']) for m in rule['matches']} == {
        ('PathPrefix', '/realms/git-code-reviewer'), ('PathPrefix', '/resources')}
    backend, = rule['backendRefs']
    assert backend['name'] == RELEASE and backend['port'] == 80
    checks.append('existing-prism-route-service-contract-realm-resources-only')
    options = copy.deepcopy(BASE)
    options['bootstrap'] = {'existingSecret': 'fixture-bootstrap'}
    options['outboundTrust'] = {'existingConfigMap': 'fixture-smtp-ca', 'key': 'bundle.pem'}
    options['networkPolicy']['monitoringPeers'] = [{'namespace': 'monitoring', 'podLabels': {'app': 'prometheus'}}]
    options['networkPolicy']['smtp'] = {'peers': [{'cidr': '192.0.2.25/32'}], 'port': 465}
    optional_docs = helm(options)
    assert optional_docs == helm(options, upgrade=True)
    optional_pod = resource(optional_docs, 'Deployment')['spec']['template']['spec']
    environment = {e['name']: e for e in optional_pod['containers'][0]['env']}
    for name in ['KC_BOOTSTRAP_ADMIN_USERNAME', 'KC_BOOTSTRAP_ADMIN_PASSWORD']:
        assert environment[name]['valueFrom']['secretKeyRef']['name'] == 'fixture-bootstrap'
    assert environment['KC_TRUSTSTORE_PATHS']['value'] == '/run/config/outbound/ca.crt'
    assert next(v for v in optional_pod['volumes'] if v['name'] == 'outbound-ca')['configMap']['items'] == [
        {'key': 'bundle.pem', 'path': 'ca.crt'}]
    policy = resource(optional_docs, 'NetworkPolicy')
    assert allows(policy, 'ingress', 'monitoring', {'app': 'prometheus'}, 9000)
    assert not allows(policy, 'ingress', NAMESPACE, {'app': 'prometheus'}, 9000)
    assert not allows(policy, 'ingress', 'monitoring', {'app': 'prometheus'}, 8443)
    assert allows(policy, 'egress', 'external', {}, 465, address='192.0.2.25')
    assert not allows(policy, 'egress', 'external', {}, 587, address='192.0.2.25')
    assert not allows(policy, 'egress', 'external', {}, 465, address='192.0.2.26')
    checks.append('optional-bootstrap-outbound-ca-monitoring-and-scoped-smtp')
    external = changed('networkPolicy.databasePeers', [{'cidr': '2001:db8::10/128'}])
    external['database']['port'] = 5544
    policy = resource(helm(external), 'NetworkPolicy')
    assert allows(policy, 'egress', 'external', {}, 5544, address='2001:db8::10')
    assert not allows(policy, 'egress', 'external', {}, 5432, address='2001:db8::10')
    assert not allows(policy, 'egress', 'external', {}, 5544, address='2001:db8::11')
    checks.append('external-ipv6-database-custom-port-scope')
    scaled = changed('replicas', 3)
    scaled['database']['budget'] = {'peakReplicas': 7, 'connectionLimit': 30}
    scaled['database']['pool'] = {'max': 4}
    assert resource(helm(scaled), 'Deployment')['spec']['replicas'] == 3
    checks.append('scale-with-explicit-terminating-allowance-and-lower-pool')
    defaults = yaml.safe_load((CHART / 'values.yaml').read_text())
    plan_path = ROOT / 'deploy/postgres/shared-plan.example.json'
    plan = json.loads(plan_path.read_text())
    identity_pool, = [p for p in plan['pools'] if p['role'] == 'gcr_keycloak']
    assert identity_pool['replicas'] == defaults['database']['budget']['peakReplicas']
    assert identity_pool['max'] == defaults['database']['pool']['max']
    assert identity_pool['replicas'] * identity_pool['max'] == defaults['database']['budget']['connectionLimit']
    assert plan['identityDatabase'] == defaults['database']['name']
    checks.append('shared-dba-example-matches-identity-database-and-connection-budget')
    # Every rejection checks the actual error cause, not just a nonzero exit.
    invalid = [
        ('image.digest', '', 'image.digest'),
        ('image.digest', 'latest', 'image.digest'),
        ('image.repository', 'https://registry.example.test/gcr', 'image.repository'),
        ('hostname', 'http://auth.example.test', 'hostname'),
        ('hostname', 'https://auth.example.test/admin', 'hostname'),
        ('hostname', 'https://user:password@auth.example.test', 'hostname'),
        ('adminHostname', BASE['hostname'], 'must be distinct'),
        ('database.username', 'postgres', 'database.username'),
        ('database.existingSecret', BASE['tls']['existingSecret'], 'distinct Secrets'),
        ('database.tls.existingConfigMap', '', 'database.tls.existingConfigMap'),
        ('database.pool.initial', 7, 'min <= initial <= max'),
        ('database.pool.min', 2, 'min <= initial <= max'),
        ('database.pool.max', 10, 'exceeds the Keycloak role connectionLimit'),
        ('database.budget.peakReplicas', 3, 'terminating replicas'),
        ('replicas', 3, 'terminating replicas'),
        ('replicas', 1, 'replicas'),
        ('tls.existingSecret', '', 'tls.existingSecret'),
        ('bootstrap.existingSecret', BASE['database']['existingSecret'], 'distinct Secrets'),
        ('fullnameOverride', 'x' * 53, 'fullnameOverride'),
        ('networkPolicy.proxy.peers', [], 'networkPolicy.proxy.peers'),
        ('networkPolicy.proxy.trustedAddresses', [], 'networkPolicy.proxy.trustedAddresses'),
        ('networkPolicy.proxy.trustedAddresses', ['0.0.0.0/0'], 'networkPolicy.proxy.trustedAddresses'),
        ('networkPolicy.proxy.trustedAddresses', ['::/0'], 'networkPolicy.proxy.trustedAddresses'),
        ('networkPolicy.proxy.trustedAddresses', ['999.1.2.3'], 'networkPolicy.proxy.trustedAddresses'),
        ('networkPolicy.adminPeers', [{}], 'networkPolicy.adminPeers'),
        ('networkPolicy.adminPeers', [{'namespace': NAMESPACE, 'podLabels': {}}], 'networkPolicy.adminPeers'),
        ('networkPolicy.adminPeers', [{'podLabels': {'app': 'anything'}}], 'networkPolicy.adminPeers'),
        ('networkPolicy.databasePeers', [], 'networkPolicy.databasePeers'),
        ('networkPolicy.databasePeers', [{'cidr': '0.0.0.0/0'}], 'networkPolicy.databasePeers'),
        ('networkPolicy.dnsPeers', [], 'networkPolicy.dnsPeers'),
        ('networkPolicy.smtp.peers', [{'namespace': NAMESPACE}], 'networkPolicy.smtp.peers'),
        ('postgresql', {'enabled': True}, 'postgresql'),
        ('extraEnv', [{'name': 'KC_DB_TLS_MODE', 'value': 'disabled'}], 'extraEnv'),
    ]
    for path, value, message in invalid:
        helm(changed(path, value), failure=message)
        checks.append('reject-' + path + '-' + str(len(checks)))
    helm({}, failure='image.digest')
    checks.append('unconfigured-chart-fails-closed')
    assert yaml.safe_load((ROOT / 'deploy/helm/git-code-reviewer/values.yaml').read_text())['keycloak']['enabled'] is False
    checks.append('application-legacy-keycloak-disabled')
    files = sorted(p for p in CHART.rglob('*') if p.is_file()) + [Path(__file__), plan_path]
    print(json.dumps({
        'status': 'passed', 'startedAt': started, 'finishedAt': datetime.now(timezone.utc).isoformat(),
        'scope': 'offline Helm/schema/resource and policy-rule semantics; no runtime/CNI/cluster validation',
        'checks': checks, 'checkCount': len(checks), 'networkMatrixDecisions': decisions,
        'fixtureImagePublished': False, 'clusterChanged': False,
        'sourceSha256': {str(p.relative_to(ROOT)): hashlib.sha256(p.read_bytes()).hexdigest() for p in files},
    }, indent=2))


if __name__ == '__main__':
    main()

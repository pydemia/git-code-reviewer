"""Verify role-specific Helm wiring. Requires Helm and PyYAML; no cluster access."""
import argparse
import io
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import yaml

ROOT = Path(__file__).resolve().parent.parent
CHART = ROOT / 'deploy/helm/git-code-reviewer'
COMMON = ['server.replicas=1', 'worker.replicas=1', 'database.isolated.enabled=true',
          'database.isolated.host=postgres.internal', 'database.isolated.runtimeSecret=fixture-app',
          'database.isolated.migratorSecret=fixture-migrator', 'database.tls.mode=verify-full',
          'database.tls.existingConfigMap=fixture-db-ca', 'retention.enabled=true']
BUNDLED = ['postgresql.enabled=true', 'postgresql.auth.existingSecret=fixture-bootstrap',
           'database.isolated.host=', 'postgresql.tls.enabled=true',
           'postgresql.tls.certificatesSecret=fixture-postgres-tls']


def render(values=(), upgrade=False, chart=CHART, failure=None, values_file=None):
    command = ['helm', 'template', 'db-fixture', str(chart)]
    if values_file:
        command += ['--values', str(values_file)]
    # Offline rendering cannot look up the fixture Secret used by the Bitnami
    # upgrade guard. These synthetic values are never sent to a cluster.
    command += ['--set', 'global.postgresql.auth.password=fixture-render-only',
                '--set', 'global.postgresql.auth.postgresPassword=fixture-render-admin-only']
    if upgrade:
        command += ['--is-upgrade']
    for setting in values:
        command += ['--set', setting]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, timeout=45)
    if failure:
        assert result.returncode != 0, 'Invalid database configuration rendered successfully'
        assert failure in result.stderr, result.stderr
        return
    assert result.returncode == 0, result.stderr
    return [item for item in yaml.safe_load_all(result.stdout) if item]


def resource(items, kind, suffix):
    return next(item for item in items if item['kind'] == kind and item['metadata']['name'].endswith(suffix))


def pod(item):
    spec = item['spec']
    if item['kind'] == 'CronJob':
        spec = spec['jobTemplate']['spec']
    return spec['template']['spec']


def env(container):
    return {item['name']: item.get('value') for item in container.get('env', [])}


def verify_isolated(items, bundled, upgrade):
    if bundled:
        postgres = pod(resource(items, 'StatefulSet', '-postgresql'))['containers'][0]
        assert env(postgres)['POSTGRESQL_ENABLE_TLS'] == 'yes'
    for kind, suffix in [('Deployment', '-server'), ('Deployment', '-worker'), ('CronJob', '-retention')]:
        spec = pod(resource(items, kind, suffix))
        assert 'fixture-migrator' not in json.dumps(spec)
        assert 'fixture-bootstrap' not in json.dumps(spec)
        volumes = {item['name']: item for item in spec['volumes']}
        assert volumes['database-password']['secret']['secretName'] == 'fixture-app'
        assert volumes['database-tls']['configMap']['name'] == 'fixture-db-ca'
        containers = spec['containers'] + spec.get('initContainers', [])
        for container in containers:
            if container['name'] == 'source-sandbox':
                assert not any('DATABASE' in key for key in env(container))
                continue
            settings = env(container)
            assert settings['DATABASE_USER'] == 'gcr_app'
            assert settings['DATABASE_ISOLATED_ROLES'] == 'true'
            assert settings['DATABASE_TLS_MODE'] == 'verify-full'
            assert settings['DATABASE_TLS_CA_FILE'] == '/run/config/database-tls/ca.crt'
            assert not any(key.startswith('MIGRATION_DATABASE') for key in settings)
        if kind == 'Deployment':
            waits = [c for c in spec['initContainers'] if c['name'] == 'wait-migrations']
            assert len(waits) == 1 and waits[0]['args'] == ['wait-migrations']
            assert resource(items, kind, suffix)['spec']['strategy']['rollingUpdate'] == {'maxSurge': 1, 'maxUnavailable': 0}
    job = next(item for item in items if item['kind'] == 'Job' and item['metadata'].get('labels', {}).get('app.kubernetes.io/component') == 'migration')
    spec = pod(job)
    assert 'fixture-app' not in json.dumps(spec)
    assert 'fixture-bootstrap' not in json.dumps(spec)
    volumes = {item['name']: item for item in spec['volumes']}
    assert volumes['database-password']['secret']['secretName'] == 'fixture-migrator'
    settings = env(spec['containers'][0])
    assert settings['MIGRATION_DATABASE_USER'] == 'gcr_migrator'
    assert 'DATABASE_URL' not in settings and 'DATABASE_USER' not in settings
    assert settings['DATABASE_TLS_MODE'] == 'verify-full'
    assert spec['containers'][0]['args'] == ['migrate']
    hook = job['metadata'].get('annotations', {}).get('helm.sh/hook')
    assert hook == (None if bundled and not upgrade else 'pre-upgrade' if bundled else 'pre-install,pre-upgrade')


def normalized(items):
    return sorted(items, key=lambda item: (item['kind'], item['metadata']['name']))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', help='Optional Git revision to compare legacy rendered resources')
    args = parser.parse_args()
    checks = []
    for bundled in [False, True]:
        values = COMMON + (BUNDLED if bundled else [])
        for upgrade in [False, True]:
            verify_isolated(render(values, upgrade), bundled, upgrade)
            checks.append(f'isolated-{ "bundled" if bundled else "external" }-{ "upgrade" if upgrade else "install" }')
    worker = resource(render(COMMON + ['worker.databasePoolMax=6']), 'Deployment', '-worker')
    assert env(pod(worker)['containers'][0])['DATABASE_POOL_MAX'] == '6'
    checks.append('separate-worker-pool')
    verify_isolated(render(COMMON + ['chatAgent.enabled=true']), False, False)
    checks.append('sandbox-without-database-secrets')
    custom_port = render(COMMON + BUNDLED + [
                                  'postgresql.primary.service.ports.postgresql=5544'])
    assert env(pod(resource(custom_port, 'Deployment', '-server'))['containers'][0])['DATABASE_PORT'] == '5544'
    checks.append('bundled-service-port')
    for setting, message in {
        'database.isolated.migratorSecret=fixture-app': 'distinct runtime and migrator Secrets',
        'database.tls.mode=legacy': 'require database.tls.mode=verify-full',
        'database.tls.existingConfigMap=': 'requires a CA ConfigMap',
        'database.isolated.host=': 'requires database.isolated.host',
        'keycloak.enabled=true': 'legacy keycloak dependency to remain disabled',
        'database.isolated.budget.applicationConnectionLimit=41': 'exceed the gcr_app connection budget',
        'database.isolated.budget.maxConnections=90': 'exceed the server limit',
        'database.isolated.budget.operatorReserve=1': 'lack operator reserve',
        'database.isolated.budget.workerPeakReplicas=1': 'must include rolling replacements',
        'server.databasePoolMax=1': 'must each allow at least two connections',
        'worker.databasePoolMax=1': "'/worker/databasePoolMax': minimum:",
    }.items():
        render(COMMON + [setting], failure=message)
        checks.append('reject-' + setting.split('=')[0])
    render(COMMON + BUNDLED + [
                     'database.isolated.runtimeSecret=fixture-bootstrap'],
           failure='separate from the PostgreSQL bootstrap Secret')
    checks.append('reject-bootstrap-secret-in-runtime')
    render(COMMON + BUNDLED + ['postgresql.tls.enabled=false'], failure='requires postgresql.tls.enabled')
    checks.append('reject-bundled-plaintext-backend')
    render(COMMON + ['secrets.auth=fixture-migrator'], failure='must not be referenced by application services')
    checks.append('reject-migrator-secret-in-auth-env')
    example = render(COMMON + BUNDLED, values_file=ROOT / 'deploy/postgres/isolated-helm.example.yaml')
    verify_isolated(example, True, False)
    configuration = resource(example, 'ConfigMap', '-postgresql-configuration')['data']
    assert 'hostnossl all all 0.0.0.0/0 reject' in configuration['pg_hba.conf']
    assert 'hostssl all all ::0/0 scram-sha-256' in configuration['pg_hba.conf']
    postgres = pod(resource(example, 'StatefulSet', '-postgresql'))
    copy = next(container for container in postgres['initContainers'] if container['name'] == 'copy-certs')
    assert copy['image'] == postgres['containers'][0]['image']
    assert copy['image'] == 'registry-1.docker.io/bitnami/postgresql@sha256:e39896e0b1ba7b0d5b8de7ab8792118eaac3cc27f89659aa9fe2c788b395e204'
    assert copy['securityContext']['runAsUser'] == 1001 and copy['securityContext']['readOnlyRootFilesystem']
    checks.append('example-overlay-backend-tls-hba-and-pinned-init-image')
    if args.baseline:
        with tempfile.TemporaryDirectory(prefix='gcr-helm-db-baseline-') as directory:
            result = subprocess.run(['git', 'archive', '--format=tar', args.baseline, 'deploy/helm/git-code-reviewer'], cwd=ROOT, capture_output=True, check=True)
            with tarfile.open(fileobj=io.BytesIO(result.stdout)) as archive:
                archive.extractall(directory, filter='data')
            baseline = Path(directory) / 'deploy/helm/git-code-reviewer'
            shutil.copytree(CHART / 'charts', baseline / 'charts', dirs_exist_ok=True)
            for values in [[], ['postgresql.enabled=true', 'postgresql.auth.existingSecret=fixture-bootstrap']]:
                for upgrade in [False, True]:
                    assert normalized(render(values, upgrade)) == normalized(render(values, upgrade, baseline)), 'Legacy manifests changed'
                    checks.append('legacy-parity-' + ('bundled' if values else 'external') + ('-upgrade' if upgrade else '-install'))
    print(json.dumps({'status': 'passed', 'checks': checks, 'clusterAccess': False, 'baseline': args.baseline}, indent=2))


if __name__ == '__main__':
    main()

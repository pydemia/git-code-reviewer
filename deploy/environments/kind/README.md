# Local kind GitHub test

이 환경은 단일 노드 kind에서 `pydemia/Python3`의 공개 PR을 GitHub App으로 polling하고 snapshot/report pipeline을 검증한다. UI는 `http://127.0.0.1:4181`에 port-forward하며 Keycloak과 model provider는 사용하지 않는다.

`kind-config.yaml`은 cgroup v1인 현재 Docker Desktop host와 호환되도록 kind `v0.32.0`에서 제공하는 Kubernetes `v1.34.8` ARM64/AMD64 node image digest를 고정한다. Kubernetes `v1.35` 이상은 cgroup v1에서 kubelet 실행을 거부하므로, host를 cgroup v2로 전환하기 전까지 이 버전을 유지한다.

테스트 대상은 [`pydemia/Python3` PR #8](https://github.com/pydemia/Python3/pull/8)이다. 변경 파일 1개, commit 1개의 작은 PR이므로 첫 연결 smoke test에 적합하다.

Development authentication은 모든 요청을 local administrator로 처리한다. 이 profile을 외부 네트워크에 노출하지 않는다.

필수 도구는 Docker, `kind v0.32.0`, `kubectl`, `helm`, `openssl`, `curl`, `jq`이다.

## 1. Create the cluster

```bash
kind create cluster \
  --name git-code-reviewer \
  --config deploy/environments/kind/kind-config.yaml \
  --wait 120s

kubectl --context kind-git-code-reviewer get nodes
kubectl --context kind-git-code-reviewer get storageclass
```

## 2. Install the GitHub App

GitHub의 [GitHub App 등록 화면](https://github.com/settings/apps/new)에서 다음과 같이 생성한다.

- GitHub App name: 계정 내에서 고유한 이름
- Homepage URL: `http://127.0.0.1:4181`
- Webhook: Active 해제. 이 profile은 webhook 대신 30초 polling을 사용한다.
- Repository permissions: Contents `Read-only`, Pull requests `Read-only`. Metadata는 기본 `Read-only`이다.
- Where can this GitHub App be installed?: `Only on this account`

App 생성 후 private key를 생성해 PEM 파일을 내려받는다. `Install App`에서 `pydemia` 계정의 `Only select repositories`를 선택하고 `Python3`만 허용한다. 자세한 화면 순서는 [GitHub 공식 설치 가이드](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)를 따른다.

App settings의 App ID, 설치 후 브라우저 URL 끝의 installation ID, 내려받은 private key PEM 경로를 설정한다. PEM 본문은 shell history나 repository에 기록하지 않는다.

```bash
export GITHUB_APP_ID='REPLACE_ME'
export GITHUB_INSTALLATION_ID='REPLACE_ME'
export GITHUB_APP_PRIVATE_KEY="$HOME/secure/git-code-reviewer.pem"

test -n "$GITHUB_APP_ID"
test -n "$GITHUB_INSTALLATION_ID"
test -r "$GITHUB_APP_PRIVATE_KEY"
```

## 3. Create namespace and secrets

```bash
export KUBE_CONTEXT=kind-git-code-reviewer
export NAMESPACE=git-code-reviewer
export POSTGRES_USER_PASSWORD="$(openssl rand -base64 36)"
export POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 36)"

kubectl --context "$KUBE_CONTEXT" apply \
  -f deploy/environments/kind/namespace.yaml

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  create secret generic git-code-reviewer-github-app \
  --from-literal=APP_ID="$GITHUB_APP_ID" \
  --from-file=PRIVATE_KEY="$GITHUB_APP_PRIVATE_KEY" \
  --dry-run=client -o yaml \
  | kubectl --context "$KUBE_CONTEXT" apply -f -

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  create secret generic git-code-reviewer-postgresql-auth \
  --from-literal=password="$POSTGRES_USER_PASSWORD" \
  --from-literal=postgres-password="$POSTGRES_ADMIN_PASSWORD" \
  --dry-run=client -o yaml \
  | kubectl --context "$KUBE_CONTEXT" apply -f -

unset POSTGRES_USER_PASSWORD POSTGRES_ADMIN_PASSWORD
```

## 4. Deploy

```bash
helm lint deploy/helm/git-code-reviewer \
  -f deploy/environments/kind/values.yaml

helm upgrade --install git-code-reviewer \
  oci://registry-1.docker.io/pydemia/git-code-reviewer \
  --version 0.7.1 \
  --kube-context "$KUBE_CONTEXT" \
  -n "$NAMESPACE" \
  -f deploy/environments/kind/values.yaml \
  --rollback-on-failure --wait --timeout 20m
```

GitHub App 준비 전 PostgreSQL, migration, server, worker, PVC만 먼저 검증하려면 `github.mode`를 임시로 끈다. Secret을 생성한 뒤 위의 일반 배포 명령을 다시 실행하면 App mode로 전환된다.

```bash
helm upgrade --install git-code-reviewer \
  deploy/helm/git-code-reviewer \
  --kube-context "$KUBE_CONTEXT" \
  -n "$NAMESPACE" \
  -f deploy/environments/kind/values.yaml \
  --set github.mode=disabled \
  --rollback-on-failure --wait --timeout 20m
```

## 5. Access the UI

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  get pod,pvc,job

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  port-forward svc/git-code-reviewer 4181:80
```

다른 terminal에서 health를 확인하고 `http://127.0.0.1:4181/admin`을 연다.

```bash
curl -fsS http://127.0.0.1:4181/health/live
curl -fsS http://127.0.0.1:4181/health/ready
curl -fsS http://127.0.0.1:4181/health/dependencies | jq
```

## 6. Register pydemia/Python3

```bash
export TENANT_ID="$(curl -fsS http://127.0.0.1:4181/api/v1/admin/tenants \
  | jq -r '.items[] | select(.slug == "default") | .id')"

jq -n \
  --arg tenantId "$TENANT_ID" \
  --arg installationId "$GITHUB_INSTALLATION_ID" \
  '{tenantId: $tenantId, instanceName: "GitHub.com",
    apiBaseUrl: "https://api.github.com/", webBaseUrl: "https://github.com/",
    githubId: 72538035, installationId: $installationId,
    owner: "pydemia", name: "Python3", pollIntervalSeconds: 30}' \
  | curl -fsS http://127.0.0.1:4181/api/v1/admin/repositories \
      -H 'content-type: application/json' --data-binary @- | jq
```

등록 후 최대 약 45초 안에 PR #8이 worklist에 나타나고 최초 snapshot 분석이 enqueue된다.

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  logs -l app.kubernetes.io/component=server --since=10m

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  logs -l app.kubernetes.io/component=worker --since=10m -f
```

## 7. Remove

```bash
kind delete cluster --name git-code-reviewer
```

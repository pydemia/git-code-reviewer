# Local kind GitHub polling test

이 환경은 단일 노드 kind에서 `pydemia/Python3`의 공개 PR을 outbound polling하고 snapshot/report pipeline을 검증한다. GitHub App, inbound webhook, 공개 domain은 사용하지 않는다. 관리자가 등록한 GitHub access token은 PostgreSQL에 암호화해 저장하고 Server의 REST polling과 Worker의 HTTPS Git fetch에만 사용한다.

UI는 `http://127.0.0.1:4181`에 port-forward하며 Keycloak과 model provider는 사용하지 않는다. Development authentication은 모든 요청을 local administrator로 처리하므로 외부 네트워크에 노출하지 않는다.

`kind-config.yaml`은 cgroup v1인 현재 Docker Desktop host와 호환되도록 kind `v0.32.0`에서 제공하는 Kubernetes `v1.34.8` ARM64/AMD64 node image digest를 고정한다. Kubernetes `v1.35` 이상은 cgroup v1에서 kubelet 실행을 거부하므로, host를 cgroup v2로 전환하기 전까지 이 버전을 유지한다.

테스트 대상은 [`pydemia/Python3` PR #8](https://github.com/pydemia/Python3/pull/8)이다. 변경 파일 1개, commit 1개의 작은 PR이므로 첫 연결 smoke test에 적합하다.

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

## 2. Build and load the application

현재 checkout을 host architecture용으로 build하고 kind의 containerd에 적재한다.

```bash
docker build \
  --build-arg VERSION=kind \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  -t git-code-reviewer:kind .

kind load docker-image git-code-reviewer:kind \
  --name git-code-reviewer
```

## 3. Create namespace and secrets

Credential registry Secret에는 GitHub token이 아니라 PostgreSQL credential row를 암호화하는 32-byte master key만 저장한다. 이 key를 잃으면 등록된 token을 복호화할 수 없으므로 실제 운영환경에서는 별도 secret manager로 보관한다.

```bash
export KUBE_CONTEXT=kind-git-code-reviewer
export NAMESPACE=git-code-reviewer
export POSTGRES_USER_PASSWORD="$(openssl rand -base64 36)"
export POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 36)"
export CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"

kubectl --context "$KUBE_CONTEXT" apply \
  -f deploy/environments/kind/namespace.yaml

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  create secret generic git-code-reviewer-postgresql-auth \
  --from-literal=password="$POSTGRES_USER_PASSWORD" \
  --from-literal=postgres-password="$POSTGRES_ADMIN_PASSWORD" \
  --dry-run=client -o yaml \
  | kubectl --context "$KUBE_CONTEXT" apply -f -

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  create secret generic git-code-reviewer-credential-registry \
  --from-literal=CREDENTIAL_ENCRYPTION_KEY="$CREDENTIAL_ENCRYPTION_KEY" \
  --dry-run=client -o yaml \
  | kubectl --context "$KUBE_CONTEXT" apply -f -

unset POSTGRES_USER_PASSWORD POSTGRES_ADMIN_PASSWORD CREDENTIAL_ENCRYPTION_KEY
```

## 4. Deploy

```bash
helm lint deploy/helm/git-code-reviewer \
  -f deploy/environments/kind/values.yaml

helm upgrade --install git-code-reviewer \
  deploy/helm/git-code-reviewer \
  --kube-context "$KUBE_CONTEXT" \
  -n "$NAMESPACE" \
  -f deploy/environments/kind/values.yaml \
  --rollback-on-failure --wait --timeout 20m
```

## 5. Access the UI

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  get pod,pvc,job

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  port-forward svc/git-code-reviewer 4181:80
```

다른 terminal에서 health를 확인하고 `http://127.0.0.1:4181/admin?tab=github`을 연다.

```bash
curl -fsS http://127.0.0.1:4181/health/live
curl -fsS http://127.0.0.1:4181/health/ready
curl -fsS http://127.0.0.1:4181/health/dependencies | jq
```

## 6. Issue a read-only token

GitHub.com의 fine-grained personal access token을 `pydemia/Python3` 하나에만 허용하고 다음 Repository permissions를 부여한다.

- Metadata: Read-only
- Contents: Read-only
- Pull requests: Read-only

Metadata는 repository 확인, Pull requests는 open PR polling, Contents는 exact commit의 HTTPS Git fetch에 사용한다. Webhook, Admin, write와 workflow 권한은 필요하지 않다. Token 원문은 values 파일, shell command, Kubernetes Secret 또는 Git URL에 넣지 않는다.

## 7. Register pydemia/Python3

`http://127.0.0.1:4181/admin?tab=github`에서 다음 순서로 등록한다.

1. GHES connection에 이름 `GitHub.com`, API base URL `https://api.github.com/`, Web base URL `https://github.com/`을 입력한다.
2. Credential label에는 `pydemia-python3-readonly`를 입력하고 access token 원문을 한 번만 입력한다.
3. 연결을 저장한 뒤 `연결 테스트`를 실행한다.
4. Repository에서 Default tenant, 위 연결, owner `pydemia`, repository `Python3`, polling interval `30`초를 선택해 등록한다.
5. `Poll now`를 실행하고 worklist에서 PR #8을 연다.

등록 직후 또는 최대 약 45초 안에 PR #8이 worklist에 나타나고 최초 snapshot 분석이 enqueue된다.

```bash
kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  logs -l app.kubernetes.io/component=server --since=10m

kubectl --context "$KUBE_CONTEXT" -n "$NAMESPACE" \
  logs -l app.kubernetes.io/component=worker --since=10m -f
```

## 8. Remove

```bash
kind delete cluster --name git-code-reviewer
```

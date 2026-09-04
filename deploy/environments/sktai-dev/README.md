# SKTAI-DEV deployment

이 폴더는 application domain과 TLS Ingress가 없는 `SKTAI-DEV`에서 GitHub Enterprise Server polling과 분석 pipeline을 검증하기 위한 Helm 환경 overlay다. Browser UI는 `kubectl port-forward`로만 열고, bundled PostgreSQL을 사용한다.

Development authentication은 접속자를 `SKTAI-DEV Administrator`로 처리한다. 공유 URL, Ingress, LoadBalancer 또는 운영 데이터와 함께 사용하지 않는다.

## Files

| File                        | Purpose                                                  |
| --------------------------- | -------------------------------------------------------- |
| `namespace.yaml`            | 전용 `git-code-reviewer` namespace                       |
| `values.yaml`               | Git에 저장하는 SKTAI-DEV 공통 Helm values                |
| `values.local.example.yaml` | StorageClass와 CA처럼 cluster마다 달라지는 override 예시 |
| `values.local.yaml`         | 실제 override. `.gitignore` 대상                         |

Secret 값과 credential encryption key는 이 디렉터리에 커밋하지 않는다. GHES access token은 Kubernetes Secret이나 values가 아니라 Admin credential registry에서 입력한다.

## 1. Preflight

```bash
kubectl config use-context SKTAI-DEV
kubectl --request-timeout=10s get nodes
kubectl get storageclass
```

Artifact volume에는 `ReadWriteMany`를 제공하는 StorageClass가 필요하고 PostgreSQL에는 `ReadWriteOnce` block StorageClass가 필요하다.

## 2. Local override

```bash
cp deploy/environments/sktai-dev/values.local.example.yaml \
  deploy/environments/sktai-dev/values.local.yaml
${EDITOR:-vi} deploy/environments/sktai-dev/values.local.yaml
```

`REPLACE_WITH_RWX_STORAGE_CLASS`와 `REPLACE_WITH_RWO_STORAGE_CLASS`를 Preflight에서 확인한 실제 이름으로 교체한다.

GHES 인증서가 사내 CA를 사용하면 CA 파일을 ConfigMap으로 등록한 뒤 `trustedCa.existingConfigMap: corporate-ca`도 설정한다. IP로 GHES에 접근할 때 인증서 SAN에 그 IP가 포함되어 있어야 한다.

## 3. Namespace and secrets

```bash
export NAMESPACE=git-code-reviewer
export POSTGRES_USER_PASSWORD="$(openssl rand -base64 36)"
export POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 36)"
export CREDENTIAL_ENCRYPTION_KEY="$(openssl rand -base64 32)"

kubectl apply -f deploy/environments/sktai-dev/namespace.yaml

kubectl -n "$NAMESPACE" create secret generic git-code-reviewer-credential-registry \
  --from-literal=CREDENTIAL_ENCRYPTION_KEY="$CREDENTIAL_ENCRYPTION_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic git-code-reviewer-postgresql-auth \
  --from-literal=password="$POSTGRES_USER_PASSWORD" \
  --from-literal=postgres-password="$POSTGRES_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

unset POSTGRES_USER_PASSWORD POSTGRES_ADMIN_PASSWORD CREDENTIAL_ENCRYPTION_KEY
```

사내 CA를 사용하는 경우에만 다음 ConfigMap을 추가한다.

```bash
kubectl -n "$NAMESPACE" create configmap corporate-ca \
  --from-file=ca.crt=/secure/path/corporate-ca.pem \
  --dry-run=client -o yaml | kubectl apply -f -
```

## 4. Validate and install

Repository checkout의 local chart를 먼저 검증한다.

```bash
helm dependency build deploy/helm/git-code-reviewer
helm lint deploy/helm/git-code-reviewer \
  -f deploy/environments/sktai-dev/values.yaml \
  -f deploy/environments/sktai-dev/values.local.yaml

helm template git-code-reviewer deploy/helm/git-code-reviewer \
  -n "$NAMESPACE" \
  -f deploy/environments/sktai-dev/values.yaml \
  -f deploy/environments/sktai-dev/values.local.yaml \
  > /tmp/git-code-reviewer-sktai-dev.yaml
```

OCI chart `0.7.1`을 설치한다.

```bash
helm upgrade --install git-code-reviewer \
  oci://registry-1.docker.io/pydemia/git-code-reviewer \
  --version 0.7.1 \
  -n "$NAMESPACE" \
  -f deploy/environments/sktai-dev/values.yaml \
  -f deploy/environments/sktai-dev/values.local.yaml \
  --rollback-on-failure --wait --timeout 20m
```

## 5. Verify and access

```bash
kubectl -n "$NAMESPACE" get pod,pvc,job
kubectl -n "$NAMESPACE" rollout status deploy/git-code-reviewer-server
kubectl -n "$NAMESPACE" rollout status deploy/git-code-reviewer-worker
helm test git-code-reviewer -n "$NAMESPACE"

kubectl -n "$NAMESPACE" port-forward svc/git-code-reviewer 8080:80
```

다른 terminal에서 확인한다.

```bash
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS http://127.0.0.1:8080/health/dependencies | jq
```

Browser UI는 `http://127.0.0.1:8080/admin?tab=github`에서 연다. Read-only PAT 등록, 연결 테스트, repository 등록과 PR polling 확인은 [private GHES test guide](../../../docs/operations/github-enterprise-test.md)를 따른다.

## 6. Upgrade and remove

동일 values로 chart를 갱신한다.

```bash
helm upgrade git-code-reviewer \
  oci://registry-1.docker.io/pydemia/git-code-reviewer \
  --version 0.7.1 \
  -n "$NAMESPACE" \
  -f deploy/environments/sktai-dev/values.yaml \
  -f deploy/environments/sktai-dev/values.local.yaml \
  --rollback-on-failure --wait --timeout 20m
```

Pilot을 완전히 제거할 때에는 release와 namespace를 삭제한다. Namespace 삭제는 PostgreSQL과 artifact PVC의 데이터도 제거한다.

```bash
helm uninstall git-code-reviewer -n "$NAMESPACE"
kubectl delete -f deploy/environments/sktai-dev/namespace.yaml
```

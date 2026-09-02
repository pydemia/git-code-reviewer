# Kubernetes deployment

## Runtime topology

하나의 immutable OCI image가 네 command를 제공한다.

| Workload           | Command     | Responsibility                                                |
| ------------------ | ----------- | ------------------------------------------------------------- |
| Server Deployment  | `serve`     | bundled browser UI, REST/SSE, auth, polling, interactive Chat |
| Worker Deployment  | `worker`    | isolated Git fetch, snapshot, deterministic/model analysis    |
| Migration hook Job | `migrate`   | advisory-lock protected forward migration                     |
| Retention CronJob  | `retention` | bounded expiry and artifact cleanup                           |

Frontend는 Server가 제공하는 정적 asset으로 image에 포함된다. 별도 frontend/backend image를 조합하지 않는다. PostgreSQL은 chart 밖의 별도 서비스이고, artifact는 여러 replica가 공유하는 RWX PV/PVC에 저장한다.

## Build and publish the image

Release image는 amd64/arm64 manifest, BuildKit provenance와 SBOM을 함께 게시한다. `latest` 대신 version과 source revision tag를 사용한다.

```bash
export VERSION=0.1.0-alpha.1
export REVISION="$(git rev-parse HEAD)"

docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --build-arg VERSION="$VERSION" \
  --build-arg REVISION="$REVISION" \
  --provenance=true --sbom=true \
  -t "docker.io/pydemia/git-code-reviewer:$VERSION" \
  -t "docker.io/pydemia/git-code-reviewer:sha-${REVISION:0:12}" \
  --push .

docker buildx imagetools inspect "docker.io/pydemia/git-code-reviewer:$VERSION"
```

운영 values에는 위 inspect 결과의 manifest digest를 `image.digest`로 넣는다. 조직에서 Cosign keyless 또는 KMS key를 승인한 경우 같은 digest를 서명하고 admission policy로 검증한다.

```bash
cosign sign "docker.io/pydemia/git-code-reviewer@sha256:..."
cosign verify "docker.io/pydemia/git-code-reviewer@sha256:..."
```

## Prerequisites

- Kubernetes 1.29 이상과 Helm 3
- 외부 PostgreSQL 15 이상, TLS와 backup 설정
- RWX를 제공하는 StorageClass 또는 기존 PVC
- TLS Ingress와 OIDC provider
- private GHES에서 설치된 read-only GitHub App
- 선택 사항: 승인된 OpenAI-compatible batch/Chat model endpoint

Pre-install migration은 일반 chart resource보다 먼저 실행되므로 DB Secret과 corporate CA ConfigMap은 설치 전에 존재해야 한다. Helm hook lifecycle은 [Helm chart hooks](https://helm.sh/docs/topics/charts_hooks/)를 참고한다.

## Prepare namespace and secrets

```bash
kubectl create namespace git-code-reviewer

kubectl -n git-code-reviewer create secret generic git-code-reviewer-db \
  --from-literal=DATABASE_URL='postgresql://USER:PASSWORD@postgres.example.internal:5432/git_code_reviewer?sslmode=require'

kubectl -n git-code-reviewer create secret generic git-code-reviewer-github-app \
  --from-literal=APP_ID='12345' \
  --from-file=PRIVATE_KEY=./github-app-private-key.pem

kubectl -n git-code-reviewer create secret generic git-code-reviewer-auth \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=OIDC_ISSUER='https://id.example.internal/realms/company' \
  --from-literal=OIDC_CLIENT_ID='git-code-reviewer' \
  --from-literal=OIDC_CLIENT_SECRET='...' \
  --from-literal=OIDC_REDIRECT_URI='https://git-code-reviewer.example.internal/auth/callback' \
  --from-literal=OIDC_ADMIN_GROUP='git-code-reviewer-admins'
```

내부 CA가 필요하면 기존 trust bundle로 ConfigMap을 만든다. TLS 검증을 끄는 설정은 사용하지 않는다.

```bash
kubectl -n git-code-reviewer create configmap corporate-ca --from-file=ca.crt=./corporate-ca.pem
```

Model을 활성화할 때에만 component별 Secret을 만든다. 분석 key는 Worker에만, Chat key는 Server에만 mount된다.

```bash
kubectl -n git-code-reviewer create secret generic git-code-reviewer-model \
  --from-literal=API_KEY='...'
kubectl -n git-code-reviewer create secret generic git-code-reviewer-chat-model \
  --from-literal=API_KEY='...'
```

## Configure values

[`values.enterprise.example.yaml`](../../deploy/helm/git-code-reviewer/values.enterprise.example.yaml)을 환경 파일로 복제하고 다음 값을 확정한다.

- `image.digest`: pilot 이후에는 mutable tag 대신 registry digest 권장
- `publicBaseUrl`, Ingress host/TLS/controller annotations
- RWX StorageClass, artifact 용량, Worker ephemeral workspace 용량
- DB/Auth/GitHub/Model Secret 이름
- 분석과 Chat의 endpoint 및 **명시적인 model name**
- retention 기간. `chatDays`는 `reportDays`보다 클 수 없다.
- NetworkPolicy를 켤 경우 DB, GHES, OIDC, model endpoint의 실제 CIDR egress. values 예시의 documentation CIDR을 그대로 사용하지 않는다.
- private registry를 사용할 경우 모든 Server/Worker/migration/retention Pod에 적용할 `imagePullSecrets`

Gemini를 사용할 경우 model 목록 조회와 최소 Chat Completions 호출을 먼저 수행한다. model name 자동 선택은 하지 않으며 endpoint에서 제공하지 않는 이름이면 Server/Worker provider call이 실패한다. [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

## Validate and install

```bash
helm lint deploy/helm/git-code-reviewer -f values.enterprise.yaml
helm template git-code-reviewer deploy/helm/git-code-reviewer \
  -n git-code-reviewer -f values.enterprise.yaml > rendered.yaml

helm upgrade --install git-code-reviewer deploy/helm/git-code-reviewer \
  -n git-code-reviewer -f values.enterprise.yaml \
  --atomic --wait --timeout 20m
```

```bash
kubectl -n git-code-reviewer get deploy,pod,job,cronjob,pvc,ingress
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-server
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-worker
helm test git-code-reviewer -n git-code-reviewer
```

Server artifact mount는 read-only이고 Worker/retention만 write할 수 있어야 한다. Pod는 non-root, read-only root filesystem, dropped capabilities, disabled service-account token으로 실행된다.

## Upgrade and rollback

새 image는 먼저 digest로 고정하고 migration Job log를 확인한다.

```bash
helm upgrade git-code-reviewer deploy/helm/git-code-reviewer \
  -n git-code-reviewer -f values.enterprise.yaml \
  --set image.digest='sha256:...' --atomic --wait --timeout 20m

kubectl -n git-code-reviewer logs job/git-code-reviewer-migrate-REVISION
helm history git-code-reviewer -n git-code-reviewer
```

Migration은 forward-only additive contract다. application rollback 전에 이전 image가 현재 DB schema를 읽을 수 있는지 확인한다. 호환되는 경우에만 `helm rollback`을 사용한다.

```bash
helm rollback git-code-reviewer REVISION -n git-code-reviewer --wait --timeout 20m
```

## Operational checks

```bash
kubectl -n git-code-reviewer port-forward svc/git-code-reviewer 8080:80
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS http://127.0.0.1:8080/health/dependencies
```

로그에는 source, diff, prompt, Chat 원문, token이 없어야 한다. Database pool 상한은 `(server replicas x pool) + (worker replicas x pool) + migration/retention/LISTEN 여유`로 계산한다.

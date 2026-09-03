# Kubernetes deployment

## Runtime topology

하나의 immutable OCI image가 네 command를 제공한다.

| Workload           | Command     | Responsibility                                                |
| ------------------ | ----------- | ------------------------------------------------------------- |
| Server Deployment  | `serve`     | bundled browser UI, REST/SSE, auth, polling, interactive Chat |
| Worker Deployment  | `worker`    | isolated Git fetch, snapshot, deterministic/model analysis    |
| Migration hook Job | `migrate`   | advisory-lock protected forward migration                     |
| Retention CronJob  | `retention` | bounded expiry and artifact cleanup                           |

Frontend는 Server가 제공하는 정적 asset으로 image에 포함된다. 별도 frontend/backend image를 조합하지 않는다. PostgreSQL은 운영형 외부 서비스가 기본이며, pilot에서는 선택형 Bitnami PostgreSQL dependency를 같은 release에 설치할 수 있다. Artifact는 여러 replica가 공유하는 RWX PV/PVC에 저장한다.

## Build and publish the image

Release image는 amd64/arm64 manifest, BuildKit provenance와 SBOM을 함께 게시한다. `latest` 대신 version과 source revision tag를 사용한다.

```bash
export VERSION=0.3.0-alpha.1
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

Helm chart도 같은 Docker Hub 계정의 OCI artifact로 게시한다. Image와 chart가 같은 repository를 사용하므로 tag 충돌을 피하기 위해 image tag는 `0.3.0-alpha.1`, chart version tag는 `0.3.0`을 사용한다. Docker Hub는 같은 repository에 container image와 Helm chart 같은 OCI artifact를 함께 저장할 수 있다. [Docker Hub OCI artifacts](https://docs.docker.com/docker-hub/repos/manage/hub-images/oci-artifacts/)

```bash
helm registry login registry-1.docker.io -u pydemia
helm dependency build deploy/helm/git-code-reviewer
helm package deploy/helm/git-code-reviewer --destination dist/helm
helm push dist/helm/git-code-reviewer-0.3.0.tgz \
  oci://registry-1.docker.io/pydemia
helm show chart \
  oci://registry-1.docker.io/pydemia/git-code-reviewer \
  --version 0.3.0
```

OCI push 대상에는 chart 이름과 tag를 붙이지 않는다. Helm이 `Chart.yaml`의 name/version으로 이를 결정한다. [Helm OCI registry](https://helm.sh/docs/topics/registries/)

## Prerequisites

- Kubernetes 1.29 이상과 Helm 3
- 외부 PostgreSQL 15 이상 또는 chart의 선택형 Bitnami PostgreSQL dependency
- RWX를 제공하는 StorageClass 또는 기존 PVC
- TLS Ingress와 OIDC provider
- private GHES에서 설치된 read-only GitHub App
- 선택 사항: 승인된 OpenAI-compatible batch/Chat model endpoint 또는 deployment-owned ChatGPT/Codex account

외부 DB 모드의 pre-install migration은 일반 chart resource보다 먼저 실행되므로 DB Secret과 corporate CA ConfigMap은 설치 전에 존재해야 한다. 번들 DB 모드는 PostgreSQL resource 생성 후 Server/Worker init container가 advisory lock 아래 최초 migration을 수행하고, 이후 upgrade에서는 pre-upgrade hook도 실행한다. Helm hook lifecycle은 [Helm chart hooks](https://helm.sh/docs/topics/charts_hooks/)를 참고한다.

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

위 `git-code-reviewer-db` Secret은 기본 외부 DB 모드에서만 필요하다. 자체 포함 pilot은 다음 values로 Bitnami PostgreSQL과 RWO PVC를 같은 release에 설치한다.

```yaml
database:
  existingSecret: ''

postgresql:
  enabled: true
  auth:
    username: git_code_reviewer
    database: git_code_reviewer
  primary:
    persistence:
      enabled: true
      storageClass: block-storage
      size: 20Gi
```

비밀번호를 chart가 생성하게 두면 `${RELEASE_NAME}-postgresql` Secret의 `password` key를 application Pod에 파일로 마운트한다. 기존 Secret을 사용하려면 `postgresql.auth.existingSecret`을 지정하고 `password`, `postgres-password` key를 준비한다. 평문 `postgresql.auth.password`를 Git이나 환경 values 파일에 기록하지 않는다.

```bash
kubectl -n git-code-reviewer create secret generic git-code-reviewer-postgresql-auth \
  --from-literal=password="$POSTGRES_USER_PASSWORD" \
  --from-literal=postgres-password="$POSTGRES_ADMIN_PASSWORD"
```

```yaml
postgresql:
  enabled: true
  auth:
    existingSecret: git-code-reviewer-postgresql-auth
```

번들 DB는 간단한 pilot과 단일 cluster 운영을 위한 선택지다. 운영 환경에서는 조직의 backup, HA, TLS, monitoring 기준을 충족하는 외부 PostgreSQL을 우선한다. Dependency chart `18.8.14`는 PostgreSQL `18.6` image를 사용하므로 chart major version을 올릴 때에는 PostgreSQL major upgrade 절차와 PV backup/restore를 먼저 검증한다. [Bitnami PostgreSQL chart](https://github.com/bitnami/charts/tree/main/bitnami/postgresql)

Docker Hub repository가 private이면 같은 계정의 access token으로 Kubernetes image pull Secret을 만든다. Docker Desktop의 `config.json`이 credential helper만 참조하는 경우 그 파일 자체를 Secret으로 복사하면 cluster에서 동작하지 않는다.

```bash
kubectl -n git-code-reviewer create secret docker-registry dockerhub-registry \
  --docker-server=https://index.docker.io/v1/ \
  --docker-username=pydemia \
  --docker-password="$DOCKERHUB_TOKEN"
```

`values.enterprise.yaml`에는 모든 Server/Worker/migration/retention Pod가 같은 Secret을 사용하도록 설정한다.

```yaml
imagePullSecrets:
  - name: dockerhub-registry
```

내부 CA가 필요하면 기존 trust bundle로 ConfigMap을 만든다. TLS 검증을 끄는 설정은 사용하지 않는다.

```bash
kubectl -n git-code-reviewer create configmap corporate-ca --from-file=ca.crt=./corporate-ca.pem
```

OpenAI-compatible model을 활성화할 때에만 component별 Secret을 만든다. 분석 key는 Worker에만, Chat key는 Server에만 mount된다.

```bash
kubectl -n git-code-reviewer create secret generic git-code-reviewer-model \
  --from-literal=API_KEY='...'
kubectl -n git-code-reviewer create secret generic git-code-reviewer-chat-model \
  --from-literal=API_KEY='...'
```

### ChatGPT account mode

API key 대신 ChatGPT/Codex account로 Review Chat을 실행할 수 있다. 이 mode는 Demian의 Codex provider와 같은 방식으로 `codex login`이 만든 account token을 사용하고, Codex Responses stream을 Server에서 호출한다. 모든 application 사용자가 하나의 deployment-owned account quota를 공유하므로 개인 계정보다 조직이 승인한 전용 account를 권장한다. OpenAI는 Codex에서 ChatGPT subscription login과 API key login을 별도 방식으로 제공한다. [OpenAI Codex authentication](https://learn.chatgpt.com/docs/auth)

cluster 외부의 보안 관리 terminal에서 로그인하고 `auth.json`을 Secret으로 등록한다. Secret 원문을 values나 Git에 넣지 않는다.

```bash
export ACCOUNT_CODEX_HOME="$HOME/.codex-git-code-reviewer"
CODEX_HOME="$ACCOUNT_CODEX_HOME" codex login --device-auth
CODEX_HOME="$ACCOUNT_CODEX_HOME" codex login status

kubectl -n git-code-reviewer create secret generic git-code-reviewer-chatgpt-account \
  --from-file=auth.json="$ACCOUNT_CODEX_HOME/auth.json"
```

ChatGPT account mode는 refresh token 회전 결과를 보존해야 하므로 Secret을 시작 seed로만 사용한다. Chart의 init container가 최초 설치나 `bootstrapRevision` 변경 시 전용 PVC로 account 파일을 복사하고, Server만 이 PVC를 read-write로 mount한다. Worker와 browser에는 mount하지 않는다.

```yaml
secrets:
  chatgptAccount: git-code-reviewer-chatgpt-account

model:
  chat:
    mode: chatgpt-account
    endpoint: '' # 기본값: https://chatgpt.com/backend-api/codex/
    name: gpt-5.6-sol
    account:
      authFileKey: auth.json
      bootstrapRevision: initial
      home: /var/lib/git-code-reviewer/chatgpt-account
      refreshEndpoint: https://auth.openai.com/oauth/token
      proactiveRefreshMinutes: 5
      persistence:
        existingClaim: ''
        storageClass: rwx-storage
        accessModes: [ReadWriteMany]
        size: 1Gi
```

account에서 로그아웃했거나 refresh token이 폐기되면 관리 terminal에서 다시 로그인하고 Secret을 갱신한다. 그다음 `bootstrapRevision`을 이전과 다른 불투명 값으로 변경하여 Helm upgrade한다. 동일 revision의 일반 Pod restart는 PVC의 갱신된 token을 Secret의 오래된 seed로 덮어쓰지 않는다.

```bash
kubectl -n git-code-reviewer create secret generic git-code-reviewer-chatgpt-account \
  --from-file=auth.json="$ACCOUNT_CODEX_HOME/auth.json" \
  --dry-run=client -o yaml | kubectl apply -f -

helm upgrade git-code-reviewer deploy/helm/git-code-reviewer \
  -n git-code-reviewer -f values.enterprise.yaml \
  --set-string model.chat.account.bootstrapRevision="$(date -u +%Y%m%dT%H%M%SZ)" \
  --atomic --wait --timeout 20m
```

account PVC에는 access/refresh token이 포함되므로 encrypted StorageClass, namespace RBAC 제한과 backup 제외 정책을 적용한다. PVC를 복구하거나 복제할 때에는 account token도 함께 복제된다는 점을 보안 검토에 포함한다. NetworkPolicy 사용 시 `chatgpt.com:443`과 `auth.openai.com:443`으로 해석되는 조직 승인 egress를 추가한다.

이 provider는 공개 OpenAI API가 아니라 Codex account transport와의 Demian-compatible integration이다. Codex 인증 또는 endpoint contract가 바뀔 수 있으므로 image upgrade 전에 account smoke test를 실행하고, 장기 운영에서는 조직의 ChatGPT workspace 정책과 전용 service account 제공 여부를 함께 검토한다.

## Configure values

[`values.enterprise.example.yaml`](../../deploy/helm/git-code-reviewer/values.enterprise.example.yaml)을 환경 파일로 복제하고 다음 값을 확정한다.

- `image.digest`: pilot 이후에는 mutable tag 대신 registry digest 권장
- `publicBaseUrl`, Ingress host/TLS/controller annotations
- RWX StorageClass, artifact 용량, Worker ephemeral workspace 용량
- DB/Auth/GitHub/Model Secret 이름
- `postgresql.enabled`: 외부 DB는 `false`, 자체 포함 pilot은 `true`; 번들 모드에서는 DB PVC StorageClass와 용량
- 분석과 Chat의 provider mode 및 **명시적인 model name**. ChatGPT account mode이면 account Secret, bootstrap revision과 전용 PVC
- retention 기간. `chatDays`는 `reportDays`보다 클 수 없다.
- NetworkPolicy를 켤 경우 DB, GHES, OIDC, model endpoint의 실제 CIDR egress. values 예시의 documentation CIDR을 그대로 사용하지 않는다.
- private registry를 사용할 경우 모든 Server/Worker/migration/retention Pod에 적용할 `imagePullSecrets`

Gemini를 사용할 경우 model 목록 조회와 최소 Chat Completions 호출을 먼저 수행한다. model name 자동 선택은 하지 않으며 endpoint에서 제공하지 않는 이름이면 Server/Worker provider call이 실패한다. [Gemini OpenAI compatibility](https://ai.google.dev/gemini-api/docs/openai)

## Validate and install

```bash
helm dependency build deploy/helm/git-code-reviewer
helm lint deploy/helm/git-code-reviewer -f values.enterprise.yaml
helm template git-code-reviewer deploy/helm/git-code-reviewer \
  -n git-code-reviewer -f values.enterprise.yaml > rendered.yaml

helm upgrade --install git-code-reviewer deploy/helm/git-code-reviewer \
  -n git-code-reviewer -f values.enterprise.yaml \
  --atomic --wait --timeout 20m
```

Source checkout 없이 Docker Hub의 chart를 직접 설치할 수도 있다. 먼저 `helm registry login`을 완료해야 한다.

```bash
helm upgrade --install git-code-reviewer \
  oci://registry-1.docker.io/pydemia/git-code-reviewer \
  --version 0.3.0 \
  -n git-code-reviewer -f values.enterprise.yaml \
  --atomic --wait --timeout 20m
```

```bash
kubectl -n git-code-reviewer get deploy,pod,job,cronjob,pvc,ingress
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-server
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-worker
helm test git-code-reviewer -n git-code-reviewer
```

Server artifact mount는 read-only이고 Worker/retention만 write할 수 있어야 한다. ChatGPT account mode의 Server에는 별도 account PVC만 write 권한을 준다. Pod는 non-root, read-only root filesystem, dropped capabilities, disabled service-account token으로 실행된다.

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

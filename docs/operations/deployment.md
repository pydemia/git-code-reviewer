# Kubernetes deployment

## Runtime topology

하나의 immutable OCI image가 네 command를 제공한다.

| Workload           | Command     | Responsibility                                                |
| ------------------ | ----------- | ------------------------------------------------------------- |
| Server Deployment  | `serve`     | bundled browser UI, REST/SSE, auth, polling, interactive Chat |
| Worker Deployment  | `worker`    | isolated Git fetch, snapshot, deterministic/model analysis    |
| Migration hook Job | `migrate`   | advisory-lock protected forward migration                     |
| Retention CronJob  | `retention` | bounded expiry and artifact cleanup                           |

Frontend는 Server가 제공하는 정적 asset으로 image에 포함된다. 별도 frontend/backend image를 조합하지 않는다. PostgreSQL은 운영형 외부 서비스가 기본이며, pilot에서는 선택형 Bitnami PostgreSQL dependency를 같은 release에 설치할 수 있다. Artifact는 여러 replica가 공유하는 RWX PV/PVC에 저장한다. OIDC는 기존 사내 provider를 연결하거나 선택형 Bitnami Keycloak dependency를 함께 설치할 수 있고, Cerbos PDP도 chart에서 선택적으로 배포할 수 있다.

## Build and publish the image

Release image는 amd64/arm64 manifest, BuildKit provenance와 SBOM을 함께 게시한다. `latest` 대신 version과 source revision tag를 사용한다.

```bash
export VERSION=0.7.0-alpha.3
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

Build network가 Alpine package mirror의 TLS chain을 검증하지 못하지만 직전 승인 image를 pull할 수
있는 환경에서는 직전 image를 runtime base로 재사용할 수 있다. Build stage는 현재 source에서 다시
생성하며, runtime base에 이미 설치된 `git`과 `tini`만 재사용한다.

```bash
docker buildx build \
  --build-arg RUNTIME_BASE="docker.io/pydemia/git-code-reviewer@sha256:<previous-digest>" \
  --build-arg REUSE_RUNTIME_BASE=true \
  --build-arg VERSION="$VERSION" \
  --build-arg REVISION="$REVISION" \
  --platform linux/amd64 --push .
```

운영 values에는 위 inspect 결과의 manifest digest를 `image.digest`로 넣는다. 조직에서 Cosign keyless 또는 KMS key를 승인한 경우 같은 digest를 서명하고 admission policy로 검증한다.

```bash
cosign sign "docker.io/pydemia/git-code-reviewer@sha256:..."
cosign verify "docker.io/pydemia/git-code-reviewer@sha256:..."
```

Helm chart도 같은 Docker Hub 계정의 OCI artifact로 게시한다. Image와 chart가 같은 repository를 사용하므로 tag 충돌을 피하기 위해 image tag는 `0.7.0-alpha.3`, chart version tag는 `0.8.2`을 사용한다. Docker Hub는 같은 repository에 container image와 Helm chart 같은 OCI artifact를 함께 저장할 수 있다. [Docker Hub OCI artifacts](https://docs.docker.com/docker-hub/repos/manage/hub-images/oci-artifacts/)

```bash
helm registry login registry-1.docker.io -u pydemia
helm dependency build deploy/helm/git-code-reviewer
helm package deploy/helm/git-code-reviewer --destination dist/helm
helm push dist/helm/git-code-reviewer-0.7.1.tgz \
  oci://registry-1.docker.io/pydemia
helm show chart \
  oci://registry-1.docker.io/pydemia/git-code-reviewer \
  --version 0.7.1
```

OCI push 대상에는 chart 이름과 tag를 붙이지 않는다. Helm이 `Chart.yaml`의 name/version으로 이를 결정한다. [Helm OCI registry](https://helm.sh/docs/topics/registries/)

## Prerequisites

- Kubernetes 1.29 이상과 Helm 3
- 외부 PostgreSQL 15 이상 또는 chart의 선택형 Bitnami PostgreSQL dependency
- RWX를 제공하는 StorageClass 또는 기존 PVC
- TLS Ingress와 외부 OIDC provider 또는 chart의 선택형 Bitnami Keycloak dependency
- 선택형 bundled Keycloak을 사용할 경우 Keycloak용 TLS 인증서와 RWO StorageClass
- 외부 또는 bundled OIDC client와 선택형 Cerbos PDP
- private GHES에서 설치된 read-only GitHub App
- 선택 사항: 승인된 OpenAI-compatible batch/Chat model endpoint 또는 deployment-owned ChatGPT/Codex account

외부 DB 모드의 pre-install migration은 일반 chart resource보다 먼저 실행되므로 DB Secret과 corporate CA ConfigMap은 설치 전에 존재해야 한다. 번들 DB 모드는 PostgreSQL resource 생성 후 Server/Worker init container가 advisory lock 아래 최초 migration을 수행하고, 이후 upgrade에서는 pre-upgrade hook도 실행한다. Helm hook lifecycle은 [Helm chart hooks](https://helm.sh/docs/topics/charts_hooks/)를 참고한다.

## Domain-free GHES pilot

DNS와 TLS Ingress를 준비하기 전에는 development authentication, bundled PostgreSQL, `kubectl port-forward`를 조합해 한정된 pilot을 실행할 수 있다. 이 mode에서는 요청자가 자동으로 administrator가 되므로 Ingress와 외부 Service를 열지 않고 운영 데이터가 없는 격리된 namespace에서만 사용한다. GHES 연동은 Server와 Worker에서 GHES API/Git endpoint로 나가는 요청이므로 application용 public domain이나 inbound webhook이 필요하지 않다.

### 1. Check cluster access and storage

```bash
kubectl config current-context
kubectl --request-timeout=10s get nodes
kubectl get storageclass
```

Artifact PVC는 Server와 Worker가 함께 mount하므로 RWX StorageClass가 필요하다. Bundled PostgreSQL에는 일반 RWO block StorageClass를 사용한다. 두 class를 먼저 식별하지 못하면 설치를 진행하지 않는다.

### 2. Prepare pilot values

[`values.pilot-ip.example.yaml`](../../deploy/helm/git-code-reviewer/values.pilot-ip.example.yaml)을 Git 외부의 임시 파일로 복사하고 `rwx-storage`, `block-storage`를 앞에서 확인한 실제 StorageClass 이름으로 바꾼다.

```bash
cp deploy/helm/git-code-reviewer/values.pilot-ip.example.yaml \
  /tmp/git-code-reviewer-pilot.yaml
${EDITOR:-vi} /tmp/git-code-reviewer-pilot.yaml
```

이 profile은 Server/Worker를 각각 1개만 실행하고 model과 Chat을 비활성화한다. 먼저 deterministic report와 GHES polling을 검증한 뒤 provider를 연결한다.

### 3. Create the namespace and credentials

GitHub App에는 대상 repository만 설치하고 Metadata, Contents, Pull requests read-only 권한을 준다. App ID와 installation ID를 기록하고 private key PEM을 관리 terminal에 둔다.

```bash
export NAMESPACE=git-code-reviewer
export GITHUB_APP_ID='REPLACE_ME'
export GITHUB_APP_PRIVATE_KEY="$HOME/secure/git-code-reviewer.pem"
export POSTGRES_USER_PASSWORD="$(openssl rand -base64 36)"
export POSTGRES_ADMIN_PASSWORD="$(openssl rand -base64 36)"

kubectl create namespace "$NAMESPACE" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic git-code-reviewer-github-app \
  --from-literal=APP_ID="$GITHUB_APP_ID" \
  --from-file=PRIVATE_KEY="$GITHUB_APP_PRIVATE_KEY" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl -n "$NAMESPACE" create secret generic git-code-reviewer-postgresql-auth \
  --from-literal=password="$POSTGRES_USER_PASSWORD" \
  --from-literal=postgres-password="$POSTGRES_ADMIN_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

unset POSTGRES_USER_PASSWORD POSTGRES_ADMIN_PASSWORD
```

GHES가 사내 CA 인증서를 사용하면 CA bundle도 등록하고 pilot values의 `trustedCa.existingConfigMap`을 `corporate-ca`로 설정한다. IP URL을 사용할 때에는 인증서 SAN에 해당 IP가 있어야 한다.

```bash
kubectl -n "$NAMESPACE" create configmap corporate-ca \
  --from-file=ca.crt=./corporate-ca.pem \
  --dry-run=client -o yaml | kubectl apply -f -
```

### 4. Validate and install

```bash
helm dependency build deploy/helm/git-code-reviewer
helm lint deploy/helm/git-code-reviewer \
  -f /tmp/git-code-reviewer-pilot.yaml

helm upgrade --install git-code-reviewer deploy/helm/git-code-reviewer \
  -n "$NAMESPACE" \
  -f /tmp/git-code-reviewer-pilot.yaml \
  --atomic --wait --timeout 20m
```

OCI chart를 사용할 때에는 local chart 경로를 다음 주소와 version으로 교체한다.

```bash
helm upgrade --install git-code-reviewer \
  oci://registry-1.docker.io/pydemia/git-code-reviewer \
  --version 0.7.1 \
  -n "$NAMESPACE" \
  -f /tmp/git-code-reviewer-pilot.yaml \
  --atomic --wait --timeout 20m
```

### 5. Check rollout and health

```bash
kubectl -n "$NAMESPACE" get pod,pvc,job
kubectl -n "$NAMESPACE" rollout status deploy/git-code-reviewer-server
kubectl -n "$NAMESPACE" rollout status deploy/git-code-reviewer-worker
helm test git-code-reviewer -n "$NAMESPACE"

kubectl -n "$NAMESPACE" port-forward svc/git-code-reviewer 8080:80
```

다른 terminal에서 health와 browser UI를 확인한다.

```bash
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS http://127.0.0.1:8080/health/dependencies | jq
```

Browser에서는 `http://127.0.0.1:8080/admin`을 연다.

### 6. Register the GHES repository

GHES repository numeric ID와 GitHub App installation ID를 먼저 확인한다. Development administrator는 session cookie가 필요 없으므로 같은 port-forward를 통해 REST API를 호출할 수 있다.

```bash
export TENANT_ID="$(curl -fsS http://127.0.0.1:8080/api/v1/admin/tenants \
  | jq -r '.items[] | select(.slug == "default") | .id')"
export GHES_API_BASE_URL='https://10.20.30.40/api/v3/'
export GHES_WEB_BASE_URL='https://10.20.30.40/'
export GHES_REPOSITORY_ID='123456'
export GITHUB_INSTALLATION_ID='98765'
export REPOSITORY_OWNER='platform'
export REPOSITORY_NAME='reviewer-api'

jq -n \
  --arg tenantId "$TENANT_ID" \
  --arg apiBaseUrl "$GHES_API_BASE_URL" \
  --arg webBaseUrl "$GHES_WEB_BASE_URL" \
  --arg installationId "$GITHUB_INSTALLATION_ID" \
  --arg owner "$REPOSITORY_OWNER" \
  --arg name "$REPOSITORY_NAME" \
  --argjson githubId "$GHES_REPOSITORY_ID" \
  '{tenantId: $tenantId, instanceName: "Internal GHES", apiBaseUrl: $apiBaseUrl,
    webBaseUrl: $webBaseUrl, githubId: $githubId, installationId: $installationId,
    owner: $owner, name: $name, pollIntervalSeconds: 30}' \
  | curl -fsS http://127.0.0.1:8080/api/v1/admin/repositories \
      -H 'content-type: application/json' --data-binary @- | jq
```

등록 직후 polling 시각이 현재로 설정된다. 결과는 다음 API와 Server log에서 확인한다.

```bash
curl -fsS http://127.0.0.1:8080/api/v1/repositories | jq
kubectl -n "$NAMESPACE" logs -l app.kubernetes.io/component=server \
  --since=10m --all-containers=true
```

### 7. Trigger and verify analysis

대상 repository에 작은 PR을 만들거나 기존 PR에 commit을 push한다. 최대 polling interval과 scheduler tick을 합친 약 45초 안에 PR이 worklist에 나타나고, base/head SHA가 처음 관찰되거나 달라지면 분석 작업이 자동 enqueue된다.

```bash
kubectl -n "$NAMESPACE" logs -l app.kubernetes.io/component=worker \
  --since=10m --all-containers=true -f
```

Browser worklist에서 PR을 열어 snapshot, changed files, deterministic finding, graph와 report를 확인한다. 같은 head SHA에서 Refresh를 여러 번 눌러도 active operation은 하나로 deduplicate되어야 한다.

### 8. End the pilot

개발 인증 배포를 방치하지 않는다. 테스트가 끝나면 port-forward를 종료하고 release 또는 namespace를 제거한다.

```bash
helm uninstall git-code-reviewer -n "$NAMESPACE"
kubectl delete namespace "$NAMESPACE"
rm -f /tmp/git-code-reviewer-pilot.yaml
```

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
  --from-literal=OIDC_REDIRECT_URI='https://git-code-reviewer.example.internal/auth/callback'
```

위 형태는 외부 OIDC provider를 연결할 때 사용한다. Bundled Keycloak에서는 issuer/client/callback을 chart가 주입하므로 같은 이름의 Secret에 `SESSION_SECRET`, `OIDC_CLIENT_SECRET`만 둔다. Keycloak client role, app의 tenant membership과 Cerbos 정책 설정은 [Identity, authorization, and tenant administration](./identity-authorization.md)을 따른다.

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

### Bundled Keycloak

Enterprise values 예시는 Bitnami Keycloak chart `25.2.0`을 `keycloak.enabled=true`로 설치한다. Keycloak 2개 replica, TLS Ingress, 전용 PostgreSQL과 RWO PVC를 만들고 `keycloak-config-cli` Job이 다음 항목을 idempotent하게 구성한다.

- realm `git-code-reviewer`
- confidential OIDC client `git-code-reviewer`와 Authorization Code + PKCE `S256`
- 정확한 callback URI와 Web origin
- client role `git-code-reviewer-admin`
- ID/access/UserInfo token의 `groups` claim mapper

먼저 application session/client secret, Keycloak administrator, Keycloak PostgreSQL credential과 TLS Secret을 준비한다. 같은 `OIDC_CLIENT_SECRET`을 Server와 realm bootstrap Job이 읽지만 원문은 ConfigMap이나 values에 들어가지 않는다.

```bash
export OIDC_CLIENT_SECRET="$(openssl rand -base64 48)"
export KEYCLOAK_ADMIN_PASSWORD="$(openssl rand -base64 48)"
export KEYCLOAK_DB_PASSWORD="$(openssl rand -base64 48)"
export KEYCLOAK_DB_ADMIN_PASSWORD="$(openssl rand -base64 48)"

kubectl -n git-code-reviewer create secret generic git-code-reviewer-auth \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=OIDC_CLIENT_SECRET="$OIDC_CLIENT_SECRET"

kubectl -n git-code-reviewer create secret generic git-code-reviewer-keycloak \
  --from-literal=admin-password="$KEYCLOAK_ADMIN_PASSWORD"

kubectl -n git-code-reviewer create secret generic git-code-reviewer-keycloak-postgresql \
  --from-literal=password="$KEYCLOAK_DB_PASSWORD" \
  --from-literal=postgres-password="$KEYCLOAK_DB_ADMIN_PASSWORD"

kubectl -n git-code-reviewer create secret tls git-code-reviewer-keycloak-tls \
  --cert=./keycloak-tls.crt \
  --key=./keycloak-tls.key
```

환경의 두 public hostname을 values에 맞춘다. `issuer`는 browser뿐 아니라 Server Pod에서도 DNS/TLS로 접근 가능해야 한다.

```yaml
auth:
  mode: oidc
  adminRole: git-code-reviewer-admin

keycloak:
  enabled: true
  auth:
    existingSecret: git-code-reviewer-keycloak
    passwordSecretKey: admin-password
  ingress:
    enabled: true
    hostname: git-code-reviewer-id.example.internal
    ingressClassName: nginx
    tls: true
    extraTls:
      - hosts: [git-code-reviewer-id.example.internal]
        secretName: git-code-reviewer-keycloak-tls
  postgresql:
    enabled: true
    auth:
      existingSecret: git-code-reviewer-keycloak-postgresql
    primary:
      persistence:
        storageClass: block-storage
        size: 20Gi
  gitCodeReviewer:
    realm: git-code-reviewer
    issuer: https://git-code-reviewer-id.example.internal/realms/git-code-reviewer
    clientId: git-code-reviewer
    adminRole: git-code-reviewer-admin
    authSecret: git-code-reviewer-auth
    clientSecretKey: OIDC_CLIENT_SECRET
    redirectUri: https://git-code-reviewer.example.internal/auth/callback
    webOrigin: https://git-code-reviewer.example.internal
```

Chart validation은 bundled Keycloak과 `auth.mode=oidc`, app/admin role, auth Secret 이름, callback/origin, TLS Ingress와 Keycloak PostgreSQL 구성이 어긋나면 설치 전에 실패한다. Realm bootstrap은 사용자 계정을 만들지 않는다. 최초 로그인 전 Keycloak Admin Console에서 사용자를 생성하거나 사내 directory federation을 연결하고, 관리자에게만 `git-code-reviewer-admin` client role을 할당한다.

Bitnami가 2025년에 versioned community image를 `bitnami/*`에서 이동했기 때문에 OCI chart의 기본 image reference는 현재 pull되지 않는다. 이 chart의 기본 bundled 설정은 설치 가능성을 위해 정확한 기존 tag를 `bitnamilegacy/*`에서 사용하고 `global.security.allowInsecureImages=true`를 명시한다. Legacy image는 보안 update나 지원을 받지 않으므로 pilot 이후에는 조직이 검증·재빌드한 internal registry 또는 Bitnami Secure Images로 `keycloak.image`, config-cli와 Keycloak PostgreSQL의 image repository/digest를 교체해야 한다. [Bitnami catalog transition notice](https://github.com/bitnami/containers/issues/83267)

Bundled mode는 단일 release 설치 편의를 위한 선택지이지 identity 운영 책임을 없애지 않는다. Keycloak realm과 전용 DB를 application DB/PVC와 별도로 backup하고, chart 또는 Keycloak major upgrade 전에 realm export와 DB restore rehearsal을 수행한다. 이미 조직 OIDC가 있다면 `keycloak.enabled=false`로 두고 기존 provider를 사용하는 구성이 여전히 권장된다. [Bitnami Keycloak chart](https://github.com/bitnami/charts/tree/main/bitnami/keycloak)

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

OpenAI-compatible model을 환경 변수로 고정할 때 component별 Secret을 만든다. 관리자 Provider 설정을 켜면 분석 Secret에 별도의 32-byte master key도 준비한다. 분석 Secret은 Server와 Worker에, Chat key는 Server에만 주입되며 browser에는 반환되지 않는다.

```bash
kubectl -n git-code-reviewer create secret generic git-code-reviewer-model \
  --from-literal=API_KEY='...' \
  --from-literal=SETTINGS_ENCRYPTION_KEY="$(openssl rand -base64 32)"
kubectl -n git-code-reviewer create secret generic git-code-reviewer-chat-model \
  --from-literal=API_KEY='...'
```

### Analysis provider administration

Deployment 재배포 없이 분석 Provider와 model을 교체하려면 관리자 설정을 활성화한다. `allowedOrigins`는 관리자가 입력할 수 있는 endpoint의 exact origin이며 path는 포함하지 않는다. 여러 origin을 쓸 수 있지만 사내에서 승인한 대상만 등록한다.

```yaml
model:
  analysis:
    # 관리자 버전이 없거나 rollback하면 이 deployment 설정을 사용한다.
    mode: disabled
    endpoint: ''
    name: ''
    admin:
      enabled: true
      encryptionKeyKey: SETTINGS_ENCRYPTION_KEY
      allowedOrigins:
        - https://models.example.internal
```

배포 후 administrator로 `/admin?tab=provider`에서 **OpenAI 호환**을 선택하고 endpoint, 정확한 model ID, API key를 입력한다. **연결 테스트**는 repository source나 분석 prompt를 보내지 않고 최소 요청만 전송한다. 통과한 설정을 새 immutable version으로 저장·활성화하면 이후 queue되는 분석부터 provider version/hash가 고정된다. **Deployment 설정**은 active 관리자 version을 해제하고 values의 fallback으로 돌아간다.

API key는 AES-256-GCM으로 PostgreSQL에 암호화되고 UI와 응답에는 설정 여부만 나타난다. `SETTINGS_ENCRYPTION_KEY`를 변경하면 기존 version을 복호화할 수 없다. 회전 전 active version을 deployment fallback으로 복원하고, 새 key로 rollout한 뒤 Provider를 다시 등록한다. 이 allowlist는 SSRF 제어이며 NetworkPolicy를 대체하지 않으므로 model endpoint의 실제 CIDR/port egress도 함께 제한한다.

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
- DB/Auth/GitHub/Model Secret 이름. Provider 관리자 설정을 켜면 분석 Secret의 master key 이름도 확정
- `auth.adminRole`, `auth.adminGroup`, default tenant 자동 가입 여부
- `authorization.mode`: 운영 권장값은 `cerbos`; bundled PDP는 `cerbos.enabled: true`, 외부 PDP는 `authorization.cerbosUrl`
- `postgresql.enabled`: 외부 DB는 `false`, 자체 포함 pilot은 `true`; 번들 모드에서는 DB PVC StorageClass와 용량
- `keycloak.enabled`: enterprise 예시는 `true`; Keycloak hostname/TLS, app/admin/DB Secret과 전용 DB PVC를 실제 환경 값으로 교체
- 분석과 Chat의 provider mode 및 **명시적인 model name**. 관리자 분석 Provider를 쓸 경우 `admin.enabled`, master key, exact origin allowlist. ChatGPT account mode이면 account Secret, bootstrap revision과 전용 PVC
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
  --version 0.7.1 \
  -n git-code-reviewer -f values.enterprise.yaml \
  --atomic --wait --timeout 20m
```

```bash
kubectl -n git-code-reviewer get deploy,pod,job,cronjob,pvc,ingress
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-server
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-worker
helm test git-code-reviewer -n git-code-reviewer
```

Bundled Cerbos를 활성화한 release에서는 PDP rollout도 확인한다.

```bash
kubectl -n git-code-reviewer rollout status deploy/git-code-reviewer-cerbos
```

Bundled Keycloak은 StatefulSet rollout과 `helm test`의 realm discovery 검사를 확인한다. Release 이름이 다르면 resource prefix도 달라진다. Realm bootstrap Job은 Helm post-install/post-upgrade hook으로 완료 후 삭제된다.

```bash
kubectl -n git-code-reviewer rollout status statefulset/git-code-reviewer-keycloak
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

Bundled Cerbos를 켰다면 `health/dependencies`의 `authorization.status`가 `ok`인지 확인한다. Cerbos 정책은 image와 별도인 chart ConfigMap에 포함되며 정책 변경 시 Cerbos Pod checksum이, application 설정 변경 시 Server Pod checksum이 갱신된다.

Bundled Keycloak을 켰다면 `helm test`가 realm의 OIDC discovery endpoint를 cluster 내부 Service로 조회한다. Browser에서 issuer의 discovery URL과 application login/callback도 별도로 확인한다.

로그에는 source, diff, prompt, Chat 원문, token이 없어야 한다. Database pool 상한은 `(server replicas x pool) + (worker replicas x pool) + migration/retention/LISTEN 여유`로 계산한다.

# PRISM-DEV 배포

이 폴더는 `~/.kube/config`의 `PRISM-DEV` context에 Git Code Reviewer를 검증하기 위한 환경별 설정을 보관한다. 공통 Kubernetes resource는 `deploy/helm/git-code-reviewer` chart를 사용한다.

## 확인된 cluster policy

| 항목                  | PRISM-DEV 값                     |
| --------------------- | -------------------------------- |
| Kubernetes API        | `https://10.250.107.193:6443`    |
| Kubernetes version    | `v1.35.1`                        |
| StorageClass          | `nfs-csi`                        |
| Provisioner           | `nfs.csi.k8s.io`                 |
| Default               | `true`                           |
| Reclaim policy        | `Delete`                         |
| Volume binding        | `Immediate`                      |
| 사용 중인 access mode | `ReadWriteMany`, `ReadWriteOnce` |
| IngressClass          | `nginx`                          |

Artifact는 Server와 Worker가 함께 사용하므로 `nfs-csi`의 `ReadWriteMany` PVC를 새로 만든다. Bundled PostgreSQL은 같은 StorageClass의 `ReadWriteOnce` PVC를 사용한다. 두 PVC 모두 release 전용 namespace에서 동적 provision하며 기존 application PVC를 재사용하지 않는다.

## Pilot 범위

- namespace: `git-code-reviewer`
- release: `git-code-reviewer`
- GitHub: `fixture`
- auth: `local` (`administrator`, `reviewer` bootstrap account)
- 분석 model: disabled
- Chat: DB credential registry 사용. 실제 account는 관리자 화면에서 등록
- Ingress: disabled
- Gateway API: `pr-review.prism.ai` 전용 HTTPRoute
- 접근: HTTPRoute 또는 `kubectl port-forward`
- image: `docker.io/pydemia/git-code-reviewer:0.8.0-alpha.6@sha256:1cc09f22a72df16538c02b348db2f58a775348bc4315967d2aef3fef630ad218`
- PostgreSQL image: chart 기본 `latest` 대신 PRISM-DEV의 `linux/amd64` manifest digest로 고정

Local account는 browser에서 접근 가능한 OIDC endpoint가 없는 PRISM-DEV 검증용이다. 운영 환경에서는 사내 OIDC와 HTTPS Ingress를 사용한다. 이 profile에는 Ingress나 외부 Service를 추가하지 않는다.

PRISM-DEV의 outbound HTTPS는 `SK holdings C&C` TLS inspection CA로 다시 서명된다. ChatGPT/Codex와 GHES HTTPS 요청을 검증하려면 해당 root CA를 `git-code-reviewer-corporate-ca` ConfigMap의 `ca.crt` key로 먼저 등록해야 한다. 인증서 파일은 Git에 넣지 않는다.

## 배포

```bash
kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  create namespace git-code-reviewer --dry-run=client -o yaml \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV apply -f -

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer create secret generic git-code-reviewer-postgresql-auth \
  --from-literal=password="$(openssl rand -base64 36)" \
  --from-literal=postgres-password="$(openssl rand -base64 36)" \
  --dry-run=client -o yaml \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV apply -f -

# 최초 1회만 생성한다. 실제 비밀번호와 session secret은 Git/values에 기록하지 않는다.
kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer create secret generic git-code-reviewer-auth \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=LOCAL_BOOTSTRAP_ADMIN_USERNAME=admin \
  --from-literal=LOCAL_BOOTSTRAP_ADMIN_PASSWORD="$(openssl rand -base64 24)" \
  --from-literal=LOCAL_BOOTSTRAP_REVIEWER_USERNAME=reviewer \
  --from-literal=LOCAL_BOOTSTRAP_REVIEWER_PASSWORD="$(openssl rand -base64 24)"

# macOS System Keychain에 설치된 PRISM-DEV outbound TLS inspection root CA를 등록한다.
security find-certificate -c 'SK holdings C&C' -p /Library/Keychains/System.keychain \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
      -n git-code-reviewer create configmap git-code-reviewer-corporate-ca \
      --from-file=ca.crt=/dev/stdin --dry-run=client -o yaml \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV apply -f -

# 최초 1회만 생성한다. 이미 존재하면 기존 key를 유지해야 등록 credential을 복호화할 수 있다.
openssl rand -base64 32 \
  | kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
      -n git-code-reviewer create secret generic git-code-reviewer-credential-registry \
      --from-file=CREDENTIAL_ENCRYPTION_KEY=/dev/stdin

helm dependency build deploy/helm/git-code-reviewer

helm upgrade --install git-code-reviewer deploy/helm/git-code-reviewer \
  --kubeconfig="$HOME/.kube/config" \
  --kube-context=PRISM-DEV \
  --namespace=git-code-reviewer \
  --values=deploy/environments/prism-dev/values.yaml \
  --rollback-on-failure --wait --timeout=20m

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  apply -f deploy/environments/prism-dev/httproute.yaml
```

## 검증

```bash
kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer get pod,pvc,job

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer rollout status deployment/git-code-reviewer-server

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer rollout status deployment/git-code-reviewer-worker

helm --kubeconfig="$HOME/.kube/config" --kube-context=PRISM-DEV \
  test git-code-reviewer --namespace=git-code-reviewer --logs

kubectl --kubeconfig="$HOME/.kube/config" --context=PRISM-DEV \
  -n git-code-reviewer port-forward service/git-code-reviewer 8080:80
```

Port-forward를 유지한 상태에서 확인한다.

```bash
curl -fsS http://127.0.0.1:8080/health/live
curl -fsS http://127.0.0.1:8080/health/ready
curl -fsS http://127.0.0.1:8080/health/dependencies
curl -i http://127.0.0.1:8080/api/v1/repositories # 로그인 전 HTTP 401 확인
```

Browser에서는 `http://127.0.0.1:8080/login`에서 로그인한다. 시스템관리자는 `/admin?tab=users`에서 Local account를 생성하고 role, 활성 상태, tenant membership, repository 접근 권한과 비밀번호를 관리한다. 일반사용자에게는 관리 메뉴가 표시되지 않으며 관리자 API도 404를 반환해야 한다.

HTTPRoute는 `envoy-gateway-system/envoy-gateway`의 `http` listener에 연결되고 `git-code-reviewer` Service port 80으로 전체 path를 전달한다. 사내 DNS에 record가 없으면 접속할 PC의 hosts 파일에 다음 항목을 추가한 뒤 `http://pr-review.prism.ai`로 접속한다.

```text
10.250.107.189 pr-review.prism.ai
```

Route 상태와 DNS 등록 전 전달 동작은 다음처럼 확인한다.

```bash
kubectl --context=PRISM-DEV -n git-code-reviewer \
  get httproute git-code-reviewer-route

curl -fsS -H 'Host: pr-review.prism.ai' \
  http://10.250.107.189/health/live
```

Bootstrap 사용자 이름은 `admin`, `reviewer`다. 비밀번호는 권한이 있는 운영자만 Secret에서 확인한다.

```bash
kubectl --context=PRISM-DEV -n git-code-reviewer get secret git-code-reviewer-auth \
  -o jsonpath='{.data.LOCAL_BOOTSTRAP_ADMIN_PASSWORD}' | base64 --decode; printf '\n'

kubectl --context=PRISM-DEV -n git-code-reviewer get secret git-code-reviewer-auth \
  -o jsonpath='{.data.LOCAL_BOOTSTRAP_REVIEWER_PASSWORD}' | base64 --decode; printf '\n'
```

명령 결과를 shell history, ticket 또는 Git 문서에 복사하지 않는다. 시스템관리자는 최초 로그인 직후 두 account의 비밀번호를 관리자 화면에서 변경한다.

## 2026-09-04 검증 결과

`~/.kube/config`의 `PRISM-DEV` context와 Kubernetes API `https://10.250.107.193:6443`을 사용해 release revision 1을 설치했다.

| 검증 항목                  | 결과                                                                       |
| -------------------------- | -------------------------------------------------------------------------- |
| Helm install               | `deployed`                                                                 |
| PostgreSQL, Server, Worker | 모두 `Ready`, main container restart 0회                                   |
| Artifact PVC               | `nfs-csi`, `ReadWriteMany`, 10Gi, `Bound`                                  |
| PostgreSQL PVC             | `nfs-csi`, `ReadWriteOnce`, 10Gi, `Bound`                                  |
| 동적 생성 PV               | 2개 모두 reclaim policy `Delete`, `Bound`                                  |
| Service                    | `ClusterIP`, port 80, Ingress 없음                                         |
| Helm test                  | `Succeeded`                                                                |
| Health API                 | live, ready, dependencies 모두 HTTP 200                                    |
| Fixture 수집               | repository 1개, open pull request 2개 확인                                 |
| 분석 결과                  | 2건 모두 `completed`, `published`, progress 100                            |
| 수동 refresh               | operation이 `queued`에서 `completed`로 전환되고 새 분석이 publish됨        |
| 결과 조회                  | files, diff, commits, report, findings, code objects, Markdown export 확인 |
| 관리자 API                 | development administrator, tenant, user 조회 확인                          |

PostgreSQL 최초 초기화 중 Server와 Worker의 `migrate` init container가 먼저 접속해 각각 3회 재시작했으나, database 준비 후 `Completed` 상태가 됐다. Main container 재시작과 최근 application error log는 없었다.

로컬에서는 package build 후 test 56건, lint, typecheck, application build가 모두 통과했다. Clean install 직후 `pnpm test`만 단독 실행하면 내부 package의 `dist`가 없어 import 단계에서 실패하므로 CI에서는 `pnpm build:packages`를 먼저 실행해야 한다.

자동 Browser 검증은 실행 환경에 연결된 browser instance가 없어 수행하지 못했다. 대신 `/`와 `/admin`이 HTTP 200, `text/html`, `<title>Git Code Reviewer</title>`을 반환하는 것까지 확인했다.

### Credential registry 배포 검증

Helm release revision 4에서 application `0.7.0-alpha.3`, chart `0.8.2`를 배포했다.

| 검증 항목       | 결과                                                                      |
| --------------- | ------------------------------------------------------------------------- |
| Server/Worker   | 각 1개 `Ready`, restart 0회                                               |
| Image           | `sha256:52d95d8ca295b72409dc50933bf33e6cf965e9ef6fcf744262d1cc66443e94b4` |
| DB migration    | `0009_account_and_ghes_registries.sql` 적용                               |
| Registry API    | 사용자/admin Chat account, GHES connection, admin repository API HTTP 200 |
| Credential 저장 | synthetic auth.json 원문이 ciphertext에 포함되지 않음을 DB에서 확인       |
| Chat 선택       | account, model, `high` effort와 credential version의 session 고정 확인    |
| Polling         | Poll now 요청 후 fixture repository의 `lastPolledAt` 갱신                 |
| Scheduler       | rolling update 후 advisory lock leadership 획득 확인                      |
| UI artifact     | ChatGPT accounts, GHES 연결, 빈 account 안내, Git graph marker 확인       |

검증에 사용한 synthetic account와 Chat session은 확인 직후 삭제했다. 실제 GHES token과 ChatGPT auth.json은 제공되지 않아 외부 provider 인증 E2E는 수행하지 않았다. `agent-browser` 실행 파일과 연결된 browser instance가 없어 자동 visual 검증은 수행하지 못했으며 HTML/JavaScript artifact와 API를 검증했다.

### Local account 배포 검증

Helm release revision 6에서 application `0.8.0-alpha.1`, chart `0.9.0`을 배포했다.

OCI chart는 `oci://registry-1.docker.io/pydemia/git-code-reviewer:0.9.0`에 게시했으며 digest는 `sha256:c170c33ea24d28d51002bdd21e2c61c268a1e5f3cc6c30f17c6238b49f66fc69`다.

| 검증 항목         | 결과                                                                                |
| ----------------- | ----------------------------------------------------------------------------------- |
| Server/Worker     | 각 1개 `Ready`, restart 0회                                                         |
| Image             | `sha256:b952e8f07a112b2615e7a628d5a7ab163c3fedc10e85f7bfcc895b7f5dfe3cae`           |
| DB migration      | `0010_local_accounts.sql` 적용, Local credential 2개 모두 scrypt hash               |
| Bootstrap account | `admin` 시스템관리자와 `reviewer` 일반사용자 생성, 각 tenant membership 1개         |
| 관리자 보호       | 로그인한 시스템관리자의 self-disable 요청 HTTP 409                                  |
| Session 폐기      | 일반사용자 비밀번호 재설정 후 기존 session HTTP 401, 재로그인 HTTP 200              |
| 로그인 제한       | 동일 사용자 이름 5회 실패 후 15분 잠금 확인, 시험용 제한 row 삭제                   |
| Repository grant  | 회수 후 일반사용자 repository 0개, 재부여 후 1개 확인                               |
| 관리자 격리       | 일반사용자의 관리자 API 요청 HTTP 404                                               |
| UI artifact       | `/login`과 JavaScript HTTP 200, 로그인·계정 생성·repository 권한·로그아웃 문구 확인 |
| Helm/Health       | Helm test 성공, live/ready/dependencies 모두 HTTP 200                               |

Bootstrap credential은 `git-code-reviewer-auth` Secret에만 있다. 최초 로그인 후 시스템관리자가 `/admin?tab=users`에서 각 Local account 비밀번호를 변경하고 조직의 전달 절차로 사용자에게 제공한다. Secret key를 바꾸어도 이미 생성된 account 비밀번호는 자동으로 덮어쓰지 않는다.

### ChatGPT account TLS 검증

ChatGPT account 등록 후 Chat 요청이 HTTP 502 `CHAT_MODEL_FAILED`로 끝날 때 failed message에는 `fetch failed`가 기록됐다. Server Pod에서 `chatgpt.com`과 `auth.openai.com`은 DNS가 정상 해석됐지만 두 HTTPS 요청 모두 `SELF_SIGNED_CERT_IN_CHAIN`으로 실패했다. 위 ConfigMap을 `trustedCa.existingConfigMap`에 연결하면 Server에 `/run/config/trust/ca.crt`가 read-only mount되고 `NODE_EXTRA_CA_CERTS`가 해당 경로로 설정된다.

Helm release revision 7에 CA를 적용한 뒤 두 endpoint가 TLS handshake를 통과했고, 등록된 account와 `gpt-5.6-sol`, `medium` effort로 실행한 실제 Chat 요청이 HTTP 201과 `completed` assistant message를 반환했다. OAuth token refresh 후 account health는 `ready`, credential version은 2가 됐다. 검증용으로 만든 Chat session은 확인 직후 삭제했다.

### GHES credential 사용 가이드 배포 검증

Helm release revision 8에서 application `0.8.0-alpha.2`, chart `0.10.0`을 배포했다. OCI chart는 `oci://registry-1.docker.io/pydemia/git-code-reviewer:0.10.0`에 게시했으며 digest는 `sha256:1a8773174479e87921402a189a34298edfb0fa217d7f4e0ee54ac7f7370abc67`다.

| 검증 항목      | 결과                                                                                 |
| -------------- | ------------------------------------------------------------------------------------ |
| Server/Worker  | 각 1개 `Ready`, rollout 이후 application error 없음                                  |
| Image          | `sha256:84d6a475be2e66ee79f0e6603531b7ee13dda61969622397f601c267c42a99c8`            |
| Helm/Health    | Helm test 성공, live/ready/startup/dependencies 모두 HTTP 200                        |
| Guide route    | `/guide` HTTP 200                                                                    |
| UI artifact    | GHES credential 발급·입력, Token 만료일, 사용 가이드 문구를 배포 JavaScript에서 확인 |
| Responsive     | 1440px와 CSS viewport 390px에서 GNB, 목차, 본문 이동과 가로 overflow 없음            |
| 기존 data 보존 | Local user, ChatGPT account와 GHES credential registry row 유지                      |

배포 환경의 기존 사용자 비밀번호는 최초 bootstrap 이후 변경된 상태다. 이를 재설정하지 않고 배포 bundle과 route를 검증했으며, authenticated 관리자·일반사용자 화면은 local mocked current-user API로 확인했다.

### Credential registry polling 수정 재배포

Helm release revision 9에서 application `0.8.0-alpha.3`, chart `0.10.1`을 배포했다. 적용한 image manifest digest는 `sha256:bb8ec547ccb09e1d9dee9e193bffb714cd66befdd48e25faa6486fba6124d9e6`다.

| 검증 항목      | 결과                                                                              |
| -------------- | --------------------------------------------------------------------------------- |
| Server/Worker  | 각 1개 `Ready`, restart 0회, 새 image digest 적용                                 |
| Helm/Health    | Helm test 성공, live/ready/startup/dependencies 모두 HTTP 200                     |
| Web/API        | `/guide` HTTP 200, 로그인 전 repository API HTTP 401                              |
| Scheduler      | rolling update 이후 advisory lock leadership 재획득, application error 없음       |
| Storage        | 기존 `nfs-csi` RWX artifact PVC와 RWO PostgreSQL PVC 유지                         |
| 기존 data 보존 | 사용자 3명, ChatGPT account 1개, GHES credential 1개, fixture repository 1개 유지 |
| Local test     | Vitest 16개 파일 66건, TypeScript typecheck, ESLint, PRISM values Helm lint 통과  |

PRISM-DEV에는 실제 credential을 연결한 repository가 아직 없다. 기존 fixture 검증을 유지하기 위해 `github.mode=fixture`로 배포했으며, 이후 관리자 화면에서 등록하는 repository는 해당 repository의 credential을 우선 사용한다.

### 전용 HTTPRoute 배포 검증

Helm release revision 11에서 `PUBLIC_BASE_URL`을 `http://pr-review.prism.ai`로 변경하고 `httproute.yaml`을 적용했다.

| 검증 항목       | 결과                                                                             |
| --------------- | -------------------------------------------------------------------------------- |
| HTTPRoute       | `git-code-reviewer/git-code-reviewer-route` 생성                                 |
| Gateway parent  | `envoy-gateway-system/envoy-gateway`, listener `http`                            |
| Route condition | `Accepted=True`, `ResolvedRefs=True`                                             |
| Backend         | `git-code-reviewer` Service port 80                                              |
| Host request    | `/health/live` HTTP 200, `/guide` HTTP 200, 비로그인 repository API HTTP 401     |
| Helm            | revision 11, Server/Worker `Ready`, Helm test 성공                               |
| 외부 이름 해석  | 사내 DNS record가 없어 개발 PC hosts 파일에 `10.250.107.189` mapping이 현재 필요 |

### 개인 프로필·비밀번호 변경 배포 검증

Helm release revision 12에서 application `0.8.0-alpha.4`, chart `0.10.2`를 배포했다. OCI chart digest는 `sha256:0aec61dc15a0edc568ceb143660a650f96646b7773cfdfaf1ee72dfaa492eb91`, image manifest digest는 `sha256:b1aedc672c9fda8eaffcea907a459307398c5c9e3940e911964ccce41fb2bf40`이다.

| 검증 항목      | 결과                                                                                   |
| -------------- | -------------------------------------------------------------------------------------- |
| Server/Worker  | 각 1개 `Ready`, restart 0회                                                            |
| Helm/Health    | Helm test 성공, live/ready/dependencies HTTP 200                                       |
| 프로필         | 임시 Local account의 조회·표시 이름 변경 HTTP 200, 성공 audit 확인                     |
| 8자 경계값     | 7자 새 비밀번호 HTTP 400, 정확히 8자 새 비밀번호 HTTP 200                              |
| Session 폐기   | 변경 전 session HTTP 401, 기존 비밀번호 로그인 401, 새 비밀번호 로그인 200             |
| Audit          | 프로필 변경 성공, 7자 validation 실패, 비밀번호 변경 성공 event 확인                   |
| Responsive UI  | desktop 1440x1000, mobile 500x1200에서 프로필 layout과 form overflow 없음              |
| 검증 자료 정리 | 임시 사용자, credential, session, login limit와 관련 audit event 삭제 후 잔여 0건 확인 |

### GHES connection 수정 배포 검증

Helm release revision 13에서 application `0.8.0-alpha.5`, chart `0.10.3`을 배포했다. OCI chart digest는 `sha256:5be0cb4f298b97b70d72e7d9745338ad884ef30069470868038eed121eb75675`, image manifest digest는 `sha256:df64559a9de37af432e0c118ff617770e9597bc852eb2fee50ccedded751d0ed`다.

| 검증 항목          | 결과                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------- |
| Server/Worker      | 각 1개 `Ready`, restart 0회, 새 image digest 적용                                               |
| Helm/Health        | Helm test 성공, live/ready/dependencies HTTP 200                                                |
| Metadata 수정      | 새 token 없이 이름·label·만료일 수정 HTTP 200, credential version과 fingerprint 유지            |
| Token 교체         | 새 token 입력 수정 HTTP 200, credential version 1→2, fingerprint 변경, ciphertext 평문 일치 0건 |
| Origin 보호        | 기존 token으로 API origin 변경 시 HTTP 400 `GITHUB_TOKEN_REQUIRED_FOR_ORIGIN_CHANGE`            |
| 공유 instance 보호 | credential 2개가 공유하는 instance 이름 변경 시 HTTP 409 `GITHUB_SHARED_INSTANCE_CONFLICT`      |
| 참조 유지          | 수정 전후 synthetic repository의 동일 `credential_id` 참조 1건 유지                             |
| Responsive UI      | desktop 1440×1100, mobile 500×1100과 공유 instance dialog 1200×950에서 overflow 없음            |
| 검증 자료 정리     | 임시 관리자, GHES instance/credential, repository, session과 audit event 삭제 후 잔여 0건 확인  |

Connection 수정 후 health는 `unverified`가 되며 연결 테스트가 `ready`로 바꾸기 전에는 polling, Git materialization과 repository 등록에 해당 credential을 사용하지 않는다. 실제 GHES endpoint와 token을 사용한 연결 테스트는 별도로 수행해야 한다.

### PR review 게시·Repository URL 등록 배포 검증

2026-09-07 12:00 KST에 Helm release revision 14로 application `0.8.0-alpha.6`, chart `0.10.4`를 배포했다. Source commit은 `be2f56fc007c`이며 OCI chart digest는 `sha256:361373950c273f395162749daf92f868c5da362e147967d8d86daddc61b3b7ea`, image manifest digest는 `sha256:1cc09f22a72df16538c02b348db2f58a775348bc4315967d2aef3fef630ad218`이다. Image는 `linux/amd64`와 BuildKit provenance/SBOM attestation을 포함한다.

| 검증 항목      | 결과                                                                                                 |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| 사전 검증      | Vitest 20개 파일 118건, TypeScript typecheck, ESLint, Helm lint·server dry-run 통과                  |
| Migration      | `0011_github_review_publication.sql` 적용, publication table 14개 column 확인                        |
| Server/Worker  | 각각 `1/1 Ready`, restart 0회, 새 image digest 적용, 배포 직후 warning/error 0건                     |
| Scheduler      | Rolling update 후 leadership 재획득                                                                  |
| Helm/Health    | Helm test 성공, live/ready/startup/dependencies HTTP 200                                             |
| HTTPRoute      | `Accepted=True`, `ResolvedRefs=True`, 실제 hostname에서 새 version 확인                              |
| Web/API        | `/guide`, `/login`, `/admin?tab=github`, 최신 JavaScript HTTP 200, 비로그인 repository API HTTP 401  |
| UI artifact    | GitHub.com API 예시, `https://github.com/org-name/repo-name`, Repository URL, PR 게시·권한 안내 확인 |
| 기존 data      | 사용자 3명, ChatGPT account 1개, GHES credential 1개, repository 1개 유지                            |
| Storage/Secret | 두 PVC의 기존 PV ID와 auth/credential registry/PostgreSQL Secret의 UID·resourceVersion 유지          |
| 기존 PR 게시   | `review_publishing_enabled=false`, publication row와 job 0건 유지                                    |

배포는 기존 connection의 URL·token·권한이나 사용자 비밀번호를 변경하지 않는다. GitHub.com 연결은 API base URL에 `https://api.github.com`, Web base URL에 `https://github.com`을 입력하고 연결 테스트 후 Repository URL `https://github.com/org-name/repo-name`으로 등록한다. 기존 repository에서 PR 게시를 시작하려면 먼저 PAT의 Metadata/Contents read와 Pull requests read/write 권한을 확인한다.

실제 GHES repository 등록과 PR 댓글 create/update 검증은 실행하지 않았다. 이번 배포의 UI 확인은 HTTPRoute가 제공하는 정적 bundle과 route 검증이며, 로그인 후 URL 입력·오류 안내 동작은 앞선 local synthetic API 검증 결과를 사용한다.

## 실제 GHES 및 ChatGPT account 등록

`/admin?tab=github`에서 GHES API/Web base URL과 access token을 등록한 뒤 연결 테스트를 실행하고 review 대상 repository를 등록한다. 등록된 repository는 fixture와 무관하게 해당 token으로 polling과 clone을 수행한다. 사내 CA가 필요하면 `trustedCa.existingConfigMap`을 지정한다.

`/admin?tab=chat`에서는 Codex ChatGPT login의 `auth.json`, 허용 model·effort, tenant 할당을 등록한다. 사용자는 review 화면의 오른쪽 Chat panel에서 할당된 account, model, effort를 선택한다. Access token, auth.json, 암호화 key는 Git repository나 values 파일에 저장하지 않는다.

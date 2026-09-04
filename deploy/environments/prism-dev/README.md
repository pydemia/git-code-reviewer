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
- 접근: `kubectl port-forward`
- image: `docker.io/pydemia/git-code-reviewer:0.8.0-alpha.1@sha256:b952e8f07a112b2615e7a628d5a7ab163c3fedc10e85f7bfcc895b7f5dfe3cae`
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

## 실제 GHES 및 ChatGPT account 등록

`/admin?tab=github`에서 GHES API/Web base URL과 access token을 등록한 뒤 연결 테스트를 실행하고 review 대상 repository를 등록한다. 등록된 repository는 fixture와 무관하게 해당 token으로 polling과 clone을 수행한다. 사내 CA가 필요하면 `trustedCa.existingConfigMap`을 지정한다.

`/admin?tab=chat`에서는 Codex ChatGPT login의 `auth.json`, 허용 model·effort, tenant 할당을 등록한다. 사용자는 review 화면의 오른쪽 Chat panel에서 할당된 account, model, effort를 선택한다. Access token, auth.json, 암호화 key는 Git repository나 values 파일에 저장하지 않는다.

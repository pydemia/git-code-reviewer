# PRISM-DEV 배포

이 폴더는 `~/.kube/config`의 `PRISM-DEV` context에 Git Code Reviewer를 검증하기 위한 환경별 설정을 보관한다. 공통 Kubernetes resource는 `deploy/helm/git-code-reviewer` chart를 사용한다.

## 2026-09-09 파일 요약 문구 배포

08:37:15 KST에 application `0.8.0-alpha.25`, chart `0.10.24`를 Helm revision **36**으로 배포했다. Source `0610479`와 release pin `783e5db`를 push 후 적용했다. 의견이 없는 검토 완료 파일만 짧게 표시하며 기존 report·미완료 안내·분석 제한은 유지한다.

- Image index: `sha256:1833e312e88887de81855b6cffc050171e0d303189bfbf3c2801efde7aeb87f7`
- Linux/amd64 manifest: `sha256:0b3d8b122c093a42c8237344d030b3e2efe12746268d26dc73b85ffdee20fb09`
- OCI chart: `sha256:6faf3ac47df0be4fee8acf9e62c57bfc604e2dccbf01a954de6b6f2001f3d437`

414개 테스트·typecheck·lint·build, health 4종·version·Helm test와 migration 28개 checksum을 확인했다. Server 1/1·Worker 2/2 Ready, restart 0회다. Image 외 values와 기존 Secret·CA·HTTPRoute·PVC/PV 및 사용자 데이터를 보존했다. 실제 Browser에서 기존 PR의 새 문구를 확인했으며 재분석·GitHub 댓글 게시 없이 적용했다. 검증 범위와 종료 유예 중인 이전 Worker는 [문구 변경 기록](../../../docs/operations/concise-review-summaries-2026-09-09.md)을 따른다.

## 2026-09-09 Interactive Review Chat 2차 배포

후속 미완료 Summary 수정은 **07:44:01 KST application `0.8.0-alpha.24`, chart `0.10.23`, Helm revision 35**로 배포했다. 구현 `ca6d9c5`, release pin `90b10b4`이며 자세한 digest·검증과 승인된 PR #917 Revision 2 재분석은 [미완료 분석 조사 기록](../../../docs/operations/incomplete-review-2026-09-09.md)을 따른다. 기존 설정·데이터와 128회 모델 예산을 유지했다. 아래 alpha.23은 선행 배포 기록이다.

07:12:40 KST에 application `0.8.0-alpha.23`, chart `0.10.22`를 Helm revision **34**로 배포했다. Source `143ba2ff09abc5fc6247233d742d8b1aae924540`와 image pin `1aeae2d`를 push한 뒤 적용했다.

- Image index: `sha256:52d8344b8255d591c9f5853843bc81bf620120a4ee4e5707bd205c1424637641`
- Linux/amd64 manifest: `sha256:08aa02d1504c0ceed091eb2625bf7fb45d39d92d4a1678b50bf4f497c88a62c3`
- OCI chart: `sha256:c2cbc4b038b8c2ba32a199cc0cd51311cd61f91925e43626d2a86494b93711b8`

Batch checkpoint·fenced job 복구/drain, DB workspace lease·같은 SHA 캐시 재사용, 원문 주소를 보존하는 대화 발췌/재조회, JS/TS AST와 Python lexical 호출·테스트 후보, 이전 run·질문·소스 복원을 포함한다. 집단 메모리 우선권과 기존 접근 권한·모델 예산을 유지한다.

405개 테스트, typecheck·lint·production build·Compose·Helm 검증을 통과했다. Native 격리 환경에서 쓰기·process·network 차단과 실제 Git/AST 조회를 확인했다. Server 1/1·Worker 2/2 Ready, health 4종 HTTP 200, 비로그인 history API 401, 07:14:09 Helm test와 migration 28개 checksum을 확인했다. Image 외 Helm values·Secret·PVC/PV는 유지했다.

실제 AI run `68115d81-e856-4963-bfa9-7d22ad813348`은 기존 검증 대화의 질문과 소스를 다시 읽고 사용자 질문·응답 후 workspace를 재사용해 163초 만에 completed가 됐다. 모델 8회·읽기 도구 6회, 4,687자 답변과 근거 2건·실제 delta 211건을 확인했다. Mac 잠금으로 desktop/mobile UI 조작·캡처는 미수행이다. 상세 기록은 [2차 검증](../../../.documents/verification-interactive-chat-phase2-2026-09-09.md)에 있다.

## 2026-09-09 Interactive Review Chat 배포

00:10:52 KST에 application `0.8.0-alpha.22`, chart `0.10.21`을 Helm revision 32 canary로 배포했다. Source `a964210f1564f0a8b7933cef3418f4803d507773`와 image 고정 설정 `a8e0ae2`를 push 후 적용했다. Build context는 해당 source commit의 `git archive`다.

실제 AI 완료를 확인한 뒤 00:23:01 KST에 revision **33**으로 전체 사용자에게 활성화했다. Allowlist 변경은 Server만 재시작해 반영했고 기존 model/repo 권한은 유지했다. 새 Server 1/1·Worker 2/2 Ready, health 4종 HTTP 200·ok, system alpha.22, 비로그인 Chat API 401, 00:23:30 Helm test 성공을 확인했다. Migration 26개 checksum과 기존 Secret·CA·PVC/PV를 보존했다. 진행 중인 기존 배치의 종료·복구 기록은 별도 검증 문서에 구분했다.

- Image index: `sha256:0f5c24e021c15facefd9c740033809f958bf48eca1c17f92dfb4a1f8193b3111`
- Linux/amd64 manifest: `sha256:67c45e7fd57ed70152551ca951cdbd8b777cdc2321336becf269ffc67d0b4934`
- OCI chart: `sha256:521420ffcfdd41708239cbdd433456fb5d6e3aec9166fe09e846334c60185f18`
- SPDX SBOM·SLSA provenance v1 attestation을 함께 게시했다.

실제 Git의 고정 base·merge-base·head 파일 트리, 읽기 전용 source 도구, 등록 ChatGPT account의 tool/streaming, 사용자 질문과 재개·중단·추가 지시, 영속 run/SSE, 메인 코드 근거 탭을 포함한다. 기존 findings·summary·GitHub 게시 계약은 유지했다. 계정별 admission과 batch/Chat 우선권을 공유하고 모델 8회·도구 24회·context 128 KiB·요청 timeout 180초를 적용한다. Worker concurrency 2 중 하나는 Chat용이며 새 Pod의 종료 유예는 3600초다.

391개 테스트(63개 파일, UTF-8 PostgreSQL 포함), 전체 TypeScript·ESLint·production build, Compose config·Helm lint를 통과했다. Native PRISM-DEV에서 이 image의 UID/환경·쓰기·경로 이탈·process·network 차단과 실제 Git source read를 검증했다. Mac이 잠겨 실제 브라우저 desktop/mobile 조작과 캡처는 수행하지 못했다. SSR과 backend smoke를 화면 검증으로 간주하지 않는다.

실제 `gpt-5.6-sol:medium` run `cf19fcf0-c4cf-4c0f-b2a6-24cab6000e55`는 모델 8회·도구 6회, 사용자 질문·응답·재개 뒤 completed가 됐다. Base/head 근거 3건, 2,249자 답변의 citation, 실제 delta 96건과 source API/hash 일치를 확인했다. 실제 Fastify handler·배포 Worker smoke이며 로그인 HTTP 인증 E2E는 아니다. 배치와 대기·workspace 준비를 포함해 약 9분 25초가 걸렸다. 두 Worker의 확인 가능한 완료 ledger 구간에서 같은 계정의 요청 중첩은 0건이었다.

alpha.18–21 canary에서 발견한 provider stream·Git TLS·신규 파일 부재·계정 점유·60초 timeout 문제와 제한된 기존 job 복구는 [검증 기록](../../../.documents/verification-interactive-chat-2026-09-08.md)에 남겼다. 각 중간 partial/실패를 성공으로 덮어쓰지 않았다. 제공 제한과 복구 절차는 [운영 문서](../../../docs/operations/interactive-chat.md)를 따른다.

## 2026-09-08 분석 저장·호출 예산 수정 배포

20:02:34 KST에 upgrade를 시작해 Helm revision 27로 배포했다. Application `0.8.0-alpha.17`, chart `0.10.16`이며 source는 `192596f18b031180a075e222484c2e9eb5ec7564`, release 설정은 `6b3ee2e`다. 모두 push 후 반영했다. Build context는 commit의 `git archive`만 사용해 local 진단 데이터와 임시 registry 인증 파일을 제외했다.

- Image index: `sha256:ae84499070c0fe8181e5ea16754d673a158bca23ae4f47596b69af96eb9a3bb3`
- Linux/amd64 manifest: `sha256:d31ed6ce9e552bd0e4f1b85af7a38730f5a267dc7dff4defb00556fb404c2487`
- OCI chart: `sha256:7151a410295b259653b2451b627275352354006569b2ed58ed358fd04f8e30d9`
- Registry에서 SPDX SBOM과 SLSA provenance v1을 확인했다.

누적 실패 8건의 원인은 중복 코드 심볼의 DB 고유 제약 위반과 재시도 시 동일 artifact 경로 충돌이었다. 심볼 정의 line 구분, 내용 hash 기반 artifact 경로와 단일 report 발행 잠금을 적용했다. 부분 완료의 호출 예산 문제에는 window 크기 조정, 요약 호출 예약, 기본 128회 상한과 한 번의 제한된 모델 재시도를 적용했다. 미지원 symbol adapter는 graph·impact coverage에 남기고 AI 리뷰 완료 상태와 분리했다. 자세한 집계는 [실패 조사 기록](../../../docs/operations/analysis-failures-2026-09-08.md)에 있다.

| 검증 | 결과 |
| --- | --- |
| 테스트 | UTF-8 local PostgreSQL integration을 포함한 57개 파일·346개 테스트, lint·typecheck·production build 통과 |
| 실제 입력 재생 | 실패 8건의 기존 DB 오류 재현. 실패·호출 예산 사례 22건 모두 수정된 graph 저장 성공. Fixture model으로 모든 window·요약 완료, 최대 124회, 예산 초과·요약 누락 0건 |
| Container | Node 22.23.2, UID 1000, network-none·read-only 실행 검증. 기본 호출 예산 128, YAML AI fixture 완료와 graph 제한 분리, 실행 image에 build CA secret 없음 |
| Helm·Workload | Lint·server-side dry-run·upgrade 성공. 새 Server·Worker 각 1/1 Ready, restart 0회, 이전 Pod 종료. 20:04:06 KST Helm test 성공 |
| HTTP | 실제 Host 경로의 health 4종 HTTP 200·ok, system version `0.8.0-alpha.17`, 비로그인 repository API 401 |
| DB·데이터 | Migration 23개와 checksum 일치, 신규 migration 없음. Users 7명, Chat accounts 4개, analyses 56건, reports 48건과 과거 실패 8건 보존 |
| 운영 설정 | Image 외 Helm values SHA-256 `88e6a71dd9b5ec5f03cb90f2309b478847b9451db7f9fb48513a7b9e876e69ef` 동일. Secret·corporate CA·HTTPRoute UID/resourceVersion과 두 PVC의 UID·PV 보존. 앱 ConfigMap만 새 release로 갱신 |
| 배포 직후 | 새 Server·Worker warning/error 0건, 새 분석 실패 0건, pending job 0건 |

배포된 Server에서 등록된 ChatGPT account의 `gpt-5.6-sol:medium`으로 과거 실패 snapshot의 YAML 설정과 중복 메서드가 있는 Python schema 파일을 실제 분석했다. 두 파일 모두 `reviewed`, 4/4 window 완료, 파일·전체 요약 완료, 모델 호출 8회, finding 3건, 소요 141.6초였다. 결과는 `completed`/`model`/`pass`, AI coverage 제한 0건이고 graph 심볼 식별자는 모두 고유했다. YAML의 symbol adapter 제한은 graph/impact에만 남았다. 이 smoke test는 전체 PR 재분석이 아니며 검증 report를 운영 DB에 저장하거나 GitHub 댓글로 게시하지 않았다.

과거 실패 record나 원본 artifact를 성공 상태로 덮어쓰지 않았다. 새로운 분석부터 수정된 동작을 사용한다. 생성 파일·lock 파일 제외와 실제 미검토 범위는 계속 부분 완료로 표시한다.

## 2026-09-08 Memory·제품 문서 배포

19:18 KST에 upgrade를 시작해 Helm revision 26으로 배포했다. Application은 `0.8.0-alpha.16`, chart는 `0.10.15`다. Source `796793e6c5f533ffbee60c89d9d73921c58f219c`를 push한 뒤 clean source로 빌드했으며 image digest를 고정한 release 설정 `5b8eb7e`도 push 후 적용했다.

개인·집단 Review Memory, GitHub PR 대화 원문·버전 수집과 관리, 분석·Chat 메모리 적용을 포함한다. 앱 상단의 `문서`에서 `Introduction`, `기능 목록`, `사용 가이드`를 전환하며 `/introduction`, `/features`, `/guide`로 직접 접근할 수 있다. 제품 Markdown 원문은 웹 빌드에 포함된다.

- Image index: `sha256:8739f1ac2e56d8f6347cb62132f0aee0d7681fa31c40a13205caac93b4e1c61f`
- Linux/amd64 manifest: `sha256:b2f3215c1a1cd17aae8dbd157b945b4c32d0bdb21c7b769bc615aec6145da914`
- OCI chart: `sha256:562dac5fde65bbd36ff02f3c7e81a9d286069d21b79163d76ef95986821f5c62`
- Registry에서 SPDX SBOM과 SLSA provenance v1 predicate를 확인했다.

| 검증 | 결과 |
| --- | --- |
| 선행 기능 검증 | Memory 개발 시 단위 테스트 295건과 DB integration 4건 통과. 문서 변경 후 웹 테스트 65건, lint·웹 빌드와 문서 메뉴·목차·링크 렌더링 검증 통과 |
| Container | 전체 production build 성공. Network-none·read-only 실행에서 UID 1000, migration 23개, Memory module과 제품 문서의 JS 포함 확인. Build CA secret은 실행 image에 없음 |
| Helm | Lint·server-side dry-run·upgrade 성공. 19:19:50 KST connection test Succeeded |
| Migration | 0020–0023 추가 적용. DB의 전체 migration 23개 checksum이 source와 일치 |
| Workload | Server·Worker 각 1/1 Ready, restart 0회. 이전 Pod 종료. Retention CronJob도 같은 image digest 사용 |
| HTTP | 실제 `pr-review.prism.ai` Host에서 live·ready·startup·dependencies가 HTTP 200·ok, system version은 `0.8.0-alpha.16` |
| 문서·인증 | `/login`, `/introduction`, `/features`, `/guide` HTTP 200. Profile·repository·Memory·PR 대화 API의 비로그인 요청은 401 |
| 데이터·설정 | Users 7명, Chat accounts 4개, GHES credential 1개, 활성 repository 2개, analyses 55건, reports 47건 유지. Image 외 Helm values와 기존 Secret·CA·HTTPRoute·PVC/PV 유지 |
| Log | 확인한 새 Server·Worker log의 warning/error 0건. Poll scheduler leadership 획득 확인 |

Image 외 Helm values의 SHA-256은 배포 전후 `88e6a71dd9b5ec5f03cb90f2309b478847b9451db7f9fb48513a7b9e876e69ef`로 동일하다. 두 PVC의 UID·PV·용량·access mode를 보존했다. 기존 auth·credential registry·PostgreSQL Secret과 corporate CA·HTTPRoute의 UID 및 resourceVersion도 유지했다.

실제 HTTPRoute가 제공하는 asset과 게시 image의 SHA-256이 일치한다.

- `/assets/index-_dhcp0bt.css`: `40d8d426c44f0588c09c3411a35d9614e34e77401400e0d745dcda7969326399`
- `/assets/index-oa7nQ6Be.js`: `1b4a30d082c5649ff81b2bdf628670129e7d808923946b1f774a108c6b01760d`

배포 전 실행 중 job은 0건이었다. 기존 두 repository의 polling 설정은 유지됐으며 배포 후 조회 결과는 `not-modified`, 오류 코드는 null이었다. 최초 DB 확인 시 Memory와 PR 원천 메시지는 0건이었다. 실제 AI·Chat·PR 게시를 검증용으로 요청하거나 공용 메모리를 활성화하지 않았다. 문서 검증은 선행 React 렌더링과 배포된 HTTP·asset 비교이며 로그인 후 live Browser E2E는 수행하지 않았다.

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

최초 설치에서는 Server와 Worker가 함께 사용할 `nfs-csi`의 `ReadWriteMany` artifact PVC를 만든다. Bundled PostgreSQL은 같은 StorageClass의 `ReadWriteOnce` PVC를 사용한다. 두 PVC 모두 release 전용 namespace에서 동적 provision한다. 재배포에서는 이 release의 기존 PVC/PV를 유지하며 삭제·재생성하지 않는다.

## Pilot 범위

- namespace: `git-code-reviewer`
- release: `git-code-reviewer`
- GitHub: `fixture`
- auth: `local` (`administrator`, `reviewer` bootstrap account)
- 분석 model: 배포 기본값은 disabled, 관리자가 분석 Provider에서 등록 account/model/effort 또는 OpenAI-compatible 연결을 선택
- Chat: DB credential registry 사용. 실제 account는 관리자 화면에서 등록
- Ingress: disabled
- Gateway API: `pr-review.prism.ai` 전용 HTTPRoute
- 접근: HTTPRoute 또는 `kubectl port-forward`
- image: `docker.io/pydemia/git-code-reviewer:0.8.0-alpha.22@sha256:0f5c24e021c15facefd9c740033809f958bf48eca1c17f92dfb4a1f8193b3111`
- PostgreSQL image: chart 기본 `latest` 대신 PRISM-DEV의 `linux/amd64` manifest digest로 고정

Local account는 browser에서 접근 가능한 OIDC endpoint가 없는 PRISM-DEV 검증용이다. 운영 환경에서는 사내 OIDC와 HTTPS Ingress를 사용한다. 이 profile에는 Ingress나 외부 Service를 추가하지 않는다.

PRISM-DEV의 outbound HTTPS는 `SK holdings C&C` TLS inspection CA로 다시 서명된다. ChatGPT/Codex와 GHES HTTPS 요청을 검증하려면 해당 root CA를 `git-code-reviewer-corporate-ca` ConfigMap의 `ca.crt` key로 먼저 등록해야 한다. 인증서 파일은 Git에 넣지 않는다.

## 배포

아래 namespace·Secret·CA 생성은 최초 설치 절차다. 재배포에서는 기존 Secret과 CA를 유지하고 `helm upgrade`와 검증만 수행한다. 특히 PostgreSQL password와 credential encryption key를 다시 생성하면 기존 데이터나 등록 credential을 사용할 수 없게 된다.

사용자 요청에 따라 기능·설정 변경을 commit·push하면 PRISM-DEV 배포와 검증도 함께 수행한다. 재배포는 현재 release의 `--reuse-values`에 새 image tag·digest만 지정해 관리자가 변경한 운영 설정을 보존한다. 배포 결과만 기록하는 후속 documentation commit에는 image rebuild·재배포가 필요하지 않다.

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

## 2026-09-07 Review 등록 삭제·사용자 선택 등록 오류 수정

14:04 KST에 Helm revision 15로 application `0.8.0-alpha.7`, chart `0.10.5`를 배포했다. Source commit은 `a66523a5569d`이며 image index digest는 `sha256:21a0ed8f5d2525c2fa7809d027bec6b832da594c816d7daef952de3f83dc0471`, OCI chart digest는 `sha256:b738b65a600b1f08cb17dc7f0553fb0a6dc1f5a10d42f3a7f53f5847c723f0df`다. Image는 `linux/amd64`와 provenance/SBOM attestation을 포함한다.

등록 시 사용자를 선택하면 `repository_grants.role` 누락으로 PostgreSQL `23502`와 HTTP 500이 발생하던 문제를 수정했다. 이제 `reviewer` role을 명시해 저장하며 기존 grant와 충돌하면 중복 생성하지 않는다. 격리된 local PostgreSQL/Fastify API에서 수정 전 실패와 수정 후 HTTP 201, 재등록 시 동일 ID·grant 1건을 확인했다.

관리자는 repository 카드의 `등록 삭제`에서 정확한 Owner/Repository를 입력해 등록을 제거할 수 있다. Migration `0012`의 `deleted_at`으로 목록·접근·polling에서 제외하고 대기 작업·grant를 정리한다. Running job은 409로 보호한다. GitHub 원본, connection/token과 기존 PR 댓글은 유지하고 분석·Chat 기록은 retention 정책에 따라 보관한다.

| 검증 항목      | 결과                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------ |
| 사전 검증      | Vitest 22개 파일 135건(PostgreSQL integration 5개 포함), lint·typecheck·build·Helm lint·server dry-run 통과  |
| Migration      | `0012_repository_deletion.sql` 적용, migration 총 12개                                                       |
| Server/Worker  | 각각 `1/1 Ready`, restart 0회, 새 image digest 적용, Scheduler leadership 재획득                             |
| Health/Route   | Helm test 성공, health 4개 endpoint HTTP 200, HTTPRoute Accepted/ResolvedRefs=True                           |
| Web/API        | 실제 hostname에서 `0.8.0-alpha.7`, 삭제 UI가 포함된 JS와 `/guide` HTTP 200, 비로그인 repository API HTTP 401 |
| 기존 데이터    | users 3명, Chat accounts 1개, GHES credential 1개, repository 1개, grant 1건 유지                            |
| Storage/Secret | 기존 두 PVC의 PV ID와 auth/registry/PostgreSQL Secret UID·resourceVersion 유지                               |
| Log            | 배포 후 Server/Worker warning/error 0건                                                                      |

실제 GitHub repository를 대신 등록하거나 PR 댓글을 게시하지 않았다. 기존 연결 설정은 그대로 두었으므로 관리자 화면에서 URL과 사용자 권한을 선택해 등록을 다시 시도할 수 있다. 삭제 UI의 desktop/mobile 동작은 앞선 local Browser 검증과 독립 UI 검토(`ship`)로 확인했다.

## 2026-09-07 Commit Defender report UI 배포

18:43 KST에 Helm revision 18로 application `0.8.0-alpha.8`, chart `0.10.7`을 배포했다. Source commit은 `bd017f211c58`이며 image manifest digest는 `sha256:3d5d4307295805f215654daa8a94a9a449c78e3cf69bf94cb4389b7deb04f56a`, OCI chart digest는 `sha256:fae95f79c9e28c5971b74058161edac056a8407c1390abdf427f96e2b87425bd`다.

첫 upgrade에서 삭제된 fixture row를 Server bootstrap이 다시 polling해 새 Server가 시작되지 않았다. Upgrade를 취소해 revision 17에서 기존 release로 자동 rollback한 뒤, `ensureFixtureRepository`가 활성 fixture ID만 반환하도록 수정하고 PostgreSQL integration test를 추가했다. 고정 image와 chart를 다시 게시한 revision 18은 정상 완료됐다.

| 검증 항목     | 결과                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------ |
| 사전 검증     | Vitest 169건 통과, DB integration 20건은 URL 미설정으로 skip; lint·typecheck·Helm lint 통과            |
| 수정 검증     | 임시 PostgreSQL에서 관련 integration·unit 8건, runtime lint·typecheck 통과                             |
| Migration     | `0013`–`0015` 적용, migration 총 15개                                                                  |
| Server/Worker | 각각 `1/1 Ready`, restart 0회, 동일 image digest 적용                                                  |
| Health/Route  | Helm test 성공, live·ready·startup·dependencies 정상, HTTPRoute Accepted/ResolvedRefs=True             |
| 운영 데이터   | users 3명, Chat account 1개, GHES credential 1개, 활성 repository 2개, analysis 31건, report 26건 유지 |
| Log           | 배포 후 Server/Worker warning/error 0건                                                                |

이번 image는 PRISM-DEV node에 맞춘 `linux/amd64` 단일 platform이다. Build 환경에서 Dockerfile frontend와 SBOM scanner remote 조회가 완료되지 않아 provenance/SBOM attestation은 포함하지 않았다.

## 2026-09-07 Main review tabs와 Chat 단축키 배포

20:01 KST에 Helm revision 19로 application `0.8.0-alpha.9`, chart `0.10.8`을 배포했다. Source commit은 `7bf85eb5af12`이며 image manifest digest는 `sha256:d59632677e4df8d871581cde38addcca486f6ac447f9a856c321b7e015e4c8cc`, OCI chart digest는 `sha256:0c3ae26bcb10c9fe8075e2d43a123cb03ba37e20adc37c5fb994697147b12ef2`다.

LNB는 Files·Outline·Impact 탐색만 유지하고 메인 toolbar에 Code·Summary·Comments 탭을 추가했다. Summary는 전체 상태와 Overall Summary·Analyzed File List·Model/Skill provenance를 표시한다. Comments는 Commit Defender의 unit-comment-block에 해당하는 AI comments만 표시하며 comment 선택 시 Code의 정확한 revision line으로 이동한다. Chat 입력은 Enter로 전송하고 Shift+Enter로 줄을 바꾼다.

Vitest 169건 통과, PostgreSQL integration 20건 skip, web lint·typecheck·production build·Impeccable layout detector·Helm lint가 통과했다. 배포 후 Server/Worker는 각각 `1/1 Ready`, restart 0회이며 Helm test와 health endpoint가 정상이고 warning/error log는 0건이다. 실제 배포 화면에서 Summary·Comments 전환과 Shift+Enter 줄바꿈을 확인했다.

## 2026-09-07 분석 lifecycle 상태 표시 배포

20:30 KST에 Helm revision 20으로 application `0.8.0-alpha.10`, chart `0.10.9`를 배포했다. Source commit은 `99d00395c066`이며 image manifest digest는 `sha256:6ba6774875548e5e9ca309dc68a44940957d54c797b2747ccaecd9a130b1edf7`, OCI chart digest는 `sha256:f19fcc54733aee31dc1581f404069bb4a8ba4dd96422d29a63630c950b25a3d3`다.

분석 상태는 `분석 대기`, `분석 중`, `분석 완료 · PASS`, `분석 완료 · BLOCKED`, `분석 완료 · 제한 있음`, `분석 실패`, `분석 미수행`, `분석 취소`로 구분한다. 기존 `분석 미완료`는 파일 검토가 끝났지만 symbol adapter 등 제한이 있는 결과도 미완료처럼 보이게 하므로 `분석 완료 · 제한 있음`으로 바꿨다.

관련 unit test 11건과 lint·web typecheck·production build·Helm lint가 통과했다. 배포 후 Server/Worker는 각각 `1/1 Ready`, restart 0회이고 Helm test와 live·ready·startup·dependencies endpoint가 정상이다. 실제 AI report 화면에서 `1/1 files 검토 완료`, `ai-powered`, `분석 완료 · 제한 있음` 표시를 확인했다.

## 2026-09-08 모델 목록·분석 진행률·구조화된 Comments 배포

07:43 KST에 Helm revision 21 upgrade를 시작해 07:44 KST에 완료했다. Source는 새 요청 직후 원격에서 확인한 `d9f9418a2056bf3fc436c5cb2449ba17ae5eaf52`다. 앞서 빌드 중이던 `9e80b53` image는 취소했고 registry나 클러스터에 게시하지 않았다.

- Application: `0.8.0-alpha.11`, chart: `0.10.10`
- Image index digest: `sha256:7ea9ee6363a0ffd7e221908b17b874f01df55a5a8a0d3cff4c73d58f2f3faf85`
- Linux/amd64 image manifest: `sha256:0d5f2416b8efd56a3c0bb88a81ac533a23c1b8d8419bccf128e77b87c0a90516`
- OCI chart digest: `sha256:5ee8cf84b5a78bfaf74183f14cac04f3cbe3dc50b905151b8b1fdd7721faf7ad`

ChatGPT model catalog 조회, 분석 미수행 Report 정리, 분석 진행률/status API, 구조화된 Summary·AI Comments와 inline 설명을 포함한다. Image에는 SPDX SBOM과 SLSA provenance attestation이 있으며 registry manifest에서도 두 predicate를 확인했다. Build CA는 BuildKit secret으로 전달했고 image에는 남기지 않았다.

| 검증 항목 | 결과 |
| --- | --- |
| Local 검증 | 38 files, 212 tests 통과. 전용 PostgreSQL integration 포함, skip 없음. Lint·typecheck·production build 통과 |
| Container | Linux/amd64, UID 1000, read-only/network-none smoke 통과. Built-in Skill 9개·migration 16개·새 status API와 model catalog 함수 확인 |
| Helm | Chart lint, server-side dry-run, upgrade와 Helm test 통과 |
| Migration | `0016_analysis_progress.sql` 적용. `analysis_runs.progress_detail`은 nullable JSONB, 기존 데이터 수정 없음 |
| Workload | Server·Worker 각각 1/1 Ready, restart 0회. Retention CronJob도 동일 digest로 갱신 |
| Route/Health | 기존 HTTPRoute Accepted/ResolvedRefs=True. Host `pr-review.prism.ai`로 live·ready·startup·dependencies HTTP 200 |
| Web/API | `/api/v1/system`의 version `0.8.0-alpha.11`. `/login`·`/guide`와 새 bundle HTTP 200. 비로그인 repository/status API HTTP 401 |
| 운영 데이터 | users 3명, Chat account 1개, GHES credential 1개, 활성 repository 2개, analysis 36건, report 31건 유지 |
| Storage/Secret | 기존 두 PVC의 PV ID와 auth/registry/PostgreSQL Secret UID·resourceVersion 유지 |
| Log | 새 Server/Worker warning/error log 0건, Server의 scheduler leadership 재획득 확인 |

Server startup probe와 Worker readiness probe가 listen 직전 각각 한 번 connection refused를 기록했지만 이후 정상화됐고 container restart는 없다. Health의 model 상태는 실제 ChatGPT inference 성공을 뜻하지 않는다. 운영 account로 모델 조회·분석·Chat을 실행하거나 PR 댓글을 새로 게시하는 검증은 하지 않았다. 새 UI는 실제 제공되는 bundle에 model catalog route·progressDetail·분석 단계 문구가 포함됐는지 확인했으며 이번 배포에서 별도 visual browser 검토는 수행하지 않았다.

## 2026-09-08 Workspace 배치 재배포

10:03 KST에 source `74cdc056833ae7b2866bc27a30a8635c9b94b5b2`를 Helm revision 22로 배포했다. 기존 release values를 재사용하고 PRISM-DEV values의 image tag·digest를 갱신했다.

- Application: `0.8.0-alpha.12`, chart: `0.10.11`
- Image index digest: `sha256:9380c382eddf61f5871ba71042a8e8750a5ca0ad787ced77c87ea345f426d839`
- Linux/amd64 image manifest: `sha256:cd318955818ae28cca7124310080c705e91cb74bf955604a99314b9f30a6167d`
- OCI chart digest: `sha256:4e12f934a4a56f7abd6b357cfb15296ddc66d1dfd4dd06c6e6958a390f4aef84`

Files 기본 전체 펼침, LNB 숨김 toggle, Chat 기본 너비 569px, 하단 Comments와 기본 높이 280px를 반영했다. Summary는 PR 전체 요약 다음에 펼쳐진 파일별 검토를 보여준다. 현재 파일의 inline comment를 기본 표시하고 선택 시작 line만 강조하며 comment 너비는 최대 880px로 제한한다.

| 검증 항목 | 결과 |
| --- | --- |
| Source 검증 | 선행 UI 작업에서 PostgreSQL integration을 포함한 218 tests / 39 files, lint·typecheck·Web build·desktop/mobile browser 검증 통과 |
| Container | 기본 `node:22-alpine`에서 전체 production build 통과. Linux/amd64, UID 1000, read-only/network-none smoke 통과. Built-in Skill 9개·migration 16개 확인 |
| Supply chain | Registry의 SPDX SBOM·SLSA provenance predicate 확인. Build CA는 BuildKit secret으로 전달했으며 runtime image에 없음 |
| Helm | Lint·server-side dry-run·upgrade 통과. 10:05 KST Helm connection test 성공 |
| Workload | 신규 Server·Worker 각각 1/1 Ready, restart 0회. Retention CronJob image도 동일 digest로 갱신 |
| Route/Health | 기존 HTTPRoute Accepted/ResolvedRefs=True. Host `pr-review.prism.ai`로 live·ready·startup·dependencies HTTP 200 |
| Web/API | `/api/v1/system` version `0.8.0-alpha.12`, `/login`·`/guide` HTTP 200. 비로그인 repository API HTTP 401 |
| 운영 데이터 | users 3명, Chat account 1개, GHES credential 1개, 활성 repository 2개, report 31건 유지. Migration 16개로 신규 migration 없음 |
| Storage/Secret | 두 PVC의 PV ID, auth/registry/PostgreSQL Secret UID·resourceVersion, Corporate CA와 HTTPRoute 유지 |
| Log | 확인한 신규 Server/Worker log에서 warning/error 0건. Server scheduler leadership 재획득 확인 |

실제 HTTPRoute가 제공하는 JS·CSS의 SHA-256이 선행 browser 검증에 사용한 production bundle과 일치했다.

- `/assets/index-DcBl5qze.js`: `925d20fce6d884fd0e16ea04647c48465e51a63ed037f2ef028aefd9c28152a0`
- `/assets/index-DEzCKiYU.css`: `21fde48398cf0748b42431695c739d938a90d8fb0e68633b295da76216d11fd2`

배포 전 실행 중인 analysis는 없었다. 기존 polling 설정은 유지했으며 확인 사이 analysis 수는 37건에서 38건으로 증가했다. 이번 검증에서 실제 모델 분석·Chat·PR 게시를 별도로 요청하지 않았다. 로그인 후 live UI 조작 검증은 재실행하지 않았으며 동일 bundle의 선행 합성 browser 검증과 live artifact 일치 검증을 구분한다. 기존 Worker는 설정된 900초 종료 유예에 따라 Terminating 상태였고 강제 삭제하지 않았다. 신규 Worker rollout은 정상 완료됐다.

## 실제 GHES 및 ChatGPT account 등록

현재 배포는 아래 revision 25 기록을 따른다. 앞선 날짜별 검증 수치는 각 배포 당시의 상태다.

`/admin?tab=github`에서 GHES API/Web base URL과 access token을 등록한 뒤 연결 테스트를 실행하고 review 대상 repository를 등록한다. 등록된 repository는 fixture와 무관하게 해당 token으로 polling과 clone을 수행한다. 사내 CA가 필요하면 `trustedCa.existingConfigMap`을 지정한다.

`/admin?tab=chat`에서는 Codex ChatGPT login의 `auth.json`, 허용 model·effort, tenant 할당을 등록한다. 사용자는 review 화면의 오른쪽 Chat panel에서 할당된 account, model, effort를 선택한다. Access token, auth.json, 암호화 key는 Git repository나 values 파일에 저장하지 않는다.

## 2026-09-08 Skill 번역·Severity Level 및 후속 UI 배포

13:03 KST에 source `cfeba4728c121e0f620d6d48cfb72770e56c1820`으로 Helm revision 23 upgrade를 시작했고, 13:04 KST에 완료했다. 배포 직전 원격 branch와 source가 일치함을 확인했다. Release 설정 commit은 `be15ef8`이다.

- Application: `0.8.0-alpha.13`, chart: `0.10.12`
- Image index digest: `sha256:788efe54c4103fcd4c9962a743a5163c5e1597f398a0aaee2e249ae53acc0fcd`
- Linux/amd64 image manifest: `sha256:232527c1a5663223bd8649ea0d462bf09452185cdfbb5264296e605d3aa7488c`
- OCI chart digest: `sha256:73585bd6fba916fbd47ac77e2f794b66ab3655bad94917d022cbdf1fcee4738f`

6개 perspective의 한국어 원문 번역 version 2와 tenant별 Severity Level을 포함한다. 앞서 미배포였던 Summary Markdown, comment block 전체 클릭, Chat 입력창·글자 크기와 하단 Model 선택, Reviews GNB 설정 버튼 수정도 함께 반영했다. 기존 Helm values를 `--reuse-values`로 유지하고 image tag·digest만 override했다.

| 검증 항목 | 결과 |
| --- | --- |
| 선행 source 검증 | 46 files, 256 tests 통과. 전용 local PostgreSQL integration 포함. Typecheck·lint·Web build·합성 desktop/mobile 검증 완료 |
| Container | `node:22-alpine` 전체 production build 성공. Linux/amd64, UID 1000, read-only/network-none smoke에서 Skill 9개·migration 17개·5개 level 확인 |
| Supply chain | Registry의 SPDX SBOM·SLSA provenance predicate 확인. Build CA는 BuildKit secret으로 전달하며 runtime image에 없음 |
| Helm | Lint·server-side dry-run·upgrade 성공. 13:04 KST Helm connection test Succeeded |
| Migration | `0017_analysis_severity.sql` 적용. DB checksum `ff540ff7f17c8c2daa6584441840cb8a4b7d25f02a0e079cb895ad002d01aa79` 일치 |
| Workload | Server·Worker 각 1/1 Ready, restart 0회. 기존 Pod 종료 확인. Retention CronJob template도 새 digest로 갱신 |
| Route/Health | HTTPRoute Accepted/ResolvedRefs=True. Host `pr-review.prism.ai`로 live·ready·startup·dependencies HTTP 200, 모두 ok |
| Web/API | `/api/v1/system` version `0.8.0-alpha.13`. `/login`·`/guide` HTTP 200. 비로그인 repository API 401, 관리자 API는 기존 정보 은닉 정책대로 404 |
| 데이터 보존 | users 3명, Chat account 1개, GHES credential 1개, 활성 repository 2개, analysis 43건, report 35건 유지. 기존 analysis 43건의 level은 NULL 유지 |
| 설정·Storage | 기존 두 PVC/PV ID, auth/registry/PostgreSQL Secret UID·resourceVersion, Corporate CA와 HTTPRoute UID·resourceVersion 유지 |
| Log | 확인한 신규 Server/Worker log에서 warning/error 0건. Server scheduler leadership 획득 확인 |

Image를 제외한 Helm values의 SHA-256은 배포 전후 `88e6a71dd9b5ec5f03cb90f2309b478847b9451db7f9fb48513a7b9e876e69ef`로 동일하다. 기존 `nfs-csi` artifact RWX, PostgreSQL RWO PVC는 모두 10Gi·Bound다.

실제 HTTPRoute가 제공하는 asset의 SHA-256이 선행 UI 검증 bundle과 일치했다.

- `/assets/index-CbB-AP4c.js`: `6ef4d209d9897a969debc33d9126dee63c0b9ee6ea75d6ecf7d3d681cf7f0bd6`
- `/assets/index-CxGqHCXb.css`: `24a521cc5721a44beb917fc8b54ebe503a4b2068da22bb7dc018f00402003016`

배포 시 활성 custom Skill과 tenant Prompt는 없었다. 새 분석은 Built-in bundle `22896b401cb61acda43d030ff1b135fa0bbc44b7b17d93efd5ffb36595147ce7`과 기본 moderate를 사용한다. 이후 관리자가 Prompt를 저장하면 해당 tenant의 새 queue에 선택한 level이 고정된다. 기존 report를 재작성하거나 실제 모델 분석·Chat·PR 게시를 별도로 실행하지 않았다. 로그인 후 live Browser 조작은 재검증하지 않았으며 선행 합성 Browser 검증과 live artifact 일치 검증을 구분한다.

## 2026-09-08 개인 Prompt·Review Chat·PR AI Comments·Grade 배포

15:11 KST에 Helm revision 24 upgrade를 시작해 15:12 KST에 완료했다. Application source는 `41febd29fcfb67f02a8cfa3654091dca03df6e46`이며 build 전 원격 branch와 일치함을 확인했다. Release 설정 `dab42ad`를 먼저 commit·push한 뒤 배포했다. 이후 deployment record만 담는 commit은 실행 image를 바꾸지 않는다.

- Application: `0.8.0-alpha.14`, chart: `0.10.13`
- Image index digest: `sha256:150fd26eb5bca01ae9d2227e9c13b8b4e163fb5189bbf0c4de0d5ed857306ae5`
- Linux/amd64 image manifest: `sha256:e96ff45d15be57d583024cac475d93f4089e96aeb2af39ac4fb83be8b93c34e7`
- OCI chart digest: `sha256:7d44d7fa177418c6ee60e72e1c9ed29cc21db40126cdc07bb9133c87887faf8f`

프로필의 개인 Prompt 편집·저장과 본인 Review Chat 적용, assistant Markdown 렌더링과 여러 파일/line range 링크, PR 게시의 AI Comments 기본 접기, Grade 한글 문구·색상 개선을 포함한다. 기존 shared PR 분석 지침·account·report·게시된 댓글을 일괄 수정하지 않는다. PR 댓글 형식은 다음 정상 게시·갱신부터 적용된다.

| 검증 항목 | 결과 |
| --- | --- |
| 선행 source 검증 | 312 tests / 52 files 통과, skip 없음. 로컬 PostgreSQL 16 integration, lint·전체 typecheck·Web build와 합성 desktop/mobile Profile 검증 완료 |
| Container | `node:22-alpine` 전체 production build. Linux/amd64, UID 1000, read-only/network-none smoke에서 Skill 9개·migration 18개·Prompt 최대 4,000자·Grade `양호` 확인 |
| Supply chain | Registry의 SPDX SBOM·SLSA provenance 확인. Build CA는 BuildKit secret으로 전달하며 runtime image에 없음 |
| Helm | Lint·server-side dry-run·upgrade 성공. 15:13 KST connection test Succeeded |
| Migration | `0018_personal_chat_prompt.sql` 적용. DB checksum `91859fe9ff95be583810be97360a15111677939b8579a93dc1022e3188a39bc5` 일치. `users.personal_prompt`는 text·NOT NULL·빈 문자열 기본값·4,000자 CHECK |
| Workload | Server·Worker 각 1/1 Ready, restart 0회. 기존 Pod 종료. Retention CronJob도 동일 image digest로 갱신 |
| Route/Health | HTTPRoute Accepted/ResolvedRefs=True. Host `pr-review.prism.ai`로 live·ready·startup·dependencies HTTP 200, 모두 ok |
| Web/API | `/api/v1/system` version `0.8.0-alpha.14`. `/login`·`/guide`·`/profile` HTTP 200. 비로그인 profile/repository GET 401. Prompt PUT은 Origin 누락 시 403, 올바른 Origin의 비로그인 요청은 401 |
| 운영 데이터 | users 7명, Chat account 4개, GHES credential 1개, 활성 repository 2개, analysis 46건, report 38건 유지. 기존 사용자 7명의 개인 Prompt는 빈 값 |
| 설정·Storage | Image 외 Helm values hash, 두 PVC/PV ID·10Gi·Bound·access mode, auth/registry/PostgreSQL Secret과 Corporate CA·HTTPRoute UID/resourceVersion 유지 |
| Log | 검증 중 확인한 신규 Server/Worker log에서 warning/error 0건. Server scheduler leadership 획득 확인 |

Image를 제외한 Helm values의 SHA-256은 배포 전후 `88e6a71dd9b5ec5f03cb90f2309b478847b9451db7f9fb48513a7b9e876e69ef`로 동일하다. Artifact PVC의 resourceVersion은 변경됐지만 UID·연결 PV·용량·RWX 정책은 유지됐다. PostgreSQL RWO PVC와 데이터도 유지됐다.

실제 HTTPRoute가 제공하는 JS·CSS는 게시한 image 안의 asset과 SHA-256이 일치한다.

- `/assets/index-CniFfEwA.js`: `44058b954c30f8beb4be247da45e16a07bc350dddee01e5fc6a5cc6338a37acb`
- `/assets/index-C1U2fJN8.css`: `f7cd1751a7c402b5d84b3197133004e6cad175a8f4dd476ad959c84932ebfcad`

최초 HTTP 검증 script는 JSON 대신 HTML 응답을 받아 중단됐다. 명시적 Host header를 지정한 curl로 실제 경로를 재검증해 위 결과를 확인했다. Prompt PUT의 최초 예상값 401은 Origin 검사 순서를 반영하지 못했으므로 Origin 누락 403과 올바른 Origin의 비로그인 401을 나눠 확인했다. 서버 인증·Origin 정책은 변경하지 않았다.

배포 전 실행 중인 analysis는 없었다. 실제 모델 분석·Chat·PR 게시를 별도로 요청하지 않았고 사용자 Prompt·credential 내용을 읽거나 변경하지 않았다. 로그인 후 live Browser E2E는 재실행하지 않았으며 선행 합성 Browser 검증과 이번 image/HTTPRoute 검증을 구분한다. 새 Prompt의 실제 모델 지시 준수 정확도는 이 배포 검증 범위 밖이다.

## 2026-09-08 사용자 삭제 배포

16:00 KST에 Helm revision 25 upgrade를 시작해 16:01 KST에 완료했다. Application source는 `47770d4d946aa3a3d7c18dd1d5481e2487079938`이며 Backend `7a38da4`와 UI·가이드·검증 기록 `47770d4`를 push한 후 build했다. Release 설정 `1704d23`도 push한 뒤 배포했다.

- Application: `0.8.0-alpha.15`, chart: `0.10.14`
- Image index digest: `sha256:9b966f7404d531cb4a32d6d83d393e34a9a3af1b6b4f4a6e61346e8dd67a7557`
- Linux/amd64 image manifest: `sha256:44dbf2e082f7f599b6e142b9d8a32da172652c4a535c845d690aa693215cfa7e`
- OCI chart digest: `sha256:cd34a6c3e8c7a92290d7b3a3df9348fbac17be66fc060c18fcc64e17ad425cfd`

시스템관리자는 `설정 → 사용자` 행의 휴지통 버튼을 누르고 Local username 또는 외부 Subject를 입력해 삭제한다. 삭제 시 session·개별 권한·개인 Prompt·Local password hash를 정리하고 tombstone으로 재로그인·identity 재사용을 막는다. 개인 Chat은 기존 retention에 따라 보관하며 공동 PR report·설정·audit은 보존한다. 현재 로그인한 본인과 마지막 활성 관리자 제거를 차단한다. 외부 IdP 원본 계정은 삭제하지 않는다.

| 검증 항목 | 결과 |
| --- | --- |
| 선행 source 검증 | 323 tests / 54 files 통과, skip 0. 로컬 PostgreSQL 16 integration·전체 typecheck·lint·Web build·합성 Browser 검증 완료 |
| Container | `node:22-alpine` 전체 production build. Linux/amd64, UID 1000, read-only/network-none smoke에서 migration 19개·Skill 9개·새 Web asset 확인 |
| Supply chain | Registry의 SPDX SBOM·SLSA provenance 확인. Build CA는 BuildKit secret으로만 전달하며 runtime image에 없음 |
| Helm | Lint·server-side dry-run·upgrade 통과. 16:01:47 KST connection test Succeeded |
| Migration | `0019_user_deletion.sql` 적용, checksum `27dc261bde47817158cd6b8ed97fee071578870b47486725ee22901b7d9d4061` 일치. Nullable timestamptz `deleted_at`과 삭제 시 비활성·빈 Prompt CHECK 확인 |
| Workload | 새 Server·Worker 각 1/1 Ready, restart 0회. Retention CronJob도 새 digest로 갱신. 기존 Server는 종료됐으며 기존 Worker는 진행 중인 분석을 마무리하는 동안 종료 대기 |
| Route/Health | HTTPRoute Accepted/ResolvedRefs=True. Host `pr-review.prism.ai`로 live·ready·startup·dependencies 모두 HTTP 200·ok |
| Web/API | `/api/v1/system` version `0.8.0-alpha.15`. `/login`·`/guide`·`/admin?tab=users` HTTP 200. 비로그인 사용자 목록과 존재하지 않는 UUID에 대한 DELETE는 정보 은닉 정책대로 404, profile GET은 401 |
| 운영 데이터 | users 7명, Chat account 4개, GHES credential 1개, 활성 repository 2개 유지. 삭제된 사용자는 0명. 기존 polling 중 analysis 48→49건, report 39→40건으로 증가 |
| 설정·Storage | Image 외 Helm values hash, 두 PVC/PV ID·10Gi·Bound·access mode, auth/registry/PostgreSQL Secret과 Corporate CA·HTTPRoute UID/resourceVersion 유지 |
| Log | 확인한 신규 Server/Worker log에서 warning/error 0건. Server scheduler leadership 획득 확인 |

Image를 제외한 Helm values의 SHA-256은 배포 전후 `88e6a71dd9b5ec5f03cb90f2309b478847b9451db7f9fb48513a7b9e876e69ef`로 동일하다. Artifact PVC의 resourceVersion은 Helm 갱신으로 달라졌지만 UID·PV·10Gi·RWX는 유지됐다. PostgreSQL PVC도 기존 RWO·PV를 유지한다.

실제 HTTPRoute와 게시 image 안의 JS·CSS가 선행 UI 검증 bundle과 SHA-256이 일치한다.

- `/assets/index-DR9xZITm.js`: `665fff1ac6aa57bacfa18204ecb1f6493fd39df6876082f759699553a0964f21`
- `/assets/index-CkCpzNZS.css`: `e786a8d3c9c20328b32d1e1ec84481e02de45cde8ae8940da75a256fd140f673`

배포 직전 분석 1건이 실행 중이었다. Worker의 기존 900초 종료 유예와 진행 중 작업 완료 대기를 유지했으며 강제 삭제하지 않았다. 운영 사용자를 삭제하거나 개인 Prompt·credential 내용을 읽지 않았다. 실제 모델·Chat·PR 게시를 검증용으로 별도 요청하지 않았고 기존 polling·queue 실행은 유지했다. 로그인 후 live Browser E2E는 수행하지 않았으며 [합성 Browser와 DB integration 검증](../../../.documents/verification-user-deletion-2026-09-08.md)과 배포 검증을 구분한다.

16:08 KST 확인 시 기존 Worker `git-code-reviewer-worker-76779559d4-6ljqx`는 아직 Terminating 상태다. 해당 job은 15:58:51 시작했고 heartbeat는 16:07:51까지 갱신됐으며 outcome/error_code는 NULL이다. Pod 삭제 확인을 위한 45초 대기 두 번은 timeout됐지만 신규 deployment의 rollout·health는 통과했다. 새 Server·Worker는 1/1 Ready·restart 0회이며 기존 Worker만 분석을 마무리한 후 회수될 예정이다.

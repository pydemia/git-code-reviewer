# Git Code Reviewer - Agent Handoff

## 1. 현재 상태

- 최종 갱신: 2026-09-07
- branch: `feat/browser-review-service`
- 단계: Review 등록 삭제와 사용자 선택 등록 오류 수정 검증 완료. PRISM-DEV revision 14에서 후속 배포 준비 중
- remote: phase별 구현과 release commit을 `origin/feat/browser-review-service`에 push함
- 사용자 소유 `.vscode/` 변경: 건드리지 않음

현재 repository에는 browser application, Node.js Server/Worker runtime, PostgreSQL schema, shared artifact storage, container image와 Helm chart가 있다. 기존 CI/CD 중심 방향은 Kubernetes에서 중앙 운영하는 사내 web service로 교체했다.

### 1.0 2026-09-07 후속 작업: 등록 삭제와 등록 실패 진단

Worktree에 Review repository `등록 삭제` UI/API와 migration `0012_repository_deletion.sql`을 추가했다. 삭제는 `deleted_at` tombstone으로 구현하며 목록·deep link·polling에서 제외하고 queued job/operation/analysis와 grant를 정리한다. Running job이 있으면 409를 반환한다. Connection/token, GitHub 원본과 PR 댓글은 보존하며 기존 기록은 retention 정책을 따른다. 재등록은 같은 ID를 사용하지만 과거 grant는 복원하지 않는다. 삭제된 fixture의 bootstrap 재생성과 in-flight polling의 새 작업 생성을 차단했다. 이 변경은 아직 위 revision 14 배포에 포함되지 않았다.

검증: 전용 local PostgreSQL에서 migration 0001–0012와 lifecycle integration 4개를 포함한 전체 133 tests 통과. Lint, typecheck, production build와 변경 파일 format 검사도 통과했다. Desktop 1440×1100과 mobile 390×844에서 취소·Escape의 focus 복귀, 확인값 불일치, 실제 API의 409 안내, 삭제 성공·새로고침 후 목록 제외와 heading focus를 확인했다. 삭제 후 DB는 등록 비활성·polling/게시 중지, queued job 2개 `REPOSITORY_DELETED`, grant 0건이었다. 모든 삭제 검증은 synthetic fixture로 실행했으며 PRISM-DEV의 repository나 credential은 변경하지 않았다. Browser screenshot은 `.impeccable/review/`에 있다. 재배포할 때 migration 0012를 포함해야 한다.

Impeccable finish review는 삭제 UI·가이드 범위에서 `ship`으로 완료했다. 삭제 UI 검증용 local Server·Browser·PostgreSQL은 종료·정리했다. 후속 사용자 요청은 등록 오류 수정, git push와 PRISM-DEV 재배포까지 포함한다.

등록 실패 진단: 2026-09-07 13:21 KST의 Server 요청 `94f69b27-7f68-46e6-8ddb-125f1256a990`에서 PostgreSQL `23502`가 발생했다. `registerGitHubRepository`의 `repository_grants` INSERT가 필수 `role` 값을 누락했다. GitHub repository 조회 후 사용자 grant를 저장하는 단계에서 전체 transaction이 rollback되어 HTTP 500이 반환됐다. Live connection은 GitHub.com API/Web root와 `ready` 상태를 확인했으며 token 원문을 조회·출력하지 않았다. URL trailing slash나 connection 인증 오류가 이번 실패 원인은 아니다.

사용자 승인 후 INSERT에 `role='reviewer'`를 명시했다. 실제 PostgreSQL과 Fastify API를 연결한 사용자 선택 등록 test에서 수정 전 HTTP 500을 재현하고 수정 후 HTTP 201, reviewer grant 저장, 재요청 시 같은 repository ID와 grant 1건 유지를 확인했다. Mock route 회귀 test도 추가했고 기존 mock이 INSERT SELECT를 credential 조회로 잘못 분류하던 조건 순서를 바로잡았다. 전체 135 tests(22 files, PostgreSQL integration 5개 포함)가 통과했다. 더 이상 `관리자만`으로 우회 등록할 필요가 없다.

### 1.1 2026-09-04 확정 요구사항과 구현 상태

사용자가 다음 target behavior를 확정했다.

- 시스템 관리자는 여러 ChatGPT account를 등록하고 account별 model, 허용/default/max reasoning effort와 tenant/user/group assignment를 관리한다.
- 일반 사용자는 허용된 Chat account, model과 effort를 선택해 대화를 시작한다. 선택은 session에 고정되고 변경하면 새 session을 만든다.
- 시스템 관리자는 GHES access-token connection과 review repository를 등록하고 repository별 polling interval/disabled/Poll now trigger 및 user/group grant를 관리한다.
- GHES token이 부여하는 외부 read/write 권한과 application repository grant는 별도로 검사한다.
- 외부 OIDC endpoint를 browser에서 사용할 수 없는 PRISM-DEV에서는 Local account mode로 시스템관리자와 일반사용자를 구분한다.
- 시스템관리자는 Local account의 role, 활성 상태, tenant membership, repository grant와 비밀번호를 관리한다. 일반사용자는 grant를 받은 repository만 조회한다.
- 로그인 사용자는 GNB의 `/profile`에서 계정 정보와 tenant를 확인한다. Local account는 표시 이름과 비밀번호를 직접 변경하며, 비밀번호 변경 시 현재 비밀번호를 확인하고 모든 session을 폐기한다. 비밀번호 길이는 8~128자다. 외부 identity는 IdP에서 관리한다.
- 로그인 사용자는 모든 주요 화면의 GNB에서 `/guide`로 이동해 role별 사용 절차, GHES PAT 최소 권한·입력·회전, repository polling, Review Chat과 오류 진단을 확인한다.
- 시스템관리자는 등록된 GHES connection의 이름, API/Web URL, credential label, token 만료일과 선택형 새 token을 수정한다. Token을 비워 두면 암호문과 version을 유지하고, API 또는 Web origin을 바꿀 때는 새 token을 필수로 요구한다. 공유 instance의 공통 이름·URL은 수정할 수 없다.

Credential registry는 migration `0009`, Local account는 migration `0010`으로 구현됐다. PRISM-DEV에는 `admin` 시스템관리자와 `reviewer` 일반사용자가 있고 fixture repository grant는 `reviewer`에게 부여되어 있다. Bootstrap 비밀번호는 Kubernetes Secret에만 있으며 Git에는 없다. 실제 ChatGPT account는 등록되어 `gpt-5.6-sol` Chat까지 검증했지만 실제 GHES token과 private repository E2E는 남아 있다. `/admin?tab=github`에서 실제 credential을 등록·검증해야 한다. Local user의 repository grant는 `/admin?tab=users`에서 사후 부여·회수할 수 있다. Group grant 편집 UI는 후속 범위다.

## 2. 제품과 runtime 경계

1. GUI는 VS Code/browser extension이 아니라 Server가 제공하는 browser application이다.
2. Server는 bundled web UI, REST/SSE, 인증, 인가, polling과 interactive Review Chat을 담당한다.
3. Worker는 Git fetch, immutable snapshot materialization, deterministic analysis와 선택형 batch model 분석을 담당한다.
4. PostgreSQL이 tenant, application user, membership, repository grant, provider/prompt version, durable job, operation/event, report와 Chat record의 정본이다. 별도 queue는 두지 않는다.
5. Artifact는 shared RWX PVC를 사용한다. Worker workspace는 `emptyDir` 또는 pod 단위 generic ephemeral PVC를 사용한다.
6. GitHub Enterprise 접근은 repository 범위를 제한한 fine-grained PAT과 outbound polling/manual refresh를 사용하며 repository workflow와 webhook은 요구하지 않는다. Metadata/Contents는 read, Pull requests는 PR timeline review 댓글 생성·갱신 때문에 read/write가 필요하다. GHES 정책상 fine-grained PAT을 사용할 수 없을 때만 classic PAT의 `repo` scope를 사용한다.
7. Report는 Commit Defender의 grade, summary, per-file summary, P0-P3 category, finding, evidence와 exact-revision link를 계승한다.
8. Workspace는 크기를 조절할 수 있는 LNB/Main/Chat/FNB panel, 실제 Evidence/Git graph/Impact/Tests view와 responsive unified diff fallback을 제공한다.
9. Object impact는 structure parent/children과 dependency uses/used-by를 구분한다. 중복된 FNB 최상위 tab 대신 Impact 내부에서 표현한다.
10. Tests view는 report data를 바탕으로 추가된 test의 목적, test case와 assertion을 설명한다.

## 3. Tenant, identity와 authorization

책임은 다음과 같이 분리한다.

- Keycloak 또는 기존 사내 OIDC provider: 로그인, MFA/SSO, 사용자 identity와 관리자 role
- Local account mode: 외부 OIDC endpoint가 없는 private pilot의 application 로그인과 role
- PostgreSQL: application enabled 상태, tenant, membership, repository grant와 prompt version
- Cerbos: principal/action/resource 속성을 사용하는 RBAC+ABAC decision

Role은 `reviewer`, `administrator` 두 개다. Keycloak client role `git-code-reviewer-admin`, realm role 또는 설정된 admin group을 administrator로 매핑한다. Reviewer는 enabled tenant membership과 repository subject/group grant를 모두 가져야 repository와 PR을 볼 수 있다. 권한 없는 단일 resource는 존재 여부를 감추도록 404를 반환하며 Cerbos timeout, 오류 또는 잘못된 응답은 503으로 fail closed한다.

Keycloak은 선택형 Bitnami chart dependency로 포함했고 enterprise values 예시에서 활성화한다. 전용 realm, confidential client, PKCE, admin client role과 groups mapper를 `keycloak-config-cli` hook으로 구성하며 별도 PostgreSQL PVC를 사용한다. 조직이 Entra ID, Okta, PingFederate 같은 OIDC provider를 이미 운영하면 기본값처럼 `keycloak.enabled=false`로 두고 기존 provider를 사용할 수 있다. Bundled mode에서도 identity DB, realm, TLS, HA, backup과 patch lifecycle은 application과 분리해 운영한다. Cerbos는 chart에 선택적으로 포함하거나 외부 PDP URL을 지정한다.

관리자 browser UI `/admin`은 다음 기능을 제공한다.

- tenant 생성, 표시 이름 변경, 활성/비활성 전환
- Local account 생성, 표시 이름·role·활성 상태·비밀번호, tenant membership과 repository grant 관리
- 전역 분석 Provider immutable version 생성, 연결 테스트, 과거 version 재활성화, deployment 설정 복원
- tenant별 분석 prompt immutable version 생성, 과거 version 재활성화, built-in prompt 복원

일반사용자와 시스템관리자는 GNB의 `/profile`에서 identity type, 사용자 이름 또는 subject, role과 tenant membership을 확인한다. Local account는 표시 이름과 8~128자 비밀번호를 직접 변경할 수 있다. 비밀번호 변경 성공 시 모든 session을 삭제하고 다시 로그인하도록 하며, schema validation과 현재 비밀번호 오류를 포함한 성공·실패 요청을 audit event로 기록한다. 표시 이름 변경과 audit insert는 같은 database transaction에서 처리한다.

## 4. 분석 Provider와 prompt 관리

분석 Provider는 모든 tenant가 공유하는 전역 설정이다. `/admin?tab=provider`에서 `disabled` 또는 `openai-compatible` mode, endpoint, 정확한 model ID, timeout과 API key를 설정한다. Endpoint는 deployment가 정한 exact-origin allowlist를 통과해야 하며, 연결 테스트에는 repository source, diff와 tenant prompt를 보내지 않고 `Reply with OK.` 최소 요청만 보낸다.

Provider version은 수정하거나 삭제하지 않는다. API key는 deployment Secret의 32-byte master key로 AES-256-GCM 암호화하며 API와 browser에는 설정 여부만 반환한다. Active 관리자 version이 없으면 deployment 환경 설정으로 fallback한다. 같은 key를 유지한 새 version을 만들 수 있지만, deployment fallback 또는 credential이 없는 version에서 OpenAI-compatible mode를 저장할 때는 새 key가 필요하다.

관리자 지침은 built-in source-as-untrusted guard와 structured JSON output contract 사이에만 추가된다. Tenant prompt가 이 두 고정 경계를 교체할 수 없고, report와 audit event에는 원문 대신 prompt version ID와 SHA-256 hash만 기록한다.

분석 작업 생성 시 active provider와 prompt의 version/hash를 `analysis_runs`에 함께 고정한다. 이후 관리자가 active version을 변경해도 이미 queue된 분석은 기존 조합을 사용한다. 같은 prompt 지침을 다시 저장하면 중복 row를 만들지 않고 기존 version을 활성화한다. 과거 version은 report 재현성을 위해 삭제하지 않는다.

주요 파일:

- `apps/runtime/src/routes/admin.ts`
- `apps/runtime/src/services/authorization.ts`
- `apps/runtime/src/jobs/worker.ts`
- `apps/web/src/AdminPage.tsx`
- `packages/db/migrations/0007_tenancy_authorization_prompts.sql`
- `packages/db/migrations/0008_analysis_provider_administration.sql`
- `deploy/helm/git-code-reviewer/cerbos/policies/`
- `docs/operations/identity-authorization.md`

## 5. ChatGPT account 연동

Review Chat은 `disabled`, `openai-compatible`, `chatgpt-account`, `registry` 네 mode를 지원한다.

`chatgpt-account`는 Demian의 Node.js Codex provider에서 확인한 공개 동작과 호환되도록 구현했다. `demian-cli` package는 관련 없는 agent runtime까지 bundle하고 안정적인 TypeScript declaration을 제공하지 않으므로 dependency로 추가하지 않고 작은 local provider boundary만 유지했다.

기존 `chatgpt-account` mode는 deployment-owned Codex `auth.json`을 전용 writable PVC에서 읽는다. 새 `registry` mode에서는 관리자가 auth.json을 등록하고 tenant/user/group에 account를 할당한다. AES-256-GCM 암호문만 PostgreSQL에 저장하며 API는 credential 원문을 반환하지 않는다. 사용자는 할당된 account, model, effort를 선택하고 이 조합과 credential version은 Chat session에 고정된다. Token refresh 결과도 같은 master key로 다시 암호화해 version을 올린다.

GHES access token도 같은 registry master key로 암호화한다. 저장소는 `credential_id`를 가지며 Server polling과 Worker clone/PR publication 직전에만 token을 복호화한다. 기본 `registry` mode는 전역 GitHub reader를 만들지 않고 저장소별 token client만 사용한다. Rolling update 중 새 Server가 advisory lock 획득에 실패하더라도 15초마다 재시도한다. Fine-grained PAT은 대상 repository만 선택하고 Metadata/Contents read와 Pull requests read/write를 허용한다. Credential label은 application 내부 식별자이며 같은 instance/label 재등록은 token rotation으로 처리한다. 등록된 connection 수정은 credential ID, repository 참조와 enabled 상태를 유지한다. 저장 직후 health를 `unverified`로 바꾸고 연결 테스트가 성공해 `ready`가 되기 전에는 polling, Git materialization, PR publication과 repository 등록에서 token을 복호화하지 않는다.

Migration `0011_github_review_publication.sql`과 `github.review.publish` durable job은 application `0.8.0-alpha.6`에 포함되어 PRISM-DEV에 배포됐다. Repository별 게시 toggle을 켜면 completed/partial report의 한국어 요약을 GHES PR timeline 관리 댓글로 생성하고 후속 분석에서는 같은 comment ID를 갱신한다. 저장된 ID가 없으면 HMAC marker를 검색해 crash retry의 중복 생성을 막는다. 게시 403은 `GITHUB_REVIEW_PERMISSION_DENIED`로 격리하며 report 상태를 바꾸지 않는다. 기존 repository의 `review_publishing_enabled`는 migration의 기본값 `false`를 유지한다.

같은 release에 GitHub.com 기준 textbox·guide 예시(API `https://api.github.com`, Web `https://github.com`)와 전체 Repository URL 등록을 포함했다. `https://github.com/org-name/repo-name`를 입력하면 shared parser가 Owner/Repository를 표시하고 Server가 선택한 연결 origin과 token 권한을 확인해 canonical 이름을 저장한다. 기존 owner/name API 입력은 유지한다. 연결 미검증, 잘못된 base URL, host mismatch, API 401/403/404와 network 오류는 한국어 조치 안내를 제공한다. 기존 live 연결 값은 자동으로 수정하지 않는다.

사용자 요청으로 예시와 test fixture는 `org-name/repo-name`으로 익명화했다. URL 등록은 synthetic API를 연결한 local Chromium에서 1440px/390px UI, `.git` 정규화, POST payload, 404 안내, 다른 host 차단과 console page error 부재를 확인했다. PRISM-DEV 재배포 후 실제 HTTPRoute가 제공하는 bundle에서도 예시와 Repository URL·PR 게시 안내를 확인했다. 실제 GitHub repository 등록과 PR 댓글 작성은 실행하지 않았다.

## 6. 배포 artifact

### Container image

- image: `docker.io/pydemia/git-code-reviewer:0.8.0-alpha.6`
- source revision: `be2f56fc007c`
- manifest digest: `sha256:1cc09f22a72df16538c02b348db2f58a775348bc4315967d2aef3fef630ad218`
- platform: `linux/amd64`
- supply-chain metadata: BuildKit provenance와 SBOM attestation 포함

하나의 immutable image가 `serve`, `worker`, `migrate`, `retention` command를 제공한다.

### Helm chart

- chart: `oci://registry-1.docker.io/pydemia/git-code-reviewer`
- version: `0.10.4`
- app version: `0.8.0-alpha.6`
- chart digest: `sha256:361373950c273f395162749daf92f868c5da362e147967d8d86daddc61b3b7ea`
- 기본 database: 외부 PostgreSQL 15+
- pilot database: `postgresql.enabled=true`이면 별도 RWO PVC와 함께 Bitnami PostgreSQL dependency 설치
- identity: enterprise 예시는 `keycloak.enabled=true`로 Bitnami Keycloak `25.2.0`, TLS Ingress와 전용 PostgreSQL dependency 설치
- authorization: `authorization.mode=cerbos`, `cerbos.enabled=true`이면 bundled Cerbos와 versioned policy 설치

Enterprise values 예시는 image manifest digest를 고정한다. Chart는 Server/Worker Deployment, Service/Ingress, migration 경로, retention CronJob, artifact PVC, 선택형 account PVC, Keycloak, Cerbos, security 설정과 선택형 PostgreSQL dependency를 생성한다. Provider 관리가 켜지면 allowlist를 ConfigMap에 넣고 같은 model Secret의 암호화 master key를 Server와 Worker에 주입한다.

Bitnami의 2025 community catalog 전환으로 Keycloak chart `25.2.0`의 원래 `bitnami/*` 고정 image tag는 현재 pull되지 않는다. Bundled 기본값은 실제 존재를 확인한 정확한 `bitnamilegacy/*` tag를 사용하지만 보안 update가 없으므로 pilot 용도다. 운영 전에는 조직이 검증한 internal rebuild/mirror 또는 Bitnami Secure Images의 repository/digest로 교체해야 한다.

## 7. 검증 상태

Local에서 완료한 항목:

- Prettier format check, ESLint, TypeScript typecheck
- production application build
- Vitest 20개 파일, 118개 test (Repository URL parser와 등록 API의 성공·오류 경로 포함)
- 임시 PostgreSQL 16에서 migration `0001`~`0011` 순차 적용과 publication table/column 확인
- 실제 Cerbos 0.55.0 policy compile/decision test 29개
- ARM64 Docker Desktop의 kind Kubernetes 1.34.8에서 PostgreSQL/Server/Worker/PVC Ready
- `GITHUB_MODE=registry`, credential registry API 활성화와 dependencies health HTTP 200
- 기본, enterprise, bundled PostgreSQL+Cerbos Helm lint
- default Keycloak 비활성, enterprise Keycloak 활성과 앱/Keycloak PostgreSQL 동시 render
- Keycloak TLS Ingress, Secret 참조, realm/client/PKCE/admin role/groups mapper JSON과 OIDC discovery Helm test 확인
- 잘못된 auth mode, TLS, auth Secret, admin role, callback과 database 설정의 fail-fast 확인
- bundled PostgreSQL+Cerbos+ChatGPT account 복합 Helm render
- local PostgreSQL migration과 실제 Cerbos mode authorization integration test

PRISM-DEV release revision 4 검증:

- Kubernetes API `https://10.250.107.193:6443`, namespace/release `git-code-reviewer`
- Server/Worker 1개씩 Ready, restart 0회, image digest `sha256:52d95d...e94b4`
- migration `0009_account_and_ghes_registries.sql` 적용
- Helm test, health API, fixture repository 1개/PR 2개와 기존 분석 결과 확인
- synthetic ChatGPT account의 암호문 저장, 사용자 catalog, model/`high` effort session binding 확인 후 test row 삭제
- repository Poll now 이후 `lastPolledAt` 갱신, scheduler leadership 획득 확인
- 실제 ChatGPT/GHES credential은 없으므로 외부 provider E2E는 미실행
- 관리자 browser UI의 tenant/user/provider/prompt workflow 확인
- 관리자 Provider 저장/활성화, deployment 복원과 API response credential 비노출 확인
- 관리자 Provider 화면 390x844, 1440x1000 visual/overflow 확인
- browser error overlay, console error와 page error 없음
- axe-core accessibility audit: 36 pass, 0 violation, 0 incomplete
- multi-platform image build/push와 registry manifest 재조회
- OCI Helm chart push와 registry metadata 재조회

PRISM-DEV release revision 6 Local account 검증:

- Server/Worker 각 1개 Ready, restart 0회, image digest `sha256:b952e8f...3cae`
- migration `0010_local_accounts.sql`, scrypt credential 2개와 `admin`/`reviewer` account 확인
- 로그인 전 401, Local login 200, 일반사용자의 관리자 API 404 확인
- 시스템관리자 self-disable 409, 비밀번호 재설정 시 기존 일반사용자 session 401 확인
- 같은 사용자 이름의 로그인 실패 5회 후 15분 잠금 확인, 시험용 제한 row 삭제
- repository grant 회수 시 일반사용자 repository 0개, 재부여 시 1개 확인
- Helm test와 live/ready/dependencies HTTP 200, scheduler leadership와 application error 없음
- `/login`과 배포 JavaScript HTTP 200, Local account/repository 권한 UI marker 확인
- `agent-browser` 실행 파일이 없어 이번 변경의 자동 visual Browser 검증은 미실행
- ChatGPT account 첫 실사용에서 PRISM-DEV outbound TLS inspection CA 미신뢰로 `SELF_SIGNED_CERT_IN_CHAIN`이 발생했다. `git-code-reviewer-corporate-ca` ConfigMap을 만들고 PRISM-DEV `trustedCa` values에서 참조하도록 보완했다. Corporate CA PEM은 Git에 저장하지 않는다.
- Helm release revision 7에서 CA 적용 후 `chatgpt.com`, `auth.openai.com` TLS 연결과 `gpt-5.6-sol` 실제 Chat 요청 HTTP 201을 확인했다. OAuth refresh 결과 account health가 `ready`, credential version이 2로 갱신됐고 검증용 Chat session은 삭제했다.

PRISM-DEV release revision 8 GHES 사용 가이드 검증:

- Server/Worker 각 1개 `Ready`, image digest `sha256:84d6a475...99c8` 적용
- Helm chart `0.10.0`, application `0.8.0-alpha.2`, Helm test 성공
- live/ready/startup/dependencies 모두 HTTP 200, rollout 이후 application error 없음
- `/guide` HTTP 200과 배포 JavaScript의 GHES credential, Token 만료일, 사용 가이드 marker 확인
- desktop 1440px와 CSS viewport 390px에서 GNB, sticky 목차, 본문 overflow와 이동 동작 확인
- rollout 전 등록된 Local user, ChatGPT account와 GHES credential row가 유지됨을 확인
- 기존 사용자의 변경된 비밀번호를 덮어쓰지 않기 위해 배포 환경의 authenticated visual test는 생략하고 local mocked current-user API로 관리자·일반사용자 UI를 모두 확인

PRISM-DEV release revision 9 credential registry polling 수정 검증:

- Helm chart `0.10.1`, application `0.8.0-alpha.3`, image digest `sha256:bb8ec547...d9e6` 적용
- Server/Worker 각 1개 `Ready`, restart 0회, Helm test 성공
- live/ready/startup/dependencies 모두 HTTP 200, `/guide` HTTP 200, 로그인 전 repository API HTTP 401
- Server가 rolling update 직후 scheduler leadership을 재획득했고 Server/Worker application error가 없음
- 기존 `nfs-csi` RWX artifact PVC와 RWO PostgreSQL PVC의 volume ID가 유지됨
- 사용자 3명, ChatGPT account 1개, GHES credential 1개, fixture repository 1개가 rollout 전후 유지됨
- 실제 credential을 연결한 repository는 아직 없다. PRISM-DEV는 기존 fixture 검증을 유지하도록 `github.mode=fixture`로 두며, credential이 지정된 repository는 repository별 token reader를 우선 사용한다.

PRISM-DEV release revision 11 전용 HTTPRoute 검증:

- `git-code-reviewer/git-code-reviewer-route`를 `envoy-gateway-system/envoy-gateway`의 `http` listener에 연결
- 전용 hostname `pr-review.prism.ai`의 전체 path를 `git-code-reviewer` Service port 80으로 전달
- Route 상태 `Accepted=True`, `ResolvedRefs=True` 확인
- Host header 기반 요청에서 `/health/live` HTTP 200, `/guide` HTTP 200, 비로그인 repository API HTTP 401 확인
- Helm `PUBLIC_BASE_URL`을 `http://pr-review.prism.ai`로 변경하고 revision 11 rollout 및 Helm test 완료
- Gateway Service의 LoadBalancer 주소와 사내 DNS record는 없다. 현재 개발 PC에서는 `10.250.107.189 pr-review.prism.ai` hosts 항목이 필요하다.

PRISM-DEV release revision 12 개인 프로필·비밀번호 변경 검증:

- Helm chart `0.10.2`, application `0.8.0-alpha.4`, image digest `sha256:b1aedc67...bf40` 적용
- Server/Worker 각 1개 `Ready`, restart 0회, Helm test와 live/ready/dependencies HTTP 200
- 임시 Local account의 프로필 조회·표시 이름 변경과 성공 audit 확인
- 7자 새 비밀번호 HTTP 400과 실패 audit, 정확히 8자 새 비밀번호 HTTP 200과 성공 audit 확인
- 변경 전 session과 기존 비밀번호 HTTP 401, 변경한 비밀번호 재로그인 HTTP 200 확인
- desktop 1440x1000과 mobile 500x1200에서 GNB, 프로필 요약, form 단일 열과 overflow를 확인
- 검증용 사용자, credential, session, login limit와 audit event 삭제 확인

PRISM-DEV release revision 13 GHES connection 수정 검증:

- Helm chart `0.10.3`, application `0.8.0-alpha.5`, image digest `sha256:df64559a...d0ed` 적용
- Server/Worker 각 1개 `Ready`, restart 0회, Helm test와 live/ready/dependencies HTTP 200
- 관리자 연결 목록에 `연결 수정` dialog를 추가하고 desktop 1440×1100, mobile 500×1100, 공유 instance 1200×950에서 layout과 overflow 확인
- Token을 비운 metadata 수정은 credential version/fingerprint를 유지하고, token 교체는 version 1→2와 fingerprint 변경 확인
- API/Web origin 변경에 새 token을 요구하며, 공유 instance 공통 필드 변경을 거부하고, disabled 상태와 repository `credential_id` 참조를 유지
- 수정 후 `unverified` credential이 연결 테스트 전 polling, Git materialization과 repository 등록에 사용되지 않도록 차단
- Synthetic token 원문이 ciphertext에 포함되지 않음을 확인하고 임시 관리자, instance, credential, repository, session과 audit event 삭제 후 잔여 0건 확인

Authorization test는 administrator 허용, reviewer admin 차단, repository grant 없는 reviewer 차단과 PDP 장애 fail-closed를 확인한다. Provider test는 AES-256-GCM round trip, allowlist/credential 검증, immutable version 활성화, deployment fallback과 run별 provider hash 고정을 확인한다. Prompt test는 built-in guard/contract 보존, tenant 지침 합성, version/hash 고정을 확인한다. ChatGPT account provider test는 request header/payload/SSE parsing, proactive refresh 저장, 401 뒤 한 번의 refresh/retry와 안전한 missing-auth error를 검증한다.

사용자의 enterprise 환경에서 남은 검증:

1. 전용 service account에서 대상 repository만 선택하고 Metadata/Contents read, Pull requests read/write를 가진 fine-grained PAT을 발급해 `/admin?tab=github`에 등록한다. 조직 정책상 fine-grained PAT을 사용할 수 없을 때만 classic PAT의 `repo` scope를 사용한다. `0011` migration 이전에 등록된 repository의 PR 게시는 기본적으로 꺼지므로 token 교체와 연결 테스트 후 repository 카드에서 직접 시작한다.
2. GHES REST/GraphQL/Git fetch, exact SHA link, polling, manual refresh와 PR 관리 댓글의 create/update/idempotency를 검증한다.
3. Bundled Keycloak 또는 승인된 외부 OIDC provider, StorageClass, TLS ingress, CA bundle과 network policy로 배포한다.
4. 실제 사용자에게 Keycloak role, tenant membership과 repository grant를 할당해 격리를 확인한다.
5. `docs/operations/github-enterprise-test.md`의 end-to-end와 failure test를 수행한다.
6. 공유 ChatGPT/Codex deployment account와 quota/data policy가 조직 정책에 부합하는지 확인한다.

PRISM-DEV release revision 14 PR 게시·Repository URL 등록 배포 검증:

- Application `0.8.0-alpha.6`, chart `0.10.4`를 OCI registry에서 받아 upgrade 완료
- Migration `0011` 적용, publication table 14개 column과 기존 repository 게시 기본값 `false` 확인
- Server/Worker 각각 `1/1 Ready`, restart 0회, 새 digest 적용, Scheduler leadership 재획득
- Helm test 성공, HTTPRoute `Accepted=True`/`ResolvedRefs=True`, health 4개 endpoint HTTP 200
- 실제 hostname의 `/api/v1/system`에서 새 version 확인, `/guide`와 최신 JS HTTP 200, 비로그인 repository API HTTP 401
- 사용자 3명, ChatGPT account 1개, GHES credential 1개, repository 1개 유지
- PostgreSQL RWO·artifact RWX PVC의 PV ID와 auth/registry/DB Secret resourceVersion 유지
- 기존 repository의 PR 게시, publication row와 job은 모두 0건으로 유지. 실제 GHES write와 사용자 비밀번호 변경 없이 검증
- 배포 직후 Server/Worker log의 warning/error 0건. 상세 기록은 `deploy/environments/prism-dev/README.md` 참조

## 8. Commit 순서

PR review 댓글 게시·Repository URL 등록 구현은 다음 commit에 있다.

- `be2f56f` `feat: publish PR reviews and register repositories by URL`

PRISM-DEV 전용 HTTPRoute 배포는 다음 commit에 있다.

- `fc97965` `release: add PRISM-DEV HTTPRoute`
- `1d751a5` `release: rename PRISM-DEV review hostname`

이번 credential registry outbound polling 수정은 다음 commit에 있다.

- `2827f78` `ops: add local kind GitHub test profile`
- `e8623d1` `fix: use credential registry for outbound polling`
- `c808f83` `release: publish outbound polling registry profile`
- `642d346` `release: redeploy polling fix to PRISM-DEV`

이번 GHES credential 가이드와 Web GNB 확장은 다음 commit에 있다.

- `a02ceb8` `feat: add in-app GHES credential guide`
- `5a5cc38` `release: deploy GHES credential guide to PRISM-DEV`

이번 Local account와 사용자별 repository grant 확장은 다음 commit에 있다.

- `b466ec8` `feat: add local user authentication and administration`
- `8f75b5c` `feat: manage user repository grants`
- `6d567fd` `release: verify local accounts on PRISM-DEV`

개인 프로필과 본인 비밀번호 변경 확장은 다음 commit에 있다.

- `8c9d246` `feat: add personal profile password management`
- `bb688b8` `release: prepare personal profile deployment`

등록된 GHES connection 수정 확장은 다음 commit에 있다.

- `ae1a287` `feat: edit registered GHES connections`
- `388af58` `release: prepare GHES connection editing`

이번 Provider 관리 확장의 phase commit은 다음과 같다.

- `5a6cb57` `docs: design administrator model provider settings`
- `0147cc4` `feat: add administrator analysis provider settings`
- `8317b43` `feat: expose analysis provider administration`
- `6e08fea` `feat: configure provider administration in Helm`
- `898144c` `release: prepare provider administration preview`
- `faf28a8` `release: pin provider preview image digest`

Bundled Keycloak Helm 확장은 다음 commit에 있다.

- `92a6e5e` `feat: bundle Keycloak with Helm deployments`

직전 tenant/prompt 관리 확장은 다음 commit에 있다.

- `f528fdc` `docs: design tenant authorization and prompt administration`
- `315e03f` `feat: add tenant authorization and prompt versioning`
- `a9338c9` `feat: add tenant and prompt administration UI`
- `95d8583` `feat: deploy tenant authorization with Cerbos`
- `c688c75` `release: prepare tenant administration preview`
- `0a6b755` `release: pin tenant preview image digest`

직전 ChatGPT account 확장은 `f7bcb2c`, `fa05417`, `7670ee1`, `af342c1`에 있다.

## 9. 문서 정본

다음 순서로 읽는다.

1. `PRODUCT.md`
2. `.documents/blueprint.md`
3. `.documents/requirements-specification.md`
4. `.documents/functional-design.md`
5. `.documents/ui-implementation-design.md`
6. `.documents/tenancy-identity-authorization-prompt-design.md`
7. `.documents/implementation-plan.md`
8. `.documents/local-account-authentication.md`
9. `.documents/design-review-resolution-2026-09-02.md`
10. `docs/operations/deployment.md`
11. `docs/operations/identity-authorization.md`
12. `docs/operations/backup-restore.md`
13. `docs/operations/github-enterprise-test.md`

시각 기준은 수정하지 않았다.

- `.documents/visuals/review-workspace.html`
- `.documents/visuals/review-workspace-preview.png`

원본 검토 입력인 `.documents/design-review-2026-09-02.md`와 `.documents/design-review-remediation-2026-09-02.md`도 보존한다.

## 10. 주의사항

- GitHub, model, OIDC, database 또는 ChatGPT account credential을 browser, ConfigMap, plain values나 log에 노출하지 않는다.
- Bundled Keycloak의 `bitnamilegacy/*` image를 보안 update가 제공되는 production image로 간주하지 않는다. 운영 전 승인된 registry/digest로 교체한다.
- Application PostgreSQL과 Keycloak PostgreSQL은 별도 DB/PVC/Secret이며 함께 활성화해도 resource name과 backup lifecycle을 분리한다.
- `MODEL_CREDENTIAL_ENCRYPTION_KEY`는 Server와 Worker에 동일하게 주입하고 PostgreSQL, ConfigMap 또는 plain values에 두지 않는다. Key를 잃거나 바로 교체하면 기존 Provider version을 복호화할 수 없다.
- Provider origin allowlist는 application SSRF 경계일 뿐 NetworkPolicy를 대체하지 않는다. 실제 model CIDR/port egress도 함께 제한한다.
- Prompt 원문은 관리자 route 밖의 report, audit metadata, log와 trace에 노출하지 않는다.
- 운영자 host home이나 local `~/.codex`를 production Pod에 mount하지 않는다.
- ChatGPT account credential을 Worker, migration 또는 retention workload에 mount하지 않는다.
- Browser local storage를 source, report, diff, Chat 또는 credential cache로 확장하지 않는다.
- Report 또는 Chat evidence를 더 최신 base/head revision으로 자동 재해석하지 않는다.
- External source link는 browser 입력 origin이 아니라 등록된 GHES origin과 exact SHA로 만든다.
- PR comment write 권한을 Contents, Administration 또는 Workflows write로 확대하지 않는다. 자동 approve/request-changes, Check와 status는 생성하지 않는다.
- Cerbos 장애 시 이전 allow decision을 재사용하거나 local mode로 fallback하지 않는다.
- Keycloak account, password, MFA와 role assignment를 application 관리자 UI에서 직접 편집하지 않는다.
- Local account mode는 private pilot 전용이다. Bootstrap password를 values나 문서에 기록하지 않고 최초 로그인 뒤 관리자 UI에서 변경한다.
- Local account의 tenant membership만으로 repository 접근을 허용하지 않는다. 사용자별 repository grant를 별도로 부여한다.
- PRISM-DEV의 ChatGPT/Codex HTTPS는 `SK holdings C&C` root CA를 `git-code-reviewer-corporate-ca/ca.crt`로 mount하고 `NODE_EXTRA_CA_CERTS`로 검증한다. `NODE_TLS_REJECT_UNAUTHORIZED=0` 같은 우회 설정은 사용하지 않는다.
- `.vscode/` 또는 관련 없는 사용자 변경을 되돌리지 않는다.

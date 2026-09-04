# Git Code Reviewer - Agent Handoff

## 1. 현재 상태

- 최종 갱신: 2026-09-04
- branch: `feat/browser-review-service`
- 단계: ChatGPT account/GHES credential registry, 사용자 model·effort 선택, repository별 polling과 PRISM-DEV Helm `0.8.2` 배포 완료
- remote: phase별 구현 및 release commit을 `origin/feat/browser-review-service`에 push함
- 사용자 소유 `.vscode/` 변경: 건드리지 않음

현재 repository에는 browser application, Node.js Server/Worker runtime, PostgreSQL schema, shared artifact storage, container image와 Helm chart가 있다. 기존 CI/CD 중심 방향은 Kubernetes에서 중앙 운영하는 사내 web service로 교체했다.

### 1.1 2026-09-04 확정 요구사항과 구현 상태

사용자가 다음 target behavior를 확정했다.

- 시스템 관리자는 여러 ChatGPT account를 등록하고 account별 model, 허용/default/max reasoning effort와 tenant/user/group assignment를 관리한다.
- 일반 사용자는 허용된 Chat account, model과 effort를 선택해 대화를 시작한다. 선택은 session에 고정되고 변경하면 새 session을 만든다.
- 시스템 관리자는 GHES access-token connection과 review repository를 등록하고 repository별 polling interval/disabled/Poll now trigger 및 user/group grant를 관리한다.
- GHES token이 부여하는 외부 read 권한과 application repository grant는 별도로 검사한다.

위 동작은 migration `0009`, encrypted credential registry, 관리자 API/UI, 사용자 Chat selector와 저장소별 reader 선택으로 구현됐다. PRISM-DEV에는 registry를 활성화했지만 실제 ChatGPT account와 GHES token은 등록하지 않아 registry가 빈 상태다. 실제 credential을 전달받은 뒤 `/admin?tab=chat`, `/admin?tab=github`에서 등록·연결 테스트를 수행해야 외부 E2E가 완료된다. Repository grant는 등록 시 사용자 subject 1개를 선택할 수 있으며 다중 user/group grant를 사후 편집하는 전용 UI는 후속 범위다.

## 2. 제품과 runtime 경계

1. GUI는 VS Code/browser extension이 아니라 Server가 제공하는 browser application이다.
2. Server는 bundled web UI, REST/SSE, 인증, 인가, polling과 interactive Review Chat을 담당한다.
3. Worker는 Git fetch, immutable snapshot materialization, deterministic analysis와 선택형 batch model 분석을 담당한다.
4. PostgreSQL이 tenant, application user, membership, repository grant, provider/prompt version, durable job, operation/event, report와 Chat record의 정본이다. 별도 queue는 두지 않는다.
5. Artifact는 shared RWX PVC를 사용한다. Worker workspace는 `emptyDir` 또는 pod 단위 generic ephemeral PVC를 사용한다.
6. GitHub Enterprise 접근은 read-only GitHub App과 outbound polling/manual refresh를 사용하며 repository workflow와 webhook은 요구하지 않는다.
7. Report는 Commit Defender의 grade, summary, per-file summary, P0-P3 category, finding, evidence와 exact-revision link를 계승한다.
8. Workspace는 크기를 조절할 수 있는 LNB/Main/Chat/FNB panel, 실제 Evidence/Git graph/Impact/Tests view와 responsive unified diff fallback을 제공한다.
9. Object impact는 structure parent/children과 dependency uses/used-by를 구분한다. 중복된 FNB 최상위 tab 대신 Impact 내부에서 표현한다.
10. Tests view는 report data를 바탕으로 추가된 test의 목적, test case와 assertion을 설명한다.

## 3. Tenant, identity와 authorization

책임은 다음과 같이 분리한다.

- Keycloak 또는 기존 사내 OIDC provider: 로그인, MFA/SSO, 사용자 identity와 관리자 role
- PostgreSQL: application enabled 상태, tenant, membership, repository grant와 prompt version
- Cerbos: principal/action/resource 속성을 사용하는 RBAC+ABAC decision

Role은 `reviewer`, `administrator` 두 개다. Keycloak client role `git-code-reviewer-admin`, realm role 또는 설정된 admin group을 administrator로 매핑한다. Reviewer는 enabled tenant membership과 repository subject/group grant를 모두 가져야 repository와 PR을 볼 수 있다. 권한 없는 단일 resource는 존재 여부를 감추도록 404를 반환하며 Cerbos timeout, 오류 또는 잘못된 응답은 503으로 fail closed한다.

Keycloak은 선택형 Bitnami chart dependency로 포함했고 enterprise values 예시에서 활성화한다. 전용 realm, confidential client, PKCE, admin client role과 groups mapper를 `keycloak-config-cli` hook으로 구성하며 별도 PostgreSQL PVC를 사용한다. 조직이 Entra ID, Okta, PingFederate 같은 OIDC provider를 이미 운영하면 기본값처럼 `keycloak.enabled=false`로 두고 기존 provider를 사용할 수 있다. Bundled mode에서도 identity DB, realm, TLS, HA, backup과 patch lifecycle은 application과 분리해 운영한다. Cerbos는 chart에 선택적으로 포함하거나 외부 PDP URL을 지정한다.

관리자 browser UI `/admin`은 다음 기능을 제공한다.

- tenant 생성, 표시 이름 변경, 활성/비활성 전환
- 사용자 검색, application 접근 kill switch, tenant membership 관리
- 전역 분석 Provider immutable version 생성, 연결 테스트, 과거 version 재활성화, deployment 설정 복원
- tenant별 분석 prompt immutable version 생성, 과거 version 재활성화, built-in prompt 복원

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

GHES access token도 같은 registry master key로 암호화한다. 저장소는 `credential_id`를 가지며 Server polling과 Worker clone 직전에만 token을 복호화한다. Fixture/GitHub App 전역 reader와 token 기반 reader를 저장소 단위로 함께 사용할 수 있다. Rolling update 중 새 Server가 advisory lock 획득에 실패하더라도 15초마다 재시도한다.

## 6. 배포 artifact

### Container image

- image: `docker.io/pydemia/git-code-reviewer:0.7.0-alpha.3`
- source tag: `docker.io/pydemia/git-code-reviewer:sha-cb12b514035a`
- manifest digest: `sha256:52d95d8ca295b72409dc50933bf33e6cf965e9ef6fcf744262d1cc66443e94b4`
- platform: `linux/amd64`
- supply-chain metadata: BuildKit provenance와 SBOM attestation 포함

하나의 immutable image가 `serve`, `worker`, `migrate`, `retention` command를 제공한다.

### Helm chart

- chart: `oci://registry-1.docker.io/pydemia/git-code-reviewer`
- version: `0.8.2`
- app version: `0.7.0-alpha.3`
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
- Vitest 15개 파일, 61개 test
- 실제 Cerbos 0.55.0 policy compile/decision test 29개
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

Authorization test는 administrator 허용, reviewer admin 차단, repository grant 없는 reviewer 차단과 PDP 장애 fail-closed를 확인한다. Provider test는 AES-256-GCM round trip, allowlist/credential 검증, immutable version 활성화, deployment fallback과 run별 provider hash 고정을 확인한다. Prompt test는 built-in guard/contract 보존, tenant 지침 합성, version/hash 고정을 확인한다. ChatGPT account provider test는 request header/payload/SSE parsing, proactive refresh 저장, 401 뒤 한 번의 refresh/retry와 안전한 missing-auth error를 검증한다.

사용자의 enterprise 환경에서 남은 검증:

1. Private GHES repository에 GitHub App을 설치하고 repository를 tenant에 등록한다.
2. GHES REST/GraphQL/Git fetch, exact SHA link, polling과 manual refresh를 검증한다.
3. Bundled Keycloak 또는 승인된 외부 OIDC provider, StorageClass, TLS ingress, CA bundle과 network policy로 배포한다.
4. 실제 사용자에게 Keycloak role, tenant membership과 repository grant를 할당해 격리를 확인한다.
5. `docs/operations/github-enterprise-test.md`의 end-to-end와 failure test를 수행한다.
6. 공유 ChatGPT/Codex deployment account와 quota/data policy가 조직 정책에 부합하는지 확인한다.

## 8. Commit 순서

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
8. `.documents/design-review-resolution-2026-09-02.md`
9. `docs/operations/deployment.md`
10. `docs/operations/identity-authorization.md`
11. `docs/operations/backup-restore.md`
12. `docs/operations/github-enterprise-test.md`

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
- Cerbos 장애 시 이전 allow decision을 재사용하거나 local mode로 fallback하지 않는다.
- Keycloak account, password, MFA와 role assignment를 application 관리자 UI에서 직접 편집하지 않는다.
- `.vscode/` 또는 관련 없는 사용자 변경을 되돌리지 않는다.

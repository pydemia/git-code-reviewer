# Git Code Reviewer - Agent Handoff

## 1. 현재 상태

- 최종 갱신: 2026-09-03
- branch: `feat/browser-review-service`
- 단계: browser review service 구현 및 `0.4.0-alpha.1` preview image 완료
- remote: `7670ee1`까지 feature와 release 준비 commit을 `origin/feat/browser-review-service`에 push함
- 사용자 소유 `.vscode/` 변경: 건드리지 않음

현재 repository에는 동작하는 browser application, Node.js Server/Worker runtime, PostgreSQL schema, shared artifact storage, container image와 Helm chart가 있다. 기존 CI/CD 중심 방향은 Kubernetes에서 중앙 운영하는 사내 web service로 교체했다.

## 2. 제품과 runtime 경계

1. GUI는 VS Code/browser extension이 아니라 Server가 제공하는 browser application이다.
2. Server는 bundled web UI, REST/SSE, 인증, polling과 interactive Review Chat을 담당한다.
3. Worker는 Git fetch, immutable snapshot materialization, deterministic analysis와 선택형 batch model 분석을 담당한다.
4. PostgreSQL이 metadata, durable job, operation/event, report와 Chat record를 소유하며 별도 queue는 두지 않는다.
5. Artifact는 shared RWX PVC를 사용한다. Worker workspace는 `emptyDir` 또는 pod 단위 generic ephemeral PVC를 사용한다.
6. GitHub Enterprise 접근은 read-only GitHub App과 outbound polling/manual refresh를 사용하며 repository workflow와 webhook은 요구하지 않는다.
7. Report는 Commit Defender의 grade, summary, per-file summary, P0-P3 category, finding, evidence와 exact-revision link를 계승한다.
8. Workspace는 크기를 조절할 수 있는 LNB/Main/Chat/FNB panel, 실제 Evidence/Git graph/Impact/Tests view와 responsive unified diff fallback을 제공한다.
9. Object impact는 structure parent/children과 dependency uses/used-by를 구분한다. 중복된 FNB 최상위 tab 대신 Impact 내부에서 표현한다.
10. Tests view는 report data를 바탕으로 추가된 test, test case와 assertion을 설명한다.

## 3. ChatGPT account 연동

Review Chat은 `disabled`, `openai-compatible`, `chatgpt-account` 세 mode를 지원한다.

`chatgpt-account`는 Demian의 Node.js Codex provider에서 확인한 공개 동작과 호환되도록 구현했다. `demian-cli` package는 관련 없는 agent runtime까지 bundle하고 안정적인 TypeScript declaration을 제공하지 않으므로 dependency로 추가하지 않고 작은 local provider boundary만 유지했다.

Server 구현은 다음을 수행한다.

- deployment-owned Codex `auth.json`을 `CHATGPT_ACCOUNT_HOME`에서 읽음
- account ID와 installation ID header를 포함한 Codex Responses request 전송
- streaming response를 기존 Chat response contract로 변환
- 만료 임박 access token을 미리 refresh하고 HTTP 401 뒤 한 번만 refresh/retry
- 회전된 token을 mode `0600`으로 원자 저장
- provider error에서 credential path와 response body를 노출하지 않음

이 mode는 interactive Chat에만 사용한다. Worker에는 account credential이 전달되지 않는다. 각 사용자의 local Codex login을 암묵적으로 재사용하지 않으며 모든 application 사용자가 하나의 deployment account를 공유한다.

Kubernetes에서는 Secret이 init container를 통해 전용 writable account PVC를 seed한다. 최초 실행 또는 `model.chat.account.bootstrapRevision` 변경 시에만 복사하므로 일반적인 restart가 회전된 refresh token을 덮어쓰지 않는다. 이 PVC에는 encrypted StorageClass, 제한된 namespace RBAC와 backup 제외 정책을 적용한다.

주요 파일:

- `apps/runtime/src/services/chat-model.ts`
- `apps/runtime/src/services/chat-model.test.ts`
- `apps/runtime/src/config.ts`
- `deploy/helm/git-code-reviewer/templates/server-deployment.yaml`
- `deploy/helm/git-code-reviewer/templates/chatgpt-account-pvc.yaml`
- `docs/operations/deployment.md`
- `docs/operations/development.md`

## 4. 배포 artifact

### Container image

- image: `docker.io/pydemia/git-code-reviewer:0.4.0-alpha.1`
- source tag: `docker.io/pydemia/git-code-reviewer:sha-7670ee16ff1e`
- manifest digest: `sha256:f6c9e8a5273c8fd3aab904533abd2bae6831efff06c7c41d6006866813782136`
- platform: `linux/amd64`, `linux/arm64`
- supply-chain metadata: BuildKit provenance와 SBOM attestation 포함

하나의 immutable image가 `serve`, `worker`, `migrate`, `retention` command를 제공한다.

### Helm chart

- chart: `oci://registry-1.docker.io/pydemia/git-code-reviewer`
- version: `0.4.0`
- app version: `0.4.0-alpha.1`
- chart digest: `sha256:f44529ebf89cbe6658530aed516209ab3d34b1c18b69374ab912de4cf76b63a4`
- 기본 database: 외부 PostgreSQL 15+
- pilot database: `postgresql.enabled=true`이면 별도 RWO PVC와 함께 Bitnami PostgreSQL dependency 설치

Enterprise values 예시는 image manifest digest를 고정한다. Chart는 Server/Worker Deployment, Service/Ingress, migration 경로, retention CronJob, artifact PVC, 선택형 account PVC, security 설정과 선택형 PostgreSQL dependency를 생성한다.

## 5. 검증 상태

Local에서 완료한 항목:

- Prettier format check
- ESLint
- TypeScript typecheck
- production application build
- Vitest 10개 파일, 38개 test
- 기본 values Helm lint/render
- ChatGPT account mode Helm lint/render
- ChatGPT account mode와 bundled PostgreSQL 조합 Helm render
- local Codex login을 사용한 실제 ChatGPT account provider smoke test
- multi-platform image build/push와 registry manifest 재조회
- OCI Helm chart push와 registry metadata 재조회

Account provider test는 request header/payload/SSE parsing, proactive refresh 저장, 401 뒤 한 번의 refresh/retry와 안전한 missing-auth error를 검증한다.

사용자의 enterprise 환경에서 남은 검증:

1. Private GHES repository에 GitHub App을 설치하고 repository를 등록한다.
2. GHES REST/GraphQL/Git fetch, exact SHA link, polling과 manual refresh를 검증한다.
3. 승인된 OIDC provider, StorageClass, TLS ingress, CA bundle과 network policy로 배포한다.
4. `docs/operations/github-enterprise-test.md`의 end-to-end와 failure test를 수행한다.
5. 공유 ChatGPT/Codex deployment account와 quota/data policy가 조직 정책에 부합하는지 확인한다.

## 6. Commit 순서

최근 구현과 release commit은 다음과 같다.

- `a132abc` `feat: establish browser service foundation`
- `cb2dfd5` `feat: add authenticated GHES pull request worklist`
- `15c77ba` `feat: materialize immutable pull request snapshots`
- `f985c0a` `feat: publish canonical review reports and relationships`
- `712289b` `feat: complete revision-bound review workspace`
- `e963743` `feat: harden Kubernetes pilot operations`
- `94aa8b6` `docs: publish Helm chart through Docker Hub OCI`
- `2992ef1` `feat: make review workspace panels resizable`
- `8ba1aa2` `feat: add optional Bitnami PostgreSQL deployment`
- `23f2822` `feat: complete review workspace tools and chat states`
- `5d9d501` `release: publish workspace tools preview`
- `f7bcb2c` `feat: support ChatGPT account review chat`
- `fa05417` `feat: persist ChatGPT account auth in Helm deployments`
- `7670ee1` `release: prepare ChatGPT account preview`

## 7. 문서 정본

다음 순서로 읽는다.

1. `PRODUCT.md`
2. `.documents/blueprint.md`
3. `.documents/requirements-specification.md`
4. `.documents/functional-design.md`
5. `.documents/ui-implementation-design.md`
6. `.documents/implementation-plan.md`
7. `.documents/design-review-resolution-2026-09-02.md`
8. `docs/operations/deployment.md`
9. `docs/operations/github-enterprise-test.md`

시각 기준은 수정하지 않았다.

- `.documents/visuals/review-workspace.html`
- `.documents/visuals/review-workspace-preview.png`

원본 검토 입력인 `.documents/design-review-2026-09-02.md`와 `.documents/design-review-remediation-2026-09-02.md`도 보존한다.

## 8. 주의사항

- GitHub, model, OIDC, database 또는 ChatGPT account credential을 browser, ConfigMap, plain values나 log에 노출하지 않는다.
- 운영자 host home이나 local `~/.codex`를 production Pod에 mount하지 않는다.
- ChatGPT account credential을 Worker, migration 또는 retention workload에 mount하지 않는다.
- Browser local storage를 source, report, diff, Chat 또는 credential cache로 확장하지 않는다.
- Report 또는 Chat evidence를 더 최신 base/head revision으로 자동 재해석하지 않는다.
- External source link는 browser 입력 origin이 아니라 등록된 GHES origin과 exact SHA로 만든다.
- ChatGPT account provider는 public OpenAI API가 아니라 Codex account transport를 사용한다. 해당 transport가 바뀔 수 있으므로 image upgrade 전에 account smoke test를 다시 실행한다.
- `.vscode/` 또는 관련 없는 사용자 변경을 되돌리지 않는다.

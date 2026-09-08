# Git Code Reviewer - Agent Handoff

## 1. 현재 상태

- 최종 갱신: 2026-09-08
- branch: `feat/browser-review-service`
- 단계: Workspace 배치 변경·가이드·테스트를 commit·push하고 PRISM-DEV에 application `0.8.0-alpha.12`, Helm revision 22로 재배포함
- 배포 source: `74cdc056833ae7b2866bc27a30a8635c9b94b5b2` (재배포 전 원격 최신 commit과 일치 확인). Release 설정·기록 commit은 git log 참조
- 사용자 소유 `.vscode/` 변경: 건드리지 않음

현재 repository에는 browser application, Node.js Server/Worker runtime, PostgreSQL schema, shared artifact storage, container image와 Helm chart가 있다. 기존 CI/CD 중심 방향은 Kubernetes에서 중앙 운영하는 사내 web service로 교체했다.

### 2026-09-08 Workspace 배치 변경 — 배포 완료

사용자는 Files 전체 펼침 기본값, LNB 숨김 toggle, Chat 약 1.8배 확대, FNB Comments 이동·높이 확대, PR 전체 요약 후 펼쳐진 파일 요약, 선택 전 inline comment, Diff의 반복 line 테두리 제거와 읽기 너비 제한을 요청했다. 구현은 `6224ee6`으로 먼저 push했고 모바일 control·Tab 순서·가이드·검증 기록은 `74cdc05`에 있다.

- `FileTree.tsx`: 기본 전체 펼침, 접은 경로만 state에 저장. 선택 파일의 ancestor 자동 펼침과 green/red 합계·keyboard 지원 유지. LNB는 unmount하지 않아 숨김·복원 뒤 접힌 상태가 남는다.
- `workspace-layout.ts`, `App.tsx`: LNB/Chat/FNB 기본값 244/569/280px, Chat 최대 800px, Main 최소 360px. 표시 크기를 viewport에 맞춰 계산하되 저장한 크기를 덮어쓰지 않는다. localStorage v2는 기존 v1의 기본 316/176px만 이전하며 직접 지정한 값은 보존한다. LNB toggle은 메인 toolbar에 있고 separator 더블클릭·Home은 해당 패널 초기화다.
- `ReviewReportPanel.tsx`: Summary에는 PR 전체 요약 → 펼쳐진 파일 요약 → 파일 목록·provenance만 남긴다. 상세 unit block은 FNB Comments에 둔다. 과거 report에 total-summary가 없으면 누락을 안내하며 결과를 재작성하지 않는다. Comments에는 코드 이동·위치 확인·GHES 원문을 유지한다.
- `ReviewDiff.tsx`: 현재 파일의 모든 inline comment는 선택 전에도 표시한다. 선택 시 시작 line만 강조하며 block 너비는 최대 880px다. File-level과 diff 밖 anchor를 구분한다. 기존 finding deep link는 Code와 Comments를 함께 열고 `tool=evidence`는 Comments로 해석한다.
- 모바일에서도 FNB tab label과 Split/Unified control을 숨기지 않는다. DOM 순서는 LNB → Main → Comments → Chat이며 시각 순서와 Tab 이동 순서를 맞춘다.

전체 218 tests(39 files, local PostgreSQL integration 포함), lint/typecheck/Web production build와 browser 검증을 통과했다. 상세 근거·합성 screenshot은 [Workspace 배치 검증](verification-workspace-layout-2026-09-08.md)에 있다. 실제 GHES·모델·PR 게시 검증은 실행하지 않았다. 후속 재배포 요청에 따라 새 image를 build하고 아래 revision 22로 배포했다. 기존 immutable report·Secret·PVC는 유지했으며 신규 DB migration은 없다.

### 2026-09-08 10:03 배포 (revision 22, 현재)

Source `74cdc05`의 application `0.8.0-alpha.12`, chart `0.10.11`을 registry에 게시하고 PRISM-DEV release를 revision 22로 upgrade했다. Linux/amd64 image에는 SPDX SBOM과 SLSA provenance가 있다. 전체 container build, non-root/read-only smoke, Helm lint·server-side dry-run·test와 Server/Worker rollout이 통과했다. 상세 digest와 검증 기록은 [PRISM-DEV 배포 문서](../deploy/environments/prism-dev/README.md)에 있다.

신규 Server·Worker 각각 1/1 Ready, restart 0회이며 HTTPRoute의 health 4개 endpoint, login·guide는 HTTP 200, 비로그인 repository API는 401이다. 제공 중인 JS·CSS hash가 선행 browser 검증 bundle과 일치한다. 두 PVC의 PV ID, auth/registry/PostgreSQL Secret UID·resourceVersion, CA ConfigMap과 HTTPRoute를 유지했다. 운영 데이터는 migration 16개, users 3명, Chat account 1개, GHES credential 1개, 활성 repository 2개, report 31건이며 analysis는 확인 사이 37→38건이 됐다. 기존 polling 설정은 유지했고 별도 live 모델 호출·PR 게시 검증은 하지 않았다. 기존 Worker는 900초 종료 유예에 따른 Terminating 상태로 강제 삭제하지 않았다.

### 2026-09-08 07:44 배포 (revision 21)

사용자의 10분 대기 요청 후 원격을 다시 조회했고, 후속 즉시 재배포 요청에서 새 `d9f9418`을 확인해 배포 대상을 갱신했다. `9e80b53`의 진행 중 image build는 취소하고 게시하지 않았다. Application `0.8.0-alpha.11`, chart `0.10.10`을 registry에 게시한 뒤 기존 values·Secret·PVC·HTTPRoute를 유지해 revision 21로 upgrade했다. 상세 digest와 검증 표는 `deploy/environments/prism-dev/README.md`에 있다.

신규 `0016_analysis_progress.sql`이 nullable `analysis_runs.progress_detail` JSONB column을 추가했다. Local PostgreSQL integration을 포함한 212 tests(38 files, skip 없음), lint/typecheck/production build, image smoke, Helm lint/dry-run/test와 rollout을 통과했다. 운영 migration 16개, users 3명, Chat account 1개, GHES credential 1개, 활성 repository 2개, analysis 36건, report 31건을 확인했다. Server/Worker는 각 1/1 Ready, restart 0회이며 실제 HTTPRoute에서 version과 새 bundle을 검증했다. Startup/readiness probe의 최초 connection refused 각 1건 외 지속 장애는 없고 application warning/error log는 0건이다.

이번 배포는 기존 Provider/account 설정을 바꾸거나 실제 모델 호출·PR 댓글 게시를 실행하지 않았다. Model catalog와 analysis status API의 동작은 automated test로 확인했고 live 접근 경로·bundle·인증 차단을 검증했다. 과거 절의 날짜별 수치와 배포 상태는 당시 기록이다.

### 1.0b 2026-09-07 Commit Defender report와 분석 Skill

구현 정본은 [Skill/report 설계](skill-based-review-report.md), 최종 근거는 [검증 기록](verification-skill-report-2026-09-07.md)이다. 사용자에게 phase별 commit·push 승인을 받았으며 재배포는 요청받지 않았다. 참조 revision은 `pydemia/commit-defender@47dabfea718729b0ccc685ae173857476040d6ea`이다. VS Code/local Git 결합 때문에 dependency로 도입하지 않고 데이터 관계와 분석 형식을 현재 Server/Worker에 맞게 re-engineering했다.

- `packages/analysis-engine/skills/*/SKILL.md`: 6 perspective와 3 form. 제한된 scalar frontmatter를 파싱하며 body를 실행하지 않는다. 새 perspective는 enum 수정 없이 추가한다.
- `routes/analysis-skills.ts`, `services/analysis-skills.ts`, migration 0014: 전역 immutable bundle version 저장·재활성화·Built-in 복원. Admin role/PDP, advisory lock, DB 불변성 trigger, 본문을 제외한 audit을 적용한다.
- Worker와 migration 0015: queued run에 bundle/hash를 고정하고 실행 시 재검증한다. 활성 설정 변경으로 기존 run을 재해석하지 않는다. Migration 이전 null bundle run만 legacy 경로를 유지한다.
- `skill-review.ts`, `review-windows.ts`: line 번호가 있는 window(core 80줄, overlap 12줄) → unit-comment-block → 파일별 overall-summary → total-summary. Window는 입력 크기 단위이고 segment는 comment가 지정한 실제 한쪽 revision의 line 범위다. File/category/side/range 검증 후 accepted unit만 집계한다. 기본 32 calls, stage 입력 128,000 bytes를 넘으면 생략을 기록한다.
- 등록 account/model/effort와 OpenAI-compatible adapter 모두 같은 stage별 contract를 사용한다. P3를 낮추지 않으며 incomplete/failed/unavailable/demo를 PASS와 구분한다. 대상 PR의 SKILL.md나 TODO는 신뢰된 지침이 아니다.
- `AnalysisSkillsPanel.tsx`: 전체 bundle 편집, perspective 추가·초안 삭제·비활성화, 저장, history 불러오기·재활성화·복원. Tenant prompt와 전역 Skill을 별도로 관리한다.
- `ReviewReportPanel.tsx`, `contracts/report-presentation.ts`: 전체 상태, 파일별 Overall Summary, AI Comments, Analyzed File List와 Model/Skill provenance. Browser-safe schema를 contracts에 두고 API view/JSON/Markdown/PR publication에 같은 계층을 유지한다. MergeBase comment의 GHES link도 해당 snapshot SHA를 사용한다.

전체 189 tests(33 files), lint/typecheck/build, PRISM-DEV Helm lint를 통과했다. 실제 local Server·별도 Worker·PostgreSQL·loopback 모의 모델에서 report 2개와 Chat을 확인했다. Desktop/mobile에서 Skill 저장·복원·재활성화, mergeBase line 이동·inline 설명을 검증했다. Screenshot은 `.impeccable/review/{skills,structured-report,structured-comments}-{desktop,mobile}.png`다. 독립 Impeccable reviewer가 요청한 mobile 버튼 문구와 sticky navigation offset을 수정했으며 verdict pass에서 두 항목 모두 resolved, 해당 수정 범위의 disposition은 ship이다.

현재 소스에서 추출한 UI 기준은 root `DESIGN.md`와 `.impeccable/design.json`에 있다. 후속 UI는 기존 gray/teal·한국어·조절 가능한 panel을 유지한다. Local Container build와 non-root/read-only smoke도 통과했고 기본 Skill 9개와 migration 15개를 확인했다. 검증용 Browser/Server/Worker/DB와 임시 파일은 종료·삭제했으며 screenshot과 local 검증 image는 보존했다.

Migration 0013부터 0015까지 적용됐고 운영 DB에 migration 15개, analysis 31건, report 26건이 있다. 기존 immutable report를 새 형식으로 덮어쓰지 않는다. 실제 GHES/ChatGPT로 source를 전송하거나 PR 댓글을 게시하는 신규 live 검증은 수행하지 않았다.

### 1.0a 2026-09-07 Workspace와 등록 account 기반 batch 분석

사용자는 접이식 Files tree, 각 행의 green additions/red deletions, Findings 클릭 시 관련 코드 line과 inline 설명, Commit Defender처럼 구체적인 한국어 review를 요청했다. 후속 질문에서 batch 분석에도 **등록된 ChatGPT account와 model·effort를 선택**하도록 확정했다. 상세 구현은 [Workspace와 account 분석 설계](review-workspace-and-analysis-account.md)를 따른다.

실제 PAT repository가 전역 `GITHUB_MODE=fixture` 때문에 데모 token rotation report를 받은 것이 잘못된 분석의 원인이었다. Materialization/analysis 양쪽에 명시적 fixture repository 판정을 적용했고 arbitrary 첫 파일에 데모 comment를 붙이는 fallback을 제거했다. 기존 report는 덮어쓰지 않는다. `versions.model`/`versions.review`로 데모·미수행·실패를 표시하고 Provider 설정 후 새로고침을 안내한다. 진행 중 작업은 중복 제거하되 완료 후 수동 refresh는 operation별 새 job을 생성한다. Workspace는 refresh 완료 후 최신 analysis ID로 이동한다.

Migration `0013_analysis_chat_account.sql`과 `chatgpt-account` 분석 Provider mode를 추가했다. Admin은 account·enabled model·allowed effort·Timeout을 선택하고 version으로 저장한다. Worker는 repository tenant 또는 all assignment를 호출 직전에 검사하며 user/group 전용 권한을 빌리지 않는다. Provider version은 credential 사본을 보관하지 않고 기존 registry의 인증·refresh 경로를 공유한다. OpenAI-compatible mode의 별도 key/allowlist 검사는 유지했다. PRISM-DEV values는 `model.analysis.admin.enabled=true`, `secrets.modelProvider=''`로 다음 배포를 준비했다. 실제 account 선택은 DB Admin 설정으로 해야 하며 아직 live 설정을 바꾸지 않았다.

Files tree는 폴더별 합계, keyboard navigation, 모두 접기/펼치기를 제공한다. Findings/파일 요약/Outline 선택 시 정확한 파일과 line으로 이동한다. Inline comment는 문제·영향·수정 제안을 표시하고 Evidence에는 위치 정보를 간결히 남긴다. P0는 Praise이며 Critical은 P3이다. Split은 row 정렬, Unified는 삭제 line도 보존하며 mobile은 Unified로 전환한다. 모델 출력의 per-file summary를 보존하고 없는 영향·수정 설명은 일반론으로 생성하지 않는다. File-level line 0을 가짜 line 1로 바꾸지 않는다. `verified`의 UI 표기는 ‘코드 위치 확인’이며 의미적 검증을 주장하지 않는다.

검증: 26 files의 149 tests 전체 통과(전용 PostgreSQL integration 10개 포함), migration 0001–0013, lint, typecheck, production build, PRISM-DEV Helm lint/template 통과. 실제 Server/Worker + 임시 DB + loopback 모의 모델로 account/model/high effort 호출과 report 저장을 확인했다. 동일 SHA manual refresh가 새 snapshot/analysis를 만들고 completed로 종료됨을 확인했다. 모의 모델 장애 시 partial/AI review 실패도 확인했다. 실제 GitHub/ChatGPT에 source를 보내는 검증과 클러스터 재배포는 수행하지 않았다.

최종 화면은 `.impeccable/review/workspace-{desktop,mobile}.png`, `workspace-findings-{desktop,mobile}.png`, `provider-{desktop,mobile}.png`에 저장했다. Desktop 1440×1000, mobile 390×844에서 tree 접기/펼치기, line 3 이동, inline 설명, Unified의 삭제 line 5개 유지와 horizontal overflow 없음을 확인했다. 기존 삭제 기능 검증 screenshot은 보존했다. 다음 배포 시 Server/Worker를 함께 갱신하고 migration 0013을 적용한 뒤 관리자가 분석 account를 선택하고 기존 실제 PR을 재분석해야 한다.

독립 Impeccable finish review는 해당 UI 확장 범위에서 `ship`으로 완료했다. 판정과 screenshot 목록은 `.impeccable/review/workspace-review.md`에 있다. 기존 history active 카드 경고 2건은 범위 밖 기존 스타일로 남겼으며 신규 시각 세계나 DESIGN 문서를 만들지 않았다.

검증용 Server·Worker·모의 모델 서버·Browser session과 임시 PostgreSQL container를 종료했다. 이 작업에서 생성한 임시 모의 데이터도 삭제했으며 source, screenshot과 검증 기록은 repository에 남겼다. 실제 클러스터와 등록된 account·repository는 변경하지 않았다. 후속 요청은 Commit Defender의 Overall Summary report와 영역별 Skill 관리이며 기존 검증 완료분과 별도 phase로 구현한다.

### 1.0 2026-09-07 후속 작업: 등록 삭제와 등록 실패 진단

Source commit `a66523a`에 Review repository `등록 삭제` UI/API와 migration `0012_repository_deletion.sql`을 추가했다. 삭제는 `deleted_at` tombstone으로 구현하며 목록·deep link·polling에서 제외하고 queued job/operation/analysis와 grant를 정리한다. Running job이 있으면 409를 반환한다. Connection/token, GitHub 원본과 PR 댓글은 보존하며 기존 기록은 retention 정책을 따른다. 재등록은 같은 ID를 사용하지만 과거 grant는 복원하지 않는다. 삭제된 fixture의 bootstrap 재생성과 in-flight polling의 새 작업 생성을 차단했다. 등록 오류 수정과 함께 revision 15에 배포했다.

검증: 전용 local PostgreSQL에서 migration 0001–0012와 lifecycle integration 4개를 포함한 전체 133 tests 통과. Lint, typecheck, production build와 변경 파일 format 검사도 통과했다. Desktop 1440×1100과 mobile 390×844에서 취소·Escape의 focus 복귀, 확인값 불일치, 실제 API의 409 안내, 삭제 성공·새로고침 후 목록 제외와 heading focus를 확인했다. 삭제 후 DB는 등록 비활성·polling/게시 중지, queued job 2개 `REPOSITORY_DELETED`, grant 0건이었다. 모든 삭제 검증은 synthetic fixture로 실행했으며 PRISM-DEV의 repository나 credential은 변경하지 않았다. Browser screenshot은 `.impeccable/review/`에 있다. 재배포할 때 migration 0012를 포함해야 한다.

Impeccable finish review는 삭제 UI·가이드 범위에서 `ship`으로 완료했다. 삭제 UI 검증용 local Server·Browser·PostgreSQL과 등록 오류 회귀 테스트용 임시 PostgreSQL은 종료·정리했다. 사용자 요청에 따라 등록 오류 수정, git push와 PRISM-DEV 재배포를 수행했다.

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

분석 Provider는 모든 tenant가 공유하는 전역 설정이다. `/admin?tab=provider`에서 `disabled`, `openai-compatible`, `chatgpt-account` mode를 선택한다. OpenAI-compatible은 endpoint, 정확한 model ID, Timeout과 API key를 설정하고 deployment exact-origin allowlist를 통과해야 한다. ChatGPT account mode는 registry의 account·model·effort를 선택하며 실제 실행 시 repository tenant/all assignment를 검사한다. 연결 테스트에는 repository source, diff와 tenant prompt를 보내지 않고 `Reply with OK.` 최소 요청만 보낸다.

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

- image: `docker.io/pydemia/git-code-reviewer:0.8.0-alpha.12`
- source revision: `74cdc056833a`
- image index digest: `sha256:9380c382eddf61f5871ba71042a8e8750a5ca0ad787ced77c87ea345f426d839`
- platform: `linux/amd64`
- supply-chain metadata: SPDX SBOM과 SLSA provenance attestation 포함

하나의 immutable image가 `serve`, `worker`, `migrate`, `retention` command를 제공한다.

### Helm chart

- chart: `oci://registry-1.docker.io/pydemia/git-code-reviewer`
- version: `0.10.11`
- app version: `0.8.0-alpha.12`
- chart digest: `sha256:4e12f934a4a56f7abd6b357cfb15296ddc66d1dfd4dd06c6e6958a390f4aef84`
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

Review 등록 삭제와 사용자 선택 등록 오류 수정은 다음 commit에 있다.

- `a66523a` `feat: delete review registrations and fix selected-user grants`

PRISM-DEV revision 15는 2026-09-07 14:04 KST에 배포했다. Server/Worker 각각 `1/1 Ready`, restart 0회, migration 12개(`0012` 포함), Helm test와 health 4개 endpoint HTTP 200을 확인했다. 실제 hostname의 version은 `0.8.0-alpha.7`이며 삭제 UI가 포함된 최신 JS를 제공한다. 기존 users 3명, Chat accounts 1개, GHES credential 1개, repository 1개와 grant 1건, 두 PVC의 PV ID와 auth/registry/PostgreSQL Secret UID·resourceVersion을 유지했다. Scheduler leadership 재획득과 배포 후 warning/error 0건도 확인했다. 실제 GitHub repository 등록·댓글 게시와 사용자 데이터 삭제는 실행하지 않았다. 사용자 선택 등록 HTTP 201 검증은 격리된 local PostgreSQL/Fastify API의 회귀 테스트 결과다.

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

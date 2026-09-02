# Git Code Reviewer — 구현계획서

## 1. 문서 정보

| 항목 | 내용 |
|---|---|
| 문서 상태 | 구현 기준안 v0.1 |
| 기준 요건 | `requirements-specification.md` |
| 기준 설계 | `functional-design.md`, `blueprint.md`, `ui-implementation-design.md` |
| 구현 방식 | trunk 기반의 작은 logical commit, 항상 green 상태 유지 |
| 기준 package manager | pnpm |
| 기준 repository 구성 | Turborepo monorepo |

이 계획에서 `CP`는 Commit Phase를 뜻한다. 하나의 CP는 기본적으로 하나의 logical commit이며, review 가능한 최소 기능·contract·test를 함께 포함한다. CI나 조직 정책 때문에 여러 commit으로 나눌 경우 `CP-08.1`, `CP-08.2`처럼 suffix를 붙이고 CP의 완료 조건을 모두 충족한 뒤 완료 처리한다.

## 2. Commit Phase 운영 규칙

### 2.1 한 CP에 포함할 것

- 한 가지 목적과 그 목적을 검증하는 test
- 필요한 public contract 또는 schema 변경
- 사용자·운영 동작이 바뀌는 경우 해당 문서와 message catalog
- migration이 있으면 forward migration과 호환성 검증
- 보안 경계가 바뀌면 threat case와 negative test

### 2.2 한 CP에 섞지 않을 것

- 서로 독립적으로 revert해야 하는 기능
- 대규모 formatting/rename과 실제 동작 변경
- DB contract 제거와 아직 이전 contract를 쓰는 consumer 변경
- runtime secret 값과 source code
- 여러 vendor integration을 한 번에 추가하는 작업
- 기능 구현과 무관한 기존 사용자 변경

### 2.3 Commit 완료 조건

모든 CP는 다음 공통 조건을 만족해야 한다.

- repository의 formatter, lint, typecheck와 해당 package test가 통과한다.
- 새 public type/API/event/artifact에는 schema version과 contract test가 있다.
- error path와 authorization path를 최소 하나 검증한다.
- telemetry에 source, path, prompt, token이 들어가지 않는지 검토한다.
- 변경된 요건 ID를 commit body 또는 PR description에 기록한다.
- 미정 값은 code에 임의로 고정하지 않고 config/interface/TBD로 남긴다.
- commit 단독 checkout 상태에서 build와 test가 가능하다.

권장 commit 형식:

```text
<type>(<scope>): <구체적인 변경>

Requirements: FR-SN-001, SEC-011
Commit-Phase: CP-08
```

`type`은 `docs`, `chore`, `feat`, `fix`, `test`, `refactor`, `ci`, `build`를 사용한다. 제목은 실제 변경을 설명하며 “setup”, “update”, “misc”처럼 범위가 불분명한 단어만 쓰지 않는다.

### 2.4 Schema와 배포 호환성

- DB는 `expand → backfill/dual-read → contract` 순으로 바꾼다.
- event/artifact는 producer가 새 version을 내기 전에 consumer가 새 version을 읽을 수 있어야 한다.
- rolling deployment 동안 Web/API/Poller/Worker의 현재·직전 image가 같은 DB schema에서 동작해야 한다.
- destructive migration은 별도 CP로 분리하고 backup, queue drain, rollback 불가 범위를 명시한다.
- feature flag는 미완성 기능을 숨기는 수단으로만 사용하지 않는다. 운영상 점진 rollout과 kill switch가 필요한 경계에 사용한다.

## 3. Milestone과 dependency

| Milestone | Commit Phase | 결과 |
|---|---|---|
| M0 Contract & Foundation | CP-00–CP-04 | 문서, monorepo, contract, local platform, DB 기반 |
| M1 Walking Skeleton | CP-05–CP-13 | Polling → snapshot → queue → Worker → 최소 Check/UI |
| M2 Reviewable MVP | CP-14–CP-24 | 실제 diff/finding/evidence/Chat/Git graph review workflow |
| M3 Pilot Hardening | CP-25–CP-28 | stale·권한·보안·운영·배포 검증을 마친 pilot |
| M4 Change Impact & Enterprise | CP-29–CP-33 | impact/history 고도화와 enterprise 기능 |

주 dependency:

```text
CP-00 → CP-01 → CP-02 → CP-03 → CP-04
                    ├──────────────→ CP-14(UI foundation)
                    └→ CP-05 → CP-06 → CP-07 → CP-08 → CP-09
                                              │            │
                                              └→ CP-10 → CP-11 → CP-12 → CP-13
                                                          │
                     CP-14 → CP-15 → CP-16 → CP-17 ───────┤
                                      CP-18 → CP-19 → CP-20
                                                └→ CP-21 → CP-22 → CP-23 → CP-24
                                                                           │
                                                      CP-25 → CP-26 → CP-27 → CP-28
                                                                           │
                                                      CP-29 → CP-30 → CP-31 → CP-32 → CP-33
```

UI foundation은 contract가 고정된 뒤 backend와 일부 병렬 개발할 수 있다. 실제 data integration은 snapshot/diff API가 완성된 CP-11 이후 진행한다.

## 4. M0 — Contract & Foundation

### CP-00 문서와 추적 기준 고정

- 목적: 제품 범위, outbound-only 구조, Worker delivery, UI topology와 요건 ID를 구현 기준으로 고정한다.
- 변경:
  - `.documents/requirements-specification.md`
  - `.documents/functional-design.md`
  - `.documents/implementation-plan.md`
  - 기존 blueprint/UI 설계/handoff/README link 정합화
- 검증:
  - Markdown link와 heading 검사
  - `FR-*`, `DR-*`, `SEC-*`, `NFR-*`, `OD-*`, `CP-*` 중복·미참조 검사
  - draw.io와 문서의 실행 공간·secret 전달 경계 수동 review
- 완료 조건: 미정 사항이 `OD-*`로 분리되고 모든 MVP 기능이 요건과 기능설계에 연결된다.
- 권장 commit: `docs(architecture): define requirements design and commit plan`
- 요건: 전체 기준선

### CP-01 Monorepo와 공통 개발 도구

- 선행: CP-00
- 목적: app/package를 독립 build·test할 수 있는 최소 source tree를 만든다.
- 변경:
  - root `package.json`, `pnpm-workspace.yaml`, `turbo.json`, lockfile
  - `apps/web`, `apps/api`, `apps/poller`, `apps/worker`의 빈 health entry
  - `packages/contracts`, `domain`, `db`, `github`, `git`, `policy`, `observability`
  - TypeScript strict config, ESLint, formatter, test runner, dependency boundary rule
- 검증:
  - clean checkout에서 `pnpm install --frozen-lockfile`, build, lint, typecheck, unit test
  - package boundary 위반 fixture가 lint에서 실패
- 완료 조건: 네 app이 placeholder health command로 실행되며 package graph가 cycle 없이 build된다.
- 권장 commit: `chore(repo): scaffold typed monorepo boundaries`
- 요건: 구현 기반, NFR-OPS-005

### CP-02 Versioned contract와 domain state

- 선행: CP-01
- 목적: REST/event/artifact envelope, ID type과 state transition을 framework 독립 package로 고정한다.
- 변경:
  - opaque branded ID, timestamp, error envelope
  - `SnapshotManifest.v1`, `DiffIndex.v1`, `FindingCandidate.v1`, `AnalysisReport.v1`
  - run/stage/conversation/publish state machine
  - event envelope와 주요 event schema
- 검증:
  - valid/invalid fixture, JSON round-trip, backward reader fixture
  - illegal state transition와 cross-snapshot reference negative test
- 완료 조건: app이 공유 contract를 import할 수 있고 schema validation 실패가 typed error로 나온다.
- 권장 commit: `feat(contracts): add versioned review domain schemas`
- 요건: FR-AN-007, FR-RV-003~004, FR-RP-001, DR-005

### CP-03 Local platform과 configuration boundary

- 선행: CP-01, `OD-002`, `OD-009`, `OD-011`의 개발용 선택
- 목적: PostgreSQL, Redis, S3-compatible storage와 service config를 local에서 재현한다.
- 변경:
  - local compose/devcontainer 또는 동등한 실행 profile
  - typed non-secret config loader와 secret reference interface
  - dependency health/readiness probe
  - `.env.example`에는 placeholder와 설명만 포함
- 검증:
  - platform start/stop, health/readiness, 잘못된 config fail-fast
  - secret value가 config dump와 log에 나타나지 않는 test
- 완료 조건: local에서 네 app이 dependency에 연결되고 runtime secret을 image rebuild 없이 바꿀 수 있다.
- 권장 commit: `chore(platform): add local runtime and typed configuration`
- 요건: SEC-003, DR-008, NFR-OPS-005

### CP-04 Database migration과 tenant isolation skeleton

- 선행: CP-02, CP-03
- 목적: 핵심 entity, repository layer와 tenant 격리의 기반을 만든다.
- 변경:
  - tenant/principal/host/installation/repository/PR/snapshot/run/stage/artifact/poll/publish/audit schema
  - migration runner와 schema version check
  - tenant context repository, PostgreSQL RLS
  - transaction/outbox skeleton
- 검증:
  - migration up/down 또는 documented rollback, clean DB와 기존 version upgrade
  - tenant A token으로 tenant B row 조회·수정 차단
  - unique/idempotency constraint concurrency test
- 완료 조건: source·secret을 저장하지 않는 핵심 metadata model과 isolation test가 green이다.
- 권장 commit: `feat(db): add tenant-scoped review metadata schema`
- 요건: DR-001~002, DR-008, SEC-002, NFR-REL-001

## 5. M1 — Walking Skeleton

### CP-05 GitHub App credential와 host adapter

- 선행: CP-02~04, `OD-001`, `OD-004`
- 목적: GitHub host 차이를 격리하고 short-lived installation credential로 read/Check API를 호출한다.
- 변경:
  - `GitHubHostAdapter`, `InstallationCredentialProvider`
  - App JWT, installation token cache와 early expiry
  - API/GraphQL/Git URL normalizer, redirect/DNS/TLS allowlist policy
  - GitHub Cloud/GHES contract fixture
- 검증:
  - expired token, 401 재발급, 403 permission, 404 scope, rate-limit header
  - allowlist 밖 redirect와 host confusion 차단
  - log/exception/queue에 token이 없는지 검사
- 완료 조건: private test installation metadata와 PR을 최소 permission으로 읽고 token을 영속화하지 않는다.
- 권장 commit: `feat(github): add scoped app authentication and host adapter`
- 요건: FR-GH-001~003, FR-GH-010, SEC-003

### CP-06 Installation과 repository reconciliation

- 선행: CP-05
- 목적: 설치 범위와 repository authorization state를 durable하게 맞춘다.
- 변경:
  - installation/repository sync service
  - permission hash와 last reconciled state
  - revoked/suspended transition, cache eviction event
  - bootstrap command와 operator safe output
- 검증:
  - repository 추가/제거, App 제거, 일시 5xx와 명시적 403 구분
  - revoked repository의 token 발급과 new job 차단
- 완료 조건: 재실행해도 같은 repository가 중복되지 않고 권한 축소가 domain event로 전달된다.
- 권장 commit: `feat(github): reconcile installations and repository access`
- 요건: FR-GH-009, UC-006, SEC-002, DR-007

### CP-07 Poll state, scheduler lease와 quota

- 선행: CP-04, CP-06, `OD-003`
- 목적: 여러 Poller replica가 checkpoint와 quota를 보존하며 due target을 조회한다.
- 변경:
  - poll target/checkpoint repository
  - active/idle/draft interval calculator
  - PostgreSQL lease/shard claim
  - primary/secondary rate limit, `retry-after`, reset, `x-poll-interval`
- 검증:
  - concurrent replica, lease expiry/takeover, restart recovery
  - quota 80% background cap과 reserve priority unit test
  - pagination 중단 후 마지막 page checkpoint 재개
- 완료 조건: 두 Poller가 동시에 실행돼도 target cycle이 중복되지 않고 2 interval 안에 복구한다.
- 권장 commit: `feat(poller): add durable scheduling leases and quota budget`
- 요건: FR-GH-006~007, NFR-REL-002, NFR-SCL-001~002

### CP-08 PR 관측과 snapshot idempotency

- 선행: CP-07
- 목적: polling 결과에서 실제 분석이 필요한 PR 변화만 판정한다.
- 변경:
  - conditional PR list/detail fetch
  - PR observation upsert와 transition decision
  - snapshot/run idempotency key
  - `pull.observed.v1`, `snapshot.created.v1`, `analysis.requested.v1` outbox
- 검증:
  - open/reopen/draft release/head/base/title-only 변화 matrix
  - `updated_at`과 OID가 불일치하는 fixture
  - concurrent insert 시 snapshot/run 1개
- 완료 조건: private test PR open과 head 변경이 서로 다른 snapshot request를 만들고 동일 head 반복 조회는 no-op이다.
- 권장 commit: `feat(poller): detect pull request snapshot transitions`
- 요건: FR-GH-004~005, FR-SN-001~002, NFR-REL-001

### CP-09 Manual refresh와 priority queue

- 선행: CP-07~08
- 목적: 사용자의 최신 상태 확인을 자동 polling보다 우선한다.
- 변경:
  - `POST /pulls/{id}/refresh`
  - refresh coalescing row/job, priority policy
  - deferred/rate-limited status API/event
  - authorization·audit 처리
- 검증:
  - 동시 요청 N건 coalesce, 다른 tenant는 분리
  - quota 부족 시 `retryAt`, 10초 시작/상태 표시 acceptance
  - 권한 없는 refresh 거부
- 완료 조건: UI 또는 API에서 refresh를 요청하면 기존 poll cycle과 충돌 없이 우선 처리된다.
- 권장 commit: `feat(poller): prioritize and coalesce manual refresh`
- 요건: FR-GH-008, UC-003, BR-001

### CP-10 Safe Git runner와 mirror/worktree

- 선행: CP-05, CP-08
- 목적: repository를 격리된 경로에서 안전하게 fetch하고 immutable worktree를 만든다.
- 변경:
  - argv-only process runner, timeout/output limit/cancellation
  - ref/OID/path validator와 Git config/hook 차단
  - repository UUID bare mirror lock
  - detached worktree lifecycle, symlink/submodule 검사
- 검증:
  - malicious filename/ref/option, hook, symlink escape, submodule URL fixture
  - force-push, merge commit, shallow deepen, concurrent mirror access
  - cancellation 뒤 worktree cleanup
- 완료 조건: 허용 OID만 worktree로 만들고 sandbox 밖 write와 비허용 network 요청이 실패한다.
- 권장 commit: `feat(git): add isolated mirror and worktree runner`
- 요건: FR-SN-003~005, FR-SN-008~009, SEC-011

### CP-11 Snapshot manifest와 raw diff artifact

- 선행: CP-02, CP-04, CP-10
- 목적: downstream이 Git repository 대신 versioned immutable artifact를 소비하게 한다.
- 변경:
  - snapshot manifest producer
  - raw diff, file status, hunk와 old/new line mapping
  - binary/generated/rename/oversized 분류
  - object upload→artifact row commit과 orphan cleanup marker
  - snapshot/file/diff read API
- 검증:
  - rename/binary/generated/whitespace/large hunk fixture golden
  - checksum/version 변조, object upload/DB failure recovery
  - cross-tenant artifact 접근 차단
- 완료 조건: snapshot에서 file tree와 범위 기반 diff를 API로 읽으며 line mapping이 fixture와 일치한다.
- 권장 commit: `feat(snapshot): persist immutable diff artifacts`
- 요건: FR-SN-006~009, FR-AN-001, DR-003~005

### CP-12 Worker OCI image와 CI/CD supply chain

- 선행: CP-01, CP-03, CP-10, `OD-009`, `OD-011`
- 목적: Worker를 CI job이 아닌 private runtime의 별도 signed image로 배포한다.
- 변경:
  - `infra/containers/worker.Dockerfile` multi-stage build, pinned base/tool versions
  - `ci/worker-image.yml`: build/test/scan/SBOM/provenance/sign/push
  - immutable digest deploy manifest/overlay
  - ConfigMap, secret reference/workload identity, ephemeral Git volume, service account, NetworkPolicy
- CI에 입력할 non-secret 정보:
  - registry host/path, image name, allowed base digest, target platform, scan/sign policy, deployment environment, manifest path
- CI identity에 연결할 권한:
  - source read, registry push, signing keyless identity, 허용 environment의 manifest/digest update. runtime secret read 권한은 부여하지 않는다.
- Runtime에 입력할 non-secret 정보:
  - queue/database/object/model endpoint 이름, GitHub host allowlist, concurrency, timeout, CA bundle path, feature flag
- Runtime secret/identity:
  - GitHub App private key reference, DB/queue/storage/model credential reference. secret manager 또는 workload identity로 주입한다.
- 검증:
  - image layer/history/build cache/CI log secret scan
  - SBOM/provenance/signature와 critical vulnerability gate
  - unsigned image·mutable tag admission 거부
  - private runtime queue smoke job과 egress deny test
- 완료 조건: 승인 digest의 Worker가 runtime secret을 image rebuild 없이 받아 smoke job을 처리한다.
- 권장 commit: `ci(worker): build sign and deploy immutable worker image`
- 요건: SEC-003, SEC-008~010, FR-AN-008, NFR-SCL-001

### CP-13 Queue orchestrator, 빈 report와 최소 Check

- 선행: CP-08, CP-11, CP-12
- 목적: detection에서 GitHub Check까지 끝나는 Walking Skeleton을 완성한다.
- 변경:
  - run/stage orchestrator와 checkpoint/retry
  - `diff-index → compose empty report → publish Check` pipeline
  - outbox consumer와 Check delivery idempotency/receipt
  - 최소 API/UI: PR, snapshot, run stage/status, Check link
  - current head 재검증과 superseded 처리
- 검증:
  - PR open→poll→snapshot→queue→Worker→Check E2E
  - Worker kill/restart, publish timeout/retry, duplicate event
  - 분석 중 head 변경 시 이전 Check stale/superseded
- 완료 조건: Walking Skeleton의 모든 Phase 0 완료 조건과 AT-001~003의 backend 흐름을 충족한다.
- 권장 commit: `feat(review): complete polling-to-check walking skeleton`
- 요건: FR-RP-001~004, NFR-REL-001~005, BR-005, BR-009

## 6. M2 — Reviewable MVP

### CP-14 Web shell, OIDC와 `ko-KR` 기반

- 선행: CP-01~04, `OD-012`
- 목적: 인증된 사용자가 한글 기본 UI와 typed API client로 workspace에 들어온다.
- 변경:
  - Next.js app shell, OIDC session, principal/GitHub identity mapping interface
  - repository/PR route와 authorization error boundary
  - message catalog, `Intl` formatter, technical term glossary
  - API client error code mapping
- 검증:
  - unauthenticated/expired/denied flow
  - hard-coded 사용자 문구와 locale formatting 검사
  - source/error가 client telemetry에 남지 않는 test
- 완료 조건: 권한 있는 test user만 repository/PR 상태 페이지에 접근하고 모든 주요 상태를 한글로 본다.
- 권장 commit: `feat(web): add authenticated Korean review shell`
- 요건: SEC-001~002, FR-UI-015, NFR-I18N-001

### CP-15 Resizable LNB/Main/Chat/FNB layout

- 선행: CP-14
- 목적: production workspace topology와 responsive fallback을 구현한다.
- 변경:
  - CSS Grid shell, LNB/Main/Chat/FNB
  - accessible vertical/horizontal separator
  - pointer·keyboard resize, default reset, min/max clamp
  - versioned local/server layout preference
  - desktop/compact/stacked/mobile state
- 검증:
  - 1440/1024/768/mobile screenshot·interaction E2E
  - pointer/keyboard resize, reload, corrupt preference, viewport round-trip
  - Main min 560px과 overflow 검사
- 완료 조건: Findings 영역과 Chat이 desktop에서 동시에 보이고 Chat component가 panel 전환에 unmount되지 않는다.
- 권장 commit: `feat(workspace): implement resizable persistent review layout`
- 요건: FR-UI-001, FR-UI-004~008, FR-UI-016

### CP-16 Files LNB와 virtualized diff

- 선행: CP-11, CP-14~15
- 목적: snapshot의 file tree와 실제 split/unified diff를 대형 PR에서도 탐색한다.
- 변경:
  - Files tree, status/count/generated/binary/omitted 표시
  - diff range query, virtualization, anchor resolver
  - split/unified, context, whitespace preference
  - loading/empty/error/partial 상태
- 검증:
  - rename/binary/100 files/5,000 lines fixture
  - old/new line deep link와 scroll 복원
  - keyboard tree navigation와 accessibility scan
- 완료 조건: file 선택부터 정확한 hunk/line 표시까지 concept placeholder 없이 동작한다.
- 권장 commit: `feat(diff): render virtualized snapshot file changes`
- 요건: FR-UI-002~003, FR-UI-013~014, NFR-PERF-002~003

### CP-17 Finding/Report API와 Findings LNB

- 선행: CP-02, CP-13, CP-15~16
- 목적: priority/confidence가 분리된 finding을 filter하고 diff와 연결한다.
- 변경:
  - report/finding repository와 read API
  - Findings group/filter/count, finding detail
  - snapshot-scoped selection reducer
  - finding→diff anchor resolution과 stale/invalid state
- 검증:
  - priority/confidence/category/status filter contract
  - finding selection→Main anchor E2E
  - 다른 snapshot finding ID와 invalid line 거부
- 완료 조건: LNB finding 선택이 같은 snapshot의 diff 위치를 열고 근거 준비 상태를 표시한다.
- 권장 commit: `feat(findings): connect review findings to diff anchors`
- 요건: FR-RV-003~004, FR-RP-001, FR-UI-002~003, FR-UI-009

### CP-18 Symbol과 History analyzer

- 선행: CP-11, `OD-006`
- 목적: 우선 두 언어의 변경 symbol과 Git history evidence를 생성한다.
- 변경:
  - Tree-sitter adapter interface와 선택 언어 adapter
  - changed symbol/index/parse coverage artifact
  - rename-aware log, blame, churn artifact
  - Outline/History API
- 검증:
  - 언어별 function/class/method/signature fixture
  - parse error·generated file partial coverage
  - rename, merge, shallow history, blame range fixture
- 완료 조건: Outline에서 symbol을 선택하고 해당 diff/history로 이동하며 coverage를 확인한다.
- 권장 commit: `feat(analyzers): index changed symbols and git history`
- 요건: FR-AN-002~003, FR-AN-007~010, FR-UI-002, FR-UI-010

### CP-19 Agent tool gateway와 Change Pack

- 선행: CP-02, CP-11, CP-18, `OD-005`
- 목적: model이 제한된 snapshot evidence만 읽는 typed tool boundary를 만든다.
- 변경:
  - `ModelGateway` adapter와 private profile config
  - typed tools: diff range, file fragment, symbol, history, finding context
  - server-side scope injection, call count/size/token/time budget
  - risk-ordered Change Pack Builder
- 검증:
  - model이 tenant/repository/ref/path를 바꿔도 scope 고정
  - arbitrary tool/URL/shell 요청 거부
  - oversized PR budget ordering과 omission
  - prompt/source 없는 tool telemetry
- 완료 조건: synthetic change pack을 승인 model로 처리하며 허용 artifact 밖 data에 접근하지 못한다.
- 권장 commit: `feat(agent): add scoped tools and budgeted change packs`
- 요건: FR-RV-001, FR-RV-008~009, FR-AN-009, SEC-004~007

### CP-20 Specialist, Verifier와 Report Composer

- 선행: CP-17~19
- 목적: correctness/security/test candidate를 검증 가능한 report로 만든다.
- 변경:
  - 세 specialist prompt/contract와 independent timeout
  - candidate schema parse·limited repair
  - verifier: line, diff relevance, evidence, duplicate, priority/confidence
  - report composer, coverage/omission/provenance
  - golden fixture와 finding fingerprint v1
- 검증:
  - known bug/security/test omission golden set
  - hallucinated line, unsupported claim, duplicate, malformed output
  - specialist 하나 실패 후 partial report
  - P3 high-confidence+direct-evidence policy
- 완료 조건: 모든 노출 finding이 유효 evidence를 가지며 일부 model 실패가 전체 report를 없애지 않는다.
- 권장 commit: `feat(review): verify specialist findings into reports`
- 요건: FR-RV-002~009, FR-RP-001, BR-003, BR-006

### CP-21 Evidence trail과 selection synchronization

- 선행: CP-17~20
- 목적: finding의 근거를 compact FNB에서 확인하고 원본으로 돌아간다.
- 변경:
  - Evidence Resolver API와 locator validation
  - FNB Evidence compact summary, chip, provenance/detail maximize
  - selection reducer: finding/file/symbol/evidence
  - missing/stale/counter evidence 상태
- 검증:
  - finding→diff→evidence→원래 line/commit 왕복 E2E
  - cross-snapshot locator와 checksum 변조 차단
  - FNB 기본 132px/collapse 상태에서 사용성 확인
- 완료 조건: 모든 게시 가능한 finding에서 직접 evidence를 한 번의 선택으로 열 수 있다.
- 권장 commit: `feat(evidence): add compact trace and synchronized navigation`
- 요건: FR-RV-005, FR-UI-005, FR-UI-009~010, AT-004

### CP-22 Persistent Chat API, Agent와 SSE

- 선행: CP-15, CP-19, CP-21
- 목적: Findings 옆에서 snapshot-scoped Chat을 계속 사용한다.
- 변경:
  - conversation/message schema와 API
  - message command, Chat Worker, typed read tools
  - sequence 기반 SSE/reconnect
  - right dock UI, draft/stream 보존, context/evidence chip
  - stale conversation과 새 snapshot 대화 분리
- 검증:
  - finding을 바꾸는 동안 draft/stream 유지
  - reconnect 중복 chunk 방지
  - 다른 snapshot tool 접근, arbitrary write tool, budget 초과 차단
  - 권한 회수 시 stream 종료
- 완료 조건: Reviewer가 finding을 보며 질문하고 답변 evidence로 이동할 수 있다.
- 권장 commit: `feat(chat): stream snapshot-scoped review conversations`
- 요건: FR-CH-001~008, FR-UI-004, BR-004

### CP-23 PR 중심 Git graph와 commit diff

- 선행: CP-11, CP-15~18, CP-21
- 목적: base/merge-base/head와 commit별 변경을 실제 data로 탐색한다.
- 변경:
  - graph pagination artifact/API
  - compact FNB Git graph와 Main maximize
  - base/merge-base/head/ref style, parent edge
  - commit selection→commit diff/Findings/Chat context 동기화
- 검증:
  - merge commit, force-push, multiple parent, history pagination
  - graph commit→diff→finding→Chat scope E2E
  - unknown/missing parent 표시
- 완료 조건: concept 화면에 없던 Git graph가 production artifact와 연결되고 commit diff로 이동한다.
- 권장 commit: `feat(graph): connect pull request history to review scope`
- 요건: FR-UI-009~012, FR-AN-003

### CP-24 Repository config, suppression과 게시 정책

- 선행: CP-20~23, `OD-007`
- 목적: base config와 관리 정책으로 분석·출력·inline 게시를 통제한다.
- 변경:
  - `.gcr.yml` schema/parser와 `.gcr/rules/*.md` hash
  - restrictive config merge와 run provenance
  - inline skip directive, reason/CODEOWNER policy
  - Check summary와 optional inline comment policy
  - publish delivery idempotency·anchor revalidation 고도화
- 검증:
  - head config 완화 무시, invalid/unknown config
  - reason 없는 suppression, P3 승인 전후
  - stale/invalid anchor comment 차단, retry at-most-once
  - PR Write permission이 없을 때 inline off
- 완료 조건: repository별 정책이 run과 report에 재현 가능하게 기록되고 stale comment를 게시하지 않는다.
- 권장 commit: `feat(policy): enforce base config suppression and publish rules`
- 요건: FR-RP-005~008, FR-CF-001~006, SEC-014 제외

## 7. M3 — Pilot Hardening

### CP-25 Authorization freshness, stale와 cancellation 통합

- 선행: CP-06, CP-13, CP-22~24
- 목적: head와 권한 변화가 API, Worker, Chat, Publisher 전체에 같은 방식으로 반영된다.
- 변경:
  - short authorization TTL과 민감 command recheck
  - `authorization.revoked.v1`, `run.superseded.v1` consumer
  - cooperative cancellation point와 cache/stream eviction
  - UI current/stale/superseded/access-revoked 상태
- 검증:
  - 분석·Chat·publish 각각의 중간 권한 회수
  - head 변경 후 10초 state propagation
  - stale API command와 artifact URL 차단
- 완료 조건: 권한이나 head가 바뀐 뒤 이전 결과가 외부 side effect나 새로운 Chat 근거로 사용되지 않는다.
- 권장 commit: `feat(security): enforce live authorization and stale cancellation`
- 요건: FR-GH-009, FR-RP-003, FR-CH-006~007, NFR-REL-004, SEC-002

### CP-26 Observability, audit와 privacy guard

- 선행: CP-13, CP-20, CP-24~25
- 목적: source를 노출하지 않고 전체 흐름을 운영·감사할 수 있게 한다.
- 변경:
  - poll/queue/stage/model/publish/API metric
  - end-to-end correlation trace와 structured safe error
  - audit action 집합, 조회 API와 접근 역할
  - telemetry redaction/lint/test helper
  - dashboard와 alert query 초안
- 검증:
  - source/path/prompt/token leakage fixture
  - 한 run의 poll→publish correlation
  - audit actor/scope/action/result 재구성, tenant isolation
- 완료 조건: 장애 원인을 correlation ID로 추적하고 audit가 private source 없이 주요 쓰기 동작을 설명한다.
- 권장 commit: `feat(ops): add privacy-safe telemetry and audit trail`
- 요건: FR-CF-006, SEC-004, SEC-013, NFR-OPS-001~003

### CP-27 Reliability, load와 security test gate

- 선행: CP-25~26, `OD-003`, `OD-010`
- 목적: MVP 목표 수치와 attack/failure scenario를 CI와 staging gate에서 검증한다.
- 변경:
  - 100 files/5,000 lines performance fixture
  - concurrent Poller/Worker, rate limit, queue poison, dependency outage test
  - tenant IDOR, SSRF/redirect, Git exploit, prompt injection, XSS suite
  - managed Chrome/Edge E2E matrix와 accessibility scan
  - golden finding regression report
- 검증:
  - NFR 목표를 환경·표본·p50/p95와 함께 기록
  - AT-001~012 전체 실행
  - failure injection 후 중복 Check/comment 없음
- 완료 조건: blocker severity의 security/reliability 결함이 없고 미달 성능은 측정값과 승인된 remediation을 남긴다.
- 권장 commit: `test(system): gate review workflow reliability and security`
- 요건: AT-001~012, SEC-001~013, NFR-PERF-*, NFR-SCL-*, NFR-REL-*, NFR-A11Y-001

### CP-28 Pilot deployment, runbook와 release gate

- 선행: CP-12, CP-27, `OD-001~012` 중 pilot 필수값
- 목적: private test/pilot repository에서 운영 가능한 배포를 만든다.
- 변경:
  - environment overlay, immutable image inventory, migration job
  - deploy/rollback, queue drain, poll recovery, secret rotation, purge runbook
  - dashboard/alert, backup/restore check, on-call ownership
  - pilot repository allowlist와 feature flag
  - 운영 값과 미정 사항 decision record
- 검증:
  - fresh deploy, rolling deploy, rollback rehearsal
  - signed digest pull, ConfigMap 변경, secret rotation, Worker smoke job
  - Poller 중단/복구, DB restore 후 duplicate publish 없음
  - pilot acceptance와 보안 review sign-off
- 완료 조건: 제한된 repository에서 M2 기능을 운영하고 장애·rollback·권한 회수 절차를 담당자가 재현한다.
- 권장 commit: `chore(release): prepare private pilot operations`
- 요건: NFR-OPS-004~005, SEC-003, SEC-008~010, BR-001~010

## 8. M4 — Change Impact & Enterprise

M4는 MVP pilot 결과와 `OD-006`, retention·tenant 요구를 반영해 착수한다. 아래 CP도 contract와 test를 포함하는 logical commit 단위로 유지한다.

### CP-29 Dependency edge와 Related tests

- 선행: CP-18, CP-23, 지원 언어별 분석 전략 확정
- 변경: import/reference graph, edge certainty, related test heuristic, Impact/Tests API와 FNB/Main view.
- 검증: static/dynamic uncertainty fixture, direct/transitive 구분, unknown을 false negative처럼 감추지 않는 UI.
- 완료 조건: 변경 symbol에서 직접 caller와 관련 test 후보로 이동하고 각 결과의 근거를 확인한다.
- 권장 commit: `feat(impact): trace direct dependencies and related tests`
- 요건: FR-AN-004~005, FR-UI-011

### CP-30 Ownership와 moved history

- 선행: CP-18, CP-29
- 변경: CODEOWNERS, blame, review history source 분리, file rename/moved symbol history, Ownership view.
- 검증: 서로 다른 owner 근거, rename/move fixture, pagination과 provenance.
- 완료 조건: ownership을 단일 사실로 단정하지 않고 source와 snapshot을 표시한다.
- 권장 commit: `feat(history): add provenance-aware ownership and moved symbols`
- 요건: FR-AN-006, FR-UI-011

### CP-31 Finding lifecycle

- 선행: CP-20, CP-30
- 변경: fingerprint v2 migration, acknowledged/resolved/reintroduced relation과 UI history.
- 검증: line shift, rename, 수정, 재도입, fingerprint collision fixture.
- 완료 조건: 과거 finding을 현재 finding과 근거 있게 연결하고 애매한 경우 새 finding으로 남긴다.
- 권장 commit: `feat(findings): track resolved and reintroduced issues`
- 요건: FR-RV-010

### CP-32 Retention, purge와 audit export

- 선행: CP-26, CP-28, `OD-008`
- 변경: retention class별 lifecycle, installation purge orchestration, audit export, encryption key extension.
- 검증: active access 선차단, signed URL 폐기, object/DB 삭제, export authorization와 data minimization.
- 완료 조건: 조직이 정한 기간과 SLA 안에 자료를 삭제하고 최소 audit proof를 보존한다.
- 권장 commit: `feat(compliance): enforce retention purge and audit export`
- 요건: DR-006~007, SEC-005, FR-CF-007

### CP-33 Enterprise isolation과 sandboxed bisect

- 선행: CP-27~32, 별도 승인 workflow 확정
- 변경: tenant key/pool isolation option, queue partition, data residency policy, network-isolated bisect sandbox와 승인 command profile.
- 검증: tenant noisy-neighbor/IDOR, region policy, sandbox egress deny, timeout/flaky/skip 상태.
- 완료 조건: 승인된 profile만 repository command를 실행하며 다른 tenant 성능·data boundary를 침범하지 않는다.
- 권장 commit: `feat(enterprise): isolate tenant workloads and approved bisect`
- 요건: NFR-SCL-003, SEC-005, 제외 범위를 변경하는 경우 별도 요건 승인 필요

## 9. Phase별 quality gate

| Gate | 적용 시점 | 필수 검사 | 실패 시 처리 |
|---|---|---|---|
| G0 Commit | 모든 CP | format, lint, typecheck, affected unit/contract test, secret scan | commit/merge 금지 |
| G1 Foundation | CP-04 | clean migration, RLS/IDOR, package boundary | M1 진입 금지 |
| G2 Walking Skeleton | CP-13 | private PR E2E, duplicate/restart/stale, signed Worker smoke | M2 data integration 금지 |
| G3 Review Quality | CP-20 | golden set, verifier negative case, partial report | finding 게시 금지 |
| G4 Workspace | CP-24 | diff/finding/evidence/Chat/graph E2E, accessibility, responsive | pilot 진입 금지 |
| G5 Security/Reliability | CP-27 | threat suite, load/failure, telemetry leakage | release blocker |
| G6 Pilot | CP-28 | deploy/rollback/rotation/recovery, 운영·보안 승인 | repository allowlist 확대 금지 |

## 10. Test 실행 분류

| 명령 범주 | 실행 위치 | 대상 |
|---|---|---|
| `test:unit` | local/CI | 순수 domain, parser helper, state, policy |
| `test:contract` | CI | REST/event/artifact/GitHub adapter schema |
| `test:integration` | CI service container | PostgreSQL/Redis/object/Git fixture |
| `test:agent-golden` | 승인 model test environment 또는 deterministic stub | candidate/verifier/report regression |
| `test:e2e` | ephemeral private environment | browser→API→Worker→GitHub test double/private repo |
| `test:security` | CI+staging | IDOR, Git exploit, prompt injection, XSS, image/secret scan |
| `test:load` | isolated staging | polling/queue/API/diff 규모와 quota |
| `test:smoke` | deploy 후 | health, queue job, test snapshot, Check capability |

Model-dependent test는 비용과 변동성을 줄이기 위해 contract stub test와 실제 approved model golden test를 분리한다. 실제 model 결과는 exact sentence가 아니라 schema, evidence reference, policy decision과 허용 범위로 판정한다.

## 11. Release와 rollback

### 11.1 배포 순서

1. backward-compatible DB expand migration
2. 새 contract를 읽을 수 있는 consumer 배포
3. producer 배포
4. background backfill 또는 artifact regeneration
5. 관측 기간 뒤 구 contract 제거 migration

Web/API/Poller/Worker image는 각각 digest를 기록한다. Worker는 queue drain 없이 rolling할 때 job lease와 graceful shutdown을 지켜야 한다. 완료하지 못한 job은 visibility timeout 뒤 다른 Worker가 마지막 completed stage에서 재개한다.

### 11.2 Rollback 조건

- tenant authorization bypass 또는 private data leakage
- stale head에 Check/comment가 게시되는 결함
- duplicate run/publish가 지속되는 idempotency 손상
- migration 후 이전 version이 schema를 읽지 못하는 경우
- queue lag나 GitHub quota 소모가 설정한 safety threshold를 넘는 경우
- critical image vulnerability 또는 signature/admission 실패

Rollback은 이전 immutable digest로 수행한다. migration이 contract 단계까지 진행되어 rollback할 수 없으면 서비스 write를 멈추고 별도 recovery procedure를 따른다. 이를 피하기 위해 destructive migration은 pilot 안정화 전 실행하지 않는다.

### 11.3 Feature rollout

| 기능 | 초기값 | 확대 기준 |
|---|---|---|
| repository polling | pilot allowlist | detection lag·quota·duplicate 지표 안정 |
| specialist agent | selected repository | precision review와 cost budget 확인 |
| Chat | selected tenant | model/data policy와 access-revocation test 통과 |
| inline comment | off | anchor error·stale-post 0, permission 승인 |
| P3 Check failure | off | high-confidence/direct-evidence 품질 기준 승인 |
| impact/related tests | off | 언어별 edge accuracy와 omission 표시 승인 |
| bisect | off | sandbox와 사용자 승인 workflow 완료 |

## 12. 운영 준비 항목

CP-28을 완료하기 전 다음 값을 실제 환경 기준으로 기록한다.

| 분류 | 필요한 정보 | 저장 위치 원칙 |
|---|---|---|
| GitHub | host URL, API kind/version, App ID, installation 범위, permission | App ID/host는 ConfigMap, private key는 Secret Manager reference |
| Network | fixed egress IP, allowed host/port, DNS/TLS inspection, CA bundle | network policy/IaC, CA는 versioned secret/config artifact |
| CI/CD | runner identity, registry path, image policy, signing issuer, deploy environment | CI variable와 OIDC trust policy. 장기 secret 금지 |
| Runtime | namespace/node pool, service account, replica/concurrency, volume size, resource limit | deployment manifest/ConfigMap |
| Data | DB/storage endpoint, encryption, backup, retention class, purge SLA | IaC와 secret reference 분리 |
| Queue | endpoint, priority/concurrency, retry/dead-letter, visibility timeout | ConfigMap+credential reference |
| Model | gateway endpoint/profile, allowed model/version/region, token budget, retention | tenant policy/ConfigMap, credential reference |
| Identity | OIDC issuer/client, group-role mapping, GitHub identity link | identity config, secret manager where required |
| Observability | metric/trace/log endpoint, redaction policy, alert route | platform config, source payload 금지 |

## 13. Definition of Ready와 Done

### 13.1 Commit Phase 시작 조건

- 관련 요건 ID와 설계 section이 식별되어 있다.
- `OD-*` 중 결과를 바꾸는 값이 확정됐거나 vendor-neutral interface로 제한할 수 있다.
- 외부 dependency와 credential 사용 방식이 승인 범위 안에 있다.
- fixture 또는 test double을 준비할 방법이 있다.
- DB/API/event 변경이면 호환성과 rollback 방식이 정의되어 있다.

### 13.2 Commit Phase 완료 조건

- 해당 CP의 변경·검증·완료 조건을 모두 충족한다.
- 새 실패 mode가 safe error 또는 omission으로 표현된다.
- 권한, tenant, stale, retry 중 관련 negative path를 test했다.
- 운영자가 알아야 할 config/metric/runbook 변경을 문서에 반영했다.
- 요건 추적 표와 decision record를 갱신했다.
- 관련 없는 변경이나 secret이 commit에 없다.

### 13.3 Milestone 완료 조건

- 해당 Gate가 CI 또는 승인된 environment에서 통과한다.
- open blocker와 known limitation이 report coverage 또는 release note에 기록된다.
- 변경한 external contract의 consumer가 준비되어 있다.
- rollback 또는 기능 비활성화 경로가 검증됐다.
- 제품·보안·운영 담당자가 각자 확인해야 할 evidence link를 갖는다.

## 14. 요건–Commit Phase 추적표

| 요건군 | 주 구현 CP | 검증 CP |
|---|---|---|
| `BR-001~010`, `AT-001~012` | 각 기능 CP | CP-27, CP-28 pilot acceptance |
| `FR-GH-001~003,010` | CP-05 | CP-27 |
| `FR-GH-004~009` | CP-06~09 | CP-13, CP-25, CP-27 |
| `FR-GH-011`, `SEC-014` | optional webhook 별도 CP | 기준 배포에 미포함, 별도 security gate |
| `FR-SN-001~009` | CP-08, CP-10~11 | CP-13, CP-27 |
| `FR-AN-001~003,007~010` | CP-11, CP-18 | CP-20, CP-27 |
| `FR-AN-004~006` | CP-29~30 | 각 CP fixture, CP-33 scale |
| `FR-RV-001~009` | CP-19~20 | CP-27 |
| `FR-RV-010` | CP-31 | CP-31 regression |
| `FR-RP-001~004` | CP-13, CP-20 | CP-25, CP-27 |
| `FR-RP-005~008` | CP-24 | CP-27 |
| `FR-UI-001~016` | CP-14~18, CP-21~23 | CP-24, CP-27 |
| `FR-CH-001~008` | CP-22 | CP-25, CP-27 |
| `FR-CF-001~006` | CP-24, CP-26 | CP-27 |
| `FR-CF-007` | CP-32 | CP-32 security test |
| `DR-001~005,008~009` | CP-04, CP-11, CP-14 | CP-27 |
| `DR-006~007` | CP-06, CP-32 | CP-28/32 purge rehearsal |
| `SEC-001~007,011~013` | CP-05, CP-10, CP-14, CP-19, CP-25~27 | CP-27 |
| `SEC-008~010` | CP-12 | CP-27~28 |
| `NFR-PERF-*`, `NFR-SCL-*`, `NFR-REL-*` | CP-07, CP-12~13, CP-16, CP-25 | CP-27~28 |
| `NFR-OPS-*` | CP-03, CP-26, CP-28 | CP-28 rehearsal |
| `NFR-UX-*`, `NFR-A11Y-*`, `NFR-I18N-*`, `NFR-COMP-*` | CP-14~16, CP-21~23 | CP-27 |

## 15. 첫 구현 착수 순서

환경 결정이 모두 끝나지 않아도 CP-00~04와 adapter interface는 구현할 수 있다. 실제 GitHub와 runtime 연결 전에 다음 항목만 먼저 확정한다.

- CP-05 전: 첫 GitHub target과 token 발급 방식
- CP-07 전: 예상 repository/PR 규모와 허용 detection lag의 범위
- CP-12 전: CI runner, private registry, signing과 runtime platform
- CP-14 전: OIDC identity 연결 방식
- CP-18 전: 우선 지원 언어 두 개
- CP-19 전: approved model gateway/profile
- CP-24 전: inline comment와 P3 Check 정책
- CP-28 전: retention, backup, alert와 운영 담당자

실제 첫 개발 묶음은 CP-00부터 CP-04까지다. 그 뒤 CP-05~13을 순서대로 완료해 빈 report라도 end-to-end로 흐르는 상태를 만든 다음 analyzer, agent, UI 기능을 확장한다.

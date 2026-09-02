# Git Code Reviewer - 구현 계획서

## 1. 목적과 방식

이 계획은 browser 기반 중앙 review service를 빈 repository에서 구현하는 순서를 정의한다. 대상 repository CI와 결합하지 않으며, 각 milestone은 Kubernetes pilot 환경에서 검증 가능한 수직 기능으로 끝난다.

| 항목 | 기준 |
|---|---|
| language | TypeScript |
| frontend | React + Vite |
| server | Fastify |
| database/job | PostgreSQL |
| repository | pnpm workspace |
| test | Vitest, integration fixture, Playwright |
| package | 하나의 OCI image |
| deploy | Helm chart |

### 1.1 개발 원칙

- Contract/schema와 consumer를 같은 변경에서 검증한다.
- 기능마다 success, retry/partial, authorization과 terminal failure 경로를 함께 구현한다.
- 실제 GHES와 platform 제약은 `M0-00`에서 검증하며 확인되지 않은 값을 조직 정책처럼 hard-code하지 않는다.
- Repository source를 실행하는 test fixture를 만들지 않는다.
- 실제 secret, 내부 hostname과 environment values를 source에 commit하지 않는다.
- Image와 chart는 첫 milestone부터 build/lint한다.
- API/SSE/data/artifact 상세는 기능 설계, 요구사항/AC/DEC는 요구사항 명세를 정본으로 사용한다.

## 2. 목표 repository 구조

```text
apps/
  web/                    # React browser application
  runtime/                # serve/worker/migrate/retention entrypoints
packages/
  contracts/              # API, event, artifact schemas
  review-contract/        # Commit Defender compatibility + canonical report
  domain/                 # snapshot, operation, run, finding, authorization
  db/                     # schema, migration, repositories, job lease/event log
  github/                 # GitHub App and GHES adapters
  git-engine/             # isolated clone, diff, history
  analyzers/              # file, symbol, impact, test adapters
  relationships/          # code object graph and relation queries
  review-agent/           # planner, specialists, verifier
  artifact-store/         # filesystem/object storage ports
  observability/          # audit, redaction, metric, tracing
  test-support/           # fixture builders, fake GHES/model
deploy/
  helm/git-code-reviewer/
docs/
  operations/             # install, upgrade, backup, retention, incident runbook
```

`apps/runtime`는 모든 command가 공유하는 조립 지점이다. Process 분리는 command로 수행하고 domain package를 복제하지 않는다.

## 3. Milestone 개요

| Milestone | 사용자에게 보이는 결과 | 운영 결과 |
|---|---|---|
| M0-00 Feasibility | 없음 | 실제 GHES/model/OIDC/storage 제약과 DEC 입력 확보 |
| M0 Foundation | visual workspace shell 접근 | image/chart skeleton과 lifecycle command 설치 |
| M1 Worklist | 로그인 후 등록 PR과 상태 조회 | scheduler leader와 GHES adapter 동작 |
| M2 Snapshot | refresh 후 정확한 diff와 진행 상태 확인 | operation/event/job, isolated clone, artifact commit |
| M3 Review | finding, evidence와 coverage 탐색 | analyzer/model/verifier, partial recovery |
| M4 Workspace | 완성된 LNB/Main/Chat/FNB 흐름 | replica-safe SSE와 revision-bound Chat |
| M5 Pilot | 사내 reviewer pilot | retention, upgrade/rollback/backup/security hardening |

## 4. M0-00 - Feasibility gate

### 목표

구현 가정을 실제 사내 GHES와 Kubernetes 환경에서 검증하고 `DEC-001`부터 `DEC-016`의 입력을 수집한다. 이 단계는 production source를 만들기보다 재현 가능한 spike와 결정 기록을 남긴다.

### 작업

| ID | 작업 |
|---|---|
| M0-00-01 | 대상 GHES exact version, API base URL과 GitHub App read permission 확인 |
| M0-00-02 | Installation token으로 REST, GraphQL과 credential-safe Git HTTPS round trip 검증 |
| M0-00-03 | Authoritative base tip, PR head/pull ref, exact-SHA source permalink와 code-navigation 지원 범위 기록 |
| M0-00-04 | Partial/shallow clone, exact SHA fetch, merge-base와 bounded deepen을 대표 repository로 검증 |
| M0-00-05 | Pagination, conditional request, rate-limit header/reset과 repository/PR 규모 측정 |
| M0-00-06 | Approved model endpoint의 private source/prompt retention, streaming과 timeout 정책 검증 |
| M0-00-07 | Application OIDC를 기본으로 확인하고 proxy identity 사용 시 assertion/header/network 조건 검증 |
| M0-00-08 | External PostgreSQL, RWX PVC/object backend, `emptyDir`/generic ephemeral RWO와 quota 확인 |
| M0-00-09 | Spike 결과, 실패 로그의 redaction 결과와 DEC 입력을 decision record로 남김 |
| M0-00-10 | Commit Defender baseline revision의 report type/schema/normalizer/prompt fixture와 재사용 경계 확정 |

### 완료 조건

- API/GraphQL/Git smoke 결과에 token, clone URL credential과 private source가 남지 않는다.
- Merge-base를 얻는 정상/deepen/unresolved 경로가 재현된다.
- GHES request budget으로 hot/active/idle 초기 tier를 운용할 수 있는지 계산된다.
- 선택 가능한 artifact backend와 workspace mode가 Kubernetes manifest 수준에서 확인된다.
- Fork, scheduler sharding, resource budget처럼 미확정인 항목은 해당 DEC에 근거와 owner가 기록된다.
- Commit Defender baseline commit과 compatibility fixture 목록이 고정되고 VS Code 전용 기능의 제외 범위가 기록된다.

## 5. M0 - Foundation

### 목표

로컬과 Kubernetes에서 같은 production artifact를 실행하고 browser가 실제 Server에서 workspace shell을 받는다.

### 작업

| ID | 작업 |
|---|---|
| M0-01 | pnpm workspace, TypeScript, lint/format/test 공통 설정 |
| M0-02 | React route shell과 제공된 visual artifact 기반 two-row Header/LNB/Main/Chat/FNB layout |
| M0-03 | Fastify startup/liveness/readiness/dependency health와 typed error envelope |
| M0-04 | Contracts package와 schema validation/code generation 경계 |
| M0-05 | PostgreSQL migration runner, advisory lock과 empty baseline schema |
| M0-06 | Multi-stage Dockerfile과 `serve|worker|migrate|retention` command |
| M0-07 | Helm server/worker, Service/Ingress, migration hook, retention CronJob과 artifact storage skeleton |
| M0-08 | `emptyDir`/generic ephemeral workspace template, non-root/read-only rootfs와 Secret reference |
| M0-09 | Values schema, conditional template validation과 application startup config validation |

### 완료 조건

- Local production build에서 worklist/workspace route가 새로고침된다.
- Image가 네 command를 non-root/read-only rootfs로 실행한다.
- Ephemeral namespace에서 `helm upgrade --install`이 성공한다.
- Migration hook은 재실행 가능하고 advisory lock으로 동시 실행되지 않는다.
- Probe는 DB readiness와 외부 dependency health를 구분한다.
- Playwright 1440px/1280px/1020px/mobile screenshot에 blank, overlap과 page overflow가 없다.

## 6. M1 - Authentication, repository와 PR worklist

### 목표

사용자가 application OIDC로 로그인하고 허용된 registered repository의 open PR과 polling 상태를 본다.

### 작업

| ID | 작업 |
|---|---|
| M1-01 | OIDC Authorization Code flow, secure session과 group/role mapping |
| M1-02 | 조건부 proxy identity assertion 검증과 spoofed identity header negative test |
| M1-03 | users, github_instances, repositories, grants, pull_requests, poll_states schema |
| M1-04 | GitHub App JWT/installation token memory cache와 redacted HTTP client |
| M1-05 | Administrator repository registration API/UI |
| M1-06 | Paginated/conditional open PR poll과 authoritative base/head 관측 |
| M1-07 | PostgreSQL advisory-lock scheduler leader, hot/active/idle/draft tier와 request budget |
| M1-08 | Repository/PR authorization middleware와 existence-hiding negative test |
| M1-09 | Compact PR worklist, filters, loading/empty/rate-limit/degraded states |
| M1-10 | Audit catalogue, redaction policy와 login/config/poll lifecycle event |

### 완료 조건

- Browser가 GitHub credential을 받거나 저장하지 않는다.
- 두 Server replica 중 하나만 due poll을 예약한다.
- Draft PR은 idle tier 정책을 따르고 disabled auto-analysis에서도 manual refresh가 가능하다.
- 허용되지 않은 user는 ID를 바꿔도 repository 존재 여부를 알 수 없다.
- GHES 401/403/404/429/5xx, pagination과 conditional request fixture를 검증한다.
- Browser가 닫힌 상태에서도 PR base/head change가 DB에 반영된다.

## 7. M2 - Snapshot, operation, queue와 diff

### 목표

Manual refresh 또는 poll이 snapshot request와 append-only materialization을 만들고, 어느 Server replica에서도 진행 상태와 canonical diff를 읽게 한다.

### 작업

| ID | 작업 |
|---|---|
| M2-01 | snapshot_requests, snapshots(materializations), operations, analysis_runs, jobs/job_attempts, event_log, artifacts schema |
| M2-02 | Job type별 executor/priority/retry/terminal failure와 DB clock 기반 claim/heartbeat/lease expiry |
| M2-03 | Manual refresh dedupe, per-user/per-PR limit과 `202 operationId/eventsUrl` response |
| M2-04 | PR 범위 durable event append, PostgreSQL `LISTEN/NOTIFY`, `Last-Event-ID` replay와 REST reconcile |
| M2-05 | Run별 opaque workspace와 credential-safe Git transport |
| M2-06 | Bounded shallow/partial clone, exact fetch, merge-base deepen과 resolution 기록 |
| M2-07 | Request dedupe와 append-only `unresolved|exact` materialization/integrity rule |
| M2-08 | Canonical diff, merge simulation, line mapping과 snapshot-scope changed source artifact |
| M2-09 | 선택한 PVC/object artifact adapter의 attempt staging, checksum, atomic immutable commit |
| M2-10 | PR/operation/analysis/file/diff/commit/merge-simulation API와 typed partial/degraded error |
| M2-11 | Files LNB, split/unified Main diff, operation progress와 stale base/head 표시 |
| M2-12 | Worker `finally`와 자기 pod startup/periodic workspace cleanup |

### 완료 조건

- 동일 PR/base/head refresh 20건이 하나의 active operation과 snapshot request를 반환한다.
- `unresolved` 뒤 `exact`는 기존 row를 수정하지 않고 새 materialization을 만든다.
- 같은 request/policy의 서로 다른 exact merge-base는 report를 publish하지 않고 integrity failure를 기록한다.
- Base 또는 head 이동은 새 request와 전체 analysis를 만들고 이전 report를 stale로 남긴다.
- 두 Server replica와 LISTEN 재연결 상황에서 event 누락을 REST/replay로 복원한다.
- Worker 강제 종료 후 DB clock lease로 job이 재개되고 retry 상한은 terminal failure가 된다.
- 동시 artifact attempt 중 하나만 canonical object를 commit하고 DB row는 object commit 뒤 생성된다.
- Clone 간 `.git`, refs, config와 worktree가 공유되지 않으며 process args/log에 token이 없다.

## 8. M3 - Analysis와 immutable report

### 목표

Reviewer가 검증 가능한 finding과 coverage를 보고 일부 실패나 budget 초과에도 report를 사용할 수 있다.

### 작업

| ID | 작업 |
|---|---|
| M3-01 | Changed-file classifier와 generated/vendor/binary policy |
| M3-02 | Tree-sitter language adapter 두 개와 mergeBase/head symbol diff |
| M3-03 | History/blame/direct reference/related-test artifact |
| M3-04 | File/byte/model-call/time budget을 가진 change-pack planner |
| M3-05 | Provider-neutral model adapter와 Worker 전용 batch model credential |
| M3-06 | Correctness/security/compatibility/testing specialist prompts |
| M3-07 | Line/symbol/reference verifier, fingerprint와 deduplication |
| M3-08 | P3-P0 priority/category/confidence contract와 P3 direct-evidence gate |
| M3-09 | Analysis-scope selected context artifact와 immutable report composer |
| M3-10 | Findings/Outline LNB, Evidence FNB와 coverage/limitation UI |
| M3-11 | Commit Defender v1 compatibility adapter, canonical normalizer와 fixture parity test |
| M3-12 | Code object/relationship artifact, structure parent/children과 dependency uses/used-by analyzer |

### 완료 조건

- 모든 P3는 현재 materialization의 직접 evidence와 high confidence를 가진다.
- Model timeout, analyzer 실패와 budget 초과는 가능한 결과를 보존한 partial report가 된다.
- Report가 materialization/analyzer/model/policy version, coverage와 omission을 표시한다.
- 같은 stage input은 checksum이 유효하면 retry에서 재사용한다.
- Fixture PR의 rename, deletion, old/new line, pre-existing issue와 category를 검증한다.
- Commit Defender fixture의 summary, grade, per-file summary, P0-P3/category와 source/rule 의미가 canonical report에 보존된다.
- Relationship fixture가 direct/transitive, cycle, edge evidence와 mergeBase/head의 added/removed/unchanged를 검증한다.

## 9. M4 - Complete review workspace와 Chat

### 목표

제공된 visual direction의 browser workspace에서 finding, diff, graph, evidence와 Chat을 같은 analysis revision으로 함께 사용한다.

### 작업

| ID | 작업 |
|---|---|
| M4-01 | Two-row Header, resizable LNB/Main/Chat/FNB와 breakpoint contract |
| M4-02 | Main 880px 미만 auto-unified, pinned split scroll과 mergeBase/head label |
| M4-03 | Analysis deep link, URL selection, revision selector와 user-level preference document |
| M4-04 | Snapshot commit 기반 Git graph, Impact, added test summary/case compact와 maximized view |
| M4-05 | Atomic ReviewSelection store와 panel scroll 복원 |
| M4-06 | User + analysis revision 고정 Chat session과 Server-side model 호출 |
| M4-07 | Bounded report/file/symbol/history/impact Chat tools와 per-user limit |
| M4-08 | Chat delta stream, stop/retry와 final message persist/reconcile |
| M4-09 | Citation navigation, report/merge state 분리와 stale revision banner |
| M4-10 | CSP/security header, sanitized Markdown, external resource 차단 |
| M4-11 | Virtualization, accessibility와 ko-KR message catalog |
| M4-12 | Report grade/summary/per-file summary, normalized finding detail과 P0 positive section |
| M4-13 | Revision 고정 report/finding/evidence/object deep link, Markdown/JSON export와 Copy Link |
| M4-14 | Registered GHES exact-SHA permalink builder와 origin/path/line negative test |
| M4-15 | Structure/Dependencies object graph, relation evidence와 coverage/limitation interaction |

### 완료 조건

- Finding 선택 후 모든 panel의 `snapshotId`와 `analysisRevisionId`가 일치한다.
- 새 report가 와도 열린 diff/Chat revision이 자동 변경되지 않는다.
- Findings와 Chat이 desktop에서 동시에 보인다.
- Main 폭 880px 경계와 narrow viewport에서도 draft/stream과 layout이 유지된다.
- Chat limit 초과는 typed `429` 또는 limit error이며 analysis report 상태를 바꾸지 않는다.
- Citation deep link가 정확한 file/line/symbol/history를 연다.
- 복사한 report/finding/evidence/object link가 로그인 뒤 같은 revision과 selection을 복원한다.
- `Open in GHES`가 exact SHA file/line을 열고 unsupported route는 내부 evidence로 안전하게 fallback한다.
- Parent/children과 uses/used-by graph의 node/edge 선택이 definition/reference/evidence를 함께 갱신한다.
- CSP/security header test와 browser storage 민감정보 검사가 통과한다.

## 10. M5 - Kubernetes pilot hardening

### 목표

사내 cluster에서 제한된 repository/reviewer pilot을 운영하고 보존과 복구를 포함한 release 절차를 확정한다.

### 작업

| ID | 작업 |
|---|---|
| M5-01 | Resource request/limit, topology spread, replica 조건부 PDB와 metric-backed optional HPA |
| M5-02 | Server/Worker/retention NetworkPolicy, egress allowlist와 workload별 Secret/mount 검증 |
| M5-03 | Artifact capacity alert와 retention claim/delete bounded batch |
| M5-04 | `retention --reconcile`, report/chat/source/event 관계와 `chatDays <= reportDays` 검증 |
| M5-05 | DB restore point `Tdb` 뒤 artifact snapshot `Tartifact >= Tdb`를 만드는 backup/restore runbook |
| M5-06 | Worker SIGTERM/preStop, grace period와 lease return 검증 |
| M5-07 | Image SBOM, vulnerability scan, signature와 digest pinning |
| M5-08 | Poll/queue/clone/analyzer/model/SSE/dependency metric과 audit redaction 검사 |
| M5-09 | Load/large PR/partial failure/retention와 dependency outage test |
| M5-10 | Helm install/upgrade/rollback/smoke/secret rotation/incident runbook |

### 완료 조건

- Clean namespace install과 current-to-next rolling update가 통과한다.
- 진행 중 job이 pod drain에서 완료되거나 다른 Worker로 인계된다.
- Backup window에는 retention deletion race가 없고 복구/reconcile 뒤 artifact 상태가 분류된다.
- Missing artifact는 unavailable과 재분석 경로를, unreferenced artifact는 retention candidate를 제공한다.
- GHES/model/artifact 장애가 liveness restart loop를 만들지 않으며 영향 기능만 degraded가 된다.
- Image history, rendered manifest, log/metric/trace에 secret, source와 prompt 원문이 없다.
- Operator와 pilot reviewer가 runbook과 `AC-01`부터 `AC-24`를 확인한다.

## 11. Test 전략

| 계층 | 범위 |
|---|---|
| Unit | key/state transition, diff mapping, verifier, redaction, backoff, retention relation |
| Contract | REST/SSE, Commit Defender adapter, link target, relationship/artifact version, provider/GHES error |
| Integration | DB-clock lease, migration lock, event fan-out, artifact race, Git/relationship fixture |
| Security | authorization, proxy spoof, path/symlink, Git option, prompt/tool scope, secret leak |
| Browser E2E | login, worklist, report/export, deep link, GHES permalink, object graph, Chat, responsive/degraded state |
| Image | four commands, non-root, read-only rootfs, health, SBOM, no build secret |
| Helm | lint/schema/template, hook, CronJob, clean install, upgrade, rollback, PVC/Secret refs |
| Resilience | Worker kill, DB/GHES/model/artifact fault, SSE reconnect, cleanup/reconcile |

GHES와 model test double은 recorded private payload 대신 synthetic fixture를 사용한다. 실제 GHES smoke test는 protected environment의 read-only repository에서 수행한다.

## 12. Requirement 추적

세부 requirement와 acceptance의 정본은 요구사항 명세서다.

| Requirement group | 구현 milestone | 핵심 검증 |
|---|---|---|
| `REQ-GH-*` | M0-00, M1 | GHES smoke, poll/backoff contract |
| `REQ-SNAP-*` | M0-00, M2 | Git fixture, materialization, cleanup |
| `REQ-AN-*` | M3 | Analyzer/model/verifier와 partial report |
| `REQ-UI-*` | M0, M2, M4 | Playwright, accessibility, visual contract |
| `REQ-CHAT-*` | M4 | Limit, stream/final reconcile, browser E2E |
| `REQ-DATA-*` | M2 | PostgreSQL lease/event와 artifact commit |
| `REQ-SEC-*` | M0-M5 | Authorization, redaction, header와 egress |
| `REQ-OPS-*` | M0, M5 | Image, Helm, retention, backup/reconcile |
| `REQ-NFR-*` | M0-00, M1-M5 | Scale measurement, load와 failure recovery |

## 13. Release 흐름

제품 기능은 대상 repository CI에 의존하지 않는다. Git Code Reviewer 자체 release만 아래 흐름을 가진다.

```text
lint/typecheck/test
  -> build frontend/runtime
  -> build OCI image
  -> vulnerability scan + SBOM + sign
  -> push immutable digest
  -> helm lint/template/package
  -> pilot namespace migration + upgrade + smoke
  -> production promotion
```

환경 promotion은 같은 image digest와 chart version을 사용하고 values/Secret reference만 바꾼다. Migration은 expand/contract를 따르며 rollback 불가능한 destructive change를 같은 release에 넣지 않는다.

## 14. 결정 gate

결정 ID, 질문과 상태의 정본은 요구사항 명세서의 `DEC-001`부터 `DEC-016`이다. M0-00은 이 결정을 위한 증거를 만들며, 각 milestone은 자신이 의존하는 DEC가 확정되지 않았으면 typed config와 명시적 startup/template validation으로 경계를 유지한다.

- M0/M1 진입: `DEC-001`, `DEC-002`, `DEC-004`, `DEC-006`, `DEC-011`, `DEC-012`
- M2 진입: `DEC-007`, `DEC-008`, `DEC-013`, `DEC-014`, `DEC-015`
- M3/M4 진입: `DEC-003`, `DEC-005`, `DEC-010`, `DEC-015`
- M5 진입: `DEC-006`, `DEC-007`, `DEC-009`, `DEC-011`, `DEC-016`

## 15. MVP 완료 정의

- 요구사항 명세의 `AC-01`부터 `AC-24`까지 pilot 환경에서 통과한다.
- Browser만으로 PR 발견, refresh operation, report review와 Chat 흐름을 완료한다.
- 대상 repository에 workflow, webhook과 write permission을 추가하지 않는다.
- Snapshot request/materialization, isolated clone, evidence verification과 partial report가 검증된다.
- 제공된 visual artifact의 workspace topology와 responsive contract가 유지된다.
- 하나의 signed image와 versioned Helm chart로 install/upgrade/rollback할 수 있다.
- DB/artifact backup, reconcile, Worker recovery, retention과 secret rotation runbook이 있다.
- 운영 dashboard와 alert가 poll lag, queue age, capacity, dependency와 terminal failure를 감지한다.

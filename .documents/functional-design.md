# Git Code Reviewer — 기능설계서

## 1. 문서 정보와 설계 기준

| 항목 | 내용 |
|---|---|
| 문서 상태 | 구현 기준안 v0.1 |
| 입력 | `requirements-specification.md`, `blueprint.md`, `ui-implementation-design.md` |
| 대상 | Web/API/Poller/Worker 개발자, platform engineer, QA, 보안 검토자 |
| API prefix | `/api/v1` |
| 기본 locale | `ko-KR` |

이 문서는 요건을 component, state, data, API, event와 사용자 interaction으로 구체화한다. 아래 endpoint와 event name은 구현 기준 contract이며 변경할 때 schema version과 migration 영향을 함께 검토한다.

### 1.1 설계 원칙

- 모든 read·analysis·Chat·publish 동작은 `tenant_id`, `repository_id`, `snapshot_id` 중 필요한 scope를 server가 결정한다.
- GitHub의 가변 PR을 직접 분석하지 않는다. immutable snapshot을 만든 뒤 downstream stage가 그 ID만 사용한다.
- Polling, queue retry와 사용자 refresh가 겹쳐도 snapshot·run·외부 게시가 중복되지 않아야 한다.
- Git·AST에서 만든 deterministic artifact와 model inference 결과를 저장·versioning·관측 단계에서 분리한다.
- repository content는 data다. prompt instruction, Git option, path, URL, command로 해석하지 않는다.
- 부분 실패는 `partial`과 omission으로 표현한다. 성공한 evidence와 finding을 버리지 않는다.
- UI state는 snapshot과 selection을 함께 보존해 서로 다른 version의 diff, finding, Chat을 섞지 않는다.

## 2. 실행 공간과 trust boundary

```text
[Public/SaaS 또는 사내 GHES]
 GitHub API · GraphQL · Git · Checks
                 ▲
                 │ outbound HTTPS, allowlist, fixed egress IP
                 │
[Private runtime network]
 Web/API ─ Poller ─ Queue ─ Worker ─ Analyzer Sandbox
    │         │        │       │
 PostgreSQL   └────────┴──── Object Storage
    │                         Model Gateway
    └─ Audit/Metric/Trace collector
                 ▲
                 │ private ingress, SSO/OIDC
[Local client]
 Managed Browser

[CI/CD execution space]
 Source checkout → build/test → scan/SBOM/sign → private registry
                                      │ immutable digest
                                      ▼
                               Private runtime deploy
```

| 경계 | 허용 흐름 | 금지 흐름 |
|---|---|---|
| Browser → Web/API | 사내망/VPN HTTPS, OIDC session | object storage 직접 credential, GitHub installation token 전달 |
| Runtime → GitHub | 승인 host의 API·GraphQL·Git·Checks outbound | GitHub → runtime public ingress, 임의 redirect |
| Worker → dependency | queue, DB metadata, object storage, model gateway, 승인 GitHub endpoint | arbitrary Internet, user 지정 URL |
| Sandbox → dependency | stage input/output channel, 필요 시 read-only worktree | application DB credential, public network, Docker socket |
| CI → registry/deploy | OIDC/workload identity 기반 단기 credential | 장기 registry password, runtime secret의 build arg |

Reviewer가 사용하는 app은 중앙 Web application이다. local에는 browser와 session만 존재하며 repository clone이나 model credential을 보관하지 않는다.

## 3. Component 설계

### 3.1 Web (`apps/web`)

- Next.js/React 기반 review workspace를 제공한다.
- API response를 server state로, panel size·active tab·selection을 client state로 구분한다.
- source·prompt를 client telemetry에 기록하지 않는다.
- diff virtualization과 deep link 복원을 담당한다.
- Chat transport가 끊겨도 작성 중 draft와 이미 수신한 message를 유지한다.

### 3.2 API (`apps/api`)

- OIDC session을 검증하고 GitHub identity를 내부 principal에 연결한다.
- 모든 repository route에서 `AuthorizationService`를 호출한다.
- REST query/command, SSE Chat stream, artifact proxy를 제공한다.
- command의 idempotency와 audit event를 transaction 경계 안에서 기록한다.
- raw source가 포함된 error를 일반화하고 correlation ID만 반환한다.

### 3.3 Poller (`apps/poller`)

- host/installation/repository shard의 PostgreSQL lease를 획득한다.
- active, idle, draft, reconciliation schedule을 선택한다.
- conditional request, GraphQL cursor와 quota 정보를 저장한다.
- 변화가 있으면 `pull_request.observed`를 기록한 후 snapshot command를 발행한다.
- manual refresh request를 별도 우선순위 queue에서 coalesce한다.

### 3.4 Worker (`apps/worker`)

- BullMQ job을 받아 stage state machine을 실행한다.
- job payload의 opaque ID로 DB에서 scope와 config를 다시 읽는다.
- short-lived installation token과 model credential을 runtime에 요청한다.
- worktree와 stage temporary file은 ephemeral volume에만 둔다.
- 완료 artifact를 checkpoint로 남기고 retry 시 재사용한다.
- queue job 종료 시 credential handle과 worktree를 폐기한다.

### 3.5 Domain packages

| package | 책임 | 허용 dependency |
|---|---|---|
| `packages/contracts` | REST/event/artifact schema, error code | schema library만, runtime adapter 없음 |
| `packages/domain` | entity, state transition, idempotency key | contracts, 순수 함수 |
| `packages/db` | migration, repository, tenant isolation | domain |
| `packages/github` | App auth, host adapter, API/GraphQL/Git URL policy | contracts, domain |
| `packages/git` | safe process runner, mirror/worktree, ref/path validation | domain |
| `packages/analyzers/*` | deterministic artifact 생성 | contracts, git adapter interface |
| `packages/agent` | planner, typed tool, specialist, verifier, composer | contracts, artifact reader |
| `packages/policy` | config, priority, suppression, publish decision | domain, contracts |
| `packages/observability` | metric, trace, redaction, correlation | code-free metadata만 |

Domain package는 Web framework, queue client, GitHub SDK를 직접 import하지 않는다. Adapter가 domain command와 result로 변환한다.

### 3.6 Platform service

| service | 사용 목적 | 저장 대상 |
|---|---|---|
| PostgreSQL | transaction, state, lease, authorization mapping, metadata, audit index | source 본문과 secret 제외 |
| Redis/BullMQ | priority job, retry, progress signal | opaque ID와 non-sensitive scheduling metadata |
| Object Storage | diff, file index, analyzer artifact, report body | tenant/snapshot prefix, encryption, checksum |
| Secret Manager | GitHub App key, 필요 시 model/registry secret | application DB에 복제하지 않음 |
| Model Gateway | 승인 model routing, token/region policy | source/prompt retention은 조직 정책을 따름 |
| Registry | signed Worker/API/Web OCI image | immutable digest, SBOM, provenance, signature |

## 4. 식별자와 idempotency

외부에서 받은 repository 이름, ref, PR 번호를 storage key나 shell argument로 직접 사용하지 않는다. 내부 UUID/opaque ID로 변환한다.

| 대상 | unique/idempotency key |
|---|---|
| Repository | `github_host_id + github_repository_node_id` |
| Pull request | `repository_id + github_pr_number` |
| Snapshot | `repository_id + pr_number + base_oid + head_oid` |
| Analysis run | `snapshot_id + policy_hash + analyzer_set_version + model_profile_version` |
| Poll cycle | `poll_target_id + scheduled_at_bucket + trigger_kind` |
| Manual refresh | `tenant_id + repository_id + pr_number + coalesce_window` |
| Check publish | `analysis_run_id + check_kind + conclusion_version` |
| Inline comment | `finding_id + head_oid + anchor_fingerprint` |
| Finding | category·rule·normalized location·evidence signature로 만든 versioned fingerprint |

`merge_base_oid`가 base history 변화로 달라지면 base/head가 같더라도 snapshot manifest version을 비교한다. 구현 초기 unique key는 blueprint 계약을 따르되, merge-base 변화가 분석 결과에 영향을 줄 수 있는 host에서는 `snapshot_revision`을 추가해 기존 snapshot을 변형하지 않는다.

## 5. Domain state model

### 5.1 Pull request 관측 상태

```text
unknown ──observed──> open ──draft released──> open
                       │  ▲
                       │  └──── reopened ─── closed
                       ├──────── merged
                       └──────── closed
```

관측할 때마다 `base_oid`, `head_oid`, `draft`, `state`, `updated_at_hint`, `observed_at`을 저장한다. run 예약 여부는 다음 표를 따른다.

| 변화 | 새 snapshot | 새 run | 비고 |
|---|---:|---:|---|
| 최초 open 관측 | 예 | 예 | draft 정책에 따라 낮은 우선순위 가능 |
| head OID 변경 | 예 | 예 | 이전 running/completed run stale 처리 |
| base OID 또는 merge-base 변경 | 예 | 예 | head가 같아도 분석 기준 변경 |
| reopen, OID 동일 | 아니오 | 조건부 | 이전 report freshness와 policy 비교 |
| draft → ready, OID 동일 | 아니오 | 조건부 | draft에서 전체 분석을 생략했으면 새 run |
| title/body만 변경 | 아니오 | 조건부 | specialist가 metadata를 사용하는 policy에서만 |
| closed/merged | 아니오 | 아니오 | polling class와 UI 상태 갱신 |

### 5.2 Analysis run 상태

```text
created → queued → collecting → analyzing → verifying → composing → publishing → completed
              │          │           │          │             │
              ├──────────┴───────────┴──────────┴─────────────┤
              └──────────────> partial / failed / cancelled
                                          │
                                      superseded
```

- `partial`은 최종 사용 가능 상태다. `failed`는 report를 만들 수 없는 상태다.
- 새 head를 감지하면 아직 외부 게시 전인 run은 `cancel_requested`를 기록한다. stage가 cooperative cancellation point에서 종료한다.
- 이미 완료된 run도 `superseded_by_run_id`를 연결하고 읽기 전용 history로 유지한다.
- `publishing` 진입 전 authorization과 current head를 재검증한다.
- state transition은 domain function으로만 실행하고 `analysis_run_transition`에 이전/다음 상태, reason, timestamp를 남긴다.

### 5.3 Stage 상태

각 stage는 `pending | running | completed | omitted | failed | cancelled` 중 하나다.

| stage | 필수 입력 | 산출물 | retry 성격 |
|---|---|---|---|
| `snapshot-manifest` | repository, refs | manifest, worktree reference | GitHub/Git 일시 오류 재시도 |
| `diff-index` | snapshot manifest | raw diff, file/line index | deterministic, 안전한 재시도 |
| `symbol-index` | changed files | symbol artifact, coverage | file별 격리, partial 가능 |
| `history-index` | mirror, diff index | commit/blame/churn | history 부족 시 omitted 가능 |
| `impact-index` | symbol/import index | edge, related test | 후속, partial 가능 |
| `change-pack` | analyzer artifacts | specialist input manifest | deterministic |
| `specialist-*` | change pack, policy | finding candidates | timeout/validation 제한 재시도 |
| `verify` | candidates, artifacts | verified findings | deterministic 중심 |
| `compose` | findings, coverage | report | schema failure 제한 재시도 |
| `publish` | report, live head | Check/comment receipt | idempotent side effect |

### 5.4 Finding 상태

```text
candidate → verified → published
              ├──────> suppressed
              ├──────> rejected
              └──────> report-only

published → acknowledged → resolved → reintroduced  (후속 release)
```

Verifier가 거절한 candidate는 사용자 report에 노출하지 않되 품질 평가용 비식별 metadata를 남길 수 있다. private source와 설명 원문을 별도 승인 없이 평가 dataset으로 복사하지 않는다.

### 5.5 Conversation 상태

| 상태 | 의미 | 전환 조건 |
|---|---|---|
| active | 현재 snapshot과 일치, 질문 가능 | conversation 생성 |
| streaming | assistant response 생성 중 | message command 승인 |
| stale | PR current head와 snapshot 불일치 | 새 head 감지 |
| access-revoked | 사용자 또는 installation 권한 없음 | authorization 재검증 실패 |
| archived | retention 또는 사용자 정리 | archive command |

stale conversation은 과거 조사 기록으로 읽을 수 있지만 새 snapshot의 evidence를 섞어 답하지 않는다. 사용자가 “최신 snapshot에서 새 대화”를 명시적으로 선택해야 한다.

## 6. 주요 처리 흐름

### 6.1 설치와 repository reconciliation

1. Platform Admin이 GitHub App을 대상 organization/repository에 설치한다.
2. Reconciliation job이 installation metadata와 repository node ID를 조회한다.
3. `github_installation`과 `repository`를 upsert하고 permission snapshot을 저장한다.
4. 접근 가능한 repository에 poll target을 만든다. 처음에는 낮은 동시성으로 open PR 목록을 bootstrap한다.
5. repository 제외 또는 App 제거가 확인되면 `authorization_state=revoked`로 먼저 전환한다.
6. token minting, new job, API/artifact access, Chat stream을 차단한다.
7. cache 폐기와 data purge는 retention policy에 따라 별도 job으로 실행한다.

GitHub에서 일시적으로 5xx가 난 경우를 제거로 간주하지 않는다. 명시적 401/403/404 의미와 연속 reconciliation 결과를 host adapter가 판정한다.

### 6.2 Scheduled polling

1. Scheduler가 `next_poll_at <= now()`인 target을 priority 순으로 조회한다.
2. `SELECT … FOR UPDATE SKIP LOCKED` 또는 advisory lease로 shard owner를 정한다.
3. 저장된 cursor/validator와 host quota budget을 읽는다.
4. GitHub Adapter가 페이지를 조회하고 각 page 완료 뒤 checkpoint를 transaction으로 저장한다.
5. PR observation을 upsert하고 변화 판정 command를 실행한다.
6. 새 snapshot이 필요하면 unique insert 후 `analysis.requested.v1`을 enqueue한다.
7. 마지막 page까지 성공하면 cursor cycle을 닫고 다음 interval을 계산한다.
8. 실패 시 성공한 checkpoint는 유지하고 host가 준 `retry-after`, rate reset, `x-poll-interval`을 반영한다.

자동 polling budget은 기본 80%까지만 쓴다. 남은 20%는 manual refresh, publish, permission 확인에 예약한다. 실제 값은 `OD-003`에서 조정한다.

### 6.3 Manual refresh

1. API가 사용자와 repository 권한을 검사한다.
2. `refresh_request`를 coalesce key로 upsert한다.
3. 이미 queued/running이면 기존 request ID와 상태를 반환한다.
4. Poller는 `user-refresh` priority로 해당 PR만 조회한다.
5. quota로 미뤄지면 `deferred_until`과 안전한 reason code를 저장한다.
6. Web은 SSE 또는 짧은 polling으로 상태를 갱신한다.

API가 즉시 GitHub를 동기 호출해 browser request를 오래 붙잡지 않는다.

### 6.4 Snapshot 수집

1. Worker가 `analysis_run_id`를 받아 scope와 authorization state를 다시 읽는다.
2. 설치 token을 발급하고 repository remote URL을 allowlist host에서 조합한다.
3. repository UUID 경로의 bare mirror lock을 획득해 필요한 OID를 fetch한다.
4. base/head object 존재와 type을 확인하고 merge-base를 계산한다.
5. run UUID 경로에 detached worktree를 만든다. Git hook과 unsafe config를 비활성화한다.
6. manifest에 OID, object availability, submodule policy, tool version, checksum을 기록한다.
7. raw diff와 file index를 object storage에 업로드한 뒤 DB artifact row를 commit한다.
8. temporary worktree는 stage 종료 또는 run cancellation 때 제거한다.

Object upload와 DB commit 사이 실패는 orphan lifecycle job이 정리한다. DB row가 completed가 되기 전 artifact를 소비하지 않는다.

### 6.5 Deterministic 분석

1. Diff Analyzer가 file status, hunks, old/new line map, binary/generated/oversized 분류를 만든다.
2. Symbol Analyzer가 변경 구간과 겹치는 AST symbol, signature, parent와 parse coverage를 만든다.
3. History Analyzer가 rename-aware log, blame와 churn을 snapshot 범위에서 조회한다.
4. 후속 Impact Analyzer는 import/reference edge와 certainty, Related tests를 만든다.
5. 각 analyzer는 독립 artifact와 omission을 저장한다.
6. Change Pack Builder가 risk ordering과 token budget에 따라 specialist별 manifest를 만든다.

Analyzer는 source content를 metric label이나 exception message에 넣지 않는다. file path가 필요한 application record에는 암호화된 값 또는 접근 통제된 metadata를 쓰고 telemetry에는 opaque ID만 사용한다.

### 6.6 Agent review와 검증

1. Planner가 policy, diff summary, symbol/history artifact를 읽고 specialist job을 만든다.
2. 각 specialist는 지정 change pack과 typed tool만 사용한다.
3. tool handler가 요청의 tenant/repository/snapshot을 무시하고 server-side scope를 주입한다.
4. specialist output을 `FindingCandidate.v1` schema로 parse한다.
5. Verifier가 location, diff relevance, evidence existence, duplicate, priority/confidence policy를 확인한다.
6. Report Composer가 verified finding과 coverage/omission을 `AnalysisReport.v1`로 만든다.
7. model stage가 실패해도 deterministic artifact가 있으면 partial report를 만든다.

Specialist 기본 집합은 correctness, security, test다. compatibility와 performance는 repository policy와 지원 자료가 있을 때 활성화한다.

### 6.7 Report 게시

1. Publisher가 current installation/repository permission을 재확인한다.
2. GitHub에서 current head OID를 조회한다.
3. run snapshot과 다르면 run을 stale/superseded 처리하고 side effect를 만들지 않는다.
4. Check idempotency record를 `pending`으로 생성한다.
5. Check summary를 게시하고 receipt/external ID를 저장한다.
6. inline policy가 켜져 있으면 각 finding anchor를 current diff와 대조한다.
7. anchor가 유효한 finding만 comment idempotency record를 만든 뒤 게시한다.
8. 일부 inline comment 실패는 Check를 없애지 않고 publish omission에 기록한다.

DB transaction과 GitHub API를 하나의 transaction으로 묶을 수 없으므로 outbox와 receipt reconciliation을 사용한다. timeout 후 응답을 받지 못한 경우 external marker를 조회한 뒤 재게시 여부를 결정한다.

### 6.8 Finding 조사와 panel 동기화

1. route가 `repository/pr/snapshot`을 결정한다.
2. LNB Findings selection이 `findingId`를 state store에 기록한다.
3. resolver가 finding location을 `fileId`, `side`, `line`, `commitOid` selection으로 변환한다.
4. Main diff가 해당 anchor를 virtualization index로 연다.
5. FNB Evidence가 finding의 evidence ID 목록을 표시한다.
6. Chat dock은 conversation을 바꾸지 않고 selection context chip만 갱신한다.
7. evidence나 graph commit을 선택하면 같은 resolver를 거쳐 Main과 FNB를 동기화한다.

selection resolve에 실패하면 가장 가까운 hunk를 임의로 열지 않는다. “이 snapshot에서 위치를 찾을 수 없음”과 reason을 표시한다.

### 6.9 Chat

1. 사용자가 새 message와 선택 context를 전송한다.
2. API가 conversation snapshot, current authorization, budget을 검증한다.
3. message를 저장하고 `chat.response.requested.v1`을 생성한다.
4. Chat Agent는 typed tools로 evidence를 읽고 answer chunk를 만든다.
5. SSE가 sequence number와 함께 chunk, tool-status, citation, completed/error event를 전달한다.
6. client는 마지막 sequence로 reconnect한다.
7. answer 완료 시 사용한 evidence ID와 model provenance를 message에 연결한다.
8. 권한 회수나 stale 정책 위반을 감지하면 stream을 종료하고 안전한 상태 code를 보낸다.

Chat은 source write, branch push, merge, GitHub comment 게시 tool을 제공하지 않는다.

### 6.10 Config와 suppression

1. Snapshot Collector가 base OID의 `.gcr.yml`과 `.gcr/rules/*.md`를 읽는다.
2. Config Parser가 version, type, unknown key와 limit을 검사한다.
3. Admin policy와 base config를 field별로 병합하되 더 제한적인 값을 선택한다.
4. head의 config 변경은 finding 대상일 수 있지만 현재 run policy source로 사용하지 않는다.
5. inline suppression parser가 directive, scope, finding fingerprint와 reason을 정규화한다.
6. Policy Engine이 priority, CODEOWNER 승인, repository rule을 확인한다.
7. 적용·거절 결과를 audit에 기록한다.

## 7. Data 설계

### 7.1 주요 entity

| entity | 주요 field | 관계·제약 |
|---|---|---|
| `tenant` | `id`, `name_enc`, `status`, `data_region`, `retention_policy_id` | 모든 domain entity의 상위 scope |
| `principal` | `id`, `tenant_id`, `oidc_subject`, `github_identity_id`, `status` | subject unique, 민감 display 값 분리 |
| `github_host` | `id`, `tenant_id`, `base_url`, `api_kind`, `ca_bundle_ref`, `allowlist_policy_id` | host 정규화 unique |
| `github_installation` | `id`, `host_id`, `external_id`, `permission_hash`, `state`, `last_reconciled_at` | token 저장 금지 |
| `repository` | `id`, `tenant_id`, `installation_id`, `external_node_id`, `name_enc`, `authorization_state` | host+node unique |
| `pull_request` | `id`, `repository_id`, `number`, `state`, `draft`, `observed_base_oid`, `observed_head_oid` | repository+number unique |
| `snapshot` | `id`, `pr_id`, `base_oid`, `merge_base_oid`, `head_oid`, `manifest_artifact_id`, `created_at` | immutable |
| `analysis_run` | `id`, `snapshot_id`, `policy_hash`, `pipeline_version`, `status`, `coverage`, `superseded_by` | idempotency unique |
| `analysis_stage` | `id`, `run_id`, `kind`, `attempt`, `status`, `artifact_id`, `omission_code` | run+kind+version unique |
| `artifact` | `id`, `tenant_id`, `snapshot_id`, `kind`, `schema_version`, `object_key`, `checksum`, `size`, `retention_class` | completed 이후 read 가능 |
| `finding` | `id`, `run_id`, `fingerprint`, `priority`, `confidence`, `category`, `location_json`, `status` | run+fingerprint unique |
| `evidence` | `id`, `run_id`, `kind`, `artifact_id`, `locator_json`, `checksum` | locator schema version 포함 |
| `finding_evidence` | `finding_id`, `evidence_id`, `role` | direct/supporting/counter |
| `report` | `id`, `run_id`, `schema_version`, `artifact_id`, `summary_json` | run당 current report 1개 |
| `conversation` | `id`, `tenant_id`, `pr_id`, `snapshot_id`, `created_by`, `status` | snapshot 변경 금지 |
| `message` | `id`, `conversation_id`, `role`, `sequence`, `content_artifact_id`, `selection_json`, `provenance_json` | conversation+sequence unique |
| `poll_target` | `id`, `repository_id`, `class`, `next_poll_at`, `lease_owner`, `lease_until` | due index |
| `poll_checkpoint` | `id`, `target_id`, `cycle_id`, `cursor`, `etag`, `last_modified`, `quota_json`, `status` | page 단위 durable |
| `publish_delivery` | `id`, `run_id`, `kind`, `idempotency_key`, `state`, `external_id`, `attempt` | idempotency key unique |
| `audit_event` | `id`, `tenant_id`, `actor_id`, `action`, `target_type`, `target_id`, `result`, `metadata_safe`, `created_at` | append-only export |

### 7.2 Tenant isolation

- API repository method는 `TenantContext` 없이는 호출할 수 없게 type과 constructor를 제한한다.
- PostgreSQL RLS를 방어 계층으로 사용하고 application query에도 tenant predicate를 둔다.
- object key는 `tenant/<opaque-tenant-id>/snapshot/<opaque-snapshot-id>/...` 형식으로 만들며 사용자 입력을 포함하지 않는다.
- signed URL은 tenant, artifact, principal, expiry를 포함한 authorization record를 거쳐 발급한다.
- queue payload는 `{ jobId, tenantId, runId, stage }`만 포함하고 source/path/token을 넣지 않는다.

### 7.3 Index와 transaction

| 사용 패턴 | index/transaction 기준 |
|---|---|
| due poll target | `(state, next_poll_at, priority)` partial index |
| PR current snapshot | `(pull_request_id, created_at desc)` |
| run 조회 | `(snapshot_id, created_at desc)`, idempotency unique |
| finding filter | `(run_id, priority, category, status)`, fingerprint index |
| Chat pagination | `(conversation_id, sequence)` unique |
| audit 기간 조회 | `(tenant_id, created_at desc, action)` |
| publish | delivery pending insert와 outbox insert를 한 transaction으로 처리 |

Migration은 expand → dual-read/write가 필요한 경우 backfill → contract 순으로 배포한다. 실행 중인 이전 Worker가 새 schema와 공존할 수 없는 migration은 queue drain과 별도 release gate를 요구한다.

### 7.4 Retention과 purge

Retention class는 최소 `ephemeral-worktree`, `source-artifact`, `analysis-artifact`, `report`, `chat`, `audit`로 나눈다. 기간은 `OD-008`에서 정한다.

Purge workflow는 다음 순서를 따른다.

1. authorization을 revoked로 전환하고 신규 접근을 차단한다.
2. active run과 Chat stream을 취소한다.
3. signed URL 발급과 cache를 폐기한다.
4. source/analysis/report/chat artifact를 정책 순서대로 삭제한다.
5. DB content row를 삭제·익명화하고 최소 audit proof를 보존 정책에 맞춰 남긴다.
6. object storage delete marker와 최종 결과를 audit한다.

## 8. External API 설계

### 8.1 공통 규칙

- 인증: secure, HTTP-only OIDC session 또는 내부 service token. Browser에 GitHub installation token을 반환하지 않는다.
- authorization: route마다 tenant, repository read/admin 권한을 명시한다.
- pagination: opaque cursor. page size는 server maximum을 넘을 수 없다.
- command: `Idempotency-Key` header를 지원한다.
- version: URL major version + response의 `schemaVersion`.
- error: `{ code, message, correlationId, retryable, retryAt? }`. source와 stack trace 제외.
- time: RFC 3339 UTC. UI가 `Intl`로 표시한다.

### 8.2 Read API

| Method | Path | 목적 | 주요 response | 권한 |
|---|---|---|---|---|
| GET | `/repositories` | 접근 가능한 repository 목록 | repository, installation/authorization state | repository read filter |
| GET | `/repositories/{repoId}/pulls` | PR과 current snapshot/run 목록 | PR state, head, run status, last checked | repo read |
| GET | `/pulls/{prId}` | PR workspace bootstrap | PR, current snapshot, current run, capability | repo read |
| GET | `/pulls/{prId}/snapshots` | 과거 snapshot 목록 | OID, status, created, superseded link | repo read |
| GET | `/runs/{runId}` | run 상태와 coverage | stage, omission, provenance, publish status | repo read |
| GET | `/runs/{runId}/report` | report summary와 finding counts | `AnalysisReport.v1` summary | repo read |
| GET | `/runs/{runId}/findings` | finding filter/pagination | finding rows, evidence summary | repo read |
| GET | `/findings/{findingId}` | finding 상세 | location, explanation, evidence IDs | repo read |
| GET | `/snapshots/{snapshotId}/files` | file tree와 diff summary | file index, status, counts | repo read |
| GET | `/snapshots/{snapshotId}/diff` | virtualized diff range | hunks/line range/anchor token | repo read |
| GET | `/snapshots/{snapshotId}/graph` | PR 중심 Git graph | nodes, parents, refs, pagination | repo read |
| GET | `/snapshots/{snapshotId}/history` | file/symbol history | commit/blame/churn, provenance | repo read |
| GET | `/evidence/{evidenceId}` | evidence locator와 표시 자료 | kind, locator, safe payload | repo read |
| GET | `/conversations` | snapshot별 Chat 목록 | metadata, stale status | repo read |
| GET | `/conversations/{id}/messages` | message pagination | message, evidence refs | repo read |
| GET | `/layout-preferences/{repoId}` | server sync preference | versioned layout state | 본인 |

Diff API는 임의 byte range 대신 server가 발급한 anchor/range token을 받는다. client가 object storage key나 filesystem path를 지정하지 못하게 한다.

### 8.3 Command API

| Method | Path | 목적 | 결과 | 추가 조건 |
|---|---|---|---|---|
| POST | `/pulls/{prId}/refresh` | 우선 PR 조회 요청 | `202` request ID/status | coalescing, quota 표시 |
| POST | `/runs/{runId}/retry` | 허용 stage 재실행 | `202` 새 run 또는 stage attempt | admin/policy, stale 검사 |
| POST | `/findings/{id}/feedback` | useful/incorrect/already-known/fixed | feedback receipt | repo read, audit |
| POST | `/findings/{id}/suppress` | UI 기반 suppression 요청 | policy decision | repo admin/CODEOWNER 정책 |
| POST | `/conversations` | snapshot-scoped Chat 생성 | conversation | repo read, current/stale 명시 |
| POST | `/conversations/{id}/messages` | message 전송 | message ID, stream URL | budget, authorization |
| POST | `/conversations/{id}/archive` | 대화 archive | updated state | creator/admin policy |
| PUT | `/layout-preferences/{repoId}` | layout preference 저장 | version/updatedAt | 유효 범위 clamp |
| POST | `/runs/{runId}/publish` | 정책상 수동 게시 | delivery status | repo admin, head 재검증 |

`retry`는 기존 immutable run row를 덮어쓰지 않는다. 동일 input의 정책적 재시도라면 attempt relation을 연결한 새 run 또는 명시적인 retryable stage attempt를 만든다.

### 8.4 SSE

| Path | event | payload |
|---|---|---|
| `/events/pulls/{prId}` | `run.status` | run ID, snapshot ID, status, safe progress |
|  | `snapshot.changed` | old/new snapshot ID, OID summary |
|  | `authorization.revoked` | reason code, effective time |
| `/conversations/{id}/stream` | `message.chunk` | message ID, sequence, text fragment |
|  | `tool.status` | tool kind, started/completed/failed. source args 제외 |
|  | `evidence.added` | evidence ID, label, locator summary |
|  | `message.completed` | usage summary, finish reason |
|  | `message.error` | safe error code, retryable |

SSE는 `Last-Event-ID`로 reconnect한다. server buffer를 벗어나면 client가 completed message를 REST로 다시 읽는다.

### 8.5 Error code

| code | HTTP | 의미 | UI 처리 |
|---|---:|---|---|
| `AUTHENTICATION_REQUIRED` | 401 | session 없음/만료 | 로그인 이동 |
| `REPOSITORY_ACCESS_DENIED` | 403 | 사용자 또는 installation 권한 없음 | workspace 내용을 지우고 안내 |
| `SNAPSHOT_STALE` | 409 | command 기준 snapshot이 최신이 아님 | 최신 snapshot 이동 선택 |
| `RUN_ALREADY_ACTIVE` | 409 | 동일 run 진행 중 | 기존 run 상태 표시 |
| `RATE_LIMITED` | 429 | GitHub/model/service budget 제한 | `retryAt` 표시, 반복 요청 억제 |
| `ARTIFACT_NOT_READY` | 409 | stage 미완료 | progress 유지 |
| `ANCHOR_INVALID` | 422 | diff anchor가 현재 snapshot에 없음 | 근거 없음 상태 표시 |
| `CONFIG_INVALID` | 422 | repository config 오류 | base commit과 validation path 표시 |
| `POLICY_DENIED` | 403 | publish/suppress/retry 정책 거부 | 필요한 역할·정책 설명 |
| `DEPENDENCY_UNAVAILABLE` | 503 | queue/storage/model/GitHub 장애 | correlation ID와 retry 상태 표시 |

## 9. Internal event contract

Event envelope:

```json
{
  "eventId": "uuid",
  "eventType": "analysis.requested.v1",
  "occurredAt": "2026-09-02T00:00:00Z",
  "tenantId": "opaque-id",
  "correlationId": "uuid",
  "causationId": "uuid",
  "payload": {}
}
```

| event | producer | consumer | payload 최소값 | dedupe key |
|---|---|---|---|---|
| `pull.observed.v1` | Poller | Snapshot service | repositoryId, prId, base/head OID, state | observation hash |
| `snapshot.created.v1` | Snapshot service | Run service, UI notifier | snapshotId, prId | snapshotId |
| `analysis.requested.v1` | Run service | Worker | runId | run idempotency key |
| `stage.requested.v1` | Worker orchestrator | Stage worker | runId, stage, attempt | runId+stage+version |
| `stage.completed.v1` | Stage worker | Orchestrator | runId, stage, artifactId/status | stage execution ID |
| `report.ready.v1` | Composer | Publisher, UI notifier | runId, reportId | reportId |
| `publish.requested.v1` | Run service | Publisher | runId, delivery kind | publish idempotency key |
| `run.superseded.v1` | Snapshot service | Worker, Publisher, UI | oldRunId, newSnapshotId | oldRunId+newSnapshotId |
| `authorization.revoked.v1` | Reconciliation | API, Worker, purge | repo/installation ID | scope+permission hash |
| `chat.response.requested.v1` | API | Chat Worker | conversationId, messageId | messageId |

Payload에는 source, diff, prompt, token, repository display name과 file path를 넣지 않는다. Consumer는 ID로 DB authorization과 artifact metadata를 다시 확인한다.

## 10. Artifact contract

모든 artifact에는 다음 envelope을 사용한다.

```json
{
  "schema": "DiffIndex",
  "schemaVersion": 1,
  "producer": { "name": "diff-analyzer", "version": "semver-or-digest" },
  "tenantId": "opaque-id",
  "snapshotId": "opaque-id",
  "createdAt": "RFC3339 UTC",
  "contentChecksum": "sha256:...",
  "payload": {}
}
```

### 10.1 Finding contract

| field | 형식 | 규칙 |
|---|---|---|
| `id`, `fingerprint` | opaque ID/string | fingerprint algorithm version 포함 |
| `priority` | `P0 | P1 | P2 | P3` | 영향도, confidence와 별도 |
| `confidence` | `low | medium | high` + score optional | UI가 priority와 독립 표시 |
| `category` | versioned enum | correctness/security/test/compatibility/performance 등 |
| `title` | 짧은 한글 설명, 기술용어 English 허용 | 허위 certainty 금지 |
| `explanation` | sanitized Markdown | 관찰, 영향, 조건을 구분 |
| `location` | file ID, side, line/range, symbol ID optional | raw filesystem path 금지 |
| `evidenceRefs` | evidence ID list | 게시 가능 finding은 direct evidence 1개 이상 |
| `suggestedAction` | 설명 또는 patch hint | 자동 적용하지 않음 |
| `policy` | suppression/publish decision | reason과 policy version 포함 |

### 10.2 Evidence locator

| kind | locator |
|---|---|
| `diff-line` | fileId, side, line, hunkId |
| `symbol` | symbolId, fileId, start/end line, parserVersion |
| `commit` | OID, parent OID optional |
| `blame` | fileId, line range, commit OID |
| `history` | file/symbol ID, ordered commit OID |
| `dependency-edge` | from/to symbol ID, edge kind, certainty |
| `test` | test file/symbol ID, relation kind, certainty |

UI가 locator를 직접 신뢰하지 않는다. Evidence Resolver API가 snapshot 소속과 artifact checksum을 검사한 뒤 safe view state로 변환한다.

## 11. Review Workspace 기능설계

### 11.1 Desktop layout

```text
┌──────── LNB ───────┬──────────── Main ────────────┬──── Chat ────┐
│ Files              │ PR header / snapshot         │ conversation │
│ Findings           │ Diff / file / commit         │ messages     │
│ Outline            │                              │ composer     │
│ Impact             │                              │              │
├────────────────────┴──────────────────────────────┴──────────────┤
│ FNB: Evidence | Git graph | History | Ownership | Impact | Tests │
└──────────────────────────────────────────────────────────────────┘
```

| panel | 기본/범위 | resize | 저장 |
|---|---|---|---|
| LNB | 280px / 220–420px | vertical separator, Arrow ±8px, Shift+Arrow ±32px | 사용자+repository |
| Main | flex / min 560px | 인접 panel 제약으로 결정 | 직접 저장 안 함 |
| Chat | 380px / 320–560px | vertical separator, keyboard 동일 | 사용자+repository |
| FNB | 132px / 48px–45vh | horizontal separator, collapse 48px | 사용자+repository |

Separator는 `role="separator"`, orientation, value min/max/now와 visible focus를 가진다. double-click/Enter로 해당 panel 기본값을 복원한다.

### 11.2 Responsive state

| viewport | state | 동작 |
|---|---|---|
| `>= 1280px` | `desktop` | 네 영역 동시 표시, 저장 size 적용 |
| `960–1279px` | `compact` | LNB/Chat을 제한 범위로 clamp, FNB 축소 가능 |
| `720–959px` | `stacked` | Main 위, Chat 아래 유지. LNB는 drawer/rail, FNB tool sheet |
| `< 720px` | `mobile` | 한 번에 주 content 한 영역, Chat route/sheet는 mount state 보존 |

viewport가 넓어지면 사용자의 desktop size를 복원한다. compact에서 clamp한 값을 원래 preference에 덮어쓰지 않는다.

### 11.3 LNB mode

| mode | MVP 내용 | 선택 결과 |
|---|---|---|
| Files | tree, changed status, line count, generated/binary/omitted 표시 | Main file diff, FNB file evidence |
| Findings | priority/confidence/category/status filter, group, count | Main anchor, FNB evidence, Chat context |
| Outline | changed symbol tree, parse coverage | Main symbol range, History filter |
| Impact | 후속: caller/callee/test group과 certainty | Main/FNB Impact view |

Files와 Findings는 pagination과 virtualization을 지원한다. filter는 URL에 안전한 non-sensitive 값만 반영하고 file path 원문을 browser history에 남길지는 조직 정책을 적용한다.

### 11.4 Main

- Header: repository/PR, snapshot OID 요약, current/stale/partial, last checked, refresh, run stage.
- Toolbar: file/commit scope, split/unified, whitespace, context line, finding overlay.
- Diff: old/new line number, hunk header, inline finding marker, selected evidence highlight.
- Maximize: Git graph, History, Impact처럼 수평 공간이 필요한 FNB tool을 Main으로 확장한다.
- Empty state: 선택 없음, binary/generated, omitted, artifact 준비 중, permission denied를 구분한다.

Line anchor는 `snapshotId + fileId + side + line + hunk checksum`으로 해석한다. line number만 URL에 저장하지 않는다.

### 11.5 Persistent Chat dock

- Panel 자체는 route와 LNB/FNB tab 전환에도 unmount하지 않는다.
- Header에 snapshot OID, stale badge, conversation switcher, budget 상태를 표시한다.
- Context chip은 현재 finding/file/symbol/commit을 보여주며 사용자가 message에서 제외할 수 있다.
- 답변의 evidence chip은 title만 표시하고 선택 시 Evidence Resolver를 거쳐 이동한다.
- 새 snapshot이 생기면 “이 대화는 이전 HEAD 기준”을 표시하고 새 conversation 생성 action을 제공한다.
- input draft, scroll anchor, pending message는 conversation ID별로 저장한다. source content가 포함될 수 있으므로 browser persistence 사용 여부는 조직 정책을 따른다.

### 11.6 FNB

| tool | 기본 표시 | 상세/maximize |
|---|---|---|
| Evidence | 선택 finding의 direct evidence chip과 한 줄 요약 | 전체 근거, counter evidence, provenance |
| Git graph | base/merge-base/head와 주변 commit의 compact graph | branch/author/time/path filter, pagination |
| History | 선택 file/symbol의 최근 commit | rename/move chain, blame, churn |
| Ownership | 후속: CODEOWNERS/blame/review 근거 | 출처별 비교, 기간 filter |
| Impact | 후속: direct edge 요약 | graph와 certainty, unknown 표시 |
| Related tests | 후속: test 후보와 상태 | relation 근거, 실행 결과가 있으면 별도 표시 |

Evidence trail은 화면 절반을 차지하는 독립 pane으로 만들지 않는다. 기본 compact height에서 가장 직접적인 근거를 먼저 보여주고 상세 분석은 maximize한다.

### 11.7 Client state

```ts
type ReviewSelection = {
  snapshotId: string;
  fileId?: string;
  side?: "base" | "head";
  line?: number;
  hunkToken?: string;
  symbolId?: string;
  findingId?: string;
  evidenceId?: string;
  commitOid?: string;
};

type LayoutPreference = {
  schemaVersion: 1;
  lnbWidth: number;
  chatWidth: number;
  fnbHeight: number;
  fnbCollapsed: boolean;
  lnbMode: "files" | "findings" | "outline" | "impact";
  fnbTool: "evidence" | "graph" | "history" | "ownership" | "impact" | "tests";
};
```

- `snapshotId`가 바뀌면 resolver가 나머지 selection의 유효성을 검사한다.
- finding/file/evidence 선택은 reducer command로만 변경한다.
- layout state와 review selection state를 분리해 panel resize가 data query를 재실행하지 않게 한다.
- server preference와 local preference가 충돌하면 `updatedAt`과 schema version으로 결정하며 범위를 벗어난 값은 clamp한다.

### 11.8 사용자 문구와 locale

- `PR`, `diff`, `snapshot`, `finding`, `commit`, `merge-base`, `HEAD`, `Git graph`, `Worker`, `runtime`, `queue`, `Chat`, `Check`는 English 표기를 유지한다.
- 상태·오류·도움말과 설명문은 한글로 작성한다.
- 번역을 추가할 수 있게 message catalog key를 기능 단위로 관리한다.
- 날짜, 숫자, 상대시간, byte, duration은 `Intl` formatter를 사용한다.
- backend error code와 사용자 문구를 분리한다. server English exception을 그대로 노출하지 않는다.

## 12. Policy 설계

### 12.1 Priority와 confidence

| priority | 의미 | 기본 게시 정책 |
|---|---|---|
| P0 | 검토할 가치가 있는 좋은 변경. merge 판단 영향 없음 | richness 설정에 따라 요약에 포함, finding 수에서 제외 가능 |
| P1 | 선택적 개선이나 참고 정보 | advisory로 report에 포함 가능 |
| P2 | 수정 없이 merge하면 실제 결함 위험이 있는 문제 | Check에 명확히 표시, 실패 여부는 정책 |
| P3 | 보안·데이터 손상·중대한 회귀처럼 merge 차단 후보 | high confidence+direct evidence일 때만 failure 후보 |

Confidence는 evidence 직접성, parser coverage, 재현 조건과 불확실성으로 계산한다. 모델의 자기평가 점수만 사용하지 않는다.

### 12.2 Config merge

| field | merge 규칙 |
|---|---|
| `analysis.exclude` | admin 강제 제외/포함 정책을 먼저 적용하고 repository pattern을 허용 범위에서 추가 |
| `max_changed_lines`, `history_depth`, budget | 더 작은 제한값 |
| specialist enable | admin이 금지하면 false, repository는 허용 집합 안에서 선택 |
| `publish_inline` | admin과 base config가 모두 true이고 permission이 있을 때 true |
| `fail_check_on` | admin 허용 priority의 교집합 |
| retention/model profile | admin/tenant 정책만 결정, PR config로 변경 불가 |

### 12.3 Suppression

- directive parser는 comment token을 AST 또는 line parser로 식별하고 생성 file에서는 정책에 따라 무시한다.
- suppression key는 rule/category/finding fingerprint와 line scope를 포함한다.
- reason이 없거나 기간·scope가 지나치게 넓으면 거부한다.
- P3 suppression은 설정 시 CODEOWNER 승인을 확인한다.
- suppress가 finding 존재 자체를 지우지 않는다. report 표시 정책과 audit record를 분리한다.

## 13. 보안 control 배치

| 위협 | 예방 control | 탐지·복구 |
|---|---|---|
| tenant IDOR | server scope 주입, DB RLS, artifact authorization | denied metric, security audit |
| token 유출 | short-lived token, secret manager, queue/log 금지 | secret scan, rotation, credential revoke |
| prompt injection | instruction/data 분리, typed read tool, scope 고정 | malicious fixture, tool audit metadata |
| Git option/path injection | argv runner, `--`, ref/path allowlist, opaque work path | security test, sandbox violation log |
| symlink/submodule/hook | worktree validation, hooks disabled, submodule policy | stage fail/omit, artifact quarantine |
| SSRF/redirect | approved host construction, redirect/DNS/TLS fail closed | outbound denied metric |
| stale publish | live head·anchor 재검증 | stale-post metric과 delivery reconciliation |
| supply-chain 변조 | pinned base, scan, SBOM, provenance, signature, digest admission | deployment gate와 image inventory |
| XSS | schema/size validation, Markdown sanitize, CSP | browser security test |
| 권한 회수 지연 | short auth TTL, sensitive command recheck, reconciliation | stream cancel, cache purge |

## 14. 실패, retry와 backpressure

| 실패 | 처리 | 최종 상태 |
|---|---|---|
| GitHub primary rate limit | reset까지 target 지연, reserve 보호 | queued/deferred |
| secondary limit/abuse | host concurrency 감소, retry-after 준수 | queued/deferred |
| Git fetch 일시 오류 | exponential backoff+jitter, 제한 retry | failed 또는 재개 |
| history object 부족 | 필요한 OID deepen fetch, limit 초과 시 omission | partial 가능 |
| parser crash | file/process 격리, 해당 language/file omission | partial |
| model timeout | specialist별 제한 retry, 다른 specialist 유지 | partial |
| schema invalid model output | repair 1회 등 제한된 정책, verifier 거부 | partial |
| object upload 성공/DB 실패 | orphan marker/lifecycle cleanup | retry 가능 |
| publish timeout | external marker/receipt 조회 후 결정 | completed/partial |
| new head | cooperative cancel, publish 차단 | superseded |
| authorization revoked | 즉시 command/stream 차단, job cancel | cancelled/access-revoked |

Queue priority는 `authorization/publish verification > manual refresh > active PR > normal analysis > idle reconciliation > backfill` 순이다. Tenant별 concurrency와 global dependency circuit breaker를 함께 적용한다.

## 15. Observability와 audit

### 15.1 Metric

- Poll: cycle count, page latency, detection lag, checkpoint age, lease contention, quota remaining, backoff.
- Queue/Worker: queue lag, active job, stage duration, retry, cancellation, artifact reuse.
- Analysis: files/lines bucket, parser coverage, omission count, finding priority/confidence/category.
- Model: profile/model version, token count, latency, schema error, tool count, budget stop. prompt/source 제외.
- Publish: Check/comment attempt, idempotent reuse, invalid anchor, stale blocked, permission error.
- UI/API: route latency, diff range size, SSE reconnect, authorization denied. path/source 제외.

High-cardinality label에는 opaque tenant/repository/run ID를 제한적으로 쓰고 file ID는 metric label로 사용하지 않는다.

### 15.2 Trace

Correlation chain은 refresh/poll event에서 publish까지 이어진다. Git command argv, model prompt, source path·snippet은 span attribute에서 제외한다. stage span에는 artifact ID, schema version, size bucket, result code만 기록한다.

### 15.3 Audit action

최소 action 집합:

- login/identity link, repository access denied
- installation/repository scope change
- config/policy 적용과 validation failure
- run retry/cancel/manual publish/manual refresh
- finding feedback/suppress/unsuppress
- Check/comment publish와 stale 차단
- artifact export, audit export, purge
- operator deployment/rollback/secret rotation reference

Audit metadata는 source 본문 없이 누가, 어떤 scope에, 무엇을, 어떤 결과로 수행했는지를 재구성할 수 있어야 한다.

## 16. Test 설계와 요건 연결

| test layer | 대상 | 대표 요건 |
|---|---|---|
| Unit | state transition, key, config merge, line map, priority, sanitization | FR-GH-005~008, FR-SN-002, FR-AN-001, FR-RV-003~007, FR-CF-* |
| Contract | GitHub host adapter, REST/event/artifact schema | FR-GH-001~004, FR-AN-007, FR-RP-001~005, DR-005 |
| Integration | DB RLS, object authorization, queue retry, Git fixture, image delivery | FR-SN-003~009, DR-001~008, SEC-003~011 |
| Agent golden | specialist output, verifier, prompt injection | FR-RV-001~010, BR-003, SEC-006~007 |
| Component/UI | layout, selection reducer, diff virtualization, locale | FR-UI-001~016, NFR-I18N-001 |
| E2E | poll→snapshot→analysis→UI→Chat→Check | AT-001~012 |
| Load/failure | polling quota, Worker scale, checkpoint recovery, API p95 | NFR-PERF-*, NFR-SCL-*, NFR-REL-* |
| Security | IDOR, SSRF, malicious repository, supply chain, XSS | SEC-* |

## 17. 구현 시 지켜야 할 경계

- `apps/web`이 GitHub API나 object storage를 직접 호출하지 않는다.
- Poller가 분석을 직접 실행하지 않고 snapshot/run command만 만든다.
- Worker image build에 runtime `.env`, GitHub private key, model key를 전달하지 않는다.
- queue payload에 path, source, diff, prompt, token을 넣지 않는다.
- model이 repository/ref/tool argument를 직접 선택하게 하지 않는다.
- PR head의 `.gcr.yml`로 현재 run의 검사 강도·권한·model endpoint를 완화하지 않는다.
- stale run을 current result로 덮어쓰거나 stale finding을 현재 head에 게시하지 않는다.
- concept HTML에 없는 기능을 production 범위에서 임의로 제외하지 않는다.
- 한글 UI를 만들기 위해 `snapshot`, `finding`, `diff`, `merge-base` 같은 용어를 의미가 다른 번역어로 바꾸지 않는다.

## 18. 미정 사항 반영 방식

`requirements-specification.md`의 `OD-*`가 확정되기 전에는 다음 interface를 vendor-neutral하게 유지한다.

| 미정 사항 | interface |
|---|---|
| GitHub Cloud/GHES | `GitHubHostAdapter`와 host contract suite |
| token broker | `InstallationCredentialProvider` |
| model endpoint | `ModelGateway`와 model profile config |
| language | `SymbolAnalyzerAdapter`, `DependencyAnalyzerAdapter` |
| registry/signing | OCI digest, SBOM, provenance, signature verification contract |
| secret manager | file reference/workload identity 기반 `SecretProvider` |
| runtime | container env/volume/network contract, Kubernetes manifest 우선 |
| retention 기간 | retention class와 policy table, 값은 deployment config |

특정 제품을 선택하면 adapter와 deployment overlay를 추가한다. Domain contract와 artifact schema에는 vendor 이름을 넣지 않는다.

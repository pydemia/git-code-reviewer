# Git Code Reviewer - 설계 검토 수정 제안서

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-09-02 |
| 대상 finding | `.documents/design-review-2026-09-02.md`의 H-01~H-08, M-01~M-19, L-01~L-10 |
| 성격 | 제안서. 이 문서 외에 어떤 파일도 수정하지 않았다. |
| 전제 | 사용자가 확정한 16개 제품 방향은 변경 대상이 아니다. 모든 제안은 그 안에서만 움직인다. |
| 사용법 | 각 제안은 대상 문서·위치·교체 문안·연쇄 수정·검증 방법을 함께 담는다. 승인한 항목만 골라 적용할 수 있다. |

제안에 포함된 수치(주기, 상한, timeout, replica 수)는 근거를 붙인 초기값이며 조직 확인 전까지 확정값이 아니다. §11에 확인이 필요한 값을 모아 두었다.

---

## 1. 적용 원칙

수정을 반복하지 않으려면 문서 간 역할을 먼저 고정한다. 이번 검토에서 나온 불일치 16건 중 9건이 같은 contract를 두 문서가 각자 적는 구조에서 나왔다.

### 1.1 contract 정본 규칙 (제안)

| contract | 정본 문서 | 다른 문서의 취급 |
|---|---|---|
| 요구사항 ID, AC, DEC | `requirements-specification.md` | 참조만. 목록 복제 금지 |
| API, SSE event, artifact schema, data model | `functional-design.md` | blueprint는 개념 설명만, 목록 복제 금지 |
| UI layout 수치, route, selection | `ui-implementation-design.md` | visual HTML/PNG가 시각 기준, 설계 문서가 수치 기준 |
| Helm values, chart resource | `functional-design.md` §11 | blueprint는 배포 개념만 |
| milestone, task ID | `implementation-plan.md` | blueprint의 Phase는 삭제 또는 매핑표로 축약 |

적용 결과로 다음 블록을 삭제하거나 요약으로 바꾼다.

- `blueprint.md:363-379` (API 초안) → "API contract는 기능 설계 §7을 따른다" 한 문장
- `blueprint.md:437-487` (values 전문) → 핵심 키 5개 요약 + 기능 설계 참조
- `blueprint.md:517-559` (Phase 0-4) → M0-M5 매핑표
- `blueprint.md:561-573`, `implementation-plan.md:264-277` (결정 목록) → `DEC-*` 참조

### 1.2 제안 적용 순서

| Batch | 내용 | 선행 조건 | 대상 시점 |
|---|---|---|---|
| B1 | 문구·정합성 수정 (L 전체, M-01, M-02, M-04, M-09, M-10, M-11) | 없음 | 즉시 |
| B2 | contract 확정 (H-01, H-03, H-08, M-05, M-18, M-19) | 없음 | M2 착수 전 |
| B3 | 실행 경로 (H-02, H-05, H-06, M-14, M-16) | B2 | M4 착수 전 |
| B4 | 규모·운영 (H-04, H-07, M-03, M-06, M-07, M-17, M-12) | 실측·조직 확인 | M5 착수 전 |

---

## 2. High finding 수정 제안

### FIX-H-03. snapshot identity와 merge-base 정정 절차

가장 먼저 적용해야 한다. DB 제약과 immutability 규칙이 여기서 결정된다.

**선택지**

| 안 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A (권장) | snapshot key는 base/head 유지. merge-base는 상태를 가진 해석 결과로 두고 단조 전이만 허용 | 탐지 시점에 row를 만들 수 있다. 구현이 단순하다 | 요구사항 용어 수정이 필요하다 |
| B | `merge_base_sha`를 unique key에 포함 | 요구사항 용어를 그대로 둔다 | merge-base는 clone 이후에야 확정되므로 탐지 시점에 row를 만들 수 없다 |

merge-base는 base/head가 같으면 결정적이다. 값이 달라지는 경우는 이전 계산이 깊이 제한 아래에서 부정확했거나 history가 재작성된 상황뿐이다. 따라서 "정정"을 일반 경로로 두지 않고 단조 전이와 무결성 오류로 나누는 A안을 권장한다.

**제안 문안**

`requirements-specification.md:26` 용어 교체:

```
| snapshot | `repository + PR number + base SHA + head SHA`로 식별되는 불변 입력.
            merge-base SHA는 snapshot에 귀속된 해석 결과이며 identity의 일부가 아니다. |
```

`requirements-specification.md` §6에 추가:

```
| REQ-SNAP-012 | 필수 | snapshot은 `merge_base_sha`와 `merge_base_resolution`(`pending|exact|unresolved`)을 가진다.
                       전이는 `pending -> exact`, `pending -> unresolved`, `unresolved -> exact`만 허용한다. |
| REQ-SNAP-013 | 필수 | 이미 `exact`인 merge-base와 다른 값이 계산되면 결과를 반영하지 않고 run을 실패로 처리하며 무결성 event를 남긴다. |
```

`functional-design.md:87` 문장 교체:

```
merge-base는 snapshot 생성 후 worker가 확정하며 `merge_base_resolution` 상태로 관리한다.
확정된 값은 수정하지 않는다. 같은 base/head에서 다른 merge-base가 계산되면 history 재작성 또는
engine 결함이므로 조용히 정정하지 않고 run을 failed로 종료하고 audit event를 남긴다.
```

`functional-design.md:82` analysis key에 `merge_base_resolution` 추가. `unresolved` 상태에서 만든 partial report가 이후 `exact` 결과를 밀어내지 않게 한다.

**연쇄 수정**: `functional-design.md:207`의 snapshots 제약 설명, `blueprint.md:207-213` snapshot key 설명.

**검증**: fixture test로 (1) 깊이 제한 안에서 exact 확정, (2) 한도 초과 시 unresolved + partial, (3) 이후 더 깊은 정책으로 exact 승격, (4) exact 상태에서 다른 값 계산 시 failed를 확인한다.

### FIX-H-01 + FIX-H-08. API, event, artifact contract 보강

**제안: `functional-design.md:222-243` 교체**

```text
GET    /api/v1/me
GET    /api/v1/repositories
GET    /api/v1/repositories/{repoId}/pulls
GET    /api/v1/repositories/{repoId}/pulls/{number}
GET    /api/v1/repositories/{repoId}/pulls/{number}/analyses
GET    /api/v1/repositories/{repoId}/pulls/{number}/events
POST   /api/v1/repositories/{repoId}/pulls/{number}/refresh
GET    /api/v1/operations/{operationId}

GET    /api/v1/analyses/{analysisId}
GET    /api/v1/analyses/{analysisId}/coverage
GET    /api/v1/analyses/{analysisId}/findings
GET    /api/v1/analyses/{analysisId}/findings/{findingId}
GET    /api/v1/analyses/{analysisId}/events

GET    /api/v1/snapshots/{snapshotId}/files
GET    /api/v1/snapshots/{snapshotId}/files/{fileId}/content
GET    /api/v1/snapshots/{snapshotId}/diff
GET    /api/v1/snapshots/{snapshotId}/symbols
GET    /api/v1/snapshots/{snapshotId}/history
GET    /api/v1/snapshots/{snapshotId}/impact
GET    /api/v1/snapshots/{snapshotId}/commits
GET    /api/v1/snapshots/{snapshotId}/ownership
GET    /api/v1/snapshots/{snapshotId}/tests
GET    /api/v1/snapshots/{snapshotId}/merge-simulation

POST   /api/v1/analyses/{analysisId}/chat-sessions
GET    /api/v1/chat-sessions/{sessionId}
POST   /api/v1/chat-sessions/{sessionId}/messages
GET    /api/v1/chat-sessions/{sessionId}/events

GET    /api/v1/admin/repositories
POST   /api/v1/admin/repositories
PATCH  /api/v1/admin/repositories/{repoId}
GET    /api/v1/admin/retention
PUT    /api/v1/admin/retention
POST   /api/v1/admin/analyses/{analysisId}/cancel
GET    /api/v1/admin/jobs
POST   /api/v1/admin/jobs/{jobId}/requeue
GET    /api/v1/admin/audit-events
```

**refresh 응답 (신규)**

```json
{
  "operationId": "op_...",
  "deduplicated": true,
  "state": "queued",
  "eventsUrl": "/api/v1/repositories/12/pulls/482/events",
  "estimatedStartSeconds": 3
}
```

`deduplicated: true`는 REQ-GH-008과 AC-03의 동작을 응답으로 관측 가능하게 만든다.

**operation 응답 (신규)**

```json
{
  "id": "op_...",
  "type": "pr_refresh",
  "state": "queued|polling|completed|failed",
  "result": { "snapshotChanged": false, "snapshotId": "snp_...", "analysisId": null },
  "startedAt": "...", "finishedAt": null,
  "error": null
}
```

**SSE contract 교체 (`functional-design.md:263-279`)**

```text
# PR scope: /repositories/{repoId}/pulls/{number}/events
event: poll.started        data: { operationId, occurredAt }
event: poll.completed      data: { operationId, outcome: "unchanged|changed|deferred", reason, occurredAt }
event: snapshot.detected   data: { snapshotId, headSha, baseSha, analysisId, occurredAt }
event: analysis.state      data: { analysisId, revision, state, stage, progress, occurredAt }
event: analysis.available  data: { analysisId, revision, reportUrl, stale, occurredAt }
event: merge.state         data: { snapshotId, mergeState, baseRefTipSha, occurredAt }

# analysis scope: /analyses/{analysisId}/events
event: analysis.state, analysis.available

# chat scope: /chat-sessions/{sessionId}/events
event: chat.delta          data: { sessionId, messageId, sequence, delta }
event: chat.completed      data: { sessionId, messageId, citations, usage }
event: chat.failed         data: { sessionId, messageId, code, retryable }
```

모든 event는 단조 증가 `id`를 가진다. client는 `Last-Event-ID`로 재연결하고, 재생 창(기본 1시간)을 벗어나면 REST로 전체 상태를 다시 읽는다.

**artifact contract 보강 (`functional-design.md:281-302`)**

```text
artifacts/<repository-id>/<snapshot-id>/
  snapshot-manifest.v1.json
  source-manifest.v1.json
  source/<opaque-file-id>.blob.zst
  diff-index.v1.json
  diffs/<opaque-file-id>.patch.zst
  commits.v1.json.zst
  merge-sim/<base-ref-tip-sha>.v1.json.zst
  <analysis-id>/
    symbols.v1.json.zst
    history.v1.json.zst
    ownership.v1.json.zst
    impact.v1.json.zst
    tests.v1.json.zst
    coverage.v1.json
    model/<specialist-id>.v1.json.zst
    report.v1.json.zst
```

snapshot 단위 산출물(source, diff, commits, merge simulation)을 analysis 단위 산출물과 분리한다. 같은 snapshot을 다른 analyzer/model version으로 재분석할 때 clone과 diff를 다시 만들지 않아도 되고, FIX-H-04의 merge simulation 재계산이 report immutability를 건드리지 않는다.

**신규 요구사항**

```
| REQ-DATA-008 | 필수 | 비동기 요청은 operation resource로 조회할 수 있고 중복 요청은 같은 operation을 반환한다. |
| REQ-DATA-009 | 필수 | PR 범위 event stream이 poll, snapshot, analysis, merge 상태 변화를 전달한다. |
```

**검증**: AC-13(§9) 추가. contract test에서 모든 endpoint의 `schemaVersion`과 identity 필드를 검사한다.

### FIX-H-02. SSE fan-out

broker를 두지 않는 결정을 유지하면서 replica 간 전달을 정의한다.

**제안 구조**

1. `event_log` table을 둔다.

```
event_log(id bigserial PK, scope text, scope_id text, type text,
          payload jsonb, created_at timestamptz default now())
index (scope, scope_id, id)
```

`payload`에는 ID와 상태만 넣는다. source, diff, prompt, token은 넣지 않는다(REQ-SEC-007 유지).

2. 상태를 바꾼 transaction이 같은 transaction에서 `event_log`에 append하고 `NOTIFY gcr_events, '<id>:<scope>:<scope_id>'`를 보낸다. payload는 8000 byte 한도 안의 식별자만 담는다.
3. 각 server replica는 pool과 분리된 전용 연결로 `LISTEN gcr_events`를 유지하고, 알림을 받으면 해당 scope 구독자에게 `event_log` row를 읽어 전달한다. 전달 직전에 구독자의 authorization을 다시 확인한다.
4. `LISTEN` 연결이 끊기면 해당 replica는 2초 주기로 `event_log`를 tail하는 fallback으로 전환하고 복구되면 되돌린다.
5. 재연결 client의 `Last-Event-ID`는 `event_log.id`로 해석해 재생한다. 보존은 1시간, retention job이 정리한다.

**신규 요구사항**

```
| REQ-DATA-010 | 필수 | event는 durable log에 append되고 replica 간 전달과 재연결 재생이 broker 없이 동작한다. |
```

**연쇄 수정**: `functional-design.md:2.3` component 표에 "Event log/fan-out" 행 추가, `implementation-plan.md` M2-08 완료 조건에 "server replica 2개에서 어느 쪽에 붙어도 event를 수신한다" 추가.

**검증**: AC-16(§9). resilience test에서 LISTEN 연결 강제 종료 후 fallback 전환과 복구를 확인한다.

### FIX-H-04. base branch 이동과 merge simulation 신선도

**제안**

1. base SHA 출처를 고정한다. PR 목록 응답의 base SHA를 신뢰하지 않고, repository poll마다 open PR이 사용하는 base branch 집합의 tip을 한 번 조회해 캐시한다. 조회 비용은 PR 수가 아니라 base branch 수(보통 1-3)에 비례한다.
2. `snapshots`에 `base_ref_tip_sha`, `base_ref_observed_at`을 저장한다.
3. merge simulation artifact를 `(snapshot_id, base_ref_tip_sha)`로 키한다(FIX-H-08의 경로 분리).
4. base tip이 이동하면 canonical diff와 report는 그대로 두고 `merge_state`만 `stale`로 바꾼 뒤 경량 `merge.simulate` job을 큐에 넣는다. 완료되면 `merge.state` event로 알린다.
5. UI Header에 merge 상태를 report 상태와 별도로 표시한다.

canonical diff는 `merge-base...head` 의미이므로 base tip 이동에 대체로 영향받지 않는다. 반면 통합 위험 판단은 달라진다. report immutability를 지키면서 이 차이만 갱신하는 것이 이 제안의 요지다.

**신규 요구사항**

```
| REQ-GH-012  | 필수 | poll은 open PR의 base branch tip을 관측하고 snapshot에 기록한다. |
| REQ-SNAP-014| 필수 | merge simulation은 base ref tip에 귀속된 별도 artifact이며 base tip 이동 시 stale로 표시하고 재계산한다. |
| REQ-UI-015  | 필수 | UI는 report 상태와 별개로 현재 base 기준 merge 상태(clean/conflicted/stale/not_run)를 표시한다. |
```

**검증**: AC-14(§9). Git fixture로 base 전진 후 canonical diff 불변, merge 상태 stale, 재계산 후 clean/conflicted 확정을 확인한다.

### FIX-H-05. Chat model 호출 경계

**제안: Chat 추론은 server가 수행한다.**

worker로 위임하면 token delta를 worker에서 browser까지 중계해야 하고, 그 경로를 DB event log로 흘리면 지연과 부하가 모두 커진다. 대화형 stream은 server에서 직접 처리하는 것이 자연스럽다. 대신 분석용 model 호출은 worker에 그대로 둔다.

| 용도 | 실행 주체 | 성격 | 상한 |
|---|---|---|---|
| 분석 specialist | worker | batch | run당 호출 수, timeout |
| Chat 응답 | server | interactive stream | 사용자별 동시 1, 분당 메시지 상한 |

**연쇄 수정**

- `requirements-specification.md:176` REQ-SEC-003 교체: "server와 worker의 egress를 각각 allowlist로 제한한다. server는 GHES, model endpoint, PostgreSQL, artifact backend를, worker는 GHES, model endpoint, PostgreSQL, artifact backend를 허용한다."
- `visuals/git-code-reviewer.drawio` page 1에 Server → Model endpoint edge 추가(label: `chat inference`).
- `blueprint.md:120-153` architecture 블록에 Server → Model 경로 표기.
- values: `secrets.modelProvider`를 server와 worker 양쪽 Deployment에 mount한다고 명시.
- `functional-design.md` §12에 model metric을 `component` label로 분리.

**신규 요구사항**

```
| REQ-SEC-009  | 필수 | model credential과 egress 허용은 실제 호출하는 workload에만 부여한다. |
| REQ-CHAT-008 | 필수 | 사용자별 chat 동시 요청, 분당 메시지, tool turn과 요청 timeout 상한을 강제한다. |
```

### FIX-H-06. probe 계층과 degraded mode

**제안: probe 의미를 세 층으로 나눈다.**

| probe | server | worker | 판단 기준 |
|---|---|---|---|
| startup | schema version 확인, artifact backend 접근 확인 | 동일 | 실패 시 기동 실패 |
| readiness | HTTP listener와 초기화 완료 여부만 | lease loop가 최근 주기 안에 동작했는지(파일 touch exec probe) | 외부 의존성 제외 |
| liveness | event loop 응답성 | heartbeat thread 정상 여부 | 외부 장애로 재시작하지 않음 |

의존성 상태는 probe가 아니라 `/healthz/dependencies`로 노출한다.

```json
{ "db": "ok", "artifact": "degraded", "ghes": "ok", "model": "ok" }
```

degraded 상태의 동작을 명시한다.

- DB 장애: 읽기 캐시 가능한 화면 유지, write API와 refresh는 `503` + `retryable: true`, UI에 banner
- artifact 장애: metadata와 finding 목록은 제공, diff/source 조회만 실패 표시
- GHES 장애: poll 지연 사유와 마지막 성공 시각 표시(REQ-GH-009와 연결)
- model 장애: 분석은 deterministic-only partial, Chat은 재시도 안내

**제안 문안** — `requirements-specification.md:198` 교체:

```
| REQ-OPS-012 | 필수 | startup probe가 schema와 artifact 접근을 확인하고, readiness는 process의 요청 처리 가능 여부만 반영하며,
                      liveness는 외부 GHES/model/DB 장애로 pod를 재시작하지 않는다. |
| REQ-OPS-016 | 필수 | 의존성 장애는 별도 health endpoint와 UI degraded 표시로 노출하고 영향받는 기능만 거부한다. |
```

**검증**: AC-15(§9). PostgreSQL을 강제로 끊고 UI가 503 페이지가 아니라 degraded 화면을 유지하는지 확인한다.

### FIX-H-07. poll 예산과 분산

**제안 1: shard 기반 scheduler**

advisory lock을 전역 하나가 아니라 shard 단위로 잡는다.

```
shard_id = hash(repository_id) % scheduler.shardCount   # 기본 4
```

server replica는 미점유 shard를 claim하고 heartbeat로 유지한다. replica가 늘면 shard가 분산되고, 줄면 남은 replica가 인계한다. lock 획득 실패는 정상 동작이다.

**제안 2: tier 기반 주기**

| tier | 조건 | 주기(초기값) |
|---|---|---:|
| hot | 최근 30분 내 head 변경, 또는 현재 열람 중인 PR | 60초 |
| active | open PR이고 24시간 내 활동 | 5분 |
| idle | 그 외 open PR, draft | 15분 |
| disabled | 관리자 비활성 | 없음 |

manual refresh는 tier와 무관하게 우선 처리한다. 사용자별 분당 5회, PR당 30초 1회로 제한한다.

**제안 3: 요청 예산 guard**

`github.requestBudgetPerHour`를 값으로 두고, 소진율이 80%를 넘으면 hot을 제외한 tier의 주기를 2배로 늘린다. 예산과 실제 사용량을 metric으로 노출한다.

**제안 4: 요구사항 재작성** — `requirements-specification.md:207` 교체:

```
| REQ-NFR-001 | 필수 | hot tier PR은 기본 60초, active는 5분, idle은 15분 안에 다시 조회한다.
                      요청 예산 초과 시 hot을 제외한 tier 주기를 자동으로 늘리고 지연 사유를 표시한다. |
| REQ-GH-013  | 필수 | poll은 shard 단위로 분산되며 server replica 수에 따라 처리량이 늘어난다. |
```

**측정 근거**

| 구성 | 목록 조회 요청/시간 |
|---|---:|
| repository 100개 전부 60초 | 6,000 |
| hot 20 + active 30 + idle 50 (제안 tier) | 1,200 + 360 + 200 = 1,760 |

conditional request가 rate limit에서 어떻게 계산되는지는 대상 GHES에서 확인해야 한다(§11, DEC-012).

---

## 3. Medium finding 수정 제안

### FIX-M-01. run state와 UI badge mapping

`requirements-specification.md` §10에 표를 추가한다.

| run state | UI badge | 설명 |
|---|---|---|
| requested | 대기 | 큐에 있음 |
| preparing, analyzing, persisting | 진행 중 (stage 표시) | progress와 elapsed 표시 |
| completed | 완료 | |
| partial | 부분 완료 | omission 목록 필수 |
| failed | 실패 | 실패 stage, request ID |
| superseded | 대체됨 | 최신 run link 제공 |
| cancelled | 취소됨 | 취소 주체 표시 |

`stale`은 상태가 아니라 파생 값으로 정의한다: `report.head_sha != pull_request.head_sha` 또는 `merge_state = stale`. UI는 badge와 별도 표식으로 표시한다.

### FIX-M-02. priority 의미와 category enum

`requirements-specification.md` §7에 추가한다.

| priority | 의미 | 표시 문구 | 규칙 |
|---|---|---|---|
| P3 | 보안, data loss, build 불가, 치명 오류 | 치명 | high confidence와 직접 evidence 필수 |
| P2 | merge 전에 확인할 결함 가능성 | 결함 가능성 | 직접 evidence 필수 |
| P1 | 선택적 개선, 정보 | 개선 | |
| P0 | 검토할 가치가 있는 좋은 변경 | 요약 | summary에만 사용 |

`REQ-AN-007`의 "최고 priority"를 `P3`로 명시한다. category enum을 확정한다.

```
correctness | security | compatibility | testing | maintenance
```

visual의 `maintenance`를 enum에 포함하는 안을 권장한다. REQ-AN-004의 네 관점은 model specialist 축이고, category는 finding 분류 축이므로 하나 더 있어도 모순이 아니다. UI는 등급 문자와 표시 문구를 함께 노출해 P3=치명 관례가 뒤집혀 읽히지 않게 한다.

### FIX-M-03. cleanup 책임 분리

| 대상 | 실행 주체 | 주기 | 근거 |
|---|---|---|---|
| pod-local workspace | worker in-process sweeper | 기동 시 전체 삭제 + 10분 주기 | emptyDir은 다른 pod가 볼 수 없다 |
| RWO/generic ephemeral workspace | 동일 | 동일 | pod에 귀속 |
| artifact orphan(참조 없는 prefix, 미완료 temp) | retention CronJob | 1시간 | cross-pod 접근 필요 |
| 만료 report/chat/source | retention CronJob | 1일 | DB row와 object를 함께 삭제 |
| event_log | retention CronJob | 10분 | 재생 창 1시간 |

`requirements-specification.md:106` REQ-SNAP-009를 "workspace는 run 종료 시 삭제하고, worker in-process sweeper가 자기 pod의 잔여물을 정리한다"로 좁히고, artifact/retention은 신규 REQ-OPS-017로 분리한다.

### FIX-M-04. command 목록과 주기 작업 resource

command를 다음으로 확정한다.

```
git-code-reviewer serve
git-code-reviewer worker
git-code-reviewer migrate
git-code-reviewer retention        # artifact orphan, 만료 데이터, event_log
```

workspace sweep은 별도 command가 아니라 worker in-process 기능으로 둔다(FIX-M-03). `requirements-specification.md:187` REQ-OPS-001을 4개 command로 수정하고, chart template에 다음을 추가한다.

```
templates/retention-cronjob.yaml
```

values:

```yaml
retention:
  enabled: true
  schedule: "17 * * * *"
  batchSize: 500
  reportDays: 90        # 조직 확인 필요
  chatDays: 30          # report 보다 길게 설정할 수 없음
  eventLogHours: 1
```

`chatDays <= reportDays` 제약을 `values.schema.json`에 넣는다.

### FIX-M-05. artifact 재시도 semantics

`functional-design.md` §8에 추가한다.

```
- stage 산출물은 `<...>/.staging/<attempt-id>/`에 쓰고 checksum 검증 후 canonical key로 atomic commit한다.
- canonical key로 commit된 object는 불변이며 같은 key로 다시 쓰지 않는다.
- 재시도는 canonical object가 이미 존재하고 checksum이 유효하면 해당 stage를 건너뛴다.
- `.staging` 잔여물은 retention job이 24시간 후 삭제한다.
```

`artifacts` table에 `committed_at`, `producer_attempt`를 추가하고 unique는 `(run_id, type, version)`을 유지한다.

```
| REQ-DATA-013 | 필수 | artifact는 staging 후 atomic commit하며 commit된 object는 재작성하지 않는다. |
```

### FIX-M-06. object storage 전환 contract

values에 backend 블록을 추가한다.

```yaml
storage:
  backend: pvc            # pvc | object
  artifacts:
    storageClass: shared-rwx
    accessModes: [ReadWriteMany]
    size: 100Gi
  object:
    endpoint: ""
    region: ""
    bucket: ""
    prefix: "git-code-reviewer"
    forcePathStyle: true
    existingSecret: ""    # accessKeyId / secretAccessKey
    serverSideEncryption: ""
```

`values.schema.json`에 조건부 required를 넣는다(`backend=object`이면 endpoint, bucket, existingSecret 필수). NetworkPolicy egress에 object endpoint를 추가한다. artifact port는 filesystem과 object 두 구현을 M2-07에서 함께 만들고, contract test를 두 backend에 동일하게 돌린다.

```
| REQ-OPS-018 | 필수 | artifact backend는 값으로 선택하며 두 backend가 같은 artifact contract와 checksum 규칙을 만족한다. |
```

### FIX-M-07. 자원 상한 (초기값 제안)

| 항목 | 제안값 | 근거 |
|---|---:|---|
| `worker.concurrency` | 2 | disk와 CPU 산정을 단순하게 유지 |
| run당 workspace soft/hard | 2 GiB / 4 GiB | 초과 시 partial + limitation |
| worker emptyDir sizeLimit | 10 GiB | concurrency 2 × hard 4 GiB + 여유 |
| changed file 상한 | 500개 | 초과분은 omission으로 기록 |
| canonical diff 상한 | 10 MiB | |
| source artifact budget | 25 MiB | Chat citation 대상 보존량 |
| analysis timeout | 15분 | REQ-NFR-003(5분 목표)의 hard stop |
| specialist 호출 timeout / 재시도 | 120초 / 1회 | |
| chat tool turn | 8회 | |
| chat 요청 timeout | 180초 | |
| chat 사용자별 동시/분당 | 1 / 10 | 비용 통제 |

전부 values와 typed config로 노출하고, 초과는 실패가 아니라 partial + limitation으로 처리한다는 규칙을 REQ-AN-010에 연결한다.

```
| REQ-AN-013 | 필수 | 분석과 Chat은 파일 수, byte, 호출 수, 시간 상한을 가지며 초과 시 partial과 limitation으로 처리한다. |
```

### FIX-M-08. split diff 자동 전환

`ui-implementation-design.md` §7.1에 추가한다.

```
- Main 가용 폭이 880px 미만이면 split을 unified로 자동 전환하고 전환 사유를 toolbar에 표시한다.
- 사용자가 split을 명시적으로 고정하면 가로 scroll을 허용하되 page 자체는 overflow하지 않는다.
- Chat 폭을 줄여 split을 유지하는 선택지를 함께 제공한다.
```

`ui-implementation-design.md:262-271` 완료 조건에 "1440px 기본 layout에서 split diff 양쪽이 잘리지 않는다"를 추가한다.

```
| REQ-UI-016 | 필수 | 읽기 가능한 폭을 확보하지 못하면 split diff를 unified로 자동 전환한다. |
```

### FIX-M-09. layout contract를 visual에 맞춤

`ui-implementation-design.md:67-73` 표 교체:

| 영역 | 기본값 | 조절 범위 | compact |
|---|---:|---:|---|
| Header (identity 행) | 54px | 고정 | 없음 |
| Header (PR/state 행) | 72px | 고정 | 1020px 미만에서 wrap |
| LNB | 280px | 220-420px | 1279px 이하 220px |
| Main | remaining | 최소 560px | 880px 미만에서 unified |
| Chat | 380px | 320-560px | 1279px 이하 320px |
| FNB | 132px | 48px-45vh | 48px rail |

responsive breakpoint를 visual과 맞춰 `1279 / 1020 / 720`으로 수정한다. 56px rail 상태는 visual에 없으므로 삭제하거나 "M4에서 추가하는 확장"으로 명시한다.

### FIX-M-10. base와 merge-base 표기 규칙

`ui-implementation-design.md` §7.1에 추가한다.

```
- canonical diff 좌측 열은 `merge-base <short SHA>`로 표기한다.
- base branch tip은 Header에서 `base <branch> <short SHA>`로 별도 표기한다.
- selection의 side 값은 `mergeBase | head`를 사용한다.
```

`ReviewSelection`의 `side?: "base" | "head"`를 `side?: "mergeBase" | "head"`로 바꾼다. visual HTML은 사용자 소유 자산이므로 수정하지 않고, 설계 문서에 "visual의 `BASE` label은 merge-base를 의미하며 구현에서는 명시적으로 표기한다"는 각주를 남긴다.

### FIX-M-11. 단계 체계 통합

`blueprint.md:517-559`를 매핑표로 축약한다.

| blueprint Phase | implementation-plan |
|---|---|
| Phase 0 Feasibility spike | M0-00 (신규) |
| Phase 1 Walking web service | M0 + M1 + M2 일부 |
| Phase 2 Reviewable MVP | M2 나머지 + M3 + M4 |
| Phase 3 Pilot hardening | M5 |
| Phase 4 Optional expansion | MVP 이후 |

`implementation-plan.md` §4 앞에 M0-00을 추가한다.

| ID | 작업 | 통과 기준 |
|---|---|---|
| M0-00a | GHES version과 API base URL 확인 | 문서화된 endpoint 응답 |
| M0-00b | App JWT → installation token → REST/GraphQL/Git fetch 왕복 | 세 경로 모두 성공 |
| M0-00c | `--filter=blob:none`, `--no-tags`, bounded depth clone | 대상 GHES에서 지원 확인 |
| M0-00d | merge-base 단계적 deepen | 한도 내 exact 확정 또는 unresolved 판정 |
| M0-00e | conditional request와 rate limit 헤더 관측 | 예산 모델 근거 확보(FIX-H-07) |
| M0-00f | approved model endpoint의 private source 정책 확인 | 서면 확인 |

### FIX-M-12. admin, audit surface

**감사 event catalogue (제안)**

| 분류 | event |
|---|---|
| 인증 | login 성공/실패, logout, session 만료 |
| 권한 | grant 부여/회수, role 변경 |
| 설정 | repository 등록/비활성, analysis profile 변경, retention 변경 |
| 분석 | run 생성/시작/완료/실패/취소/supersede, clone 시작/완료 |
| 조회 | report 조회, snapshot file 조회, artifact 다운로드 |
| Chat | session 생성, 질문, tool 호출, provider 호출 |
| 운영 | job 재실행, migration 실행, secret rotation |

각 event는 actor, action, resource type/id, outcome, request id, 시각만 기록한다. source, prompt, 응답 원문은 기록하지 않는다(REQ-AUTH-005 유지).

**역할 통일**: `Operator`(배포·복구), `Security operator`를 분리하지 않고 `Operator` 하나로 두되 `audit:read` 권한을 별도 grant로 둔다. `blueprint.md:86`, `PRODUCT.md:12`, `requirements-specification.md:68`을 같은 이름으로 맞춘다.

```
| REQ-SEC-012 | 필수 | 감사 event catalogue를 정의하고 원문 없이 metadata만 기록하며 권한 있는 사용자가 조회할 수 있다. |
```

**milestone 배치**: audit 기록은 M1(인증/권한)과 M2(분석)에 나눠 넣고, 조회 UI는 M5로 둔다.

### FIX-M-13. 요구사항 추적표

`requirements-specification.md` 끝에 추적표를 추가한다. 형식 예시는 다음과 같다.

| REQ | 설계 위치 | milestone | 검증 |
|---|---|---|---|
| REQ-SEC-005 | functional-design §9.2 | M4-10 (신규) | Browser E2E, XSS fixture |
| REQ-SEC-008 | functional-design §5.8 | M5-10 (신규) | 만료 삭제 test |
| REQ-AN-011 | functional-design §4.2 | M2-10 (신규) | 새 head 감지 후 supersede test |
| REQ-AUTH-005 | functional-design §12 | M1-09 (신규) | redaction test |

신규 task 제안:

| ID | 작업 |
|---|---|
| M1-09 | audit event 기록과 redaction helper |
| M2-10 | supersede 전이와 최신 run 우선 처리 |
| M4-10 | Markdown/code sanitize, CSP·보안 header, CSRF/origin 검사 |
| M5-10 | retention 실행(command + CronJob)과 사용자 삭제 처리 |

### FIX-M-14. 보안 header와 CSP

server가 모든 응답에 다음을 붙인다.

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'nonce-<n>';
  img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-ancestors 'none';
  base-uri 'none'; form-action 'self'; object-src 'none'
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
Strict-Transport-Security: max-age=31536000; includeSubDomains
Permissions-Policy: geolocation=(), camera=(), microphone=()
```

Markdown 렌더 규칙: raw HTML 차단, `http`/`https`/내부 상대 경로만 허용, 외부 이미지는 로드하지 않고 링크로 표시, 링크에 `rel="noopener noreferrer"`.

```
| REQ-SEC-010 | 필수 | 응답에 CSP와 보안 header를 적용하고 외부 리소스 로드를 차단한다. |
```

### FIX-M-15. fork PR 정책

**권장: MVP는 fork PR을 지원 대상에 포함하되 head를 base repository의 pull ref에서만 가져온다.**

```
fetch: refs/pull/<number>/head   # fork remote를 직접 추가하지 않는다
```

fork PR은 worklist에 `fork` 표식을 달고, source artifact 보존과 Chat scope는 동일 규칙을 적용한다. 지원하지 않기로 하면 worklist에서 제외 사유를 표시한다(§11, DEC-013).

```
| REQ-GH-014 | 필수 | fork PR의 head는 base repository의 pull ref로만 fetch하며 fork remote를 추가하지 않는다. |
```

### FIX-M-16. identity 신뢰 조건

**권장: application OIDC를 기본으로 한다.** Authorization Code + PKCE, confidential client, `Secure`/`HttpOnly`/`SameSite=Lax` cookie, idle timeout 8시간.

reverse proxy identity를 쓰는 배포를 허용한다면 다음을 필수로 둔다.

- NetworkPolicy ingress를 ingress controller의 namespace/pod selector로 제한
- server는 신뢰 목록 밖에서 온 identity header를 무조건 제거
- proxy가 서명한 JWT를 검증(평문 header 신뢰 금지)
- negative test: pod에 직접 요청해 header를 위조하면 거부되는지 확인

```
| REQ-SEC-011 | 필수 | proxy가 주입한 identity는 서명 검증과 네트워크 제한이 함께 적용될 때만 신뢰한다. |
```

### FIX-M-17. backup 순서와 reconcile

| 단계 | 내용 |
|---|---|
| 1 | artifact snapshot을 먼저 만든다 (T0) |
| 2 | DB backup을 나중에 만든다 (T1 > T0) |
| 3 | 복구는 같은 쌍으로 수행한다 |
| 4 | 복구 후 reconcile job이 DB row와 artifact를 대조한다 |

reconcile 결과 처리:

- artifact가 없는 report → `unavailable`로 표시하고 재분석 경로 제공
- DB 참조가 없는 artifact → retention 대상으로 표시

RPO 제안: DB 15분(PITR), artifact 24시간. `requirements-specification.md:230` AC-11을 다음으로 교체한다.

```
| AC-11 | backup/restore | 복구 후 reconcile이 끝나면 남은 report의 checksum이 일치하고 누락 artifact는 unavailable로 표시된다. |
```

```
| REQ-OPS-020 | 필수 | backup 순서와 복구 후 reconcile 절차를 정의하고 runbook에 포함한다. |
```

### FIX-M-18. job executor와 재시도 정책

`functional-design.md` §4.3에 표를 추가한다.

| job type | executor | priority | max attempts | backoff | 상한 초과 |
|---|---|---:|---:|---|---|
| `pr.poll` | server scheduler (shard 점유 replica) | 50 | 5 | 5s×2^n, jitter, 상한 5분 | repository backoff, dead-letter 없음 |
| `pr.poll.manual` | 동일 | 10 | 3 | 즉시, 5s, 20s | 사용자에게 실패 표시 |
| `analysis.run` | worker | 20 | 3 | 30s×2^n, 상한 10분 | `dead_letter` + admin 재실행 |
| `merge.simulate` | worker | 40 | 3 | 동일 | merge 상태 `not_run` |
| `chat.turn` | server (동기) | - | 0 | - | 사용자 재시도 |

`jobs`에 `dead_letter` 상태와 `last_error_code`를 추가하고, admin API로 조회·재실행한다.

```
| REQ-DATA-011 | 필수 | job type별 executor, priority, 재시도 상한, backoff와 dead-letter 처리를 정의한다. |
```

### FIX-M-19. lease 시간 기준

`functional-design.md:125`에 추가한다.

```
lease와 heartbeat 시각은 모두 DB `now()`로 계산한다. claim, renew, 만료 판정은 단일 UPDATE 문에서 수행하며
worker의 local clock을 사용하지 않는다. 기본값은 heartbeat 30초, lease 90초로 시작한다.
```

```
| REQ-DATA-012 | 필수 | lease와 heartbeat는 DB clock을 기준으로 하며 worker clock skew가 중복 실행을 만들지 않는다. |
```

검증: resilience test에서 worker clock을 앞뒤로 5분 조작하고 중복 claim이 없는지 확인한다.

---

## 4. Low finding 일괄 수정

| ID | 대상 | 제안 |
|---|---|---|
| L-01 | `blueprint.md:493` | "browser pod" → "server pod만 artifact를 read-only로 mount하고 browser는 API로만 접근한다" |
| L-02 | `blueprint.md:212`, `:218` | `github_host` → `github_instance_id`, `analysis_profile` → `profile_version`로 통일 |
| L-03 | `ui-implementation-design.md:21` | route를 `/analyses/:analysisId`로 바꾸거나, `/reviews`를 유지하고 "UI route와 API path는 다르다"를 명시 |
| L-04 | `requirements-specification.md:198` | worker probe를 exec 방식으로 명시 (FIX-H-06 표에 포함) |
| L-05 | `ui-implementation-design.md:79-83` | key를 `gcr:workspace-layout:v1:<user-id>`로 축소하고 repository override는 최근 10개만 유지 |
| L-06 | `functional-design.md` §11 | ingress values에 SSE 주석 추가: `proxy-buffering: off`, `proxy-read-timeout: 3600`, HTTP/2 권장 |
| L-07 | values | `imagePullSecrets`, `database.pool.max`(기본 10) 추가. 총 연결 = (server replica + worker replica) × pool + LISTEN 연결 |
| L-08 | `blueprint.md:7` | "skip directive"를 삭제하거나 후속 요구사항으로 등록 |
| L-09 | `functional-design.md` §11.4 | migration Job을 Helm `pre-install`/`pre-upgrade` hook으로 두고 advisory lock으로 동시 실행을 막는다고 명시 |
| L-10 | `requirements-specification.md:87` | draft PR 기본 정책(분석함/안 함)과 사용자 override 가능 여부 명시 |

---

## 5. 이번 제안 과정에서 새로 발견한 항목

### N-01. Deployment로는 worker별 RWO PVC를 만들 수 없다

- 근거: `blueprint.md:473-477`(`workspace.mode: pvc`), `functional-design.md:386`, `:363-379`(worker는 Deployment)
- 문제: Deployment는 `volumeClaimTemplates`를 지원하지 않는다. 모든 replica가 같은 PVC를 mount하려 하고, RWO는 단일 노드 바인딩이므로 replica 2개 이상에서 스케줄이 실패하거나 한 노드에 강제로 묶인다.
- 제안: `workspace.mode=pvc`일 때 generic ephemeral volume을 사용한다. pod마다 PVC가 자동 생성되고 pod 삭제 시 함께 삭제되므로 Deployment를 유지할 수 있다.

```yaml
volumes:
  - name: workspace
    ephemeral:
      volumeClaimTemplate:
        spec:
          accessModes: [ReadWriteOnce]
          storageClassName: fast-rwo
          resources:
            requests:
              storage: 20Gi
```

  forensic 보존이 필요한 경우에만 worker를 StatefulSet으로 전환하는 별도 모드를 둔다.

```
| REQ-OPS-019 | 조건부 | workspace PVC 모드는 pod별 volume을 보장하는 방식으로 배포한다. |
```

### N-02. `chatDays`가 `reportDays`를 넘는 구성을 막을 장치가 없다

Chat은 report evidence에 고정되므로 report보다 오래 남으면 citation이 깨진 대화가 남는다. FIX-M-04의 values schema 제약으로 함께 해결한다.

---

## 6. 신규 요구사항 초안 (붙여넣기용)

```
| REQ-GH-012   | 필수   | poll은 open PR의 base branch tip을 관측하고 snapshot에 기록한다. |
| REQ-GH-013   | 필수   | poll은 shard 단위로 분산되며 server replica 수에 따라 처리량이 늘어난다. |
| REQ-GH-014   | 필수   | fork PR의 head는 base repository의 pull ref로만 fetch한다. |
| REQ-SNAP-012 | 필수   | snapshot은 merge_base_resolution 상태를 가지며 단조 전이만 허용한다. |
| REQ-SNAP-013 | 필수   | 확정된 merge-base와 다른 값이 계산되면 반영하지 않고 run을 실패 처리한다. |
| REQ-SNAP-014 | 필수   | merge simulation은 base ref tip에 귀속된 별도 artifact다. |
| REQ-AN-013   | 필수   | 분석과 Chat의 자원 상한을 정의하고 초과를 partial로 처리한다. |
| REQ-UI-015   | 필수   | merge 상태를 report 상태와 별도로 표시한다. |
| REQ-UI-016   | 필수   | 폭이 부족하면 split diff를 unified로 자동 전환한다. |
| REQ-UI-017   | 필수   | run state와 UI badge mapping을 고정하고 stale을 파생 값으로 표시한다. |
| REQ-CHAT-008 | 필수   | 사용자별 chat 동시성, 분당 메시지, tool turn, timeout 상한을 강제한다. |
| REQ-DATA-008 | 필수   | 비동기 요청은 operation resource로 조회하며 중복 요청은 같은 operation을 반환한다. |
| REQ-DATA-009 | 필수   | PR 범위 event stream이 poll/snapshot/analysis/merge 변화를 전달한다. |
| REQ-DATA-010 | 필수   | event는 durable log에 append되고 broker 없이 replica 간 전달과 재생이 동작한다. |
| REQ-DATA-011 | 필수   | job type별 executor, 재시도 상한, backoff, dead-letter를 정의한다. |
| REQ-DATA-012 | 필수   | lease와 heartbeat는 DB clock을 기준으로 한다. |
| REQ-DATA-013 | 필수   | artifact는 staging 후 atomic commit하며 commit된 object를 재작성하지 않는다. |
| REQ-SEC-009  | 필수   | model credential과 egress는 실제 호출하는 workload에만 부여한다. |
| REQ-SEC-010  | 필수   | CSP와 보안 header를 적용하고 외부 리소스 로드를 차단한다. |
| REQ-SEC-011  | 필수   | proxy identity는 서명 검증과 네트워크 제한이 함께 있을 때만 신뢰한다. |
| REQ-SEC-012  | 필수   | 감사 event catalogue를 정의하고 원문 없이 metadata만 기록한다. |
| REQ-OPS-016  | 필수   | 의존성 장애는 별도 health endpoint와 degraded 표시로 노출한다. |
| REQ-OPS-017  | 필수   | retention과 artifact orphan 정리를 실행하는 workload를 chart가 제공한다. |
| REQ-OPS-018  | 필수   | artifact backend를 값으로 선택하며 두 backend가 같은 contract를 만족한다. |
| REQ-OPS-019  | 조건부 | workspace PVC 모드는 pod별 volume을 보장하는 방식으로 배포한다. |
| REQ-OPS-020  | 필수   | backup 순서와 복구 후 reconcile 절차를 정의한다. |
```

---

## 7. 신규 검수 시나리오 초안

```
| AC-13 | manual refresh | operation ID를 받고 poll 시작·snapshot 동일·새 snapshot 발견이 순서대로 표시된다. |
| AC-14 | base branch 전진 | canonical diff는 그대로이고 merge 상태만 stale 후 재계산된다. |
| AC-15 | DB 일시 장애 | 서비스가 503로 사라지지 않고 degraded 화면과 마지막 성공 시각을 유지한다. |
| AC-16 | server replica 2개 | 어느 replica에 연결해도 진행 event를 수신한다. |
| AC-17 | 재시도 상한 초과 | job이 dead-letter로 이동하고 관리자가 원인 확인 후 재실행한다. |
| AC-18 | retention 만료 | report/chat/source가 DB와 storage에서 함께 삭제된다. |
| AC-19 | 보안 header | 응답에 CSP가 적용되고 외부 이미지·script가 차단된다. |
| AC-20 | 복구 후 reconcile | 누락 artifact를 가진 report가 unavailable로 표시된다. |
```

---

## 8. 문서별 적용 체크리스트

### `requirements-specification.md`

- [ ] `:26` snapshot 용어 교체 (FIX-H-03)
- [ ] `:87` draft 정책 명시 (L-10)
- [ ] `:120-121` priority 의미와 category enum 추가 (FIX-M-02)
- [ ] `:164` state → badge mapping 추가 (FIX-M-01)
- [ ] `:176` REQ-SEC-003 component별 egress로 교체 (FIX-H-05)
- [ ] `:198` REQ-OPS-012 probe 계층으로 교체 (FIX-H-06)
- [ ] `:207` REQ-NFR-001 tier 기반으로 교체 (FIX-H-07)
- [ ] `:230` AC-11 reconcile 포함으로 교체 (FIX-M-17)
- [ ] 신규 REQ 26건, AC 8건 추가 (§6, §7)
- [ ] 추적표 추가 (FIX-M-13)

### `functional-design.md`

- [ ] `:82` analysis key에 merge_base_resolution 추가
- [ ] `:87` merge-base 정정 문단 교체 (FIX-H-03)
- [ ] `:104-125` job executor 표, lease clock 규칙 추가 (FIX-M-18, FIX-M-19)
- [ ] `:147-153` refresh 응답과 operation 정의 (FIX-H-01)
- [ ] `:222-243` API 목록 교체 (FIX-H-08)
- [ ] `:263-279` SSE contract 교체와 fan-out 절 추가 (FIX-H-01, FIX-H-02)
- [ ] `:281-302` artifact 경로 분리와 staging/commit 규칙 (FIX-H-08, FIX-M-05)
- [ ] `:322-328` 보안 header, identity 신뢰 조건 추가 (FIX-M-14, FIX-M-16)
- [ ] `:359-388` retention CronJob, storage backend, workspace volume 방식 (FIX-M-04, FIX-M-06, N-01)
- [ ] `:390-398` migration hook과 lock 명시 (L-09)

### `blueprint.md`

- [ ] `:7` skip directive 문구 정리 (L-08)
- [ ] `:120-153` architecture에 Server → Model 경로 추가 (FIX-H-05)
- [ ] `:207-218` key 표기 통일 (L-02)
- [ ] `:363-379` API 목록 삭제하고 기능 설계 참조 (§1.1)
- [ ] `:437-487` values 요약으로 축약 (§1.1)
- [ ] `:493` browser pod 문구 수정 (L-01)
- [ ] `:517-573` Phase와 결정 목록을 매핑/참조로 축약 (FIX-M-11, §1.1)

### `ui-implementation-design.md`

- [ ] `:21` route 명명 정리 (L-03)
- [ ] `:67-73` layout 표를 visual 기준으로 교체 (FIX-M-09)
- [ ] `:79-83` preference key 축소 (L-05)
- [ ] `:87-94` breakpoint를 1279/1020/720으로 교체 (FIX-M-09)
- [ ] `:98-109` Header 2행 구조와 merge 상태 표시 (FIX-M-09, FIX-H-04)
- [ ] `:145-165` split 자동 전환과 merge-base 표기 (FIX-M-08, FIX-M-10)
- [ ] `:196-206` selection side 값 변경 (FIX-M-10)
- [ ] `:218-231` degraded 상태 행 추가 (FIX-H-06)

### `implementation-plan.md`

- [ ] M0-00 spike 추가 (FIX-M-11)
- [ ] M1-09, M2-10, M4-10, M5-10 추가 (FIX-M-13)
- [ ] M2-08 완료 조건에 replica 2개 event 수신 추가 (FIX-H-02)
- [ ] M2-07에 object backend contract test 추가 (FIX-M-06)
- [ ] M5-03에 reconcile job 추가 (FIX-M-17)
- [ ] `:264-277` 결정 목록을 DEC 참조로 축약 (§1.1)

### `PRODUCT.md`, `README.md`, `handoff.md`

- [ ] 역할 이름 통일 (FIX-M-12)
- [ ] command 목록 4개로 통일 (FIX-M-04)
- [ ] handoff `:87-97` DEC 목록에 신규 DEC 5건 반영 (§11)

### `visuals/git-code-reviewer.drawio`

- [ ] page 1에 Server → Model endpoint edge 추가 (FIX-H-05)
- [ ] page 2에 retention CronJob과 object storage 대안 표기 보강 (FIX-M-04, FIX-M-06)

`visuals/review-workspace.html`과 preview PNG는 사용자 소유 자산이므로 수정 대상에서 제외한다.

---

## 9. milestone 재배치 제안

| 시점 | 적용할 제안 | 이유 |
|---|---|---|
| M0-00 (신규) | FIX-M-11의 spike 항목 | H-04와 H-07의 근거 확보 |
| M0 | FIX-M-09, FIX-M-04(command), L 전체 | shell을 만들기 전에 layout과 command를 고정 |
| M1 | FIX-M-16, FIX-M-12(기록), FIX-H-07(shard, tier) | 인증과 scheduler가 여기서 만들어진다 |
| M2 | FIX-H-03, FIX-H-01, FIX-H-08, FIX-M-05, FIX-M-18, FIX-M-19, FIX-M-06 | contract와 저장 규칙이 굳는 시점 |
| M3 | FIX-M-02, FIX-M-07 | finding schema와 자원 상한 |
| M4 | FIX-H-02, FIX-H-05, FIX-M-08, FIX-M-10, FIX-M-14 | workspace와 Chat 완성 |
| M5 | FIX-H-06, FIX-M-03, FIX-M-17, FIX-M-12(조회), N-01 | 운영과 복구 |

---

## 10. 제안이 만드는 추가 작업량 (개략)

| 영역 | 추가 작업 | 규모 감각 |
|---|---|---|
| contract | endpoint 12개, event 5종, artifact 5종 | M2 범위 확대 |
| event fan-out | event_log table, LISTEN/NOTIFY, 재생 | 신규 component 1개 |
| merge simulation 재계산 | job type 1개, artifact 1개, UI 표시 | 소규모 |
| retention/orphan | command 1개, CronJob 1개, reconcile job 1개 | 소규모 |
| admin/audit | endpoint 8개, 화면 2개, event 기록 | M5로 분산 가능 |
| 보안 강화 | header, sanitize, identity 조건, negative test | M4 집중 |

전체적으로 M2와 M4가 가장 많이 늘어난다. 대신 M2에서 contract를 굳히면 M3-M5의 재작업이 줄어든다.

---

## 11. 확인이 필요한 값과 결정

아래는 제안으로 대체할 수 없고 조직이 정해야 하는 항목이다. 기존 `DEC-001`~`DEC-011`에 더해 5건을 추가로 제안한다.

```
| DEC-012 | 대상 GHES의 rate limit 활성 여부, 시간당 한도, conditional request 취급 |
| DEC-013 | fork PR을 MVP 지원 범위에 포함할지 |
| DEC-014 | priority 방향(P3=치명) 유지 여부와 category enum 확정 |
| DEC-015 | §3 FIX-M-07의 자원 상한 초기값 승인 |
| DEC-016 | 감사 조회 주체와 audit event 보존 기간 |
```

이 제안서에서 값을 넣었지만 확정이 아닌 항목:

| 항목 | 제안값 | 확정 주체 |
|---|---:|---|
| poll tier 주기 | 60초 / 5분 / 15분 | 운영 + GHES 규모(DEC-004) |
| `github.requestBudgetPerHour` | 3,000 | DEC-012 |
| `scheduler.shardCount` | 4 | 운영 |
| `worker.concurrency` | 2 | DEC-015 |
| analysis timeout | 15분 | DEC-015 |
| chat tool turn / timeout | 8회 / 180초 | DEC-015 |
| heartbeat / lease | 30초 / 90초 | 운영 |
| event_log 재생 창 | 1시간 | 운영 |
| report / chat retention | 90일 / 30일 | DEC-009 |
| DB RPO / artifact RPO | 15분 / 24시간 | DEC-006 |

값이 확정되지 않은 동안에는 typed config와 validation error로 남기고 조직 정책처럼 하드코딩하지 않는다는 기존 원칙(`handoff.md:99`)을 그대로 유지한다.

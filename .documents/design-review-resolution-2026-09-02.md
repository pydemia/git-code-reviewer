# Git Code Reviewer - 설계 검토 처리 결정

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-09-02 |
| 입력 | `design-review-2026-09-02.md`, `design-review-remediation-2026-09-02.md` |
| 상태 | 기준 문서 반영 결정 |
| 원칙 | Review 원문은 수정하지 않고 이 문서에서 disposition을 관리한다. |

## 1. Contract 정본

| Contract | 정본 문서 | 다른 문서 |
|---|---|---|
| 요구사항 ID, AC, DEC | `requirements-specification.md` | ID를 참조하고 목록을 복제하지 않는다. |
| API, SSE, data와 artifact schema | `functional-design.md` | Blueprint는 개념만 설명한다. |
| Helm resource와 values | `functional-design.md` | Blueprint는 배포 원칙만 설명한다. |
| Browser route, layout과 selection | `ui-implementation-design.md` | Visual은 시각 기준으로 유지한다. |
| Milestone과 task | `implementation-plan.md` | Blueprint는 milestone mapping만 제공한다. |

## 2. Finding disposition

| Finding | 결정 | 반영 요약 |
|---|---|---|
| H-01 | ACCEPT | Refresh operation resource와 PR 범위 event stream을 추가한다. |
| H-02 | ACCEPT | PostgreSQL event log와 `LISTEN/NOTIFY`, REST reconcile을 사용한다. |
| H-03 | ACCEPT_WITH_CHANGES | Mutable snapshot 대신 request와 append-only materialization을 분리한다. |
| H-04 | ACCEPT_WITH_CHANGES | Base tip 변경은 MVP에서 새 snapshot과 전체 재분석을 생성한다. |
| H-05 | ACCEPT | Batch model은 Worker, Chat model은 Server가 호출한다. |
| H-06 | ACCEPT_WITH_CHANGES | Liveness와 dependency health를 분리하되 존재하지 않는 DB read cache는 약속하지 않는다. |
| H-07 | DEFER_PARTIAL | Poll tier/budget은 반영하고 scheduler sharding은 실측 후 활성화한다. |
| H-08 | ACCEPT_WITH_CHANGES | API를 보강하고 artifact를 snapshot/analysis scope로 분리한다. |
| M-01 | ACCEPT | Run state와 UI badge mapping, stale 파생 규칙을 고정한다. |
| M-02 | ACCEPT | P3가 최고 위험임을 명시하고 category enum을 고정한다. |
| M-03 | ACCEPT | Pod-local cleanup과 persistent retention을 분리한다. |
| M-04 | ACCEPT | `retention` command와 Kubernetes CronJob을 추가한다. |
| M-05 | ACCEPT | Attempt staging, checksum과 immutable commit을 명시한다. |
| M-06 | ACCEPT_WITH_CHANGES | Backend contract는 정의하고 object adapter 구현은 DEC-007 결과에 따른다. |
| M-07 | ACCEPT_WITH_CHANGES | 수치는 config로 두고 analysis partial과 Chat limit error를 분리한다. |
| M-08 | ACCEPT | 폭이 부족하면 split diff를 unified로 전환한다. |
| M-09 | ACCEPT | UI 수치와 breakpoint를 visual 기준에 맞춘다. |
| M-10 | ACCEPT | Canonical diff의 왼쪽 side를 `mergeBase`로 명시한다. |
| M-11 | ACCEPT | Feasibility gate를 M0-00으로 편입하고 Blueprint phase를 축약한다. |
| M-12 | ACCEPT_WITH_CHANGES | Audit catalogue는 추가하고 제품 내 조회 UI는 DEC-016으로 둔다. |
| M-13 | ACCEPT_WITH_CHANGES | 누락 task와 requirement-group matrix를 추가하며 전체 ID 목록은 복제하지 않는다. |
| M-14 | ACCEPT_WITH_CHANGES | CSP/security header를 추가하되 HSTS는 ingress/platform 정책으로 둔다. |
| M-15 | DEFER | Fork PR 지원 여부를 DEC-013으로 결정한다. |
| M-16 | ACCEPT | Application OIDC 기본, proxy identity 사용 조건을 명시한다. |
| M-17 | ACCEPT_WITH_CHANGES | DB restore point가 artifact snapshot보다 늦어지지 않도록 순서를 정정한다. |
| M-18 | ACCEPT | Job executor, retry, terminal failure와 operator requeue를 정의한다. |
| M-19 | ACCEPT | Lease와 heartbeat는 DB clock을 사용한다. |
| L-01~04 | ACCEPT | 용어, route 설명과 worker probe를 정리한다. |
| L-05 | ACCEPT | Layout preference를 user 단위 document와 최근 repository override로 제한한다. |
| L-06~10 | ACCEPT_WITH_CHANGES | SSE ingress, pool, migration lock과 draft policy를 운영 contract에 반영한다. |
| N-01 | ACCEPT | Worker persistent scratch는 pod별 generic ephemeral PVC를 사용한다. |
| N-02 | ACCEPT_WITH_CHANGES | Retention 관계는 app validation과 Helm template `fail`로 검증한다. |

## 3. 보정된 핵심 결정

### 3.1 Snapshot

- Poller는 `repository + PR + base SHA + head SHA`의 snapshot request를 upsert한다.
- Worker는 merge-base 계산 결과와 정책을 포함한 append-only snapshot materialization을 만든다.
- Analysis, report와 Chat은 materialization ID를 참조한다.
- `unresolved` 뒤에 `exact`를 얻으면 기존 materialization을 수정하지 않고 새 version을 만든다.
- 같은 입력에서 서로 다른 exact merge-base가 나오면 integrity failure로 처리한다.
- Base tip 변경은 새로운 request/materialization/analysis를 만든다.

### 3.2 Health

- Startup은 config와 schema compatibility를 확인한다.
- Liveness는 process/event-loop failure만 재시작 대상으로 삼는다.
- Server readiness는 HTTP 초기화와 핵심 DB 처리 가능 여부를 반영한다.
- Artifact, GHES와 model 상태는 dependency health와 기능별 degraded 응답으로 표시한다.
- DB 장애 중 새 사용자를 위한 cached application 동작은 MVP가 약속하지 않는다.

### 3.3 Backup

- Artifact는 immutable object를 먼저 commit한 뒤 DB에서 참조한다.
- Backup 중 retention delete를 중지하거나 충분한 deletion grace period를 적용한다.
- DB backup/PITR restore point를 먼저 정하고 그 이후 artifact snapshot을 생성한다.
- 복구할 DB 시점은 artifact snapshot 시점보다 늦을 수 없다.
- 복구 후 reconcile이 missing artifact와 unreferenced artifact를 분류한다.

### 3.4 Configuration

- `chatDays <= reportDays`는 standard JSON Schema의 cross-field 비교에 의존하지 않는다.
- Application startup validation과 Helm template `fail`을 모두 사용한다.
- Analysis budget 초과는 partial/limitation, Chat rate/concurrency 초과는 typed `429` error다.
- Poll, worker, retention과 model 관련 수치는 조직 확인 전 typed config의 초기값일 뿐이다.

## 4. 보류 결정

| ID | 결정 |
|---|---|
| DEC-012 | GHES rate-limit 활성 여부, 실제 한도와 conditional request 처리 |
| DEC-013 | Fork PR을 MVP에 포함할지 여부 |
| DEC-014 | Poll 규모가 scheduler sharding을 요구하는 기준 |
| DEC-015 | Analysis/Chat/workspace resource budget 초기값 |
| DEC-016 | Audit 조회를 제품 UI와 외부 로그 시스템 중 어디에 둘지 |

## 5. 적용 검증

- 기준 문서에 위 disposition과 반대되는 문장이 없어야 한다.
- 요구사항 ID와 acceptance ID는 중복되지 않아야 한다.
- API/event/artifact 이름은 기능 설계에 한 번만 정의한다.
- M0-00에서 GHES token/API/Git, partial clone, merge-base와 rate-limit을 실제 환경에서 확인한다.
- Helm 검증은 generic ephemeral PVC, retention CronJob, migration hook/lock과 두 server replica의 SSE fan-out을 포함한다.

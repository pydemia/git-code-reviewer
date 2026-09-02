# Git Code Reviewer - 기획/설계 교차 검증 보고서

| 항목 | 내용 |
|---|---|
| 작성일 | 2026-09-02 |
| 대상 | `PRODUCT.md`, `README.md`, `.documents/{handoff,blueprint,requirements-specification,functional-design,ui-implementation-design,implementation-plan}.md`, `.documents/visuals/*` |
| 참고 | `/home/pydemia/git/commit-defender/.documents/github-chrome-extension/github-enterprise-pr-analysis-server-design.md` (아이디어 출처, 기준 문서 아님) |
| 성격 | 설계 검토 전용. 이 보고서 작성 외에 어떤 파일도 수정하지 않았다. |
| 전제 | 사용자가 확정한 16개 제품 방향은 검증 기준이며 변경 제안 대상이 아니다. |

line reference는 검토 시점의 파일 내용을 기준으로 한다.

---

## 1. Findings

### 1.1 Critical

없음.

폐기된 전제(CI/CD, webhook 의존, GitHub write-back, VS Code/browser extension, Redis, SaaS tenant)가 실질적으로 되살아난 곳은 없고, read-only permission 범위로 설계된 기능을 수행할 수 없는 항목도 발견되지 않았다. 즉시 중단해야 할 보안 결함도 없다.

### 1.2 High

#### H-01. Manual refresh의 operation과 poll 단계 event가 contract에 없다

- 위치: `.documents/functional-design.md:147-153`, `:222-243`, `:263-279` / `.documents/ui-implementation-design.md:107` / `.documents/implementation-plan.md:129` / `.documents/requirements-specification.md:88-89`(REQ-GH-007/008), `:167`(REQ-DATA-006), `:208`(REQ-NFR-002), `:222`(AC-03)
- 문제: 기능 설계 5.3은 "진행 중이면 기존 operation ID를 반환", "202 Accepted와 상태 URL", "SSE는 `poll.started`, `snapshot.detected`, `analysis.*`를 전달"을 약속한다. 그러나 7.1 API 목록에 operation resource가 없고, 7.3 SSE contract에는 `analysis.state`, `analysis.available`, `chat.delta`, `chat.completed`만 정의돼 있다. 새 snapshot이 감지되기 전에는 `analysisId`가 존재하지 않아 `/analyses/{analysisId}/events`를 구독할 수도 없다.
- 영향: UI 설계 §5의 refresh 단계 표시(poll 시작 → snapshot 동일 → 새 snapshot 발견 → run 진행)와 REQ-NFR-002의 "10초 이내 조회 시작 또는 지연 사유 표시"를 구현할 수 없다. AC-03의 동시 refresh dedupe 응답 형태도 정의되지 않아 M2-03이 문서에 없는 URL을 만들게 된다.
- 권장: PR 범위 event stream(`GET /api/v1/repositories/{repoId}/pulls/{number}/events`)과 operation 조회(`GET /api/v1/operations/{operationId}`)를 API contract에 추가하고, `poll.*`, `snapshot.*` event를 SSE contract에 명시한다. refresh 응답 body에 `operationId`, `deduplicated`, `expectedStartWithinSeconds`를 포함한다.

#### H-02. multi-replica server의 SSE fan-out 경로가 정의되지 않았다

- 위치: `.documents/functional-design.md:41-61`(server 2+ replicas, advisory lock은 scheduler에만 적용), `:263-279` / `.documents/requirements-specification.md:167`(REQ-DATA-006), `:190`(REQ-OPS-004), `:200`(REQ-OPS-014) / `.documents/handoff.md:24`(별도 message broker 없음) / `.documents/ui-implementation-design.md:227`
- 문제: 상태 전이는 worker와 leader scheduler가 PostgreSQL에 기록하고, SSE 연결은 Service가 임의로 배정한 replica에 붙는다. broker를 두지 않기로 확정한 상태에서 replica 간 event 전달 방식(PostgreSQL `LISTEN/NOTIFY`, 짧은 DB polling, sticky session 중 무엇인지)이 어느 문서에도 없다.
- 영향: server replica 2개 구성에서 상당수 client가 진행 event를 받지 못하고 REST 재조회에만 의존한다. AC-05의 원자적 동기화 체감과 AC-10의 rolling update 중 연속성 검증이 흔들린다. 구현 단계에서 "broker 도입" 요구로 되돌아갈 위험이 있다.
- 권장: `LISTEN/NOTIFY` 기반 fan-out + 재연결 시 REST reconcile을 contract로 확정하고 REQ-DATA-006에 추가한다. M2-08과 M4-07 완료 조건에 "server replica 2개에서 어느 replica에 붙어도 event를 수신한다"를 넣는다. notification payload에는 ID와 state만 넣어 REQ-SEC-007을 유지한다.

#### H-03. snapshot identity 정의와 unique key, 정정 절차가 서로 모순된다

- 위치: `.documents/requirements-specification.md:26`(용어: base + merge-base + head), `:98`(REQ-SNAP-001) / `.documents/blueprint.md:207-213`(snapshot key에 merge-base 없음) / `.documents/functional-design.md:78-87`, `:207`(snapshots unique 제약)
- 문제: 요구사항은 merge-base SHA를 snapshot identity에 포함한다고 정의하지만, key와 DB unique 제약은 `pr_id/base_sha/head_sha`다. 그런데 기능 설계 §3은 "같은 base/head라도 merge-base 계산 결과가 달라졌다면 기존 snapshot을 조용히 수정하지 않고 새 snapshot 또는 corrected revision을 만든다"고 규정한다. 현재 unique 제약에서는 새 snapshot 생성이 불가능하다.
- 영향: shallow clone에서 잘못 확정한 merge-base를 정정할 경로가 없다. 구현자는 결국 immutable snapshot row를 in-place update하게 되고, 이는 REQ-DATA-007(retention 만료 전까지 immutable)과 이미 저장된 report/Chat citation의 의미를 조용히 바꾼다.
- 권장: 두 선택지 중 하나로 확정한다. (a) `merge_base_sha`를 snapshot key와 unique 제약에 포함한다. (b) merge-base를 snapshot 속성으로 유지하되 `merge_base_resolution`(`exact | deepened | unresolved`)을 필수 필드로 두고, 정정은 append-only `snapshot_revision`으로만 허용한다. 어느 쪽이든 정정 시 기존 analysis run/report/Chat session을 어떻게 표시할지(예: `superseded_by_correction`) 함께 정의한다.

#### H-04. base branch 이동 감지와 merge simulation 신선도가 설계에 없다

- 위치: `.documents/blueprint.md:195-206`(poll state와 판정 기준), `:223-253`(integration view) / `.documents/requirements-specification.md:85`(REQ-GH-004), `:100`(REQ-SNAP-003) / `.documents/functional-design.md:137-146`
- 문제: base SHA를 어디서 얻는지 명시가 없다. PR metadata의 base SHA는 base branch가 전진해도 갱신되지 않을 수 있고, 그때 PR의 `updated_at`도 변하지 않는다. canonical diff(`merge-base...head`)는 base 전진에 대체로 영향받지 않지만, integration view와 merge simulation, 통합 위험 판단은 달라진다. 참고 자료는 이 문제를 `push` webhook 또는 reconciliation job으로 명시적으로 다뤘다(참고 문서 §3.1).
- 영향: "exact snapshot" 보증이 merge simulation에는 성립하지 않는다. reviewer는 base가 이미 이동한 뒤에도 과거 conflict 판정을 현재 상태처럼 읽는다. stale 표시는 head 기준이므로 이 상황을 표현하지 못한다.
- 권장: base SHA의 출처를 "poll 시점 base ref tip 재조회"로 고정하고 REQ-GH-004에 명시한다. snapshot에 `base_ref_observed_at`을 두고, base 이동 시 전체 재분석 대신 merge simulation만 재계산하는 경량 run 또는 `mergeSimulationStale` 상태를 정의한다. base ref 확인 비용은 H-07의 poll 예산에 포함한다.

#### H-05. Chat model 호출 주체가 문서마다 다르고 egress/secret 경계가 비대칭이다

- 위치: `.documents/functional-design.md:66-74`(API server 책임에 Chat orchestration), `:185-191` / `.documents/blueprint.md:120-153`(Model endpoint가 Worker 아래에만 연결), `:483`(`secrets.modelProvider`의 대상 workload 미지정) / `.documents/visuals/git-code-reviewer.drawio:27`(worker→model edge만 존재) / `.documents/requirements-specification.md:176`(REQ-SEC-003은 worker egress만 제한)
- 문제: Chat은 server가 orchestration하는데 기준 architecture와 drawio는 model 연결을 worker에만 그렸다. REQ-SEC-003도 worker egress만 제한하고 server의 model egress는 요구사항에 없다. model credential을 어느 Deployment에 mount하는지도 values contract에 없다.
- 영향: NetworkPolicy와 Secret mount 대상이 미정이라 Chat이 배포 시점에 차단되거나, 반대로 server에 필요 이상의 egress를 열게 된다. server가 직접 호출한다면 장시간 model 응답이 REQ-NFR-004(metadata API p95 500ms)를 담당하는 replica set과 자원을 공유하는 문제도 함께 결정해야 한다.
- 권장: Chat 추론 주체를 확정한다(server 내 orchestration, 또는 chat job을 worker에 위임). 결정에 맞춰 drawio page 1의 edge, REQ-SEC-003, `secrets.modelProvider` mount 대상, NetworkPolicy egress 대상을 동시에 수정한다. server가 호출하는 쪽을 택하면 model 호출 전용 concurrency 제한을 요구사항에 추가한다.

#### H-06. readiness를 외부 의존성에 묶어 부분 장애가 전체 중단이 된다

- 위치: `.documents/requirements-specification.md:198`(REQ-OPS-012), `:214`(REQ-NFR-008) / `.documents/blueprint.md:500` / `.documents/functional-design.md:342-343`
- 문제: readiness가 DB와 artifact storage 연결을 반영하면 PostgreSQL failover나 artifact store 일시 장애 때 모든 server replica가 동시에 unready가 되고 Ingress는 endpoint를 잃는다. 사용자에게는 정적 UI, 오류 안내, REQ-GH-009의 "마지막 성공 시각" 표시까지 함께 사라진다. 이는 REQ-NFR-008과 정면으로 충돌한다.
- 영향: 30초짜리 DB failover가 사용자 관점의 완전 outage로 확대된다. 장애 중 상태 확인 수단이 없어 운영 대응도 어려워진다.
- 권장: schema/storage 확인은 startup probe로 옮기고, readiness는 process가 요청을 처리할 수 있는지로 한정한다. 의존성 상태는 `/healthz/dependencies`와 UI degraded banner로 노출하고, 장애 시 write API와 refresh만 거부한다. REQ-OPS-012 문장을 이 구분에 맞게 수정한다.

#### H-07. poll 예산과 단일 leader 실행이 REQ-NFR-001과 상충할 수 있다

- 위치: `.documents/requirements-specification.md:86-87`(REQ-GH-005/006), `:207`(REQ-NFR-001), `:240`(DEC-004) / `.documents/blueprint.md:205`, `:396` / `.documents/functional-design.md:102`, `:139`
- 문제: active PR 60초 재조회를 advisory lock을 얻은 단일 server replica가 수행한다. repository 당 open PR 목록 조회만 계산해도 시간당 60 요청이고, repository 100개면 6,000 요청이다. GitHub App installation의 통상 시간당 한도(5,000)를 이미 넘고, 여기에 PR 상세와 H-04의 base ref 확인이 더해진다. 단일 leader는 수평 확장 경로도 없다.

| 구성 | 시간당 요청(목록만) |
|---|---:|
| repository 20개, 60초 주기 | 1,200 |
| repository 100개, 60초 주기 | 6,000 |
| repository 100개, active 20 + idle 80(5분) | 2,160 |

- 영향: 규모가 커지면 REQ-NFR-001을 만족하지 못하거나 rate-limit backoff가 상시화된다. 지연 원인이 설계상 필연인데 요구사항은 필수로 남아 검수 단계에서 충돌한다.
- 권장: repository shard 단위 advisory lock으로 poll을 병렬화하고, 요구사항에 poll 예산 모델(설치당 시간당 요청, PR당 비용)을 추가한다. 60초는 전체가 아니라 "최근 활동 상위 N개 PR" tier의 목표로 재정의한다. 대상 GHES의 rate limit 활성 여부를 DEC-001 또는 DEC-004에 포함한다.

#### H-08. 요구된 FNB/Chat/관리 기능을 뒷받침하는 API와 artifact가 contract에 없다

- 위치: `.documents/requirements-specification.md:137`(REQ-UI-007), `:152-153`(REQ-CHAT-003/004), `:181`(REQ-SEC-008) / `.documents/functional-design.md:222-243`(API), `:281-302`(artifact) / `.documents/blueprint.md:363-379` / `.documents/ui-implementation-design.md:103`, `:178-191`
- 문제: API 목록은 files/diff/symbols/history/impact까지만 있다. 요구사항과 UI가 필수로 규정한 다음 데이터에 접근 경로가 없다.

| 필요한 것 | 근거 | 현재 contract |
|---|---|---|
| commit 목록·Git graph | REQ-UI-007, UI `:183-191` | 없음 |
| ownership/blame | REQ-UI-007 | 없음 |
| related test | REQ-UI-007 | 없음 |
| merge simulation 결과 | REQ-SNAP-003, M2-06 | artifact·API 모두 없음 |
| file content(citation 대상) | REQ-CHAT-003, UI `:172` | `/files` 목록만 |
| analysis revision 목록 | UI `:103` revision selector | 없음 |
| coverage/limitation | REQ-AN-009 | report 내부로만 암시 |
| operation 상태 | 기능 설계 `:150-152` | 없음(H-01) |
| admin(등록·retention·cancel) | REQ-AUTH-004, REQ-SEC-008, UI `:23` | 없음 |

- 영향: M4-03, M4-06, M4-08이 정의되지 않은 endpoint 위에 서고, artifact contract에 ownership/tests/merge-simulation 형식이 없어 M2/M3 산출물이 UI 요구와 어긋난 채로 굳는다.
- 권장: contracts package에 endpoint와 artifact type을 함께 추가한다. 최소한 `snapshots/{id}/commits`, `snapshots/{id}/ownership`, `snapshots/{id}/tests`, `snapshots/{id}/merge-simulation`, `snapshots/{id}/files/{fileId}/content`, `analyses/{id}/coverage`, `repositories/{repoId}/pulls/{number}/analyses`, `operations/{id}`, `admin/repositories`, `admin/retention`을 정의한다.

### 1.3 Medium

#### M-01. run state 어휘가 요구사항·UI·SSE에서 서로 다르고 mapping이 없다

- 위치: `.documents/requirements-specification.md:164`(REQ-DATA-003의 9개 상태) / `.documents/ui-implementation-design.md:103`(queued/running/completed/partial/failed/stale), `:218-231` / `.documents/functional-design.md:104-121`, `:266-267`
- 문제: UI badge는 `queued`, `running`, `stale`을 쓰는데 이 셋은 REQ-DATA-003의 상태가 아니다(`stale`은 head 비교로 파생되는 성질이다). 반대로 `superseded`, `cancelled`의 UI 표현은 정의되지 않았다. SSE `analysis.state`가 `state`와 `stage`를 함께 보내지만 어느 쪽이 badge인지도 불명확하다.
- 영향: worklist 필터와 badge 구현이 임의 매핑에 의존하고, superseded run을 사용자가 실패로 오해할 수 있다.
- 권장: 요구사항에 run state → UI badge mapping table과 `stale` 계산식(`report.head_sha != pr.head_sha`)을 명시하고, SSE `state`는 REQ-DATA-003 어휘만 사용하도록 고정한다.

#### M-02. priority 의미와 finding category enum이 정의되지 않았다

- 위치: `.documents/blueprint.md:287-296`(P3=치명, P0=좋은 변경) / `.documents/requirements-specification.md:120-121`(REQ-AN-007의 "최고 priority", REQ-AN-008의 `P0..P3`) / `.documents/implementation-plan.md:168` / `.documents/visuals/review-workspace.html:686`(category `maintenance`)
- 문제: 요구사항은 `P0..P3`만 규정하고 의미를 정의하지 않는다. blueprint의 정의는 일반 관례(P0=최우선)와 반대이므로, 요구사항만 읽는 구현자는 REQ-AN-007의 "최고 priority"를 P0으로 해석할 수 있다. 또한 REQ-AN-004의 관점은 correctness/security/compatibility/testing 네 개인데 visual에는 `maintenance` category가 있다.
- 영향: verifier의 "직접 evidence 없는 최고 priority 금지" 규칙이 반대 등급에 적용될 수 있다. category enum이 없으면 filter/정렬/집계 contract가 흔들린다.
- 권장: 요구사항에 P0-P3 의미를 표로 고정하고, UI에는 등급 문자와 함께 사람이 읽는 severity 단어를 병기해 반대 관례로 인한 오독을 막는다. finding category enum을 확정하고 visual의 `maintenance`를 포함할지 결정한다.

#### M-03. workspace sweeper가 emptyDir 기본 구성에서 성립하지 않는다

- 위치: `.documents/requirements-specification.md:106`(REQ-SNAP-009), `:212`(REQ-NFR-006), `:227`(AC-08) / `.documents/functional-design.md:193-195`, `:386` / `.documents/blueprint.md:250`
- 문제: 기본 workspace는 pod-local emptyDir이다. 다른 pod나 CronJob은 그 디렉터리를 볼 수 없고, pod가 사라지면 내용도 함께 사라진다. 반대로 artifact PVC의 미완료 산출물과 RWO workspace는 cross-pod 정리가 필요하다. 두 성질이 하나의 "orphan sweeper"로 뭉쳐 있다.
- 영향: AC-08과 REQ-NFR-006을 어떤 구성에서 무엇으로 검증하는지 정의되지 않아 검수가 모호해진다. artifact orphan은 아무도 정리하지 않을 수 있다.
- 권장: (a) worker in-process sweeper(기동 시 + 주기, 자기 pod의 workspace만), (b) artifact orphan/retention job(cross-pod, PVC 또는 object storage 대상)을 분리해 정의하고 각각 요구사항과 milestone task에 연결한다.

#### M-04. image command 목록이 문서마다 다르고 주기 작업 실행 resource가 없다

- 위치: `.documents/requirements-specification.md:187`(REQ-OPS-001, 3개 command) / `.documents/functional-design.md:348-355`(4개 command), `:359-379`(chart templates에 CronJob 없음), `:195`(retention job 언급) / `.documents/blueprint.md:425-427`(3개)
- 문제: `sweep-workspaces`가 기능 설계에만 존재하고 요구사항·PRODUCT·handoff에는 없다. retention job은 문장으로만 있고 command도 Kubernetes resource도 없다. chart template 목록에 CronJob이 없다.
- 영향: REQ-SEC-008(retention 설정)과 REQ-DATA-007(만료 전 immutable)을 실행할 주체가 배포 산출물에 존재하지 않는다.
- 권장: command 목록을 한 곳에서 확정하고(`serve|worker|migrate|sweep|retention` 등), chart에 CronJob template과 values(`schedule`, `enabled`, `batchSize`)를 추가한 뒤 REQ-OPS-004/005에 반영한다.

#### M-05. 재시도 시 artifact 쓰기 semantics가 immutability와 unique 제약과 충돌한다

- 위치: `.documents/functional-design.md:121-125`(재시도는 새 `job_attempt`, stage checksum 재사용), `:210`(artifacts run/type/version unique), `:281-302`(atomic write) / `.documents/requirements-specification.md:168`(REQ-DATA-007)
- 문제: 같은 analysis run의 두 번째 attempt가 동일 `artifact_key`를 다시 쓸 때 덮어쓰기가 허용되는지, attempt별로 분리되는지 정의가 없다. lease 만료로 인계된 worker가 이전 attempt의 부분 산출물을 만나는 경우의 판정 규칙도 없다.
- 영향: 중복 key 충돌로 재시도가 실패하거나, 반대로 immutable이라고 선언한 object를 조용히 덮어쓴다. AC-11의 checksum 일치 검증이 불안정해진다.
- 권장: attempt별 temporary prefix에 쓰고 stage 완료 시 canonical key로 atomic commit하는 절차를 명시한다. `artifacts`에 `attempt` 또는 `producer_attempt`를 두고, publish 이후 object는 불변으로 고정한다.

#### M-06. object storage 전환 경계가 values contract에 없다

- 위치: `.documents/functional-design.md:385`(`storage.backend=object`) / `.documents/blueprint.md:465-477`(values에 backend/S3 항목 없음) / `.documents/requirements-specification.md:192`(REQ-OPS-006), `:195`(REQ-OPS-009), `:176`(REQ-SEC-003)
- 문제: `storage.backend`는 기능 설계에만 등장하고 values contract에 존재하지 않는다. endpoint, bucket, prefix, region, credential Secret, 서버 측 암호화, egress 허용 대상이 모두 미정이다. object 모드에서 server가 artifact를 읽는 경로(PVC mount 대신 직접 read)도 명시되지 않았다.
- 영향: RWX 미지원 cluster에서 "선택하면 된다"고 적혀 있으나 실제로 선택할 수 있는 설정이 없다. DEC-007 결정이 늦어지면 M2-07 구현이 한쪽 backend에 고착된다.
- 권장: values와 `values.schema.json`에 `storage.backend`와 object 설정 블록을 정의하고, port 두 개(filesystem/object)를 M2-07에서 함께 만든다. NetworkPolicy egress에 object endpoint를 포함하도록 REQ-SEC-003을 보완한다.

#### M-07. worker 동시 실행 수와 분석 자원 상한이 정의되지 않았다

- 위치: `.documents/functional-design.md:386`(emptyDir size limit), `:159`(M3-04 planner) / `.documents/requirements-specification.md:193`(REQ-OPS-007), `:201`(REQ-OPS-015), `:209`(REQ-NFR-003) / `.documents/blueprint.md:471-477` / 참고 문서 §7.3
- 문제: worker pod 하나가 동시에 몇 개 run을 처리하는지, run 하나의 disk/CPU/memory/시간 상한이 얼마인지 어디에도 없다. 참고 자료는 changed files 500, raw diff 10MiB, context 25MiB, workspace 2/4GiB, 분석 timeout 15분, chat tool turn 8회, chat timeout 3분처럼 구체적 상한을 두었는데 현재 설계는 "byte budget", "size/budget aware"라는 표현만 남겼다.
- 영향: emptyDir sizeLimit과 node ephemeral storage 산정이 불가능하고, HPA metric(queue age)과 replica 계획도 근거를 잃는다. 대형 PR 하나가 worker를 장시간 점유해도 이를 막는 규칙이 없다.
- 권장: `worker.concurrency`와 run 단위 상한(파일 수, diff bytes, context bytes, 분석 timeout, model 호출 수, chat tool turn/timeout)을 요구사항과 values에 넣고, 초과 시 실패 대신 partial + limitation으로 처리하는 규칙을 명시한다.

#### M-08. split diff의 가로 예산이 layout contract와 맞지 않는다

- 위치: `.documents/ui-implementation-design.md:65-73`(Main 최소 560px), `:145-153` / `.documents/visuals/review-workspace.html:205`(`minmax(560px, 1fr)`), `:399`(diff-columns min-width 760px), `:577`(1279px에서 Main 460px) / `.documents/visuals/review-workspace-preview.png`
- 문제: 1440px에서 LNB 280 + Chat 380 + handle을 빼면 Main은 약 768px이고 split 한 쪽은 약 380px이다. 제공된 preview PNG에서도 HEAD 열이 잘려 보인다. layout contract가 허용하는 최소 Main 560px에서는 한 쪽이 약 280px로 줄어 split diff가 사실상 읽을 수 없다.
- 영향: REQ-UI-005(split/unified)와 UI 완료 조건의 "horizontal overflow 없음"이 동시에 만족되지 않는다.
- 권장: Main 폭 임계값(예: 880px) 아래에서 unified로 자동 전환하거나 Chat을 일시 축소하는 규칙을 UI 설계에 추가하고, 완료 조건에 "1440px에서 split diff 양쪽이 잘리지 않는다"를 넣는다.

#### M-09. UI layout contract가 제공된 visual과 일치하지 않는다

- 위치: `.documents/ui-implementation-design.md:69`(Header 52px 고정), `:70`(LNB compact 56px rail), `:87-92`(breakpoint 1280/960/720) / `.documents/visuals/review-workspace.html:68`(topbar 54px), `:151`(prbar 72px), `:577`(1279px에서 LNB 220px), `:581`(1020px breakpoint) / `.documents/requirements-specification.md:144`(REQ-UI-014)
- 문제: visual의 header는 topbar(54px)와 prbar(72px) 두 행이며 합계 약 126px인데 설계는 52px 한 행으로 규정한다. 설계의 56px rail 상태는 visual에 없고, breakpoint도 960 대 1020으로 다르다. REQ-UI-014는 시각 구조의 기준을 visual로 지정한다.
- 영향: M0-02와 M4-01이 어느 쪽을 따를지 모호하고, Header에 나열된 6개 요소를 52px에 배치할 수 없다.
- 권장: Header를 identity 행과 PR/state 행 두 단으로 규정하고 각 높이를 visual에 맞춘다. rail 상태와 breakpoint는 visual 대비 의도적 확장임을 문서에 명시한다.

#### M-10. diff의 base 측 label이 base와 merge-base를 혼동시킨다

- 위치: `.documents/visuals/review-workspace.html:714`(`BASE · 7c91de4`), `:804`(같은 SHA를 `merge-base 7c91de4`로 표기) / `.documents/requirements-specification.md:99`(REQ-SNAP-002) / `.documents/ui-implementation-design.md:196-206`(`side: "base" | "head"`)
- 문제: canonical diff의 좌측은 merge-base인데 visual과 client state는 이를 `BASE`/`base`로 부른다. 설계 문서 전체가 base SHA와 merge-base SHA를 신중히 구분하는 것과 어긋난다.
- 영향: reviewer가 좌측을 base branch tip으로 오해하고, deep link의 `side=base`가 어떤 tree를 뜻하는지 구현마다 달라질 수 있다.
- 권장: UI 설계에 label 규칙을 추가한다. canonical diff 좌측은 `merge-base <short SHA>`로 표기하고 base branch tip은 Header에서 별도로 보여준다. selection 값도 `mergeBase | head`처럼 명확한 이름을 검토한다.

#### M-11. milestone 체계가 두 개이고 feasibility spike가 구현 계획에 없다

- 위치: `.documents/blueprint.md:517-559`(Phase 0-4) / `.documents/implementation-plan.md:52-61`(M0-M5), `:264-277`
- 문제: 두 문서가 서로 다른 단계 체계를 제시하고 mapping이 없다. 특히 Phase 0의 GHES/App token round trip, partial clone과 merge-base deepen 검증, model endpoint 정책 확인이 M0-M5 어디에도 task로 없다. 구현 계획 §12는 결정 확인만 다룬다.
- 영향: 가장 큰 기술 위험(GHES version별 partial clone 지원, token으로의 Git fetch, 모델 정책)이 검증되지 않은 상태로 M2까지 진행될 수 있다.
- 권장: 하나를 정본으로 삼고 다른 문서는 참조만 남긴다. spike를 `M0-00`으로 편입하거나 `M-1 Feasibility gate`로 명시하고, 통과 기준(예: 대상 GHES에서 blobless clone + exact fetch + merge-base 확인 성공)을 적는다.

#### M-12. 관리자와 보안 담당자 기능의 surface가 없다

- 위치: `.documents/requirements-specification.md:68`(Operator), `:75`(REQ-AUTH-004), `:181`(REQ-SEC-008) / `.documents/blueprint.md:85-86`(Security operator) / `.documents/functional-design.md:215`(audit_events), `:222-243` / `.documents/ui-implementation-design.md:23` / `.documents/implementation-plan.md:103`
- 문제: 역할은 정의됐지만 audit 조회, retention 설정, run 취소, 실패 job 확인 기능이 API·UI·milestone에 없다. 감사 event 목록(무엇을 기록할지)도 정의되지 않았다. 역할 이름도 문서마다 Operator와 Security operator로 갈린다.
- 영향: REQ-AUTH-004와 REQ-SEC-008을 검수할 대상이 없다. 보안 검토 단계에서 감사 요구가 뒤늦게 들어오면 M5 범위가 커진다.
- 권장: 감사 event catalogue(login, grant 변경, repository 등록, clone/분석 시작·완료, report 조회, chat 질의/tool 호출, admin 설정 변경)와 admin API/화면을 요구사항에 추가하고 M1/M5에 task로 배치한다. 역할 taxonomy를 한 이름으로 통일한다.

#### M-13. 일부 필수 요구사항이 구현 milestone에 연결되지 않았다

- 위치: `.documents/requirements-specification.md:178`(REQ-SEC-005 sanitize), `:181`(REQ-SEC-008 retention), `:124`(REQ-AN-011 superseded), `:76`(REQ-AUTH-005 audit) / `.documents/functional-design.md:318`(CSRF/origin) / `.documents/implementation-plan.md` 전체
- 문제: 구현 계획에서 sanitize, CSRF, retention 실행, superseded 전이, audit 기록에 해당하는 task를 찾을 수 없다(retention과 audit은 M5의 test·redaction 항목으로만 등장).
- 영향: 필수 요구사항이 구현 없이 test 단계에서 발견되고, 보안 항목이 pilot 직전에 몰린다.
- 권장: 요구사항 문서에 `REQ-* → milestone task` traceability table을 추가하고, 위 항목에 대응하는 task를 M1/M3/M4에 배치한다.

#### M-14. web 보안 header와 CSP 요구사항이 없다

- 위치: `.documents/requirements-specification.md:178`(sanitize만) / `.documents/functional-design.md:314-320`
- 문제: repository text와 model 출력이 Markdown/code로 렌더되는 제품인데 CSP가 전 문서에 한 번도 등장하지 않는다. `frame-ancestors`, `referrer-policy`, 외부 이미지 로딩 정책도 없다.
- 영향: sanitizer 우회 한 건이 곧바로 XSS가 되고, 외부 이미지 참조로 내부 경로/토큰이 referrer나 요청 URL로 새어 나갈 수 있다.
- 권장: `default-src 'self'`, 외부 script/style/image 차단, `frame-ancestors 'none'`, `Referrer-Policy: no-referrer`를 REQ-SEC에 추가하고, UI 완료 조건과 Browser E2E에 header 검사를 넣는다.

#### M-15. fork PR 정책이 없다

- 위치: `.documents/requirements-specification.md:78-92` / `.documents/blueprint.md:223-253` / `.documents/functional-design.md:155-164` / 참고 문서 §18-7
- 문제: fork에서 온 PR의 head는 fork repository에 있고, base repository의 pull ref를 통해 받아야 한다. fetch refspec, installation scope, 신뢰 경계에 대한 언급이 없다.
- 영향: fork PR이 clone 단계에서 실패하거나, 반대로 예상하지 못한 remote를 fetch하게 된다. 사내에서도 fork 기반 workflow가 있으면 pilot에서 바로 드러난다.
- 권장: fork PR 지원 여부를 요구사항에 명시하고, 지원한다면 head를 base repository의 pull ref에서만 받도록 fetch 규칙을 고정한다. 미지원이면 worklist에서 제외 사유를 표시한다.

#### M-16. reverse proxy identity를 신뢰하는 조건이 없다

- 위치: `.documents/blueprint.md:174`(reverse proxy OIDC 또는 application OIDC) / `.documents/requirements-specification.md:72`(REQ-AUTH-001) / `.documents/functional-design.md:131`, `:316-318` / `.documents/implementation-plan.md:100`
- 문제: proxy가 주입한 header로 identity를 받는 방식을 허용하면서, pod 직접 접근 차단, 들어오는 identity header 제거, proxy만 허용하는 NetworkPolicy 같은 전제 조건이 없다.
- 영향: cluster 내부에서 header를 위조해 임의 사용자로 접근할 수 있다. REQ-AUTH-001의 실효성이 배포 구성에 좌우된다.
- 권장: 기본 방식을 하나 정하고, header 방식을 허용할 경우 "server는 ingress controller에서 온 요청만 수락하고 client가 보낸 identity header는 무조건 제거한다"를 요구사항으로 못 박는다. NetworkPolicy ingress 규칙과 negative test를 M1에 추가한다.

#### M-17. backup/restore 일관성 절차가 없다

- 위치: `.documents/requirements-specification.md:199`(REQ-OPS-013), `:230`(AC-11) / `.documents/functional-design.md:383-388` / `.documents/implementation-plan.md:215-216`
- 문제: PostgreSQL과 artifact 저장소는 서로 다른 시점에 백업되므로, 복구 후 DB가 없는 artifact를 참조하거나 참조 없는 artifact가 남는 것이 정상 상태다. 백업 순서, 허용 오차, 복구 후 reconcile 절차가 없다.
- 영향: AC-11의 "DB reference와 artifact checksum 일치"가 실제 복구 시나리오에서 실패하고, 운영자가 어떤 상태를 정상으로 볼지 판단할 수 없다.
- 권장: artifact 먼저, DB 나중 순서와 RPO를 정하고, 복구 후 dangling reference를 정리·표시하는 reconcile job을 정의한다. report가 artifact를 잃은 경우 `unavailable`로 표시하고 재분석 경로를 제시한다.

#### M-18. job 실행 주체, 재시도 상한과 dead-letter 처리가 정의되지 않았다

- 위치: `.documents/functional-design.md:63-74`, `:139`, `:150-153`, `:209`, `:330-344` / `.documents/requirements-specification.md:165`(REQ-DATA-004)
- 문제: poll job을 server leader가 실행하는지 worker가 claim하는지 문서가 갈린다(책임 표는 scheduler를 server에 두고, 흐름은 job enqueue로 서술한다). 또한 최대 attempt, backoff 곡선, 상한 초과 job의 처리(dead-letter)와 운영자의 조회·재실행 수단이 없다.
- 영향: job table의 executor 라우팅이 구현 시 임의로 결정되고, 실패가 무한 재시도로 남아 queue age metric이 상시 경보 상태가 된다.
- 권장: job type별 executor(poll=server leader, analysis=worker 등), priority, max attempts, backoff, dead-letter 상태를 설계에 표로 추가하고 REQ-DATA-004를 확장한다.

#### M-19. job lease 시간 기준이 명시되지 않았다

- 위치: `.documents/functional-design.md:123-125` / `.documents/requirements-specification.md:165`(REQ-DATA-004), `:211`(REQ-NFR-005)
- 문제: `lease_expires_at`과 `heartbeat_at`을 DB 시각으로 계산하는지 worker 시각으로 계산하는지 정의가 없다.
- 영향: pod 간 clock skew가 있으면 lease가 조기 만료되어 같은 job이 동시에 두 worker에서 실행된다. isolated clone이라 결과는 갈라지지 않지만 artifact 이중 write와 model 비용 중복이 발생한다.
- 권장: 모든 lease/heartbeat 시간을 DB `now()` 기준으로 계산하고, claim/heartbeat/renew를 단일 문장 update로 수행한다는 규칙을 설계에 명시한다. resilience test에 clock skew 사례를 추가한다.

### 1.4 Low

| ID | 위치 | 내용과 권장 |
|---|---|---|
| L-01 | `.documents/blueprint.md:493` | "browser pod는 source volume에 접근하지 않는다"는 표현이 남아 있다. browser는 pod가 아니므로 이전 topology 잔재로 보인다. 문장을 "server pod만 artifact를 read-only로 mount한다"로 정리한다. |
| L-02 | `.documents/blueprint.md:212`, `:218` vs `.documents/functional-design.md:79`, `:82` | key 표기가 다르다(`github_host` vs `github_instance_id`, `analysis_profile` vs `profile_version`). 한 이름으로 통일한다. |
| L-03 | `.documents/ui-implementation-design.md:21` vs `.documents/functional-design.md:230` | UI route는 `/reviews/:analysisId`, API는 `/analyses/{analysisId}`다. 의도적이면 문서에 명시하고 아니면 통일한다. |
| L-04 | `.documents/requirements-specification.md:198` vs `.documents/functional-design.md:348-355` | worker는 HTTP endpoint가 없는데 readiness/liveness를 요구한다. worker probe 방식(파일 기반, 별도 metrics port)을 정의한다. |
| L-05 | `.documents/ui-implementation-design.md:79-83` | layout preference key가 repository 수만큼 증가한다. 상한·정리 규칙을 두거나 user 단위 key + repository override로 축소한다. |
| L-06 | `.documents/functional-design.md:263-279`, `.documents/blueprint.md:410-418` | SSE 운영 조건(ingress proxy buffering off, read timeout, HTTP/2)이 없다. HTTP/1.1에서는 analysis/chat 두 stream이 tab당 연결을 소비하는 점도 함께 기록한다. |
| L-07 | `.documents/blueprint.md:437-487` | `imagePullSecrets`와 DB connection pool 상한이 values contract에 없다. replica 수 × pool 크기가 외부 PostgreSQL `max_connections`를 넘을 수 있다. |
| L-08 | `.documents/blueprint.md:7` | commit-defender에서 "skip directive"를 재사용한다고 적었으나 이후 요구사항·설계에 전혀 없다. 범위 밖이면 문장을 삭제하고, 유지하려면 REQ를 추가한다. |
| L-09 | `.documents/functional-design.md:390-398`, `.documents/blueprint.md:496-505` | migration Job을 Helm hook으로 둘지, 동시 실행을 advisory lock으로 막을지 미정이다. REQ-OPS-010에 실행 방식과 lock을 명시한다. |
| L-10 | `.documents/requirements-specification.md:87`, `.documents/ui-implementation-design.md:34` | draft PR은 poll 주기만 다르고 분석 대상 여부는 정의되지 않았다. 기본 정책(분석함/안 함)과 사용자 override 가능성을 명시한다. |

---

## 2. Cross-document inconsistencies

| # | 주제 | A 위치와 내용 | B 위치와 내용 |
|---|---|---|---|
| 1 | image command 수 | `requirements-specification.md:187` — serve/worker/migrate 3개 | `functional-design.md:348-355` — sweep-workspaces 포함 4개 |
| 2 | snapshot identity | `requirements-specification.md:26`, `:98` — merge-base 포함 | `functional-design.md:81`, `:207` — key와 unique는 base/head만 |
| 3 | merge-base 정정 | `functional-design.md:87` — 새 snapshot 또는 corrected revision | `functional-design.md:207` — 같은 base/head로는 생성 불가 |
| 4 | model 연결 주체 | `functional-design.md:68` — API server가 Chat orchestration | `blueprint.md:120-153`, `visuals/git-code-reviewer.drawio:27` — model은 worker에만 연결 |
| 5 | model egress 범위 | `requirements-specification.md:176` — worker egress만 제한 | `functional-design.md:327` — server/worker egress를 분리해 허용 |
| 6 | Header 크기 | `ui-implementation-design.md:69` — 52px 한 행 | `visuals/review-workspace.html:68`, `:151` — 54px + 72px 두 행 |
| 7 | LNB compact | `ui-implementation-design.md:70` — 56px rail | `visuals/review-workspace.html:577` — 1279px에서 220px |
| 8 | responsive breakpoint | `ui-implementation-design.md:87-92` — 1280/960/720 | `visuals/review-workspace.html:576`, `:581`, `:602` — 1279/1020/720 |
| 9 | diff 좌측 label | `visuals/review-workspace.html:714` — `BASE · 7c91de4` | `visuals/review-workspace.html:804`, `requirements-specification.md:99` — 같은 SHA가 merge-base |
| 10 | run state 어휘 | `requirements-specification.md:164` — requested/preparing/analyzing/persisting/... | `ui-implementation-design.md:103` — queued/running/stale |
| 11 | SSE event 이름 | `functional-design.md:153` — poll.started, snapshot.detected | `functional-design.md:266-277` — analysis.*, chat.*만 정의 |
| 12 | 단계 체계 | `blueprint.md:517-559` — Phase 0-4 | `implementation-plan.md:52-61` — M0-M5, 매핑 없음 |
| 13 | storage backend 설정 | `functional-design.md:385` — `storage.backend=object` | `blueprint.md:465-477` — values에 해당 키 없음 |
| 14 | 역할 이름 | `blueprint.md:86` — Security operator | `requirements-specification.md:68`, `PRODUCT.md:12` — Operator |
| 15 | 구현 전 결정 목록 | `requirements-specification.md:233-247` — DEC-001~011 | `blueprint.md:561-573`(최대 repository 크기·partial clone 지원 포함), `implementation-plan.md:264-277`(Kubernetes version/ingress 포함) — 세 목록의 항목 집합이 다르다 |
| 16 | key 필드명 | `blueprint.md:212`, `:218` | `functional-design.md:79`, `:82` |

문서 간 대립이 아닌 방향 일치 항목도 확인했다. read-only 범위, polling 기반 감지, browser의 비참여, isolated clone, immutable revision, PostgreSQL 단일 job 저장소, RWX 기본 + object 대안, 동일 image의 command 분리는 PRODUCT, blueprint, 요구사항, 기능 설계, 구현 계획, drawio에서 모순 없이 반복된다.

---

## 3. Missing requirements and operational gaps

### 3.1 보안

- CSP와 보안 header 요구사항이 없다(M-14).
- reverse proxy identity를 신뢰하기 위한 전제 조건이 없다(M-16).
- fork PR의 fetch 경로와 신뢰 경계가 없다(M-15).
- 사용자별 Chat 비용·요청 상한이 없다. refresh만 rate limit 대상이며(`functional-design.md:149`), model 호출은 제한 근거가 없다.
- 감사 event catalogue와 조회 수단이 없다(M-12). `audit_events` table만 존재한다.
- secret rotation 시 반영 방식(file mount 재로딩 vs pod 재시작)이 없다. runbook 항목으로만 언급된다(`implementation-plan.md:287`).
- model provider의 입력 보존 정책을 계약 수준에서 확인하는 요구사항이 없다. 기능 설계 `:320`에 문장만 있고 REQ가 없다.

### 3.2 데이터 수명주기

- retention 실행 주체·주기·batch 크기가 없다(M-04).
- 사용자 삭제 요청(REQ-SEC-008)의 처리 범위가 없다. Chat만인지 report·source artifact도 포함인지 미정이다.
- bounded source artifact의 기본 byte budget 값이 없다(M-07).
- Chat retention이 report retention을 넘지 않는다는 규칙이 없다. 참고 자료는 이 관계를 명시했다(참고 §6.6).
- artifact orphan reconcile과 복구 후 정합성 절차가 없다(M-03, M-17).
- artifact PVC 용량 산정식(분석당 bytes × 일 run 수 × retention)이 없다. M5-03은 alert만 다룬다.

### 3.3 Kubernetes와 Helm

- retention/sweep CronJob template과 values가 없다(M-04).
- object storage values와 `values.schema.json` 필수 키 정의가 없다(M-06).
- worker probe 방식이 없다(L-04).
- `imagePullSecrets`, DB connection pool 상한이 values에 없다(L-07).
- SSE를 위한 ingress 설정 요구가 없다(L-06).
- worker replica 1개일 때 PDB가 drain을 막는 구성 위험이 정리되지 않았다. REQ-OPS-014는 2개 이상만 다룬다.
- HPA를 queue age로 운영하려면 custom metrics adapter가 필요하다는 전제가 없다(`requirements-specification.md:201`).
- migration Job 실행 방식과 동시 실행 lock이 미정이다(L-09).
- rolling update 중 job payload schema 호환 규칙이 없다. DB schema와 artifact schema는 정의됐지만(`functional-design.md:302`, `requirements-specification.md:196`) job contract는 문장만 있다(`blueprint.md:435`).

### 3.4 장애 복구

- dead-letter와 attempt 상한, 운영자 재실행 경로가 없다(M-18).
- lease 시간 기준이 없어 clock skew 시 중복 실행 위험이 있다(M-19).
- readiness가 외부 의존성에 묶여 부분 장애가 전체 중단이 된다(H-06).
- artifact store 장애 시 read 경로의 degrade 동작이 없다. write 중단만 정의됐다(`functional-design.md:343`).
- backup 순서와 복구 후 reconcile이 없다(M-17).
- base branch 이동으로 merge simulation이 낡는 경로를 감지하지 못한다(H-04).
- SSE fan-out 부재로 장애 중 상태 전파가 replica에 따라 달라진다(H-02).

---

## 4. Open questions

이미 결정된 항목(제품 형태, polling 기반, read-only 범위, isolated clone, Kubernetes/Helm 운영, storage 구성, DEC-001~011로 열려 있는 조직 값)은 제외했다.

1. **base branch 이동 처리 방침.** 매 poll에서 base ref tip을 재조회할지, merge simulation만 stale로 표시할지, base 이동 시 재분석할지. 정확도와 GHES 요청 비용의 교환이다(H-04, H-07).
2. **fork PR을 pilot 범위에 포함할지.** 포함하면 pull ref fetch 규칙과 신뢰 경계를 요구사항에 추가해야 한다(M-15).
3. **Chat 추론을 server에서 수행할지 worker로 위임할지.** NetworkPolicy, model secret mount 대상, server 응답 지연 목표가 이 결정에 달려 있다(H-05).
4. **active PR 60초 목표의 적용 범위.** 전체 registered repository인지, 최근 활동 상위 N개 tier인지. 대상 GHES의 rate limit 활성 여부와 함께 확정해야 한다(H-07).
5. **priority 방향과 category enum.** `P3 = 치명`을 유지할지, 일반 관례대로 뒤집을지. finding category에 `maintenance`를 포함할지(M-02).
6. **분석·Chat 자원 상한의 기본값.** 분석 timeout, 최대 changed files, diff/context bytes, chat tool turn과 timeout. 조직 model 비용 정책과 연결된다(M-07).
7. **사용자 데이터 삭제 요청의 범위.** Chat만인지 report와 source artifact까지인지, 요청 창구가 admin인지 본인인지(3.2).
8. **감사 조회 권한의 소유자.** Operator와 Security operator를 분리할지, 감사 조회를 제품 UI로 제공할지 로그 시스템에 위임할지(M-12).

---

## 5. Overall assessment

### 5.1 구현 시작 가능 여부

**M0은 지금 시작할 수 있다.** M0 범위(pnpm workspace, React shell, Fastify static/health, migration runner, Dockerfile command, 최소 Helm chart)에 필요한 결정은 문서에 충분히 확정돼 있고, 이 검토에서 나온 High finding 중 M0을 막는 항목은 없다.

**M2 착수 전에 H-01, H-03, H-04, H-08을 해소해야 한다.** snapshot identity와 API/event contract는 M2에서 DB 제약과 client contract로 굳는다. 이후에 바꾸면 migration과 artifact 재생성이 함께 필요하다.

**M4 착수 전에 H-02와 H-05가 필요하다.** SSE fan-out과 model 호출 경계가 정해지지 않으면 Chat과 진행 표시가 단일 replica 가정 위에 만들어진다.

**M5 전에 M-03, M-04, M-17이 필요하다.** cleanup·retention 실행 주체와 복구 정합성은 pilot 운영 승인 조건에 직결된다.

### 5.2 먼저 수정해야 할 항목

| 순서 | 항목 | 이유 |
|---|---|---|
| 1 | H-03 snapshot identity | DB 제약과 immutability 규칙이 여기서 결정된다 |
| 2 | H-08 + H-01 API/artifact contract | M2-M4 전체가 이 contract 위에 놓인다 |
| 3 | H-06 readiness 정의 | 요구사항 간 충돌이고 문장 수정으로 해결된다 |
| 4 | H-05 model 호출 경계 | drawio, REQ-SEC-003, values를 함께 수정해야 한다 |
| 5 | H-02 SSE fan-out | broker를 두지 않는 결정을 지키려면 방식을 지금 명시해야 한다 |
| 6 | H-04 base 이동 + H-07 poll 예산 | 요구사항 수치와 GHES 확인이 함께 필요하다 |

### 5.3 pilot 전에 보완해도 되는 항목

- M-09, M-10 UI 세부 계약과 label 규칙. M4-01 착수 시점까지면 충분하다.
- M-12 admin/audit surface. 범위를 정한 뒤 M1/M5에 나눠 배치할 수 있다.
- M-13 traceability table, M-11 단계 체계 통합. 문서 작업이며 구현을 막지 않는다.
- M-14 CSP, M-16 proxy identity 조건. M1/M4 구현과 함께 넣으면 된다.
- L-01부터 L-10까지 전부. 다음 문서 개정에서 일괄 처리 가능하다.

### 5.4 현재 설계의 강점

- 폐기한 전제가 깔끔하게 제거됐다. webhook, GitHub Actions, write-back, VS Code/browser extension, Redis, SaaS tenant는 모두 명시적 제외 문장으로만 남아 있고 request path에 흔적이 없다.
- read-only GitHub App permission(Metadata/Contents/Pull requests Read)으로 설계된 기능(PR 목록, exact fetch, blame/history, merge simulation)을 모두 수행할 수 있다. write가 필요한 기능은 후속으로 분리됐다.
- deterministic artifact와 model 추론의 분리, evidence verifier, partial + coverage + omission, immutable revision, snapshot 고정 Chat이 여섯 문서에서 같은 의미로 반복된다. 제품 원칙이 요구사항·설계·UI·계획까지 관통한다.
- Git 관련 보안 통제가 구체적이다. argument vector 호출, system/global config 격리, hook·smudge filter·submodule 자동 실행 금지, symlink/path traversal 검사, token을 URL·process arg·config에 남기지 않는 규칙이 모두 명시돼 있다.
- 논리 component와 Kubernetes workload가 같은 이름과 책임으로 유지되고, drawio 두 page가 문서 내용과 일치한다.
- 제공된 Review Workspace visual이 실제로 동작하는 HTML이고, LNB 4개 view와 FNB 6개 tool, persistent Chat, resize handle의 ARIA 속성까지 UI 설계와 대응한다.

### 5.5 잔여 위험

- GHES 규모와 rate limit이 미확인이다. H-07의 요청량 계산은 문서 기준 추정이며, 실측 없이는 REQ-NFR-001을 확정할 수 없다.
- 단일 leader polling이 확장 경로 없이 필수 요구사항을 떠받치고 있다.
- 5분 분석 목표(REQ-NFR-003)가 model 지연과 specialist 수에 좌우되는데, 호출 병렬화·timeout·상한이 정의되지 않았다(M-07).
- RWX storage 가용성에 기본 설계가 묶여 있고 object 전환 표면이 미완성이다(M-06).
- 문서 간 정합성이 사람 검토에 의존한다. REQ와 milestone, API contract, artifact schema를 잇는 기계적 추적 수단이 없다(M-13).
- Chat 비용 통제가 없어 pilot에서 model 지출이 예측 범위를 벗어날 수 있다.

---

## 6. 검토 범위와 검증 한계

검토한 영역: 문서 정합성, architecture 타당성, 보안 통제, Kubernetes/Helm 운영, UI 흐름과 제공 visual 대응, 범위와 구현 가능성, 요구사항-설계-milestone 추적, 참고 자료와의 차이.

검증하지 못한 것:

- 실제 GHES나 GitHub API에 접근하지 않았다. PR metadata의 base SHA 갱신 동작, rate limit 정책, partial clone 지원 여부는 문서와 일반적 동작을 근거로 한 판단이며 대상 instance에서 확인해야 한다(H-04, H-07은 이 확인에 의존한다).
- code가 존재하지 않아 정적 분석·build·test 검증은 불가능하다. 모든 finding은 문서 수준이다.
- `review-workspace-preview.png`는 1440px 폭 단일 snapshot만 확인했다. 960px, 720px 미만 동작은 HTML의 media query로만 검토했다.
- `git-code-reviewer.drawio`는 XML 내용으로만 검토했고 렌더 결과는 확인하지 않았다.
- Helm chart, Dockerfile, values schema 실물이 없어 template 유효성과 schema 제약은 검증할 수 없었다.
- 성능 목표(REQ-NFR-001~004)는 측정 가능한 형태로 서술돼 있으나 실제 달성 가능성은 GHES 규모와 model 지연 실측 없이 판단할 수 없다.

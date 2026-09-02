# Git Code Reviewer - 기능 설계서

## 1. 설계 기준

| 항목 | 내용 |
|---|---|
| 상태 | 신규 제품 기준안 v1 |
| 입력 | `blueprint.md`, `requirements-specification.md` |
| API prefix | `/api/v1` |
| runtime | Kubernetes의 server/worker Deployment |
| persistence | PostgreSQL + artifact PVC 또는 object storage |

이 설계는 browser가 clone과 분석을 담당하지 않는 중앙 웹서비스를 구현 대상으로 한다. 대상 repository의 CI, GitHub webhook과 GitHub write-back은 MVP request path에 없다.

### 1.1 원칙

- 가변 PR metadata는 snapshot request로만 사용하고 clone 결과를 append-only snapshot materialization으로 고정한다.
- server가 identity, repository와 snapshot scope를 결정한다.
- deterministic artifact와 model inference를 분리해 재사용하고 검증한다.
- retry와 사용자 refresh가 겹쳐도 같은 snapshot/run은 하나만 생성한다.
- 부분 실패를 숨기지 않고 `partial`, coverage와 omission으로 표현한다.
- source repository의 instruction, command, hook과 executable을 실행하지 않는다.
- logical architecture와 Kubernetes 배포 topology를 같은 component contract로 유지한다.

## 2. Architecture

### 2.1 논리 구조

```text
Browser
  -> Server: static SPA, OIDC, REST, SSE, poll scheduler, Chat
       -> PostgreSQL: registry, operations, event log, jobs, reports, Chat
       -> Artifact store: source, diff, graph, analyzer artifact, report
       -> approved model endpoint: interactive Chat inference
       -> Worker: clone, snapshot materialization, analyzer, model, verifier
            -> GHES API/Git
            -> approved model endpoint
```

GHES 연결은 모두 outbound다. browser는 Server만 호출하고 GHES token, model credential, clone path 또는 storage locator를 알지 못한다.

### 2.2 Kubernetes 배치

```text
Ingress
  -> Service/server
      -> Deployment/server (2+ replicas)

Deployment/worker (1+ replicas)
  -> emptyDir 또는 generic ephemeral RWO workspace
  -> RWX artifact PVC

CronJob/retention
  -> expired DB rows와 persistent artifact 정리

server + worker
  -> existing PostgreSQL
  -> existing Secrets

Helm release
  -> pre-install/pre-upgrade migration Job
  -> ConfigMap / Secret refs / NetworkPolicy / PDB
```

`serve`, `worker`, `migrate`, `retention`은 같은 image와 schema package를 사용하고 command만 다르다. scheduler는 server 안에서 실행하되 PostgreSQL advisory lock을 얻은 replica만 due repository를 예약한다. 규모 실측에서 필요할 때 같은 contract를 유지한 채 lock scope를 repository shard로 확장한다.

### 2.3 Component 책임

| Component | 책임 | 가지지 않는 책임 |
|---|---|---|
| Web SPA | worklist, review workspace, selection, REST/SSE client | clone, model key, source persistence |
| API server | auth, authorization, resource query, refresh, SSE, interactive Chat inference | long-running clone/analyzer |
| Poll scheduler | due target, PR delta, quota/backoff, snapshot request | report 분석, GitHub write-back |
| Job repository | enqueue, lease, heartbeat, retry, dedupe | 별도 message broker 운영 |
| Event log/fan-out | transactional event append, replica notification, replay | source/prompt/token 전달 |
| Analysis worker | isolated clone, artifact pipeline, report persist | arbitrary repo command, public ingress |
| Artifact store | immutable large object와 checksum | authorization 결정 |
| PostgreSQL | metadata, state, leases, audit metadata | source tree 보관 |
| Model adapter | Server Chat와 Worker batch를 위한 provider-neutral request/stream/usage/error | local CLI credential 재사용 |

## 3. Identity와 domain key

```text
repository_key     = github_instance_id / github_repository_id
pr_key             = repository_id / pr_number
snapshot_request   = pr_id / base_sha / head_sha
materialization    = snapshot_request_id / materialization_version
analysis_key       = snapshot_id / profile_version / analyzer_version
                     / model_profile / policy_hash
snapshot_artifact  = snapshot_id / artifact_type / schema_version
analysis_artifact  = analysis_id / artifact_type / schema_version
```

Poller는 base/head가 바뀔 때 `snapshot_request`를 upsert한다. Worker는 clone과 deepen을 마친 뒤 `merge_base_sha`, `merge_base_resolution=exact|unresolved`, 계산 policy/depth를 포함한 materialization을 append한다. API의 `snapshotId`는 이 materialization ID다.

Materialization은 생성 후 수정하지 않는다. Unresolved 결과 뒤에 exact 결과를 얻으면 version을 올린 새 row를 만들고 기존 analysis/report/Chat은 이전 row에 남는다. 동일 request와 계산 policy에서 서로 다른 exact merge-base가 나오면 history rewrite 또는 engine defect로 간주해 publish하지 않고 integrity audit event를 남긴다.

## 4. 상태 모델

### 4.1 Repository poll state

```text
idle -> due -> polling -> idle
                  |        ^
                  v        |
               backing_off
                  |
               disabled
```

주요 필드는 `last_success_at`, `next_poll_at`, `etag`, `rate_limit_reset_at`, `failure_count`, `mode`, `lease_owner`다. manual refresh는 `next_poll_at`을 앞당기며 실행 중 poll을 중복 생성하지 않는다.

Poll mode는 `hot|active|idle|disabled`다. 초기 목표는 각각 60초, 5분, 15분, polling 없음이지만 실제 interval과 request budget은 GHES 실측값으로 설정한다. Draft는 기본 `idle`이며 관리자가 자동 분석을 비활성화해도 manual refresh는 허용한다.

### 4.2 Analysis run state

```text
requested -> preparing -> analyzing -> persisting -> completed
    |            |            |             |
    |            +------------+-------------+-> partial
    +------------------------------------------> cancelled
    +------------------------------------------> superseded
                 unrecoverable ----------------> failed
```

- `completed`: 필수 stage와 report persist 완료
- `partial`: 사용 가능한 artifact/report가 있고 omission 존재
- `failed`: 사용자에게 제공할 report가 없음
- `superseded`: 최신 head run이 대체함
- `cancelled`: 관리자 요청 또는 shutdown 정책으로 중단됨

terminal state는 바꾸지 않는다. 재시도는 같은 analysis row의 attempt가 아니라 새 `job_attempt`으로 기록한다.

`stale`은 run state가 아니다. `report.base_sha != pull_request.base_sha` 또는 `report.head_sha != pull_request.head_sha`이면 파생된다. Base tip 변경도 새 snapshot/run을 생성하며 이전 report는 stale이다.

### 4.3 Job lease

executor는 transaction 안에서 실행 가능한 job을 `FOR UPDATE SKIP LOCKED` 방식으로 claim하고 `lease_owner`, `lease_expires_at`, `heartbeat_at`을 설정한다. Claim, renew와 expiry는 worker local clock이 아니라 DB `now()`를 사용하는 단일 statement로 판정한다. Heartbeat가 끊기면 reaper가 retry 가능한 job을 재예약한다. Stage output checksum이 이미 유효하면 해당 stage는 재실행하지 않는다.

Priority 숫자는 작을수록 먼저 실행한다. 수치와 backoff는 typed config이며 아래 값은 초기값이다.

| Job type | Executor | Priority | Max attempts | Backoff | 상한 초과 |
|---|---|---:|---:|---|---|
| `pr.poll` | scheduler leader | 50 | 5 | exponential+jitter, 최대 5분 | repository backoff |
| `pr.poll.manual` | scheduler leader | 10 | 3 | 즉시, 5초, 20초 | operation failed |
| `snapshot.materialize` | worker | 20 | 3 | exponential+jitter, 최대 10분 | terminal failure |
| `analysis.run` | worker | 30 | 3 | exponential+jitter, 최대 10분 | terminal failure |

Terminal failure는 `last_error_code`를 보존하며 administrator가 동일 domain key로 새 attempt를 요청할 수 있다. 기본 heartbeat/lease 값은 DEC-015에서 확정한다.

## 5. 핵심 흐름

### 5.1 로그인과 worklist

1. 기본 application OIDC가 user identity를 확인한다. Proxy identity mode는 §9.2의 trust 조건을 충족할 때만 사용한다.
2. server는 subject를 `users`에 upsert하고 role/group mapping을 적용한다.
3. `GET /repositories`는 grant가 있는 registered repository만 반환한다.
4. PR 목록은 현재 observed head, 최신 analysis state, priority count와 poll 상태를 함께 반환한다.
5. browser는 마지막으로 선택한 repository 같은 비민감 preference만 localStorage에 보관한다.

### 5.2 Background poll

1. leader scheduler가 `next_poll_at <= now()` target을 claim한다.
2. GitHub App JWT로 installation token을 발급하거나 memory cache에서 가져온다.
3. conditional request와 pagination으로 open PR을 읽는다.
4. PR adapter가 PR metadata 또는 명시적 ref query로 현재 base branch tip과 head SHA를 확정한다.
5. PR number/state/base/head를 저장된 관측값과 비교한다.
6. 새 PR 또는 변경 SHA에 대해 snapshot request를 upsert하고 materialize job을 생성한다.
7. 닫힌 PR은 state만 갱신하며 기존 report retention을 유지한다.
8. quota, request budget과 tier에 따라 다음 poll 시각을 계산한다.

### 5.3 Manual refresh

1. server가 user/repository 권한과 per-user/per-PR rate limit을 확인한다.
2. 동일 PR refresh가 진행 중이면 기존 active operation을 반환한다.
3. 새 요청이면 operation을 만들고 high-priority `pr.poll.manual` job을 예약한다.
4. `202 Accepted`와 아래 body를 반환한다.

```json
{
  "operationId": "op_...",
  "deduplicated": true,
  "state": "queued",
  "eventsUrl": "/api/v1/repositories/12/pulls/482/events"
}
```

SSE는 poll 시작/완료, snapshot request/materialization과 analysis 상태를 순서대로 전달한다. 예상 시작 시간은 scheduler가 신뢰할 수 있는 값을 계산할 때만 optional field로 제공한다.

### 5.4 Snapshot 준비

1. worker가 snapshot request와 server-side registry에서 GHES clone endpoint를 얻는다.
2. opaque run directory와 `emptyDir` 또는 generic ephemeral workspace를 만든다.
3. credential helper 또는 header로 installation token을 전달하고 URL에 넣지 않는다.
4. `--no-tags`, bounded depth와 가능한 경우 `--filter=blob:none`으로 독립 clone한다.
5. exact base/head를 fetch하고 merge-base가 없으면 정책 한도까지 deepen한다.
6. 계산 결과를 새 append-only snapshot materialization으로 commit한다.
7. exact이면 base/head/integration view와 canonical diff를 확정한다.
8. changed source와 snapshot-level artifact를 byte budget 안에서 저장한다.
9. unresolved이면 추정 diff를 만들지 않고 가능한 metadata만 가진 partial analysis로 이어간다.

### 5.5 Analysis pipeline

```text
snapshot materialization
  -> manifest/diff index
  -> language/symbol index
  -> history/reference/test candidates
  -> selected context source manifest
  -> change pack planner
  -> specialist model calls
  -> evidence verifier/deduplicator
  -> immutable report composer
```

각 stage는 versioned manifest, checksum, input dependency를 artifact metadata에 기록한다. Analyzer가 선택한 context source는 analysis scope에 저장한다. Analysis budget 또는 file limit을 넘으면 생략 범위와 이유를 partial report에 남긴다.

### 5.6 Commit Defender report core 재사용

초기 compatibility baseline은 Commit Defender commit `47dabfea718729b0ccc685ae173857476040d6ea`의 다음 구현이다.

| 원본 | 재사용할 계약 |
|---|---|
| `vscode-extension/src/types.ts` | `AnalysisReport schema_version: 1`, grade, per-file summary, P0-P3/category |
| `vscode-extension/src/commentFormatter.ts` | lint/model 결과를 한 finding list로 정규화하고 P3부터 정렬하는 규칙 |
| `vscode-extension/src/ai/schemas.ts` | structured review output과 enum 검증 |
| `vscode-extension/src/ai/prompt.ts` | protected review rubric, actionable comment와 untrusted source 원칙 |
| `vscode-extension/src/ai/json.ts` | enum normalization과 truncation 감지 fixture |

| Commit Defender v1 | Canonical PR report |
|---|---|
| `schema_version` | compatibility metadata와 adapter 선택 |
| `staged_files` | snapshot changed files와 per-file coverage |
| `duration_ms` | analysis timing summary |
| `review.summary`, `review.grade` | report summary와 grade |
| `review.per_file_summaries` | `fileId` 기반 per-file summary |
| `lint_findings`, `review.file_comments` | producer/rule/provenance가 있는 normalized finding |
| `review.is_error` | analysis stage failure/partial limitation, 일반 finding으로 만들지 않음 |
| `review.blocking`, `exit_code` | 호환 입력으로만 읽고 검증된 P3 기반 `hasCriticalFindings`로 치환 |

`packages/review-contract`에 위 동작을 versioned port하고 Commit Defender fixture를 contract test로 둔다. VS Code API, pre-commit hook, local credential, skip directive와 UI rendering은 가져오지 않는다. Truncated model JSON을 복구했더라도 누락 범위를 `partial`로 기록하며 text pattern만으로 P3를 확정하지 않고 evidence verifier를 통과시킨다.

Canonical report는 Commit Defender core에 PR snapshot, evidence, confidence, coverage와 impact를 확장한다.

```ts
interface EvidenceLocator {
  id: string;
  fileId: string;
  side: 'mergeBase' | 'head';
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  commitOid?: string;
  artifactType: string;
}

interface Coverage {
  filesChanged: number;
  filesExamined: number;
  objectsExamined: number;
  relationsExamined: number;
  truncated: boolean;
  limitations: string[];
}

interface ImpactReport {
  summary: string;
  affectedAreas: Array<{
    objectId: string;
    risk: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
    relationIds: string[];
    evidence: EvidenceLocator[];
  }>;
  coverage: Coverage;
  confidence: 'low' | 'medium' | 'high';
}

type ProducerVersions = Record<string, string>;

type FindingCategory =
  | 'correctness' | 'security' | 'compatibility' | 'testing'
  | 'maintenance' | 'optimization' | 'review-history' | 'setting';

interface ReviewFinding {
  id: string;
  source: {
    kind: 'analyzer' | 'model';
    producer: string;
    rule?: string;
    original?: { schemaVersion: number; priority: string; category: string; comment: string };
  };
  title: string;
  problem: string;
  impact: string;
  recommendation: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  category: FindingCategory;
  confidence: 'low' | 'medium' | 'high';
  verification: { status: 'verified' | 'limited'; checks: string[]; originalPriority: string };
  anchor: EvidenceLocator;
  evidence: EvidenceLocator[];
}

interface ReviewReport {
  schemaVersion: 1;
  compatibility: { commitDefenderSchemaVersion: 1; baselineRevision: string };
  analysisRevisionId: string;
  snapshotId: string;
  summary: string;
  grade: 'exceptional' | 'proficient' | 'adequate' | 'insufficient' | 'critical';
  hasCriticalFindings: boolean;
  perFileSummaries: Array<{
    fileId: string;
    summary: string;
    priority: 'P0' | 'P1' | 'P2' | 'P3';
    grade: 'exceptional' | 'proficient' | 'adequate' | 'insufficient' | 'critical';
  }>;
  findings: ReviewFinding[];
  impact: ImpactReport;
  coverage: Coverage;
  versions: ProducerVersions;
}
```

Compatibility adapter는 Commit Defender의 원문 comment/category/priority를 `source.original`에 보존하고 canonical title/problem/impact/recommendation을 만든다. Commit Defender의 `blocking` 입력값은 저장하지 않고 검증된 P3 존재 여부로 `hasCriticalFindings`를 계산한다. 이 값과 grade는 review attention 신호이며 merge simulation, GitHub status 또는 merge gate가 아니다. P0는 조치가 필요 없는 positive/file-level observation으로 finding issue count와 분리한다.

### 5.7 Code object와 relationship graph

Graph는 lexical structure와 dependency 방향을 섞지 않는다.

```ts
interface CodeObject {
  id: string;
  kind: 'file' | 'module' | 'namespace' | 'class' | 'interface'
    | 'function' | 'method' | 'property' | 'variable' | 'schema' | 'test' | 'package';
  qualifiedName: string;
  definition?: EvidenceLocator;
  change: 'added' | 'removed' | 'modified' | 'unchanged';
}

interface CodeRelation {
  id: string;
  sourceObjectId: string;
  targetObjectId: string;
  kind: 'contains' | 'defines' | 'calls' | 'imports' | 'extends' | 'implements'
    | 'reads' | 'writes' | 'constructs' | 'tests' | 'depends-on';
  distance: number;
  change: 'added' | 'removed' | 'unchanged';
  confidence: 'low' | 'medium' | 'high';
  evidence: EvidenceLocator[];
}
```

`contains` edge는 parent container에서 child member로 향한다. Dependency/reference edge는 `source`가 `target`을 사용한다는 뜻이다. 따라서 선택 object 기준 UI는 다음처럼 계산한다.

- **Structure parent:** 선택 object로 들어오는 `contains` edge의 source
- **Structure children:** 선택 object에서 나가는 `contains` edge의 target
- **Uses:** 선택 object에서 나가는 dependency/reference edge의 target
- **Used by:** 선택 object로 들어오는 dependency/reference edge의 source

Direct edge를 먼저 만들고 transitive path는 요청 시 bounded depth로 확장한다. 각 path는 cycle, truncation, 언어 adapter와 files/objects examined coverage를 표시한다. MergeBase/head graph를 각각 계산해 edge의 `added|removed|unchanged`를 만들며, 변경되지 않은 downstream object의 위험은 finding이 아니라 `ImpactReport`에 둔다.

Package object는 manifest/lockfile을 정적으로 읽어 direct/transitive `depends-on` edge를 만든다. Package manager를 실행하지 않으며, lockfile에 없는 runtime resolution과 GHES 밖 repository의 dependents는 coverage limitation으로 남긴다.

### 5.8 Report 조회와 link target

server는 DB에서 report summary와 authorization을 확인한 뒤 artifact object를 읽는다. client가 snapshot/revision을 명시하지 않은 경우 최신 revision으로 redirect 가능한 canonical URL을 반환하지만, 열린 workspace 안에서 revision을 자동 교체하지 않는다.

Report, finding, evidence, code object, relation과 commit은 path나 absolute URL 대신 immutable ID와 typed link target을 저장한다. API response/export 시 configured `publicBaseUrl`로 내부 link를 만들고, GHES link는 registered instance/repository와 exact SHA로 server가 만든다.

```ts
type StoredLinkTarget =
  | { kind: 'workspace'; analysisId: string; selection: {
      findingId?: string; evidenceId?: string; fileId?: string;
      side?: 'mergeBase' | 'head'; line?: number; symbolId?: string;
      relationId?: string; commitOid?: string; tool?: string;
    } }
  | { kind: 'ghes-file'; repositoryId: string; commitOid: string; fileId: string;
      startLine?: number; endLine?: number };

interface LinkView {
  rel: 'self' | 'finding' | 'evidence' | 'definition' | 'relation' | 'commit' | 'ghes';
  href: string;
  target: 'same-tab' | 'new-tab';
  available: boolean;
  fallbackHref?: string;
}
```

```text
/reviews/<analysisId>
/reviews/<analysisId>?finding=<findingId>
/reviews/<analysisId>?finding=<findingId>&evidence=<evidenceId>
/reviews/<analysisId>?file=<fileId>&side=head&line=42
/reviews/<analysisId>?symbol=<objectId>&tool=impact
/reviews/<analysisId>?relation=<relationId>&tool=impact
/reviews/<analysisId>?commit=<commitOid>&tool=graph

https://<registered-ghes>/<owner>/<repo>/blob/<exact-commit>/<encoded-path>#L42-L48
```

내부 link는 로그인 후 검증된 relative `return_to`로 돌아오고 매 요청마다 repository grant를 검사한다. External GHES link는 exact commit permalink가 기본이며 branch 이름을 사용하지 않는다. PR diff anchor처럼 GHES version별로 달라질 수 있는 route는 `M0-00` adapter test를 통과한 경우에만 추가한다. Path segment와 line range를 encode/validate하고 arbitrary origin, credential query와 user-supplied URL은 거부한다.

Markdown/JSON export는 같은 typed target에서 link를 렌더링한다. Internal link는 같은 tab, GHES link는 `noopener noreferrer`를 적용한 새 tab으로 열며, source가 삭제되었거나 권한이 없으면 revision 고정 내부 evidence view를 fallback으로 유지한다.

### 5.9 Chat

1. session 생성 시 `user_id + analysis_revision_id`를 고정한다.
2. server가 concurrency/rate/tool-turn/timeout limit을 확인하고 초과하면 typed `429` 또는 limit error를 반환한다.
3. server가 질문, 현재 selection과 허용 evidence handle로 context를 구성한다.
4. model tool call은 typed handler가 snapshot scope를 다시 검증한다.
5. server가 model을 직접 호출해 token/delta를 현재 SSE connection으로 stream한다.
6. 최종 message/citation만 transaction으로 저장한다. 중단된 stream은 REST 상태 확인 후 사용자가 재시도한다.
7. 새 analysis가 있으면 UI가 별도 banner를 표시하고 사용자 동의로 새 session을 시작한다.

### 5.10 Cleanup

worker는 `finally` 단계에서 credential, Git config와 workspace를 삭제한다. Container restart로 같은 pod의 `emptyDir`이 남은 경우 worker startup/periodic cleanup이 active lease가 없는 자기 volume의 run directory만 지운다. Pod가 삭제되면 `emptyDir`과 generic ephemeral PVC는 pod lifecycle에 따라 정리된다.

`retention` CronJob은 DB lease로 singleton 실행하고 persistent artifact staging/orphan, 만료 report/chat/source와 event log를 bounded batch로 정리한다. 참조 row를 먼저 unavailable로 표시하거나 삭제 대상으로 claim한 뒤 object를 지우며 active analysis와 Chat은 건드리지 않는다.

## 6. Data model

| Table | 핵심 필드 | 주요 제약 |
|---|---|---|
| `users` | oidc_subject, display_name, role | subject unique |
| `github_instances` | api_base_url, app_id, secret_ref | host unique |
| `repositories` | github_id, installation_id, owner, name, enabled | instance/github_id unique |
| `repository_grants` | repository_id, subject_or_group, role | scope unique |
| `pull_requests` | repository_id, number, state, base_sha, head_sha | repository/number unique |
| `poll_states` | repository_id, next_poll_at, etag, backoff | repository unique |
| `operations` | type, scope, state, dedupe_key, result, error | active dedupe key unique |
| `snapshot_requests` | pr_id, base_sha, head_sha, state | pr/base/head unique |
| `snapshots` | request_id, version, merge_base_sha, resolution, policy | request/version unique, append-only |
| `analysis_runs` | snapshot_id, key, state, profile, timestamps | analysis key unique |
| `jobs` | type, payload_ref, priority, state, lease, last_error | active dedupe key unique |
| `job_attempts` | job_id, number, executor, started/ended, outcome | job/number unique |
| `event_log` | id, scope, scope_id, type, payload, created_at | append-only, scope/id index |
| `artifacts` | scope/id, type, version, checksum, locator, committed_at, producer_attempt | scope/id/type/version unique |
| `reports` | run_id, revision, summary, grade, has_critical, coverage | run unique, immutable |
| `findings` | report_id, source/rule, title/body, priority, category, confidence, anchor, fingerprint | report/fingerprint unique |
| `chat_sessions` | user_id, analysis_revision_id, title | owner-scoped |
| `chat_messages` | session_id, role, content_ref, status, usage | ordered sequence |
| `audit_events` | actor, action, resource_type/id, outcome, request_id, time | append-only metadata |

`content_ref`와 artifact `locator`는 opaque storage key다. browser API에 filesystem path, bucket credential 또는 signed internal locator를 그대로 노출하지 않는다.

## 7. API contract

### 7.1 Resource API

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
GET    /api/v1/analyses/{analysisId}/report
GET    /api/v1/analyses/{analysisId}/report/export?format=markdown|json
GET    /api/v1/analyses/{analysisId}/coverage
GET    /api/v1/analyses/{analysisId}/findings
GET    /api/v1/analyses/{analysisId}/findings/{findingId}
GET    /api/v1/analyses/{analysisId}/events
GET    /api/v1/analyses/{analysisId}/symbols
GET    /api/v1/analyses/{analysisId}/history
GET    /api/v1/analyses/{analysisId}/impact
GET    /api/v1/analyses/{analysisId}/ownership
GET    /api/v1/analyses/{analysisId}/tests
GET    /api/v1/analyses/{analysisId}/objects/{objectId}
GET    /api/v1/analyses/{analysisId}/objects/{objectId}/relations
GET    /api/v1/analyses/{analysisId}/relations/{relationId}
GET    /api/v1/snapshots/{snapshotId}/files
GET    /api/v1/snapshots/{snapshotId}/files/{fileId}/content
GET    /api/v1/snapshots/{snapshotId}/diff
GET    /api/v1/snapshots/{snapshotId}/commits
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
GET    /api/v1/admin/audit-events                 # DEC-016이 product UI일 때
```

List API는 opaque cursor pagination을 사용한다. Diff API는 file/hunk cursor, context line 수와 view mode를 받는다. Relation API는 `view=structure|dependency`, `direction=parents|children|uses|used-by`, bounded `depth`와 cursor를 받는다. 모든 response는 `schemaVersion`, resource `id`, `snapshotId` 또는 `analysisRevisionId` 중 해당 identity와 허용된 typed links를 포함한다. Admin route는 별도 role/scope를 요구하며 audit 조회를 외부 로그 시스템에 위임하면 마지막 endpoint를 제공하지 않는다.

Operation response:

```json
{
  "schemaVersion": 1,
  "id": "op_...",
  "type": "pr_refresh",
  "state": "queued|polling|materializing|analyzing|completed|failed",
  "result": {
    "snapshotChanged": false,
    "snapshotId": null,
    "analysisId": null
  },
  "startedAt": "...",
  "finishedAt": null,
  "error": null
}
```

### 7.2 Error envelope

```json
{
  "error": {
    "code": "ANALYSIS_NOT_READY",
    "message": "분석이 아직 완료되지 않았습니다.",
    "requestId": "req_...",
    "retryable": true,
    "details": { "state": "analyzing" }
  }
}
```

권한 없는 resource와 존재하지 않는 resource는 외부 관점에서 같은 응답을 사용한다. 내부 원인은 audit metadata에만 기록한다.

### 7.3 Durable state SSE

```text
# PR scope: /repositories/{repoId}/pulls/{number}/events
event: poll.started
data: { operationId, occurredAt }

event: poll.completed
data: { operationId, outcome: "unchanged|changed|deferred", reason, occurredAt }

event: snapshot.requested
data: { operationId, requestId, baseSha, headSha, occurredAt }

event: snapshot.materialized
data: { operationId, snapshotId, resolution: "exact|unresolved", analysisId, occurredAt }

event: analysis.state
data: { analysisId, revision, state, stage, progress, occurredAt }

event: analysis.available
data: { analysisId, revision, reportUrl, stale, occurredAt }
```

Analysis scope는 `analysis.state`와 `analysis.available`만 전달한다. 상태 변경 transaction은 같은 transaction에서 `event_log`를 append하고 commit 시 `NOTIFY gcr_events, '<event-id>'`를 보낸다. Notification에는 ID만 넣는다. 각 Server replica는 pool과 분리된 connection으로 `LISTEN`하고 event row를 읽은 뒤 구독자 authorization을 다시 확인한다.

LISTEN connection이 끊기면 Server는 짧은 interval로 `event_log`를 tail하고 연결이 복구되면 LISTEN으로 돌아간다. Durable event의 단조 증가 ID는 `Last-Event-ID` 재생에 사용한다. 재생 retention 밖이면 client가 operation/analysis REST resource를 다시 읽는다.

### 7.4 Chat SSE

Chat delta는 대용량 durable event log에 넣지 않고 해당 Server가 model stream을 현재 connection으로 직접 전달한다.

```text

event: chat.delta
data: { sessionId, messageId, sequence, delta }

event: chat.completed
data: { sessionId, messageId, citations, usage }

event: chat.failed
data: { sessionId, messageId, code, retryable }
```

Server나 connection이 중단되면 client는 REST로 message 상태를 확인한다. 완료 message가 없으면 새 turn으로 명시적으로 재시도한다. 중단된 token delta의 정확한 replay는 MVP가 보장하지 않는다.

## 8. Artifact contract

```text
artifacts/repositories/<repository-id>/snapshots/<snapshot-id>/
  snapshot-manifest.v1.json
  changed-source-manifest.v1.json
  source/<opaque-file-id>.blob.zst
  diff-index.v1.json
  diffs/<opaque-file-id>.patch.zst
  commits.v1.json.zst
  merge-simulation.v1.json.zst
  analyses/<analysis-id>/
    context-source-manifest.v1.json
    context-source/<opaque-file-id>.blob.zst
    symbols.v1.json.zst
    history.v1.json.zst
    ownership.v1.json.zst
    relationships.v1.json.zst
    impact.v1.json.zst
    tests.v1.json.zst
    coverage.v1.json
    model/<specialist-id>.v1.json.zst
    report.v1.json.zst

artifacts/.staging/<attempt-id>/...
```

- source path는 artifact manifest 안에 있을 수 있지만 storage key와 metric label에는 사용하지 않는다.
- snapshot source는 changed file, analysis source는 analyzer가 채택한 context로 제한하며 전체 clone을 보존하지 않는다.
- manifest는 input SHA, producer version, checksum, byte size와 completeness를 가진다.
- 각 attempt는 staging prefix에 쓰고 checksum을 검증한 뒤 filesystem atomic rename 또는 object conditional-create로 canonical key를 commit한다.
- 이미 commit된 canonical object의 checksum이 같으면 재사용한다. 다르면 덮어쓰지 않고 integrity failure로 처리한다.
- DB artifact row는 canonical object commit 뒤 기록한다. Retention은 오래된 staging object와 DB reference가 없는 object를 별도 정책으로 정리한다.
- PVC mode에서 server는 source/report/diff를 read-only mount하고 worker/retention만 write mount한다. Object mode에서는 workload별 최소 credential을 사용한다.
- schema reader는 current와 직전 version을 지원해 rolling update를 허용한다.

## 9. 보안 control

### 9.1 Git과 filesystem

- command는 shell string이 아니라 argument vector로 호출한다.
- system/global Git config 영향을 제거하고 protocol/file transport를 제한한다.
- hook path, smudge/clean filter, submodule recursion과 executable bit에 의한 실행을 금지한다.
- symlink와 path traversal을 검사하고 workspace root 밖 read를 거부한다.
- clone token은 process argument, remote URL과 persisted config에 남기지 않는다.

### 9.2 Application

- Application OIDC Authorization Code flow와 secure server session을 기본으로 한다. Session cookie는 `Secure`, `HttpOnly`, `SameSite=Lax`와 조직이 정한 idle timeout을 사용한다.
- Reverse proxy identity mode는 ingress에서 온 signed assertion을 검증하고 신뢰 경계 밖의 identity header를 제거한다. Pod 직접 접근과 forged header를 negative test한다.
- state-changing API는 origin/CSRF protection과 idempotency를 적용한다.
- Markdown renderer는 raw HTML과 unsafe scheme을 차단하고 external image를 자동 load하지 않는다. External link에는 `noopener noreferrer`를 적용한다.
- GHES permalink builder는 browser 입력 URL을 받지 않고 registry의 origin/repository와 materialization의 exact commit만 조합한다. Origin allowlist, encoded path, line range와 object ID를 검증한다.
- 기본 CSP는 script/style/font/connect를 self로 제한하고 `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`을 포함한다. Referrer, content-type와 permissions header를 적용하며 HSTS는 ingress/platform owner가 관리한다.
- authorization은 API와 artifact resolver 양쪽에서 수행한다.
- Chat/model request에는 필요한 code fragment만 넣고 provider retention policy를 적용한다.
- Model credential은 Chat을 호출하는 server와 batch 분석을 호출하는 worker에만 mount하고 component별 concurrency를 제한한다.

Audit catalogue는 login/session, grant/role, repository/config/retention 변경, snapshot/analysis lifecycle, report/source 조회, Chat session/tool/provider call, job requeue, migration과 secret rotation을 포함한다. Event에는 actor, action, opaque resource ID, outcome, request ID와 time만 기록한다.

### 9.3 Kubernetes

- pod는 non-root, privilege escalation 금지, capability drop, seccomp와 read-only rootfs를 기본으로 한다.
- application ServiceAccount는 Kubernetes API permission을 필요로 하지 않는 구성을 우선한다.
- Secret은 existing Secret 또는 external secret controller가 만들고 chart는 이름만 참조한다.
- NetworkPolicy는 server ingress와 server/worker/retention egress allowlist를 분리한다. Server는 GHES polling과 Chat model, Worker는 GHES Git/API와 batch model, 두 workload는 DB와 선택한 artifact backend만 허용한다.
- workspace와 artifact mount를 component별 최소 권한으로 나눈다.

## 10. 장애와 복구

| 장애 | 동작 |
|---|---|
| GHES 401/403 | token 한 번 갱신 후 connection error, 반복 retry 금지 |
| GHES 404 | repository/PR visibility 재검증, user에게 일반화된 오류 |
| GHES 429/5xx | reset/retry-after 기반 backoff, 다른 repository poll 지속 |
| clone timeout/disk full | run partial 또는 failed, workspace cleanup, quota metric |
| analyzer 실패 | 해당 omission을 기록하고 다음 독립 stage 진행 |
| model timeout/quota | bounded retry 후 deterministic-only partial report |
| artifact checksum 실패 | publish하지 않고 stage 재실행 |
| worker 종료 | heartbeat 중단, lease expiry 후 다른 worker가 resume |
| PostgreSQL 장애 | server readiness false, liveness 유지, 새 claim/write 중단. 이미 열린 browser는 기존 화면과 dependency error를 유지한다. |
| artifact store 장애 | metadata/finding은 유지하고 source/diff는 degraded error. Report write와 DB terminal transition은 중단한다. |
| model 장애 | deterministic-only partial은 허용하고 Chat은 retryable error를 표시한다. |
| SSE/LISTEN disconnect | event-log tail과 REST reconcile 후 stream을 재연결한다. |

### 10.1 Probe contract

| Probe | Server | Worker/retention |
|---|---|---|
| startup | typed config, compatible DB schema | 같은 config/schema와 workspace 초기화 |
| readiness | HTTP listener, event fan-out와 핵심 DB query | lease/command loop가 최근 주기 안에 진행 |
| liveness | event loop 응답성 | process/heartbeat loop 응답성 |
| dependency | DB, artifact, GHES, model 상태 상세 | DB, artifact, GHES, model 상태 상세 |

Artifact, GHES와 model 장애만으로 liveness를 실패시키지 않는다. Worker probe는 작은 internal health port를 기본으로 하며 cluster 정책이 요구할 때 동일 상태를 확인하는 exec probe를 허용한다.

### 10.2 Backup과 reconcile

Artifact는 immutable object를 commit한 뒤 DB row에서 참조한다. Backup 중에는 retention delete를 중지하거나 backup window보다 긴 deletion grace period를 보장한다.

1. PostgreSQL backup 또는 PITR restore point `Tdb`를 정한다.
2. `Tartifact >= Tdb` 시점에 artifact PVC/object snapshot을 생성한다.
3. 복구 시 같은 pair를 사용하고 DB restore point가 artifact snapshot보다 늦지 않게 한다.
4. `reconcile` 단계가 DB reference와 artifact manifest/checksum을 비교한다.
5. Missing artifact report는 `unavailable`로 표시하고 재분석 경로를 제공한다.
6. DB에서 참조하지 않는 artifact는 retention candidate로 표시한다.

## 11. Container와 Helm 설계

### 11.1 Image entrypoint

```text
git-code-reviewer serve
git-code-reviewer worker
git-code-reviewer migrate
git-code-reviewer retention
git-code-reviewer retention --reconcile
```

image는 Vite production asset, Node runtime, Git과 필요한 parser runtime만 포함한다. compiler, package manager, test fixture와 build secret은 final stage에서 제거한다. image digest가 실제 release identity이며 tag는 사람이 읽는 alias다.

### 11.2 Chart 구조

```text
deploy/helm/git-code-reviewer/
  Chart.yaml
  values.yaml
  values.schema.json
  templates/
    server-deployment.yaml
    server-service.yaml
    ingress.yaml
    worker-deployment.yaml
    migration-job.yaml
    retention-cronjob.yaml
    artifact-pvc.yaml
    service-account.yaml
    network-policy.yaml
    pod-disruption-budget.yaml
    config-map.yaml
    _helpers.tpl
  tests/
```

환경별 values는 repository 밖의 deployment configuration에서 관리할 수 있다. Chart는 secret 값을 만들기보다 existing secret name/key mapping을 받는다. `helm lint`, values schema, template snapshot과 Kubernetes schema validation을 release 전에 수행한다.

### 11.3 Values contract

```yaml
image:
  repository: registry.intra/git-code-reviewer
  tag: ""
  digest: ""
imagePullSecrets: []

server:
  replicas: 2
  databasePoolMax: 10
  chat:
    maxConcurrentPerUser: 1
    requestsPerMinute: 10
  ingress:
    host: git-code-reviewer.intra
    annotations: {} # controller별 SSE buffering/read-timeout 설정

worker:
  replicas: 2
  concurrency: 2
  terminationGracePeriodSeconds: 900
  workspace:
    mode: emptyDir # emptyDir | genericEphemeral
    size: 10Gi
    storageClass: fast-rwo

storage:
  backend: pvc # pvc | object
  artifacts:
    storageClass: shared-rwx
    accessModes: [ReadWriteMany]
    size: 100Gi
  object:
    endpoint: ""
    region: ""
    bucket: ""
    prefix: git-code-reviewer
    existingSecret: ""
    serverSideEncryption: ""

database:
  existingSecret: git-code-reviewer-db

secrets:
  githubApp: git-code-reviewer-github-app
  oidc: git-code-reviewer-oidc
  modelProvider: git-code-reviewer-model

retention:
  enabled: true
  schedule: "*/10 * * * *"
  batchSize: 500
  reportDays: 90
  chatDays: 30
  eventLogHours: 1
```

Values 숫자는 초기 예시이며 DEC-006/007/009/012/015에서 확정한다. `backend=object`이면 endpoint, bucket과 existing Secret을 요구하고 NetworkPolicy egress를 추가한다. `chatDays <= reportDays` 관계는 standard JSON Schema cross-field 비교에 의존하지 않고 Helm template `fail`과 application startup validation으로 모두 검사한다.

DB 최대 connection은 `(server replicas x server pool) + (worker replicas x worker pool) + LISTEN/retention/migration connection`으로 산정하고 external PostgreSQL 한도 아래로 제한한다. Ingress adapter는 SSE에 대해 proxy buffering을 끄고 충분한 read timeout을 설정할 수 있어야 한다. Controller-specific annotation은 typed values로 전달하고 기본 chart에 특정 ingress controller를 고정하지 않는다.

### 11.4 Storage

- `artifacts`: 여러 server/worker replica가 접근하는 RWX PVC. storage class가 RWX를 제공하지 않으면 `storage.backend=object`를 사용한다.
- `workspace`: 기본 `emptyDir`에 size limit을 둔다. Persistent scratch가 필요하면 Deployment pod별 generic ephemeral `volumeClaimTemplate`으로 RWO PVC를 만든다. Forensic 보존이 필요한 StatefulSet mode는 MVP 밖이다.
- `database`: 기본 external PostgreSQL. cluster 내 DB가 필요하면 별도 chart/release와 backup ownership을 둔다.
- PVC reclaim, expansion, snapshot schedule과 encryption은 platform team contract로 values/runbook에 기록한다.

Filesystem과 object adapter는 같은 get/put/commit/checksum/delete contract를 구현한다. MVP에서 구현할 backend는 DEC-007로 선택하며 다른 adapter는 해당 환경에 필요할 때 같은 contract test를 통과한 뒤 활성화한다.

### 11.5 Periodic lifecycle

- Worker startup/periodic cleanup은 자기 pod workspace만 정리한다.
- Retention CronJob은 DB advisory lock으로 singleton 실행하며 event log, staging, orphan과 만료 data를 각기 다른 TTL로 bounded batch 처리한다.
- `retention --reconcile`은 restore 후 명시적으로 실행하며 일반 cleanup과 구분한다.
- Secret rotation은 mounted secret 갱신 방식에 따라 checksum rollout 또는 승인된 external reloader를 사용한다. Credential은 image rebuild 없이 교체한다.

### 11.6 Rollout

1. OCI image를 scan/sign하고 digest로 registry에 push한다.
2. chart를 lint/package하고 대상 values를 server-side dry-run한다.
3. `pre-install,pre-upgrade` migration hook Job이 DB advisory lock을 얻고 idempotent expand migration을 완료한다. `before-hook-creation,hook-succeeded` cleanup policy를 사용하고 실패 Job은 조사할 수 있게 남긴다.
4. server Deployment를 rolling update한다.
5. worker는 새 claim을 멈추는 preStop/SIGTERM 절차로 rolling update한다.
6. smoke test가 auth, DB, artifact write/read와 dummy analysis queue를 확인한다.
7. 실패 시 application/chart를 rollback하되 DB는 backward-compatible 상태를 유지한다.

PDB는 replica가 2개 이상인 workload에만 기본 생성한다. HPA를 queue/custom metric으로 활성화하려면 cluster metrics adapter 제공 여부를 먼저 검증한다.

## 12. 관측성

metric:

- `poll_lag_seconds`, `poll_requests_total`, `poll_budget_remaining`, `github_rate_limit_remaining`
- `job_queue_age_seconds`, `job_attempts_total`, `worker_lease_expired_total`
- `clone_duration_seconds`, `clone_bytes`, `workspace_cleanup_failures_total`
- `analysis_stage_duration_seconds`, `analysis_partial_total`, `analyzer_coverage_ratio`
- `relationship_objects_total`, `relationship_edges_total`, `relationship_truncated_total`, `relationship_query_duration_seconds`
- `model_request_duration_seconds`, `model_errors_total`, `model_tokens_total` with bounded `component=server|worker` and `purpose=chat|analysis`
- `event_fanout_lag_seconds`, `event_replay_total`, `sse_connections`
- `http_request_duration_seconds`, `dependency_health`, `authorization_denials_total`

trace와 structured log에는 `request_id`, opaque `repository_id`, `snapshot_id`, `analysis_id`, stage와 outcome만 넣는다. repository 이름, path, source, prompt, response와 token은 넣지 않는다.

## 13. 설계 검증 기준

- API contract test가 authorization, operation dedupe, event replay와 stale revision을 검증한다.
- Git fixture test가 rename, binary, shallow deepen, unresolved/exact materialization, base 이동과 cleanup을 검증한다.
- worker integration test가 crash/DB-clock lease recovery, artifact race와 partial report를 검증한다.
- Commit Defender v1 fixture contract test가 summary/grade/per-file/finding normalization과 P3 파생값을 검증한다.
- Relationship fixture가 parent/children, uses/used-by, cycle, mergeBase/head edge 변화와 truncation을 검증한다.
- Browser E2E가 worklist부터 finding/citation/Chat, 내부 deep link와 GHES permalink까지 검증한다.
- image test가 non-root/read-only rootfs와 secret 부재를 검증한다.
- Helm test가 clean install, migration lock, upgrade/rollback, retention, external Secret, RWX/generic ephemeral volume과 termination을 검증한다.
- 두 server replica와 끊어진 LISTEN connection에서 event fan-out/replay를 검증한다.
- Backup fixture가 `Tdb <= Tartifact` pair와 restore reconcile을 검증한다.

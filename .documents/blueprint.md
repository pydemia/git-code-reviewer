# Git Code Reviewer - Browser Review Service Blueprint

## 1. 문서 목적

이 문서는 사내 GitHub Enterprise Server(GHES)의 pull request를 중앙 서버에서 분석하고, reviewer가 브라우저의 전용 review workspace에서 결과를 조사하고 질문하는 제품의 기준 설계를 정의한다.

이 설계는 기존 `git-code-reviewer`의 CI/CD 중심 구조를 계승하지 않는다. `commit-defender`에서 검증한 priority, evidence, provider adapter 개념과 PR 분석 서버 초안의 snapshot 및 isolated clone 원칙만 선택적으로 재사용한다.

기준 제품은 다음 한 문장으로 요약한다.

> 사내 웹서버가 등록된 GHES repository의 PR 변경을 outbound polling으로 감지하고, 격리된 workspace에서 분석한 결과를 브라우저 review workspace로 제공한다.

## 2. 핵심 결정

### 2.1 제품 형태

- 사용자 GUI는 VS Code extension이나 browser extension이 아닌 사내 HTTPS web application이다.
- browser는 code를 clone하거나 분석하지 않는다. 화면 렌더링, 사용자 명령, Chat stream만 담당한다.
- 중앙 서버는 PR 조회, Git fetch, snapshot, 분석, report, Chat과 보존을 담당한다.
- 서버는 사내 Kubernetes cluster에 OCI container image와 Helm chart로 배포한다.

### 2.2 변경 감지

- MVP의 기본 trigger는 중앙 scheduler의 outbound polling과 사용자의 `분석 새로고침`이다.
- GitHub Actions, repository CI workflow, webhook ingress는 필요하지 않다.
- polling은 browser가 닫혀 있어도 동작하며 active PR과 idle repository의 주기를 다르게 적용한다.
- webhook은 향후 보안 정책과 운영 필요가 확인될 때 polling 앞단의 optional accelerator로만 검토한다.

### 2.3 GitHub write-back

- MVP는 GitHub에 Check, status, review comment를 게시하지 않는 read-only service다.
- 분석 결과와 진행 상태는 web application에서 확인한다.
- PR comment나 Check Run은 조직이 필요성을 확인한 뒤 별도 permission과 publish worker를 추가하는 후속 기능이다.

### 2.4 중앙화 범위

- PR snapshot과 report는 reviewer 사이에서 공유한다.
- Chat session, saved filter와 layout preference는 사용자별로 분리한다.
- source clone은 run별 ephemeral workspace에만 존재하고 완료 후 삭제한다.
- browser storage에는 panel 크기와 선택 tab 같은 비민감 preference만 저장한다.

## 3. 해결하려는 문제

Reviewer는 GHES PR 화면만으로 다음 질문에 답하기 어렵다.

- 이 변경이 실제로 바꾸는 동작은 무엇인가?
- 변경된 symbol의 caller, importer, schema consumer와 관련 test는 어디인가?
- 현재 diff에 correctness, security, compatibility 또는 test omission이 있는가?
- 이 finding의 근거가 현재 base/head snapshot과 일치하는가?
- 과거 commit, blame, ownership과 branch 관계를 함께 보면 위험도가 달라지는가?
- 분석 결과를 근거로 후속 질문을 할 수 있는가?

Git Code Reviewer는 PR diff를 요약하는 도구가 아니라, finding에서 code evidence로 빠르게 이동하고 같은 snapshot을 두고 대화하는 review workspace를 제공한다.

## 4. 목표와 비목표

### 4.1 MVP 목표

- 등록된 GHES repository의 open PR과 base/head 변화를 polling으로 감지한다.
- `repository + PR number + base SHA + head SHA` 요청을 만들고, merge-base와 계산 정책을 포함한 불변 snapshot materialization을 생성한다.
- canonical PR diff, commit별 diff, file/symbol/history evidence를 생성한다.
- Commit Defender의 summary, grade, per-file summary, P0-P3/category와 finding normalization을 계승한 확장 report를 제공한다.
- correctness, security, compatibility, testing 관점의 priority finding과 code object 관계 impact를 제공한다.
- browser에서 Files, Findings, Outline, Impact, split diff, Chat, Git graph와 History를 한 작업공간에서 탐색한다.
- Chat을 analysis revision에 고정하고 모든 기술적 주장에 evidence locator를 연결한다.
- 일부 analyzer나 model이 실패해도 coverage와 limitation이 있는 partial report를 제공한다.
- private source, token, prompt가 log나 browser storage로 유출되지 않게 한다.

### 4.2 MVP 비목표

- GitHub merge gate 또는 CI status를 대체하지 않는다.
- repository마다 workflow file을 설치하지 않는다.
- PR branch의 build, test, package script 또는 임의 command를 실행하지 않는다.
- LLM 결과만으로 merge를 승인하거나 차단하지 않는다.
- GitHub comment와 inline review를 자동 게시하지 않는다.
- 여러 조직을 위한 billing, public signup과 완전한 SaaS multi-tenancy를 구현하지 않는다.
- VS Code extension, Chrome extension과 native host를 제공하지 않는다.
- GitLab과 Bitbucket을 동시에 지원하지 않는다.

## 5. 사용자와 핵심 흐름

### 5.1 사용자

- **Reviewer:** PR 위험, 근거, 영향 범위와 누락 test를 조사한다.
- **PR author:** finding을 확인하고 수정 후 새 snapshot 분석을 요청한다.
- **Service administrator:** Chat account/model/effort 정책, GHES access-token connection, repository/grant/polling, 보존 기간과 사용자를 관리한다.
- **Operator:** Kubernetes release, storage, backup, 보존과 audit metadata를 관리한다.

### 5.2 Browser 사용 흐름

```text
사내 URL 접속
  -> SSO 로그인
  -> 등록 repository와 open PR 선택
  -> 최신 analysis revision 확인
  -> Finding 선택
  -> split diff와 evidence 확인
  -> Git graph / History / Impact 조사
  -> 선택 finding 또는 file 범위로 Chat 질문
  -> file/line/symbol citation이 있는 답변 확인
```

### 5.3 Background 분석 흐름

```text
Scheduler
  -> due repository 조회
  -> GHES open PR metadata 조회
  -> 저장된 base/head와 비교
  -> 새 snapshot request upsert
  -> PostgreSQL job lease
  -> run별 isolated clone
  -> append-only snapshot materialization
  -> deterministic analysis
  -> bounded LLM review + verification
  -> immutable report 저장
  -> browser SSE 상태 갱신
```

Reviewer가 `분석 새로고침`을 누르면 해당 PR poll을 background scan보다 우선한다. 같은 PR에 대한 동시 refresh는 하나로 합친다.

## 6. 기준 아키텍처

```text
┌──────────────────────── GHES ────────────────────────┐
│ Pull Request API · GraphQL · Git HTTPS              │
└──────────────────────────▲───────────────────────────┘
                           │ outbound HTTPS only
                           │ administrator-registered access token
┌──────────────────────────┴───────────────────────────┐
│ Git Code Reviewer Server                             │
│                                                      │
│ Fastify API · static web assets · OIDC · SSE         │
│ repository registry · PR poll scheduler · Chat API   │
└───────────────┬───────────────────────┬──────────────┘
                │                       │
      ┌─────────▼─────────┐   ┌─────────▼─────────────┐
      │ PostgreSQL        │   │ Artifact volume       │
      │ jobs · snapshots  │   │ source · diff · report│
      │ reports · chat    │   │ encrypted at rest     │
      └─────────┬─────────┘   └───────────────────────┘
                │ job lease
      ┌─────────▼─────────────────────────────────────┐
      │ Analysis Worker                               │
      │ isolated clone · Git/AST analyzers            │
      │ review agent · verifier · report composer     │
      └───────────────┬───────────────────────────────┘
                      │ approved outbound API
              ┌───────▼────────────┐
              │ Model endpoint     │
              └────────────────────┘

Browser -> reverse proxy -> Server -> REST/SSE
Server  -> Model endpoint (interactive Chat inference)
Worker  -> Model endpoint (batch review inference)
```

### 6.1 MVP 운영 단위

MVP는 하나의 source repository와 하나의 release artifact로 관리한다.

- `server`: web asset 제공, REST/SSE, auth, polling scheduler와 Chat model 호출
- `worker`: clone, analyzer, model review와 artifact 생성
- `postgres`: metadata, job queue, report index, Chat
- `artifact volume`: bounded source, 큰 diff와 analyzer/report artifact

`server`와 `worker`는 같은 application image에서 다른 command로 실행한다. PostgreSQL job table과 lease를 사용해 별도 message broker 없이 운영한다. artifact storage는 PVC-backed filesystem interface로 시작하며 `server`와 여러 `worker` replica가 함께 읽어야 하므로 RWX volume을 기준으로 한다. cluster storage가 RWX를 제공하지 않으면 S3-compatible object storage adapter를 사용한다.

### 6.2 기준 기술 스택

| 영역 | 기준 구현 | 이유 |
|---|---|---|
| Web UI | React + TypeScript + Vite | dense workspace와 client state에 집중하고 serverless 가정을 피함 |
| Web server | Fastify + TypeScript | static asset, REST, SSE, scheduler를 한 process에서 운영 |
| Database/job | PostgreSQL | metadata와 durable job lease를 하나의 운영 dependency로 통합 |
| Artifact | encrypted RWX PVC 또는 S3-compatible storage | bounded source, diff와 report를 server/worker가 공유 |
| Git | system Git CLI, argument vector | exact SHA, merge-base, diff, blame와 history 재사용 |
| Parser | Tree-sitter adapter | 언어별 symbol을 공통 contract로 정규화 |
| Model | approved provider-neutral adapter | 조직 model 정책과 provider 교체 경계 유지 |
| Auth | application OIDC 기본, 조건부 reverse proxy identity | 별도 password system 구축을 피하고 사내 identity 재사용 |
| Streaming | SSE | analysis progress와 Chat token stream에 충분함 |

## 7. GitHub 연결과 polling

### 7.1 GHES access-token connection

MVP permission은 read-only로 시작한다.

- Metadata: Read
- Contents: Read
- Pull requests: Read

시스템 관리자는 GHES instance와 승인된 service identity의 access token을 connection으로 등록한다. Token은 deployment master key로 암호화한 DB row로 보존하고 API header와 ephemeral Git credential helper에서만 복호화한다. DB 평문, job payload, Git remote URL과 log에는 저장하지 않는다. 시스템 관리자는 token으로 실제 조회 가능한 repository만 tenant에 등록하고 repository별 poll interval, disabled 상태와 Poll now trigger를 관리한다.

### 7.2 Repository 등록

관리자는 등록한 GHES access token으로 조회 가능한 repository를 검색·검증한 뒤 분석 대상으로 등록한다. Scheduler는 등록된 repository만 조회한다. 임의 clone URL은 받지 않고 owner/name 입력도 GHES API에서 확인한 numeric repository ID로 정규화한 뒤 server-side registry에 저장한다. GHES token 권한과 application user/group grant는 별도로 관리한다.

### 7.3 Poll state

repository별로 다음을 저장한다.

- 마지막 성공 cycle과 다음 poll 시각
- pagination checkpoint와 conditional request validator
- PR별 관측 base/head SHA, state, draft 여부
- rate limit remaining/reset과 backoff
- active, idle, disabled 상태

`updated_at`은 후보를 줄이는 hint이며 snapshot 생성 여부는 authoritative base/head SHA와 PR state transition으로 판정한다. 초기 poll tier는 hot 60초, active 5분, idle/draft 15분으로 두되 실제 GHES rate limit과 규모 측정 후 확정한다. Draft PR은 idle tier의 자동 분석 대상이며 관리자가 자동 분석을 끌 수 있고 manual refresh는 유지한다.

### 7.4 Idempotency

snapshot request dedupe key:

```text
repository_id/pr_number/base_sha/head_sha
```

snapshot materialization dedupe key:

```text
snapshot_request_id/calculation_policy_hash/resolution/merge_base_sha-or-unresolved
```

analysis key:

```text
snapshot_materialization_id/analysis_profile/analyzer_version/model_profile/policy_hash
```

snapshot request는 관측값의 중복을 합치고, worker는 merge-base resolution을 포함한 append-only materialization을 만든다. `unresolved` 뒤 `exact`가 확인되면 새 materialization을 만들며 기존 report/Chat의 의미를 바꾸지 않는다. 같은 request와 정책에서 서로 다른 exact merge-base가 나오면 publish하지 않고 integrity failure로 처리한다. 같은 analysis key의 완료 report는 재사용하며 새 base 또는 head를 감지하면 이전 queued/running run을 superseded 처리하고 전체 재분석을 우선한다.

## 8. Snapshot과 isolated clone

각 run은 다른 run과 `.git`, object database, refs, config와 working tree를 공유하지 않는 독립 clone을 사용한다.

```text
<workspace-root>/<opaque-run-id>/
  repository/
  artifacts/
```

초기 clone은 대상 GHES/Git 지원 범위에서 다음 최적화를 사용한다.

- `--no-tags`
- bounded shallow history
- `--filter=blob:none`
- 필요한 base/head ref만 fetch

merge-base를 찾지 못하면 정한 한도까지 단계적으로 deepen한다. 한도를 넘으면 임의 diff로 대체하지 않고 report를 `partial`로 표시한다.

worker는 다음 view를 exact SHA로 구성한다.

```text
base view         @ base SHA
head view         @ head SHA
integration view  @ base SHA + simulated head merge
```

canonical PR diff는 `merge-base...head` 의미를 사용하며 merge simulation과 분리한다. 성공, 실패, 취소 모든 경로에서 clone을 삭제한다. Worker startup/periodic cleanup은 active lease가 없는 자기 pod의 잔여 workspace만 정리하고, persistent artifact orphan과 만료 데이터는 별도 retention CronJob이 처리한다.

clone 삭제 후에도 diff 탐색과 materialization-bound Chat이 가능하도록 changed file은 snapshot scope에, analyzer가 선택한 context file은 analysis scope에 byte budget 안에서 versioned source artifact로 보존한다. 전체 repository clone은 보존하지 않으며 source artifact는 report와 같은 authorization, encryption과 retention을 적용한다. 보존되지 않은 file은 Chat tool이 limitation으로 응답한다.

## 9. 분석과 agent

### 9.1 Deterministic stage

- changed file, rename, binary/generated/vendor 분류
- old/new line mapping과 hunk index
- base/head symbol 추출과 변경 symbol 판정
- file/line/symbol history, blame와 churn
- 직접 import/reference/caller와 관련 test 후보
- symbol/file/module/package의 structure parent/children과 dependency uses/used-by graph
- merge conflict와 resulting tree limitation

repository code, hook, build, test, package lifecycle script는 실행하지 않는다.

### 9.2 Review stage

Planner가 변경 규모와 file category에 따라 change pack을 만들고 다음 specialist를 선택한다.

- Correctness
- Security
- Compatibility
- Testing
- History/Impact

각 specialist는 필요한 diff, symbol, reference와 policy만 받는다. model에는 shell, arbitrary path, Git option, URL 또는 network tool을 제공하지 않는다.

### 9.3 Evidence verifier

- finding line이 현재 head diff에 존재하는지 확인
- symbol/reference가 analyzer artifact에 존재하는지 확인
- 변경 전부터 존재했고 악화되지 않은 문제인지 확인
- 같은 원인의 중복 finding 제거
- 근거가 약한 P3 제거 또는 confidence 하향

### 9.4 Priority와 confidence

| Priority | 의미 | 기본 처리 |
|---|---|---|
| P0 | 검토할 가치가 있는 좋은 변경 | positive/file-level observation |
| P1 | 선택적 개선 또는 정보 | advisory |
| P2 | merge 전에 reviewer가 확인할 결함 가능성 | 확인 필요 |
| P3 | 직접적인 보안, data loss, build 불가 또는 치명 오류 | 높은 confidence와 직접 evidence 필수 |

confidence는 `low | medium | high`이며 priority와 별도 축으로 표시한다.

### 9.5 Commit Defender report 계승

Commit Defender `AnalysisReport schema_version: 1`의 summary, grade, per-file summary, P0-P3/category와 lint/AI normalization을 versioned compatibility baseline으로 사용한다. 새 report는 여기에 snapshot identity, confidence, verified evidence, coverage, limitation, merge simulation과 `ImpactReport`를 추가한다. VS Code API, pre-commit blocking과 local credential 동작은 서버로 가져오지 않는다.

P3 존재 여부는 `hasCriticalFindings`로 계산해 review attention을 표시하지만 GitHub merge status나 merge simulation 결과로 해석하지 않는다. 변경 line의 actionable finding과 변경되지 않은 parent/child·caller/importer/consumer 영향은 분리한다.

Object 탐색은 GitHub code navigation의 definition/reference 경험과 dependency path를 참고하되 service가 만든 revision 고정 relationship artifact를 정본으로 삼는다. Package manifest/lockfile의 direct/transitive dependency도 표시하지만 외부 repository dependents를 추정하지 않고 coverage limitation으로 남긴다.

## 10. Browser Review Workspace

기준 UI는 다음 visual artifact를 따른다.

- `.documents/visuals/review-workspace.html`
- `.documents/visuals/review-workspace-preview.png`

```text
┌──────────────────────────────────────────────────────────────────────┐
│ Global: product · repository switcher · user                        │
│ PR: refs · analysis · coverage · merge state · refresh              │
├──────────────┬───────────────────────────────────┬───────────────────┤
│ LNB          │ Main                              │ Chat              │
│ Files        │ split/unified diff                │ snapshot scope    │
│ Findings     │ file/symbol/commit                │ evidence links    │
│ Outline      │ selected tool maximized           │ composer          │
│ Impact       │                                   │                   │
├──────────────┴───────────────────────────────────┴───────────────────┤
│ FNB: Evidence · Git graph · History · Ownership · Impact · Tests    │
└──────────────────────────────────────────────────────────────────────┘
```

- Finding 선택은 Main diff, FNB evidence와 Chat scope를 하나의 transaction으로 맞춘다.
- Findings 상단은 grade/summary/per-file summary를 제공하고 report/finding/evidence는 공유 가능한 revision 고정 link를 가진다.
- Impact는 `Structure` parent/children과 `Dependencies` uses/used-by를 구분하고 edge evidence와 PR 전후 변화를 표시한다.
- file/line/symbol/commit은 내부 deep link와 registered GHES의 exact-SHA permalink를 제공한다.
- Chat은 desktop에서 항상 보이며 finding panel과 tab으로 경쟁하지 않는다.
- 모든 query key와 URL에는 analysis revision 또는 snapshot ID가 포함된다.
- browser reload 후에도 같은 report URL과 selection을 복원한다.
- localStorage에는 panel size, tab과 locale만 저장하며 source와 Chat 원문은 저장하지 않는다.
- diff, tree, graph는 virtualize하고 partial/omitted 상태를 구분한다.

## 11. Chat

conversation은 `analysis_revision_id`에 고정한다. 새 head 분석이 완료되어도 기존 답변의 근거를 조용히 바꾸지 않는다.

허용 tool:

- report/finding 조회
- snapshot file과 line 조회
- symbol definition/reference
- code object parent/children과 uses/used-by relation
- history/blame
- dependency/impact와 related test
- canonical diff와 merge simulation

답변에는 file, line, symbol, commit 또는 analyzer artifact citation이 있어야 한다. 사용자 질문과 repository text는 모두 untrusted input으로 처리한다.

자동 분석과 remote Chat은 browser가 닫혀도 동작해야 하므로 조직이 승인한 server-side credential을 사용한다. Worker는 batch 분석을, Server는 interactive Chat을 호출한다. 시스템 관리자는 여러 Chat account와 account별 model/reasoning effort capability, assignment와 quota를 등록한다. 일반 사용자는 자신에게 허용된 account, model과 effort를 고르고 이 선택은 analysis revision과 함께 Chat session에 고정된다. Credential과 refresh 결과는 deployment master key로 암호화한 PostgreSQL row에 보존하며 host home 자동 mount와 사용자 local CLI credential 암묵 재사용은 금지한다. 상세 설계는 [Chat account registry와 GHES repository 관리 설계](account-and-ghes-administration-design.md)를 따른다.

## 12. 데이터와 API

### 12.1 주요 entity

| Entity | 목적 |
|---|---|
| `users` | OIDC subject와 profile |
| `repositories` | 등록 GHES repository와 installation scope |
| `pull_requests` | 현재 PR state와 observed refs |
| `poll_states` | checkpoint, interval, quota, backoff |
| `snapshot_requests` | 관측한 repository/PR/base/head 요청과 dedupe identity |
| `snapshots` | append-only materialization과 merge-base resolution |
| `analysis_runs` | profile/version/status/timing/limitation |
| `jobs` | PostgreSQL lease 기반 durable work |
| `operations` | manual refresh 같은 비동기 요청의 상태와 결과 |
| `event_log` | PR 범위 durable progress와 replica fan-out |
| `artifacts` | version, checksum, storage locator |
| `reports` | immutable analysis revision |
| `findings` | priority, confidence, anchor, evidence |
| `chat_sessions` | user와 analysis revision scope |
| `chat_messages` | content reference, citations, usage |
| `audit_events` | actor/action/resource/outcome metadata |

### 12.2 Browser API 경계

Browser API는 repository/PR worklist, refresh operation, immutable analysis, snapshot/analysis artifact, Chat과 admin resource로 나눈다. Poll/snapshot/analysis 상태는 PR 범위 durable SSE로 전달하고 Chat delta는 session 범위 stream으로 분리한다. Route, response identity, operation schema와 event catalogue의 정본은 [기능 설계서](functional-design.md#7-api-contract)다.

## 13. 보안과 privacy

- browser 사용자는 application OIDC를 기본으로 인증하고 repository grant를 확인한다. Reverse proxy identity는 signed assertion 검증, client header 제거와 ingress network 제한을 모두 만족할 때만 사용한다.
- GHES·Chat credential은 deployment master key로 암호화한 DB row로 보존하고 master key, OIDC와 DB secret만 Secret 또는 vault reference로 주입한다.
- source, diff, prompt와 model response를 application log와 trace attribute에 넣지 않는다.
- artifact volume과 database는 암호화하고 report/chat retention을 설정한다.
- worker filesystem path는 server-generated run ID만 사용한다.
- Git config/hook, symlink escape, submodule/LFS 자동 fetch와 command injection을 차단한다.
- server와 worker egress는 각 workload가 실제 사용하는 GHES, model, PostgreSQL, artifact backend와 필수 infrastructure로 제한한다.
- model tool handler가 repository, snapshot과 path scope를 server-side에서 강제한다.
- Markdown과 code rendering은 sanitize하고 raw HTML, unsafe URL과 외부 image/script를 허용하지 않는다. CSP와 referrer/content-type/permissions header를 적용하고 HSTS는 ingress/platform 정책으로 둔다.

## 14. 신뢰성과 운영 목표

| 항목 | MVP 목표 |
|---|---|
| poll tier | 초기 hot/active/idle 60초/5분/15분, 실측 후 확정 |
| manual refresh | 10초 안에 조회 시작 또는 지연 사유 표시 |
| 일반 PR 분석 | 100 files, 5,000 changed lines 이하 5분 내 completed/partial |
| UI metadata API | p95 500ms 이내 |
| 중복 run | 동일 analysis key당 하나 |
| worker recovery | lease 만료 후 재실행, 완료 stage/artifact 재사용 |
| workspace cleanup | run 종료 직후 또는 같은 worker의 startup/periodic cleanup |
| persistent cleanup | retention CronJob의 bounded batch와 deletion grace |

운영 metric은 poll lag, queue age, clone bytes/time, analyzer coverage, model latency/token/error, SSE disconnect, authorization denial과 cleanup failure를 포함한다. label에는 repository name, path와 source를 넣지 않는다.

## 15. Container image와 Helm 배포

논리 architecture는 `Server`와 `Worker`로 유지하지만 실제 운영 단위는 사내 Kubernetes workload다.

```text
Ingress / internal load balancer
  -> server Deployment -> Service
  -> worker Deployment
  -> scheduler leader in server replicas
  -> PostgreSQL Service 또는 사내 managed PostgreSQL
  -> artifact PVC (RWX)
  -> worker scratch volume (emptyDir 또는 generic ephemeral RWO PVC)
  -> retention CronJob
```

### 15.1 OCI image

하나의 immutable OCI image에 web static asset, server와 worker executable을 포함하고 command만 분리한다.

```text
git-code-reviewer serve
git-code-reviewer worker
git-code-reviewer migrate
git-code-reviewer retention
git-code-reviewer retention --reconcile
```

- image는 non-root UID/GID로 실행하고 read-only root filesystem을 지원한다.
- application log는 stdout/stderr로만 내보내고 source와 secret을 기록하지 않는다.
- image tag 외에 digest를 Helm value로 고정할 수 있어야 한다.
- build 결과에 dependency manifest, SBOM과 source revision label을 포함한다.
- runtime secret은 image layer와 Helm values plain text에 넣지 않는다.
- server와 worker의 current/previous version은 rolling update 동안 같은 DB schema와 job contract를 읽을 수 있어야 한다.

### 15.2 Helm chart

repository의 `deploy/helm/git-code-reviewer` chart는 다음 resource를 관리한다.

- `Deployment/server`, `Service/server`, `Ingress`
- `Deployment/worker`
- `ServiceAccount`, 최소 RBAC, pod/container security context
- `ConfigMap`과 external secret reference 또는 `Secret`
- `PersistentVolumeClaim/artifacts`
- optional worker generic ephemeral `volumeClaimTemplate`
- pre-install/pre-upgrade migration `Job`
- retention `CronJob`
- `NetworkPolicy`, `PodDisruptionBudget`
- optional `HorizontalPodAutoscaler`

`values.yaml`은 image/digest, workload replica와 resource, ingress, DB pool/Secret, workspace/artifact backend, model/Chat limit, retention과 external Secret reference를 typed contract로 제공한다. 환경별 값만 바꾸며 source code나 image를 다시 만들지 않는다. Canonical values tree와 조건 검증은 [기능 설계서](functional-design.md#113-values-contract)를 따른다. 특히 `chatDays <= reportDays`는 application startup과 Helm template `fail`에서 모두 검사한다.

### 15.3 PV/PVC contract

- **Artifact PVC:** report, diff index와 analyzer artifact를 보존한다. 여러 replica가 읽으므로 RWX를 권장한다.
- **Workspace volume:** clone과 worktree 전용이다. 기본은 size limit이 있는 `emptyDir`이며 persistent scratch가 필요할 때 Deployment pod별 generic ephemeral claim으로 RWO PVC를 만든다.
- **PostgreSQL volume:** DB를 cluster 안에서 운영할 때만 database chart 또는 별도 운영 chart가 PVC를 관리한다. application chart는 기본적으로 existing PostgreSQL endpoint를 받는다.
- browser는 API를 통해서만 source를 읽는다. Server는 artifact read-only, Worker와 retention은 필요한 범위에서 artifact write, Worker만 workspace read/write를 허용한다.
- PVC expansion, snapshot/backup, reclaim policy와 encryption은 cluster storage 운영 기준에 따른다.

### 15.4 Rollout과 lifecycle

- migration은 application rollout 전에 Helm pre-install/pre-upgrade Job으로 실행하고 DB advisory lock으로 중복 실행을 막으며 재실행 가능해야 한다.
- migration은 expand/contract 순서를 지켜 current/previous pod가 함께 동작하는 기간을 허용한다.
- startup probe는 config/schema compatibility, liveness는 process/event loop, readiness는 HTTP와 핵심 DB 처리 가능 여부를 확인한다. Artifact/GHES/model 상태는 별도 dependency health로 노출한다.
- worker는 SIGTERM 수신 후 새 job claim을 중단하고 진행 run을 grace period 안에 마치거나 lease를 반환한다.
- liveness는 process deadlock만 탐지하고 외부 GHES/model 장애 때문에 pod를 재시작하지 않는다.
- scheduler는 PostgreSQL advisory lock으로 replica 중 하나만 due target을 예약한다.
- retention CronJob은 singleton lease로 persistent orphan과 만료 report/chat/source/event를 정리하며 restore 후에는 `retention --reconcile`을 별도 실행한다.
- rollback은 image/chart rollback과 DB 호환 범위를 함께 확인한다. destructive migration은 같은 release에 넣지 않는다.

### 15.5 CI/CD와의 경계

제품 동작은 대상 repository의 GitHub Actions, build pipeline이나 Check gate에 의존하지 않는다. Git Code Reviewer 자체를 배포하기 위한 최소 delivery 흐름만 둔다.

```text
test -> build OCI image -> scan/sign -> push registry
     -> package/lint Helm chart -> helm upgrade --install
```

초기에는 이 절차를 운영 runbook으로 실행할 수 있다. 자동 pipeline은 조직 표준이 정해진 뒤 추가하며 제품 domain과 분리한다.

## 16. 구현 단계

Milestone task와 완료 조건의 정본은 [구현 계획서](implementation-plan.md)다.

| Milestone | 범위 |
|---|---|
| M0-00 Feasibility | 실제 GHES, Git, model, storage/OIDC 제약 검증과 DEC 입력 수집 |
| M0 Foundation | application/image/chart skeleton과 migration/retention command |
| M1 Worklist | application OIDC, repository registry, poll tier와 authorization |
| M2 Snapshot | operation/event/job, request/materialization, isolated clone과 diff |
| M3 Review | bounded analyzer/model/verifier와 immutable partial report |
| M4 Workspace | revision-bound UI, durable progress SSE와 Server-side Chat |
| M5 Pilot | retention, backup/reconcile, upgrade/rollback과 security hardening |

## 17. 구현 전 결정 gate

결정 ID와 상태의 정본은 [요구사항 명세서](requirements-specification.md#15-구현-전-확정-항목)의 `DEC-001`부터 `DEC-019`다. M0-00에서 GHES version/access-token/API/Git, fork/pull-ref, partial clone/deepen, rate-limit, Chat account/model/effort, model data policy, OIDC와 storage viability를 실제 환경으로 확인한다. 확인되지 않은 값은 조직 정책처럼 hard-code하지 않고 typed config와 명시적 validation error로 남긴다.

## 18. 참고 자료

- Commit Defender의 `github-enterprise-pr-analysis-server-design.md` 초안(별도 repository)
- [GitHub App installation 인증](https://docs.github.com/en/enterprise-server@3.20/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app-installation)
- [GHES Pull Request REST API](https://docs.github.com/en/enterprise-server@3.20/rest/pulls/pulls)
- [GHES REST API best practices](https://docs.github.com/en/enterprise-server@3.20/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
- [Git clone options](https://git-scm.com/docs/git-clone)
- [GitHub code navigation](https://docs.github.com/en/repositories/working-with-files/using-files/navigating-code-on-github)
- [GHES permanent file links](https://docs.github.com/en/enterprise-server@3.20/repositories/working-with-files/using-files/getting-permanent-links-to-files)
- [GHES repository dependency graph](https://docs.github.com/en/enterprise-server@3.19/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/explore-dependencies)
- [Kubernetes Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)
- [Kubernetes Generic Ephemeral Volumes](https://kubernetes.io/docs/concepts/storage/ephemeral-volumes/)
- [Kubernetes Probes](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/#container-probes)
- [Kubernetes Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)
- [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)
- [Kubernetes Secrets](https://kubernetes.io/docs/concepts/configuration/secret/)
- [Helm Charts](https://helm.sh/docs/topics/charts/)
- [PostgreSQL NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)

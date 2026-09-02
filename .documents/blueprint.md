# Git Code Reviewer — Blueprint

## 1. 문서 목적

이 문서는 private GitHub 저장소의 pull request(PR)를 분석하고, code reviewer가 변경의 위험과 근거를 빠르게 확인하며, 분석 결과를 두고 대화할 수 있는 agent system의 제품·기술 설계를 정의한다.

초기 구현은 GitHub Enterprise Cloud와 GitHub Enterprise Server(GHES)를 모두 고려하되, 하나의 조직과 제한된 저장소에서 동작하는 배포 가능한 MVP를 목표로 한다. 기준 배포는 사내망의 중앙 service가 고정된 대표 egress IP를 통해 GitHub API와 Git endpoint를 조회하는 outbound-only 구조다. GitHub에서 사내망으로 시작하는 inbound 연결은 요구하지 않는다. 문서에 명시한 기술 스택은 기준 구현안이며 조직의 표준 인프라에 맞게 같은 경계를 유지한 채 교체할 수 있다.

구현 시 검수 가능한 상세 요건은 [요건정의서](./requirements-specification.md), component·state·API·event 동작은 [기능설계서](./functional-design.md), 실제 개발 순서와 logical commit 경계는 [구현계획서](./implementation-plan.md)를 따른다. 이 blueprint와 상세 문서가 충돌하면 상세 문서의 요건 ID와 명시된 미정 사항을 먼저 확인하고 문서를 함께 정정한다.

## 2. 목표와 범위

### 2.1 목표

- PR의 `base`, `merge-base`, `head`를 고정한 분석 snapshot을 만들고 전체 diff와 commit별 diff를 설명한다.
- correctness, security, compatibility, test coverage, maintainability 관점의 finding을 코드 근거와 함께 제시한다.
- 변경 파일에서 시작해 연관 symbol, 호출부, 의존 모듈, test, 소유자, 과거 변경 및 관련 PR까지 탐색한다.
- reviewer가 resizable LNB, split diff, evidence/history/graph tool을 오가며 finding을 확인하고, 화면에서 Chat을 닫지 않은 채 같은 snapshot 문맥으로 agent와 대화하게 한다.
- 분석이 불완전하거나 추론에 의존하는 부분을 명시해 reviewer가 merge 판단의 책임과 근거를 유지하게 한다.
- private code가 허가받지 않은 모델, 저장소, 로그 또는 telemetry로 유출되지 않게 한다.

### 2.2 MVP 범위

- GitHub App 설치와 installation token을 사용한 private repository 읽기
- repository별 PR polling과 사용자 refresh에 따른 `opened`, `reopened`, head 변경, draft 해제 감지 및 분석 실행
- PR 전체 diff 및 commit별 diff, 파일 변경 요약, rename 감지
- 변경 파일과 직접 연관된 symbol 및 import/dependency 탐색
- `git log`, `git blame`, `git show` 기반의 파일·line·소유자 history
- 근거가 있는 priority finding과 PR 전체 요약
- resizable LNB/Main/Chat/FNB workspace, file tree, Findings 정리, split diff, compact evidence/history, 분석 진행 상태
- Findings와 동시에 표시되며 snapshot 범위 안에서 동작하는 persistent Chat dock
- PR 중심 Git graph와 file/symbol history tool
- GitHub Check에 분석 상태와 요약 게시. inline review comment 게시는 설정으로 선택
- repository별 규칙, 제외 경로, inline skip directive, 결과 상세도 설정

### 2.3 후속 범위

- 여러 PR 사이의 symbol-level 변경 충돌과 회귀 패턴 비교
- function/class rename 및 이동을 포함한 장기 symbol history
- 언어별 정적 분석기, test coverage, SAST/SCA 결과 결합
- branch graph의 대규모 repository 최적화
- 재현 가능한 test predicate를 이용한 sandboxed `git bisect`
- 조직 단위 품질 추세와 reviewer feedback 기반 평가

### 2.4 범위에서 제외하는 것

- 사람의 승인 없이 source branch를 수정하거나 merge하는 기능
- LLM 판단만으로 merge를 차단하는 기능
- PR과 무관한 repository 전체를 상시 색인하는 범용 code search
- 임의 shell command를 실행하는 chat agent
- test predicate가 없는 상태에서 원인 commit을 단정하는 자동 `git bisect`

## 3. 설계 원칙

1. **snapshot이 분석의 단위다.** 모든 report, finding, diff anchor, 대화는 `repository + PR number + base SHA + merge-base SHA + head SHA`에 귀속된다.
2. **수집과 추론을 분리한다.** Git, parser, 정적 분석기가 사실을 수집하고 LLM은 그 사실을 선택·연결·설명한다.
3. **finding에는 검증 가능한 근거가 있어야 한다.** 파일과 line만 제시하지 않고 관련 hunk, symbol, 호출부, commit 또는 분석기 결과를 연결한다.
4. **불확실성을 priority와 분리한다.** 영향이 크더라도 근거가 약하면 낮은 confidence로 표시하며, 추측만으로 blocking finding을 만들지 않는다.
5. **새 head SHA가 이전 결과를 무효화한다.** 진행 중인 작업은 취소하거나 superseded로 끝내고, UI와 GitHub Check에서 이전 결과를 stale로 표시한다.
6. **코드와 PR 본문은 신뢰하지 않는 입력이다.** 코드 주석에 포함된 명령을 agent instruction으로 취급하지 않으며, agent tool은 구조화된 read-only query만 허용한다.
7. **작은 PR과 큰 PR의 처리 경로를 나눈다.** 입력이 한도를 넘으면 무작위로 자르지 않고 파일 분할 분석, 중요 경로 우선순위, 생략 내역을 report에 기록한다.
8. **사람이 최종 판단한다.** P3는 정책상 merge gate의 입력이 될 수 있지만, 기본값은 reviewer가 확인하는 Check 결과다.

## 4. 사용자와 주요 시나리오

### 4.1 사용자

- **Code reviewer:** 변경의 의도, 위험, 영향 범위와 누락된 test를 확인하고 질문한다.
- **PR author:** finding의 근거를 확인하고 수정하거나 합당한 이유로 suppression을 요청한다.
- **Repository administrator:** GitHub App 권한, 분석 정책, 모델, 보존 기간, merge gate를 설정한다.
- **Security/audit 담당자:** 누가 어떤 코드에 접근했고 어떤 모델로 분석했는지 확인한다.

### 4.2 주요 흐름

#### PR이 열리거나 새 commit이 push됨

1. Poll Scheduler가 설치 및 repository 목록을 순회하며 active/idle 정책에 따라 PR 조회 작업을 예약한다. reviewer가 PR 화면을 열거나 refresh를 요청하면 해당 PR 조회를 우선 예약한다.
2. PR Poller가 installation token으로 open PR의 `base SHA`, `head SHA`, state, draft 상태를 조회하고 저장된 poll cursor 및 마지막 관측 상태와 비교한다.
3. 새 PR, reopen, base/head 변경 또는 draft 해제를 감지하면 `GitHub host + repository ID + PR number + base SHA + head SHA` idempotency key로 snapshot 요청을 만든다. 동일 ref의 반복 조회는 snapshot을 중복 생성하지 않으며, reopen이나 draft 해제처럼 ref가 같을 수 있는 transition은 기존 snapshot에 필요한 분석 run만 예약한다.
4. 수집 worker가 PR metadata와 ref를 재확인하고 repository mirror를 갱신한다.
5. `base SHA`, `merge-base SHA`, `head SHA`를 기록해 immutable snapshot을 만든다.
6. Git/AST analyzer가 diff, commit, symbol, dependency, test, history, ownership evidence를 생성한다.
7. Review Orchestrator가 변경 규모와 파일 종류에 따라 specialist review를 실행한다.
8. Evidence Verifier가 잘못된 line anchor, 중복 finding, 근거 없는 단정을 제거하거나 confidence를 낮춘다.
9. report를 저장하고 UI stream 및 outbound GitHub Check 요청으로 결과를 갱신한다.
10. 처리 중 poll 또는 게시 직전 조회에서 더 최신 `head SHA`가 확인되면 현재 run을 `superseded`로 끝내고 최신 snapshot을 처리한다.

#### Reviewer가 finding을 조사함

1. reviewer가 finding을 선택한다.
2. split diff가 해당 hunk와 line을 열고, 관련 호출부와 history를 side panel에 표시한다.
3. reviewer가 “이 변경이 기존 retry 동작을 깨뜨리나?”처럼 질문한다.
4. Chat Agent는 현재 snapshot의 evidence와 허용된 history query만 사용해 답한다.
5. 답변의 각 기술적 주장에는 파일/line, symbol, commit 또는 analyzer artifact 링크가 붙는다.

#### `git bisect`를 실행함

1. 사용자가 good commit, bad commit, 재현 command를 명시한다.
2. 시스템이 command와 timeout, network 정책, secret 접근 범위를 보여주고 실행 승인을 받는다.
3. 격리된 disposable workspace에서 `git bisect run`을 수행한다.
4. 실행 log와 first-bad commit을 제시하되, flaky test나 skip 결과가 있으면 확정 결과로 표현하지 않는다.

## 5. 시스템 구성

```text
┌──────────────────────┐       ┌──────────────────────────────────────┐
│ GitHub Cloud / GHES  │       │ Reviewer Browser                     │
│ API · GraphQL · Git  │       │ file tree · diff · history · chat    │
└──────────▲───────────┘       └──────────────────┬───────────────────┘
           │ outbound HTTPS only                 │ internal HTTPS + SSE
           │ fixed egress IP                     ▼
┌──────────┴───────────┐       ┌──────────────────────────────────────┐
│ GitHub Adapter       │       │ API / BFF                            │
│ Poller / Publisher   │◄──────│ auth · tenancy · query · refresh     │
│ cursor · quota       │       │ chat stream                          │
└──────────┬───────────┘       └───────────────┬──────────────────────┘
           │ job                               │
           ▼                                   ▼
┌─────────────────────────┐   ┌───────────────────────────────────────┐
│ Workflow Queue          │   │ PostgreSQL                            │
│ dedupe · retry · cancel │   │ poll state · report · chat · audit    │
└───────────┬─────────────┘   └────────────────┬──────────────────────┘
            ▼                                  │
┌─────────────────────────┐   ┌────────────────▼──────────────────────┐
│ Analysis Worker         │   │ Object Storage                        │
│                         │   │ large diff · graph · analyzer artifact│
│ Git/AST analyzers       │   └───────────────────────────────────────┘
│ Review Orchestrator     │
│ Evidence Verifier       │   ┌───────────────────────────────────────┐
│ Report Composer         ├──►│ Approved Model Gateway                │
└───────────┬─────────────┘   │ private endpoint · policy · metering   │
            ▼                 └───────────────────────────────────────┘
┌─────────────────────────┐
│ Ephemeral Git Workspace │
│ bare mirror + worktree  │
└─────────────────────────┘

GitHub initiates no connection to the internal network.
```

### 5.1 기준 기술 스택

| 영역 | 기준 구현 | 선택 이유 |
|---|---|---|
| Monorepo | pnpm workspace + Turborepo | UI, API, worker와 공유 contract를 한 언어로 관리 |
| Web | Next.js + React + TypeScript | server-side auth와 review UI를 함께 구성 |
| Code/diff/graph UI | Monaco Editor, custom virtualized tree/timeline/graph | split diff, line anchor, PR 중심 Git graph와 큰 artifact rendering 제어 |
| API | Fastify + TypeScript | refresh command와 streaming API를 독립 process로 운영 |
| Queue | Redis + BullMQ | MVP의 retry, dedupe, progress, cancellation 구현 |
| Scheduler | BullMQ Job Scheduler + PostgreSQL lease | active/idle polling 예약과 다중 replica의 중복 순회 방지 |
| Database | PostgreSQL | tenant 경계, snapshot, finding, chat, audit의 관계 보존 |
| Artifact | S3-compatible object storage | 큰 diff, graph, analyzer 결과를 DB 밖에 보존 |
| Git | system Git CLI를 인자 배열로 호출 | merge-base, rename, log, blame, show 동작 재사용 |
| Parser | Tree-sitter adapter | 여러 언어의 symbol 범위를 공통 contract로 변환 |
| Model access | provider-neutral internal gateway | 모델 허용 목록, data residency, 비용과 감사 정책 집중 |
| Transport | REST + SSE | query/command와 분석·chat token stream을 단순하게 분리 |

초기에는 사내 VM 또는 Kubernetes의 modular monolith로 배포한다. `web`, `api`, `poller`, `worker` process는 나누되 domain package와 database를 공유한다. `worker`는 Git CLI, parser, analyzer와 sandbox 정책이 필요하고 web/API와 scaling·resource·network profile이 다르므로 별도 OCI image로 빌드한다. CI/CD는 이 image를 만들고 배포할 뿐 PR 분석 job을 직접 실행하지 않으며, 배포된 worker가 사내 queue를 상시 소비한다. 사용자는 사내망 또는 VPN을 통해 web에 접근하고, GitHub 통신은 대표 egress IP를 가진 경로로만 나간다. 처리량이나 격리 요구가 확인된 뒤 analyzer와 model orchestration을 별도 service로 분리한다.

### 5.2 제안 source layout

```text
apps/
├── web/                       # resizable review workspace, diff, persistent chat, graph tools
├── api/                       # REST, SSE, auth, manual refresh
├── poller/                    # installation/repository/PR polling scheduler
└── worker/                    # snapshot, analysis, publish workers
packages/
├── contracts/                # versioned API/event/report schemas
├── domain/                   # snapshot, run, finding, policy rules
├── db/                       # schema, migrations, tenant-aware repositories
├── github/                   # App auth, API clients, Check publisher
├── git/                      # mirror/worktree lifecycle and safe Git commands
├── analyzers/
│   ├── diff/
│   ├── history/
│   ├── ownership/
│   ├── symbols/
│   └── dependency/
├── agent/                    # tools, prompts, orchestrator, verifier
├── policy/                   # priority, suppression, repository config
└── observability/            # structured logs, trace, metrics, audit helpers
ci/
└── worker-image.yml          # CI provider가 호출하는 build/test/scan/sign/push/deploy pipeline
infra/
├── containers/
│   └── worker.Dockerfile     # pinned Git/parser/analyzer를 넣는 multi-stage build
├── kubernetes/worker/
│   ├── deployment.yaml       # image digest, resources, probes, config/secret reference
│   ├── service-account.yaml  # workload identity binding
│   └── network-policy.yaml   # queue/data/model/GitHub egress만 허용
└── terraform/
```

### 5.3 Worker image와 CI/CD delivery contract

`worker` image는 `web`, `api`, `poller` image와 독립적으로 versioning한다. 기준 image reference는 `registry.example.internal/git-code-reviewer/worker@sha256:<digest>`이며 production manifest에서 mutable tag인 `latest`를 사용하지 않는다. 같은 source revision으로 다시 build해도 digest와 provenance가 다르면 별도 release로 취급한다.

CI/CD 흐름은 다음과 같다.

1. self-hosted CI/CD runner가 repository를 checkout하고 lockfile, worker unit/integration test와 manifest validation을 실행한다. 외부 control plane을 쓰는 runner는 내부 inbound port를 열지 않고 outbound job polling으로 작업을 가져온다.
2. `infra/containers/worker.Dockerfile`로 multi-stage build를 실행한다. runtime layer에는 compiled worker, production dependency, 버전을 고정한 Git CLI, CA trust bundle, Tree-sitter parser와 승인된 deterministic analyzer만 남긴다.
3. image를 non-root user, read-only root filesystem 전제로 검사하고 vulnerability scan, SBOM, provenance와 signature를 생성한다. build secret이 필요하면 BuildKit secret mount처럼 layer와 build log에 남지 않는 기능을 사용한다.
4. CI workload identity 또는 짧은 수명의 registry credential로 image와 metadata를 사내 registry에 push한다.
5. 검증된 digest를 `infra/kubernetes/worker/deployment.yaml` 또는 동등한 VM deployment descriptor에 전달한다. deployment controller가 digest, runtime ConfigMap/Secret reference와 service account binding을 적용하고 readiness·queue smoke test 뒤 rollout을 완료한다.

정보는 다음 경계에 둔다.

| 위치 | 저장하는 정보 | 전달 방식 | 두지 않는 정보 |
|---|---|---|---|
| Git repository | worker source, lockfile, Dockerfile, deployment template, NetworkPolicy, 설정 key schema | CI checkout | credential 실제 값, private key, production token |
| CI variable store | `REGISTRY_HOST`, `WORKER_IMAGE_REPOSITORY`, target environment/namespace, scan policy | pipeline parameter | GitHub App private key, DB/Redis/model password |
| CI identity/secret store | registry push와 deploy 권한. 가능하면 OIDC/workload identity와 짧은 수명 token 사용 | job 실행 시 runner에 한시적으로 발급 | application runtime secret, repository source를 읽는 installation token |
| Worker OCI image | compiled worker, pinned runtime/toolchain, parser/analyzer, CA bundle, build metadata label | registry에서 digest로 pull | 환경별 endpoint, credential, repository clone, 분석 artifact |
| Container registry | immutable image digest, SBOM, signature, provenance, scan result | deploy admission과 runtime pull | plaintext application secret |
| Deployment manifest | image digest, command, replica/resource/probe, volume, ConfigMap/Secret reference, service account | GitOps 또는 deploy controller | secret 실제 값, mutable `latest` tag |
| Runtime ConfigMap/환경 설정 | GitHub host/API URL, queue·DB·object storage host/name, model profile, concurrency, timeout, log level | container start 시 env 또는 read-only file | password, private key, access token |
| Secret manager/workload identity | GitHub App private key, DB/Redis credential, object storage credential, model gateway token 또는 이를 발급할 identity | CSI/read-only file 또는 identity token exchange. process 시작·rotation 시 조회 | image layer, repository, queue payload로의 복사 |
| Queue job | `tenant_id`, `repository_id`, `snapshot_id`, `run_id`, stage, retry/idempotency metadata | BullMQ message | source text, private key, installation token |
| Ephemeral Git volume | 해당 job의 bare mirror/worktree와 analyzer scratch | worker가 runtime credential로 fetch하고 job 종료/TTL에 삭제 | image build 시점 repository clone, 장기 credential |

권장 runtime key는 아래처럼 비밀 값과 reference를 분리한다. endpoint 이름 자체가 조직 정책상 민감하면 ConfigMap 대신 secret manager에서 함께 관리한다.

```text
# non-secret runtime config
GCR_GITHUB_APP_ID
GCR_GITHUB_WEB_URL
GCR_GITHUB_API_URL
GCR_GITHUB_GRAPHQL_URL
GCR_REDIS_HOST / GCR_REDIS_PORT
GCR_DATABASE_HOST / GCR_DATABASE_NAME
GCR_OBJECT_BUCKET
GCR_MODEL_PROFILE
GCR_WORKER_CONCURRENCY
GCR_JOB_TIMEOUT_MS
GCR_GIT_WORKDIR
GCR_LOG_LEVEL

# secret file reference or workload identity binding
GCR_GITHUB_APP_PRIVATE_KEY_FILE
GCR_DATABASE_PASSWORD_FILE
GCR_REDIS_PASSWORD_FILE
GCR_MODEL_TOKEN_FILE
```

worker는 queue의 ID로 tenant와 snapshot을 확인한 뒤 실행 시점에 GitHub App key를 읽거나 workload identity로 사내 credential broker를 호출해 짧은 수명의 installation token을 발급받는다. 그 token으로 허용된 ref만 ephemeral volume에 fetch한다. token, source와 prompt는 queue, image, CI artifact와 application log에 기록하지 않는다.

## 6. Component 책임

### 6.1 GitHub Adapter

- GitHub App JWT와 installation access token 발급
- GitHub Cloud/GHES별 `web_url`, `api_url`, GraphQL URL 구성
- installation, repository, PR metadata, commit, review, check-run 조회 및 게시
- HTTP Git 인증을 사용한 제한된 ref fetch
- 여러 PR의 ref/state는 GraphQL query로 모으고, 안정적인 REST `GET` endpoint는 인증된 conditional request로 조회
- primary/secondary rate limit, 응답의 quota 정보를 구분한 backoff와 host별 요청 예산 관리

최소 repository permission은 다음과 같이 시작한다.

- `Contents: Read` — Git fetch와 blob 조회
- `Pull requests: Read` — PR, changed files, commits, review context 조회
- `Checks: Read and write` — 분석 진행 상태와 최종 요약 게시
- `Metadata: Read` — repository 기본 정보

inline review comment를 게시할 때만 `Pull requests: Write`를 요구한다. 조직 정책이나 CODEOWNERS 정보를 API로 읽어야 할 때 필요한 권한은 해당 기능을 켠 설치에만 추가한다.

### 6.2 Snapshot Collector

Poll Scheduler와 PR Poller는 다음 상태를 repository 또는 installation 단위로 영속화한다.

- 마지막 성공 poll 시각, pagination cursor, conditional request validator(`ETag`, `Last-Modified`)
- PR별 마지막 관측 `base_ref_oid`, `head_oid`, state, draft 상태와 `updated_at`
- GitHub host와 installation별 남은 API quota, reset 시각, `x-poll-interval`, backoff와 다음 실행 시각

`updated_at`은 조회 후보를 줄이는 hint로만 쓰고 분석 여부는 `base_ref_oid`, `head_oid`와 PR 상태 변화로 판정한다. page 순회가 중단되면 마지막으로 완결된 checkpoint부터 재개하며, 전체 cycle이 끝나기 전에는 누락 PR을 closed로 간주하지 않는다. active PR, draft/idle PR, 비활성 repository의 poll interval을 분리하고 endpoint가 `x-poll-interval`을 반환하면 그보다 자주 조회하지 않는다. reviewer의 화면 진입 및 수동 refresh는 예약 queue에서 우선순위를 높인다. scheduler replica는 PostgreSQL lease를 획득한 shard만 순회하되, lease 만료나 중복 실행이 발생해도 snapshot idempotency key가 중복 run을 막는다.

snapshot은 다음 ref를 별도로 보존한다.

- `base_ref_oid`: poll 또는 refresh 시점 base branch tip
- `merge_base_oid`: `git merge-base base_ref_oid head_oid` 결과
- `head_oid`: 분석 대상 PR head
- `merge_ref_oid`: GitHub가 제공하고 실제 fetch가 가능한 경우의 test merge ref

PR 변경 분석은 기본적으로 `merge_base_oid...head_oid`의 변경을 사용한다. base branch 최신 상태와의 통합 위험은 별도의 mergeability 분석에서 `merge_ref_oid` 또는 임시 merge 결과로 다룬다. 이 둘을 섞으면 PR 자체 변경과 base branch 이동의 영향을 구분하기 어렵다.

repository별 bare mirror를 cache하고 run마다 detached worktree를 만든다. 외부 입력을 shell string으로 조합하지 않고 Git argument를 배열로 전달한다. fetch 대상 ref와 SHA 형식을 검증하며 worktree 경로는 시스템이 발급한 identifier로만 만든다.

기본 배포 mode는 `polling`이다. 보안 정책상 inbound가 허용되는 설치에 한해 `internal-webhook` 또는 DMZ가 event를 검증·정규화한 뒤 사내 queue가 outbound로 가져오는 `dmz-relay`를 선택 mode로 둘 수 있다. 어떤 mode에서도 snapshot 생성과 dedupe contract는 같으며 webhook은 MVP의 선행 조건이 아니다.

### 6.3 Deterministic Analyzer

#### Diff Analyzer

- `--find-renames`를 적용한 파일 상태와 hunk 계산
- added/deleted/context line을 old/new line coordinate로 정규화
- binary, generated, vendored, lock file을 분류
- 전체 PR diff와 각 commit의 parent diff를 별도 artifact로 저장
- merge commit은 first-parent만 임의 선택하지 않고 parent별 비교임을 표시

GitHub changed-files API는 빠른 목록 조회와 comment anchor 검증에 사용하되, 전체 분석의 유일한 입력으로 삼지 않는다. 대형 PR에서 API 응답 한도나 patch 생략이 발생할 수 있으므로 fetch한 Git object로 diff를 재구성한다.

#### Symbol Analyzer

- Tree-sitter adapter가 language별 AST를 `module`, `class`, `function`, `method`, `field`의 공통 symbol로 변환
- symbol key는 `language + qualified name + normalized signature`로 만들고 file path는 별도 속성으로 둔다.
- before/after AST를 비교해 added, modified, deleted, moved 후보를 계산
- parser 미지원 언어는 file/hunk 분석으로 낮추고 symbol 분석이 없음을 report에 기록

#### Dependency/Impact Analyzer

- import/include, build manifest, package workspace 관계로 module graph 생성
- changed symbol의 직접 caller/reference와 연관 test 후보 계산
- 정적 dispatch로 확정할 수 없는 동적 호출은 `possible` edge로 구분
- 영향도는 `changed`, `direct`, `transitive`, `unknown`으로 표현하고 탐색 깊이와 생략 수를 함께 저장

#### History/Ownership Analyzer

- file: `git log --follow`, rename, 최근 관련 commit
- line: snapshot과 일치하는 ref에 대한 `git blame --line-porcelain`
- symbol: AST range와 commit별 symbol fingerprint를 결합한 history
- commit: `git show` metadata와 patch, parent 관계
- PR: merge commit, branch metadata, GitHub의 commit/PR 연관 정보가 확인될 때만 연결

ownership은 최근 line 수만 세어 결정하지 않는다. 변경 line의 blame, 관련 symbol의 최근 변경자, CODEOWNERS, review history를 서로 다른 근거로 제시한다. author와 committer, PR author, reviewer를 별도 identity로 보존한다.

#### Churn/Related-change Analyzer

- file, module, symbol마다 설정한 history window 안의 변경 commit 수, additions/deletions, unique author 수, revert/fix 후속 변경을 계산한다.
- generated file, bulk formatting, repository import처럼 수치를 왜곡하는 commit은 분류해 별도 표시한다.
- churn 수치만으로 위험을 판정하지 않고 현재 PR의 변경 집중도, ownership 분산, 같은 영역의 최근 결함 수정과 함께 evidence로 제공한다.
- 과거 PR 비교는 공통 file/symbol, dependency edge, finding category를 기준으로 후보를 찾고 실제 commit 도달 관계와 GitHub PR 연결을 검증한다.
- 관련 PR의 결론이나 discussion을 현재 PR에 그대로 적용하지 않는다. 당시 base/head, 변경된 symbol, review outcome을 함께 보여 reviewer가 차이를 확인하게 한다.

### 6.4 Review Agent System

```text
Change Pack
    │
    ▼
Review Planner ──► 변경 규모, 언어, 위험 경로에 따라 review task 생성
    │
    ├── Correctness Reviewer
    ├── Security Reviewer
    ├── Compatibility Reviewer
    ├── Test Reviewer
    └── History/Churn Reviewer
             │
             ▼
Evidence Verifier ──► anchor 검증 · 반증 탐색 · 중복 제거 · priority 보정
             │
             ▼
Report Composer ──► overview · risk · file summary · findings · omissions
```

각 specialist는 전체 repository text를 직접 받지 않는다. planner가 만든 change pack에는 다음 자료만 포함한다.

- 해당 task의 diff hunk와 before/after symbol
- 직접 연관된 caller, dependency, test
- repository rule과 적용된 suppression
- 필요한 범위의 history 및 analyzer finding
- snapshot identity와 입력 생략 내역

모델이 호출할 수 있는 tool은 `get_diff_hunk`, `get_symbol`, `find_references`, `get_file_at_ref`, `get_history`, `get_blame`, `get_test_candidates`, `search_snapshot`처럼 typed read-only API로 제한한다. 임의 path 읽기, arbitrary Git option, shell, network 요청은 제공하지 않는다.

Evidence Verifier는 최소한 다음을 확인한다.

- line/range가 현재 `head_oid`의 diff에 실제로 존재하는가
- 설명이 인용한 symbol과 호출부가 analyzer artifact에 존재하는가
- finding이 변경 전부터 존재했고 이번 변경으로 악화되지 않은 문제는 아닌가
- 같은 원인을 말하는 finding이 파일별 reviewer에서 중복 생성되지 않았는가
- P3가 재현 경로 또는 직접적인 보안·손실 근거와 높은 confidence를 갖는가

### 6.5 Chat Agent

대화는 `conversation.snapshot_id`에 고정한다. 새 분석이 끝나도 기존 대화의 근거가 조용히 바뀌지 않는다. UI는 최신 snapshot으로 대화를 이어갈지 사용자가 선택하게 하며, 이어갈 때 이전 질문과 답변을 참고 자료로만 넘긴다.

Chat Agent는 분석 artifact를 검색해 답하고 다음 규칙을 따른다.

- 파일과 line을 말할 때 snapshot link를 함께 반환
- repository에 없는 runtime 동작은 가정이라고 표시
- 최신 branch 상태가 필요한 질문에는 stale 여부부터 확인
- 수정안은 patch preview까지만 만들고 source branch에 쓰지 않음
- 접근 권한이 사라진 사용자의 stream과 후속 query를 즉시 중단

### 6.6 Report Publisher

- UI에는 run 단계별 progress와 부분 file summary를 stream한다.
- GitHub Check는 대표 egress IP를 통한 outbound API 요청으로만 게시하며 `queued → in_progress → completed` 상태와 분석 대상 head SHA를 표시한다.
- Check summary에는 priority별 개수, P2/P3, 분석 범위와 생략 내역, UI deep link를 넣는다.
- inline comment는 검증된 diff anchor에만 게시하며, 한 run의 finding을 하나의 pending review로 묶어 notification 수를 줄인다.
- 동일 finding fingerprint가 같은 head SHA에 이미 게시됐다면 중복 게시하지 않는다.

## 7. Priority, confidence, suppression

### 7.1 Priority

참고 프로젝트의 네 단계 표현을 유지하되 merge 판단에 맞게 판정 조건을 고정한다.

| Priority | 의미 | 예시 | 기본 동작 |
|---|---|---|---|
| P0 Praise | 검토할 가치가 있는 좋은 변경 | 취약한 API 제거, 누락 test 보강 | 요약에만 표시, finding 수에서 제외 가능 |
| P1 Info | 선택적 개선 | 명확성, 국소적 중복, 비차단 최적화 | advisory |
| P2 Warning | merge 전에 확인할 가능성 높은 결함 | error handling 누락, 호환성 저하, 중요 test 누락 | reviewer 확인 필요 |
| P3 Critical | 직접적인 보안 취약점, data loss, build 불가, 확정적 치명 오류 | 인증 우회, destructive query 조건 누락 | 정책 설정 시 Check failure 후보 |

P3는 `confidence=high`이고 evidence verifier를 통과해야 한다. 문자열 keyword만으로 priority를 올리지 않는다. 분석 오류나 model 응답 오류는 code finding이 아니라 `run_error`로 기록한다.

### 7.2 Confidence

- `high`: 코드 경로와 결과를 snapshot에서 직접 확인했거나 deterministic analyzer가 재현함
- `medium`: 정적 관계는 확인했으나 runtime 조건 또는 외부 contract 확인이 필요함
- `low`: 검토할 가설로 유용하지만 repository 근거가 충분하지 않음

기본 GitHub 게시 대상은 high/medium P2와 high P3로 제한한다. 나머지는 UI에서 볼 수 있으며 repository 정책으로 조정한다.

### 7.3 Inline skip directive

언어의 line comment 안에 다음 directive를 지원한다.

```text
GCR:skip <reason>
GCR:skip-next-line <reason>
GCR:skip-file <reason>
```

- reason을 필수로 하고 suppression 자체를 report의 audit section에 표시한다.
- directive는 해당 line 또는 명시된 범위의 model finding에만 적용한다. secret detection, repository policy violation, deterministic P3는 숨기지 않고 `suppression_requested` 상태로 남긴다.
- changed line에서 새로 추가된 suppression은 별도 review item으로 표시한다.
- `.gcr.yml`에서 허용 category, 만료일, 승인 주체를 제한할 수 있다.

### 7.4 결과 상세도

`output.richness`는 `compact | standard | detailed`를 지원한다. 이 설정은 설명 길이와 보조 evidence 수만 바꾸며 finding 탐지, priority, confidence에는 영향을 주지 않는다.

## 8. Versioned contract

### 8.1 Analysis report

```ts
interface AnalysisReportV1 {
  schemaVersion: 1;
  runId: string;
  snapshot: {
    repositoryId: string;
    pullNumber: number;
    baseRefOid: string;
    mergeBaseOid: string;
    headOid: string;
  };
  status: 'completed' | 'partial' | 'failed' | 'superseded';
  summary: {
    title: string;
    changeIntent: string;
    risk: 'low' | 'medium' | 'high' | 'critical' | 'unknown';
    affectedAreas: string[];
    testAssessment: string;
  };
  findings: FindingV1[];
  fileSummaries: FileSummaryV1[];
  commitSummaries: CommitSummaryV1[];
  suppressions: SuppressionV1[];
  coverage: {
    filesTotal: number;
    filesAnalyzed: number;
    linesChanged: number;
    parsers: Record<string, 'full' | 'fallback' | 'unsupported'>;
    omitted: Array<{ scope: string; reason: string; count?: number }>;
  };
  timing: { startedAt: string; completedAt: string; durationMs: number };
}
```

### 8.2 Finding

```ts
interface FindingV1 {
  id: string;
  fingerprint: string;
  source: 'agent' | 'static-analyzer' | 'policy';
  category:
    | 'correctness'
    | 'security'
    | 'compatibility'
    | 'testing'
    | 'maintainability'
    | 'performance'
    | 'history';
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  confidence: 'low' | 'medium' | 'high';
  title: string;
  explanation: string;
  impact: string;
  recommendation?: string;
  anchor: {
    path: string;
    side: 'LEFT' | 'RIGHT' | 'FILE';
    startLine?: number;
    endLine?: number;
    baseOid: string;
    headOid: string;
  };
  evidence: Array<{
    kind: 'diff' | 'symbol' | 'reference' | 'commit' | 'blame' | 'analyzer';
    ref: string;
    note: string;
  }>;
  suppression: 'none' | 'requested' | 'accepted' | 'rejected';
}
```

`fingerprint`는 category, normalized path, symbol key, 원인 code와 anchor 주변의 안정적인 context를 조합한다. line number만 사용하지 않아 후속 commit에서 finding의 해결·이동·재발을 구분한다.

## 9. 데이터 모델

| Entity | 주요 필드 | 보존 목적 |
|---|---|---|
| `tenant` | id, name, policy, data_region | 조직 격리와 정책 |
| `github_installation` | installation_id, host, encrypted credential metadata | GitHub App 연결 |
| `repository` | github_id, tenant_id, default_branch, config_revision | 저장소 설정 |
| `repository_poll_state` | repository_id, cursor/validator, last_success_at, next_poll_at, backoff | 중단 복구와 polling 주기 제어 |
| `pull_poll_state` | PR id, observed base/head OID, state, draft, observed_at | 상태 변화 감지와 동일 snapshot dedupe |
| `pull_request` | repository_id, number, state, author, current_head_oid | PR identity와 최신 상태 |
| `snapshot` | PR id, base/merge-base/head OID, created_at | immutable 분석 기준 |
| `analysis_run` | snapshot_id, policy/model revision, status, timing, error | 실행 재현과 감사 |
| `changed_file` | snapshot_id, path, previous_path, status, stats | file tree와 diff index |
| `symbol` | snapshot_id, path, kind, qualified_name, range, fingerprint | object inspection |
| `finding` | run_id, fingerprint, priority, confidence, anchor, status | 검토 결과 |
| `evidence` | finding_id, kind, artifact ref, range | finding 근거 |
| `suppression` | finding/directive, reason, author, expiry, disposition | 예외 감사 |
| `conversation` | snapshot_id, user_id, title | 대화 범위 |
| `message` | conversation_id, role, content, evidence refs, usage | chat history |
| `audit_event` | tenant, actor, action, target, timestamp, metadata | 접근 및 정책 변경 추적 |

모든 tenant-owned table은 `tenant_id`를 직접 또는 검증 가능한 foreign key chain으로 가진다. application query에만 의존하지 않고 PostgreSQL Row Level Security 또는 tenant별 database로 경계를 강제한다.

큰 patch, AST, graph, raw model response는 object storage에 암호화해 저장하고 DB에는 content hash와 위치만 둔다. raw model response는 기본 UI에 노출하지 않으며 retention 정책에 따라 report보다 먼저 삭제할 수 있다.

## 10. API와 event

### 10.1 외부 API

```text
GET    /api/repositories/:repoId/pulls/:number
POST   /api/repositories/:repoId/pulls/:number/refresh
POST   /api/repositories/:repoId/pulls/:number/analyses
GET    /api/analyses/:runId
GET    /api/analyses/:runId/events                 # SSE
GET    /api/snapshots/:snapshotId/files
GET    /api/snapshots/:snapshotId/diff?path=...
GET    /api/snapshots/:snapshotId/history?path=...&symbol=...
POST   /api/snapshots/:snapshotId/conversations
POST   /api/conversations/:id/messages
GET    /api/conversations/:id/events               # SSE
POST   /api/findings/:id/feedback
POST   /api/findings/:id/suppressions
```

`refresh`는 GitHub에서 현재 PR 상태와 ref를 즉시 다시 읽도록 우선순위 poll을 예약하며, 동일 사용자의 반복 요청을 coalesce하고 rate limit을 적용한다. `analyses`는 확인된 최신 snapshot을 분석하거나 아직 snapshot이 없으면 refresh를 먼저 예약한다.

모든 resource 조회는 로그인 여부뿐 아니라 현재 사용자가 해당 GitHub repository를 읽을 수 있는지 확인한다. 권한 결과는 짧은 TTL로만 cache하고 write, stream 재연결, 민감 artifact 발급 시 재검증한다. webhook이 없는 기본 mode에서는 installation 제거, repository transfer, membership 변경을 즉시 통지받는다고 가정하지 않는다. installation/repository reconciliation이 접근 상실을 감지하면 관련 cache와 진행 중 stream을 무효화하며, 그 사이에도 TTL 상한이 권한 철회 반영 지연을 제한한다.

### 10.2 내부 event

```text
installation.poll.requested
installation.poll.completed
repository.poll.requested
repository.poll.completed
pr.change.detected
pr.snapshot.requested
pr.snapshot.created
analysis.started
analysis.stage.completed
analysis.completed
analysis.failed
analysis.superseded
report.publish.requested
report.published
```

event에는 적용 가능한 `event_id`, `tenant_id`, `installation_id`, `repository_id`, `pull_number`, `base_oid`, `head_oid`, `trigger_kind`, `snapshot_id`, `correlation_id`, `occurred_at`, `schema_version`을 넣는다. snapshot unique key는 `GitHub host + repository ID + PR number + base OID + head OID`로 고정한다. `pr.change.detected`는 여기에 state transition과 관측 cycle을 더해 감지 이력을 보존할 수 있지만, trigger 종류가 달라졌다는 이유만으로 snapshot이나 동일 policy의 analysis run을 중복 생성하지 않는다. consumer는 at-least-once delivery를 전제로 idempotent하게 구현한다.

## 11. UI Blueprint

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ repo / PR #123   base…head   analysis: complete   P3 0 · P2 3 · P1 5       │
├──────────────────┬──────────────────────────────────────┬────────────────────┤
│ LNB              │ Main workspace                       │ Persistent Chat    │
│ Files            │ Split / unified diff                 │ scope              │
│ Findings         │ File / symbol / commit               │ conversation       │
│ Outline          │ Maximized tool view                  │ evidence links     │
│ Impact           │                                      │ composer           │
├──────────────────┴──────────────────────────────────────┴────────────────────┤
│ FNB tool dock: Evidence · Git graph · History · Ownership · Impact · Tests  │
└──────────────────────────────────────────────────────────────────────────────┘
```

- **Header:** snapshot SHA, GitHub last-checked 시각, stale 여부, refresh/backoff 상태, run 상태, coverage, priority count를 표시한다.
- **LNB:** Files, Findings, Outline, Impact mode를 제공한다. Findings는 priority/confidence/status/file/specialist 기준으로 정리하며 Chat과 상호 배타적인 tab으로 만들지 않는다.
- **Diff View:** old/new line coordinate, comment anchor, related symbol과 finding marker를 제공한다.
- **Persistent Chat:** 오른쪽 전용 dock에 항상 mount한다. 전체 PR, 선택 file, hunk, symbol, finding, commit을 질문 scope로 고정할 수 있고 evidence chip을 누르면 Main/FNB가 해당 근거로 이동한다.
- **FNB tool dock:** 초기 높이는 132px, 접힘 높이는 48px이며 사용자가 직접 확장하지 않은 상태에서는 160px을 넘지 않는다. Evidence trail, Git graph, History, Ownership, Impact, Related tests를 제공한다.
- **Git Graph:** base/head/merge-base와 직접 관련된 commit lane을 compact view로 먼저 보여준다. maximize, pan/zoom, branch/filter, history pagination과 commit-to-diff 이동을 지원한다.
- **Panel resizing:** LNB는 기본 280px(220–420px), Chat은 380px(320–560px), FNB는 132px(48px–45vh)이다. pointer와 keyboard separator를 제공하고 사용자·repository별 크기를 복원한다.
- **Responsive layout:** 1280px 이상에서는 LNB/Main/Chat을 같은 행에 표시한다. 960–1279px에서는 LNB를 rail로 줄이고, 960px 미만에서는 LNB를 sheet로, Chat을 viewport 하단 persistent dock으로 배치한다. 좁은 화면에서도 Chat scope/composer, draft와 response stream을 unmount하지 않는다.
- **UI language:** 기본 locale은 `ko-KR`로 설정한다. 메뉴의 기술 개념과 개발자가 그대로 식별해야 하는 `PR`, `diff`, `snapshot`, `finding`, `commit`, `merge-base`, `HEAD`, `Git graph`, `Worker`, `runtime`, `queue`, `Chat`은 영어 표기를 유지한다. 버튼 동작, 상태, 오류, 도움말, finding 설명과 Chat 문장은 한글로 작성하며 영어 문장을 그대로 노출하지 않는다.

finding, evidence chip, graph commit을 선택하면 LNB, Main, FNB, Chat이 하나의 `snapshotId`와 selection을 가리키도록 단일 transaction으로 갱신한다. diff, file tree, history와 graph는 큰 PR에서도 전체 DOM을 만들지 않도록 windowing/pagination한다. report가 완성되기 전에도 수집이 끝난 file부터 볼 수 있지만, 부분 결과임을 명확히 표시한다.

`.documents/visuals/review-workspace.html`은 시각 방향과 일부 interaction을 확인하는 prototype이다. prototype에 보이지 않는다는 이유로 Git graph, ownership, impact, related test 등의 production 기능을 제외하지 않는다. panel별 구현 contract, responsive state, frontend module 경계와 acceptance criteria는 [Review Workspace UI Implementation Design](./ui-implementation-design.md)을 따른다.

## 12. Repository configuration

repository root의 `.gcr.yml`을 사용한다.

```yaml
version: 1

analysis:
  exclude:
    - "**/generated/**"
    - "**/*.snap"
  generated:
    - "**/openapi-client/**"
  max_changed_lines: 20000
  history_depth: 200

review:
  priority_floor: P1
  publish_inline: false
  fail_check_on: []            # opt-in example: [P3]
  output:
    richness: standard
  specialists:
    security: true
    compatibility: true
    performance: false

suppression:
  require_reason: true
  allow_file_scope: false
  p3_requires_codeowner: true

models:
  profile: private-code-review
```

config는 base branch의 파일을 신뢰 기준으로 사용한다. PR head가 config를 바꾼 경우 변경 자체는 분석하되, 해당 run의 권한 확대·검사 완화에는 적용하지 않는다. 관리자 UI 설정과 repository config가 충돌하면 더 제한적인 값이 우선한다.

repository 전용 검토 지침은 `.gcr/rules/*.md`에 둘 수 있다. rule 파일은 reviewer prompt의 정책 자료로 취급하지만 system instruction이나 tool 권한을 바꾸지 못한다. 적용한 config commit과 rule content hash를 `analysis_run`에 기록한다.

## 13. 보안과 privacy

### 13.1 인증과 권한

- GitHub App private key는 secret manager에서 읽고 application DB에 저장하지 않는다. optional webhook mode를 켠 경우에만 webhook secret도 같은 방식으로 관리한다.
- 짧은 수명의 installation token을 run 시점에 발급하며 log, queue payload, artifact에 남기지 않는다.
- UI 사용자는 조직 SSO/OIDC로 인증하고 GitHub identity를 연결한다. 매 repository 접근 시 설치 범위와 사용자 read 권한을 함께 확인한다.
- GitHub 쓰기 동작은 service account 권한과 사용자 의도를 구분해 audit log에 남긴다.

### 13.2 Private code 처리

- model gateway는 tenant가 승인한 endpoint와 model만 허용하고 public fallback을 두지 않는다.
- prompt, source, diff를 application log와 distributed trace attribute에 기록하지 않는다.
- 저장·전송 구간을 암호화하고 tenant별 encryption key를 지원한다.
- artifact와 대화의 기본 retention을 설정 가능하게 하며 installation 삭제 시 purge workflow를 실행한다.
- embedding이나 feedback 학습에 private code를 재사용하지 않는다. 별도 동의가 필요한 기능으로 분리한다.

### 13.3 Prompt injection과 tool 안전성

- PR title, description, issue comment, source comment, filename을 모두 untrusted data로 표시한다.
- model prompt에서 repository text와 system policy를 구조적으로 분리한다.
- typed tool handler가 snapshot과 tenant를 server-side에서 주입하며 model이 repository ID나 ref를 바꾸지 못하게 한다.
- path traversal, symlink escape, submodule URL, Git config/hook 실행을 차단한다.
- worker pod는 default-deny NetworkPolicy에서 queue, database, object storage, model gateway와 허용된 GitHub endpoint만 연다. repository command를 실행하는 analyzer/bisect sandbox는 worker와 분리하고 egress deny를 적용한다.
- worker image는 CI에서 SBOM, provenance, vulnerability scan과 signature를 생성하고 admission 또는 deployment 단계에서 digest와 signature를 검증한다. runtime secret은 image build argument나 layer에 넣지 않는다.
- model output은 schema validation, size limit, Markdown sanitization을 거친 뒤 저장·표시한다.

### 13.4 Network, polling과 게시 안전성

- GitHub API, GraphQL, Git fetch와 Check/comment 게시 목적지만 firewall outbound allowlist에 등록하고 모든 요청을 고정된 대표 egress IP와 조직 DNS/TLS 검사 정책을 통과시킨다.
- GitHub에서 application workload로 향하는 inbound route, public load balancer와 webhook firewall opening은 기본 배포에 만들지 않는다. reviewer traffic은 사내망 또는 VPN ingress로 분리한다.
- poller는 GitHub 응답의 URL이나 redirect를 무조건 신뢰하지 않는다. redirect target을 정규화해 설정된 GitHub host와 outbound allowlist 안일 때만 따라가며, 허용 범위를 벗어난 target, 예상하지 못한 DNS resolution 변화와 TLS 인증서 오류는 fail closed로 처리한다.
- installation/repository reconciliation이 GitHub App 제거 또는 접근 범위 축소를 감지하면 새 token 발급과 작업 생성을 중단하고 관련 credential/cache를 폐기한다.
- review comment와 Check 게시 전에 현재 head SHA와 diff anchor를 outbound API로 다시 검증한다. 최신 head와 다르면 게시하지 않고 stale 처리한다.
- optional webhook mode에서는 raw body HMAC, `delivery_id + GitHub host` replay 방지, repository/installation 재확인을 polling mode 앞단의 추가 trigger에 적용한다.

## 14. 신뢰성, 성능, 비용 목표

다음 값은 운영 측정치가 아니라 MVP의 설계·검증 목표다.

| 항목 | 목표 |
|---|---|
| 변경 탐지 | active PR은 기본 60초, draft/idle PR은 5분 이내에 다시 조회. 실제 목표는 설치 규모와 quota 검증 뒤 조정 |
| 수동 refresh | 요청 후 10초 안에 GitHub 조회를 시작하거나 quota/backoff로 지연된 상태를 UI에 표시 |
| 중복 처리 | 같은 PR head와 snapshot에 대해 run 1개, 외부 게시 side effect 최대 1회 |
| 최신성 | 새 head를 감지한 뒤 이전 run과 Check를 10초 안에 stale/superseded 표시 |
| API quota | 자동 polling은 host/installation별 가용 예산의 80%까지만 사용하고 refresh, 게시, 권한 확인용 reserve 유지 |
| Poll 복구 | scheduler 재시작 또는 lease 이전 뒤 마지막 완료 checkpoint에서 재개하고 2회 polling interval 안에 정상 주기 회복 |
| 일반 PR 분석 | 100 files, 5,000 changed lines 이하에서 5분 내 completed 또는 partial |
| UI 조회 | 이미 생성된 diff/file index의 p95 응답 500ms 이내 |
| 복구 | worker 중단 뒤 마지막 완료 stage부터 재시도, 외부 게시 중복 없음 |
| 비용 | repository별 token/run budget 설정, 초과 시 deterministic-only partial report |

poll과 분석 stage마다 timeout과 retry 정책을 다르게 둔다. primary rate limit에 가까워지면 idle repository부터 interval을 늘리고, secondary rate limit 또는 abuse response에서는 해당 host/installation의 동시성을 낮추고 `retry-after`, reset 시각과 `x-poll-interval`을 존중한다. manual refresh, head 재검증, Check 게시, 권한 확인을 자동 background scan보다 우선한다. Git fetch나 일시적 GitHub 오류는 재시도할 수 있지만 schema가 잘못된 model 응답은 제한 횟수 뒤 partial report로 끝낸다. 일부 parser 또는 specialist 실패가 전체 report를 없애지 않게 `partial` 상태와 omission을 사용한다.

큰 PR은 다음 순서로 예산을 쓴다.

1. 변경 metadata, build/manifest, auth, data mutation, public API 경로
2. 변경 symbol의 직접 caller와 test
3. 나머지 변경 파일의 file-level review
4. transitive impact와 장기 history

생략 항목과 이유를 숨기지 않고 coverage에 기록한다.

## 15. Observability와 품질 평가

### 15.1 운영 telemetry

- poll cycle/lag, detection lag, cursor checkpoint, lease ownership, refresh coalescing, queue lag
- poll/analysis stage duration, retry, superseded run과 동일 snapshot dedupe
- repository size와 changed files/lines, parser coverage, omitted context
- model별 latency, input/output token, schema failure, tool call 수, 비용
- finding priority/confidence/category, 게시/억제/해결 상태
- GitHub API rate limit, comment anchor 실패, permission failure

metric label에는 repository name, path, prompt, source text를 넣지 않고 내부 opaque ID를 사용한다. trace는 `poll/refresh → change detection → snapshot → run → stage → publish` correlation을 제공한다.

### 15.2 Review 품질 평가

- offline fixture: 알려진 bug/security/test omission이 있는 synthetic PR과 공개 test repository
- regression: 같은 snapshot, policy, model version에 대한 contract와 finding fingerprint 비교
- reviewer feedback: useful, incorrect, already-known, fixed, suppressed reason
- 핵심 지표: P2/P3 precision, reviewer-confirmed recall sample, duplicate rate, invalid-anchor rate, stale-post rate

model이나 prompt를 바꿀 때 golden set을 실행한다. production traffic의 private code를 별도 승인 없이 평가 dataset으로 복사하지 않는다.

## 16. 단계별 구현 계획

### Phase 0 — Walking skeleton

구현:

- monorepo, local development stack, database migration
- worker 전용 OCI image, CI build/test/scan/SBOM/sign/push와 digest 기반 private runtime 배포
- ConfigMap/secret reference, workload identity, ephemeral Git volume과 worker egress NetworkPolicy
- GitHub App installation token과 installation/repository reconciliation
- active/idle PR poll scheduler, durable cursor/checkpoint, manual refresh
- repository mirror, immutable snapshot, raw diff artifact
- 빈 report까지 이어지는 queue workflow
- PR/run 상태를 보여주는 최소 UI와 GitHub Check

완료 조건:

- CI가 worker image에 secret을 포함하지 않고 immutable digest, SBOM, provenance와 signature를 registry에 게시한다.
- private runtime이 승인된 digest를 pull하고 runtime secret을 file/workload identity로 주입해 queue smoke job을 처리한다.
- private test repository에서 poller가 PR open과 head 변경을 감지해 서로 다른 snapshot을 만든다.
- 같은 PR/head를 반복 조회하거나 concurrent poller가 감지해도 run과 Check가 중복되지 않는다.
- scheduler 재시작과 pagination 중단 뒤 checkpoint에서 조회를 재개한다.
- 새 commit 뒤 이전 결과가 stale로 표시된다.

### Phase 1 — Reviewable MVP

구현:

- resizable LNB/Main/Chat/FNB workspace shell, layout preference와 responsive fallback
- LNB Files/Findings/Outline, virtualized split/unified diff, 전체/commit별 summary
- diff/history/blame analyzer와 우선 2개 언어의 Tree-sitter symbol adapter
- correctness, security, test specialist와 evidence verifier
- priority/confidence contract, Check summary, optional inline comments
- Findings와 동시에 보이는 persistent snapshot-scoped Chat과 evidence deep link
- compact Evidence trail, PR 중심 Git graph, file/symbol history
- `.gcr.yml`, skip directive, richness

완료 조건:

- finding에서 표시한 line, symbol, commit evidence로 이동할 수 있다.
- finding, evidence chip, graph commit을 선택했을 때 LNB/Main/FNB/Chat이 같은 snapshot과 selection을 가리킨다.
- desktop에서 Findings와 Chat을 동시에 사용할 수 있고, panel resize와 reload 뒤 layout 복원이 pointer/keyboard 양쪽에서 동작한다.
- Git graph에서 base/merge-base/head를 식별하고 commit을 선택해 해당 diff로 이동할 수 있다.
- 존재하지 않는 line이나 stale head에는 GitHub comment가 게시되지 않는다.
- parser/model 하나가 실패해도 omission이 포함된 partial report를 확인할 수 있다.
- P3는 high confidence와 직접 evidence가 없으면 Check failure 후보가 되지 않는다.

### Phase 2 — Change impact와 history

구현:

- import/reference graph와 연관 test 탐색
- file/module/line/function/class history
- CODEOWNERS, blame, review history를 분리한 ownership view
- Impact LNB mode, folded history와 full Git graph filter/history pagination
- ownership, impact, related test FNB tool과 Main maximize view
- finding fingerprint를 이용한 resolved/reintroduced 추적

완료 조건:

- 변경 symbol에서 직접 caller와 관련 test로 이동할 수 있다.
- rename된 파일과 지원 언어의 moved symbol이 같은 history로 연결된다.
- ownership 근거마다 출처와 snapshot/ref가 표시된다.

### Phase 3 — Enterprise hardening

구현:

- tenant isolation test, data residency, configurable retention/purge
- organization SSO, audit export, model gateway policy
- horizontal worker scaling, queue partitioning, object lifecycle
- GHES 호환성 matrix와 upgrade test
- sandboxed bisect와 승인 workflow

완료 조건:

- tenant 간 ID를 바꾼 API 요청과 artifact URL 접근이 차단된다.
- installation 제거 시 token 발급이 중단되고 설정한 기간 안에 artifact가 삭제된다.
- network가 차단된 bisect sandbox에서 승인된 command만 실행된다.

## 17. Test 전략

### Unit

- diff old/new line mapping, rename, binary/generated 판정
- priority/confidence policy, suppression 범위, finding fingerprint
- poll state transition, snapshot idempotency key, active/idle interval과 quota budget 계산
- report schema validation과 Markdown sanitization
- Git argument validator와 path normalization

### Integration

- worker image build → scan/sign → private registry push → digest rollout → queue smoke job을 test environment에서 검증
- ConfigMap 변경과 secret rotation이 image rebuild 없이 반영되고 진행 중 job의 credential이 log/queue에 남지 않는지 확인
- 실제 Git fixture로 merge-base, force-push, base 이동, merge commit, shallow fetch 처리
- GitHub API mock으로 cursor pagination, conditional response, primary/secondary rate limit, expired token, stale comment anchor 처리
- scheduler lease 만료, replica 동시 실행, cursor checkpoint 유실/복구와 동일 head dedupe
- PostgreSQL tenant policy와 object storage signed URL 격리
- queue retry 후 Check/comment가 한 번만 게시되는지 확인

### End-to-end

- PR open → poll 감지 → 분석 → UI diff/finding → chat → outbound Check 게시
- LNB finding 선택 → diff anchor/FNB evidence/Chat scope 동기화 → evidence chip으로 원래 근거 복귀
- Git graph commit 선택 → commit diff/Findings/Chat scope 동기화 → history pagination
- LNB/Chat/FNB pointer·keyboard resize → reload 복원 → compact/stacked responsive 전환
- 분석 중 head 변경 → 다음 poll/refresh 감지 → 이전 run superseded → 최신 head report 게시
- reviewer refresh → 우선 조회 및 중복 요청 coalesce → 최신 snapshot 표시
- poller 장시간 중단 → 재시작 reconciliation → 누락된 head 변경 분석
- permission 회수 중 열린 chat stream 종료
- oversized PR → 우선순위 분석 → partial coverage와 omission 표시
- skip directive 추가 → suppression audit와 P3 정책 확인

### Security

- worker image layer/history, SBOM, provenance, CI log와 build cache에 secret 또는 repository clone이 남지 않는지 검사
- unsigned image, mutable tag, 허용되지 않은 base image와 critical vulnerability의 deployment 차단
- 코드 주석과 PR 본문을 이용한 prompt injection fixture
- malicious filename, symlink, submodule, Git option injection
- allowlist 밖 redirect/DNS/TLS 실패와 GitHub host 혼동
- optional webhook mode의 replay와 다른 installation payload 변조
- tenant IDOR, artifact URL 공유, log secret leakage 검사

## 18. 주요 위험과 대응

| 위험 | 영향 | 대응 |
|---|---|---|
| LLM hallucination | 잘못된 merge 판단 | deterministic evidence, verifier, confidence, human confirmation |
| 대형 PR context 초과 | 분석 누락 또는 비용 급증 | change pack 분할, 위험 경로 우선, coverage/omission 공개 |
| force-push와 stale anchor | 엉뚱한 line에 comment | snapshot 고정, 게시 직전 head 재검증, superseded 상태 |
| 동적 언어의 call graph 부정확성 | 영향 범위 과장/누락 | edge certainty 구분, parser fallback, runtime 자료 결합 가능성 유지 |
| PR 작성자의 검사 무력화 | 보안 finding 은폐 | base config 우선, suppression audit, P3 승인 정책 |
| private code 유출 | 보안·계약 위반 | approved gateway, egress deny, code-free logs, retention/purge |
| GitHub rate limit | 변경 탐지·분석·게시 지연 | GraphQL batching, conditional request, adaptive interval, quota reserve, 게시 batching |
| Polling 탐지 지연 | reviewer가 이전 snapshot을 최신으로 오인 | stale/last-checked 표시, 화면 진입 refresh, active PR 짧은 interval |
| Poller 중복 실행 또는 cursor 유실 | API 낭비, 누락 또는 중복 분석 | lease, durable checkpoint, 주기적 full reconciliation, snapshot idempotency key |
| GitHub App 제거·권한 회수 지연 | 권한 없는 code의 일시적 노출 | 짧은 authorization TTL, 민감 동작 재검증, installation reconciliation, stream 중단 |
| repository별 build 차이 | test/bisect 오판 | 명시적 실행 profile, sandbox, timeout, flaky/skip 상태 보존 |

## 19. 구현 전에 확정할 사항

아래 결정은 architecture 경계를 바꾸지는 않지만 MVP 일정과 운영 정책에 직접 영향을 준다.

- 첫 배포 대상이 GitHub Enterprise Cloud인지 특정 GHES version인지
- GitHub host별 허용 outbound endpoint, 대표 egress IP, DNS/TLS inspection 방식
- 설치 대상 organization/repository 수, open/active PR 수와 허용 가능한 탐지 지연
- active, draft, idle repository의 polling interval과 API quota reserve 비율
- GitHub App installation token을 직접 발급할지 사내 credential broker를 통할지
- 우선 지원할 두 개 언어와 monorepo/build system
- 허용 model provider, private endpoint, data region, prompt retention 조건
- GitHub inline comment 자동 게시 여부와 P3 Check failure 사용 여부
- 예상 동시 PR 수, repository 크기, 일반적인 changed files/lines 분포
- source artifact, report, chat, audit log의 보존 기간
- 조직 SSO와 GitHub identity를 연결하는 방식

## 20. 참고 자료

- [commit-defender](https://github.com/pydemia/commit-defender): priority, inline skip, output richness 개념 참고
- [GitHub App 권한 선택](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)
- [GitHub App 자체 인증](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app)
- [GitHub REST API rate limit](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api)
- [GitHub REST API conditional request](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests-if-appropriate)
- [GitHub GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- [GitHub App webhook 사용](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps): optional mode 참고
- [Pull request REST API](https://docs.github.com/en/rest/pulls/pulls)
- [Pull request review comment REST API](https://docs.github.com/en/rest/pulls/comments)

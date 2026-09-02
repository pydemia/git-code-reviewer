# Git Code Reviewer — 요건정의서

## 1. 문서 정보

| 항목 | 내용 |
|---|---|
| 문서 상태 | 구현 기준안 v0.1 |
| 기준 문서 | `idea.md`, `blueprint.md`, `ui-implementation-design.md` |
| 대상 release | Walking Skeleton, Reviewable MVP, 후속 release |
| 기본 locale | `ko-KR` |
| 기준 배포 | 사내 중앙 service, GitHub 연결은 outbound-only |

이 문서는 제품이 충족해야 할 업무·기능·보안·운영 요건을 정의한다. Component 구조와 상세 동작은 `functional-design.md`, 구현 순서와 commit 단위는 `implementation-plan.md`에서 다룬다.

### 1.1 요구 수준

| 수준 | 의미 |
|---|---|
| 필수 | 해당 release의 완료 조건이다. 충족하지 못하면 release할 수 없다. |
| 조건부 | 조직 정책이나 repository 설정으로 기능을 켠 경우에만 필수다. |
| 후속 | MVP 이후 구현한다. Contract와 확장 지점은 MVP에서 보존한다. |
| 제외 | 현재 제품이 수행하지 않는다. 별도 승인 없이 범위를 넓히지 않는다. |

요건 ID는 변경하지 않는다. 요건을 폐기할 때는 삭제하지 않고 `폐기` 상태와 사유를 기록한다. 수치가 확정되지 않은 항목은 임의로 채우지 않고 `TBD`로 둔다.

### 1.2 주요 용어

| 용어 | 정의 |
|---|---|
| snapshot | `repository + PR number + base OID + merge-base OID + head OID`로 식별하는 불변 분석 기준 |
| analysis run | 특정 snapshot, policy, analyzer/model version으로 수행하는 한 번의 분석 실행 |
| finding | 검토자가 확인해야 할 코드 문제 후보와 그 근거 |
| evidence | diff line, symbol, commit, blame, dependency edge, test 등 finding을 검증할 수 있는 자료 |
| stale | 현재 PR head와 다른 snapshot을 기준으로 생성되어 게시·판단에 사용할 수 없는 상태 |
| superseded | 새 snapshot 또는 새 run이 기존 run을 대체한 상태 |
| partial | 일부 analyzer나 specialist가 실패하거나 budget 때문에 생략되었지만 사용 가능한 결과가 있는 상태 |
| LNB | Files, Findings, Outline, Impact를 표시하는 왼쪽 navigation panel |
| FNB | Evidence, Git graph, History, Ownership, Impact, Related tests를 표시하는 하단 tool dock |
| Chat | 선택한 snapshot과 evidence에 한정된 대화형 검토 공간 |
| Worker | queue job을 받아 Git·parser·analyzer·model pipeline을 실행하는 별도 OCI image와 runtime deployment |

## 2. 제품 범위와 전제

### 2.1 해결하려는 문제

현재 PR 검토에서는 diff와 commit history, symbol 영향 범위, ownership, 관련 test가 서로 다른 도구에 흩어진다. 자동 review 결과도 근거가 불명확하거나 최신 head와 섞이면 검토 비용과 잘못된 판단을 늘린다. 이 제품은 분석 기준을 snapshot으로 고정하고 finding에서 원본 근거까지 이동할 수 있는 review workspace를 제공한다.

### 2.2 기준 운영 환경

- GitHub Enterprise Cloud 또는 GHES에 GitHub App을 설치한다. 최초 지원 대상은 `OD-001`에서 확정한다.
- application은 사내 VM 또는 Kubernetes cluster에 중앙 배포한다.
- reviewer는 사내망 또는 VPN에서 browser로 접근한다. reviewer PC에서 분석 Worker를 실행하지 않는다.
- GitHub API, GraphQL, Git fetch, Check와 review comment 게시는 고정된 사내 egress IP를 거치는 outbound HTTPS만 사용한다.
- GitHub에서 application workload로 들어오는 public webhook endpoint는 기준 배포에 포함하지 않는다.
- private source, diff, prompt, Chat은 조직이 승인한 storage와 model gateway 경계 안에서만 처리한다.

### 2.3 출시 범위

| 범위 | 내용 |
|---|---|
| Walking Skeleton | polling으로 PR 변경 감지, snapshot/diff 생성, 빈 report까지 queue 실행, 최소 상태 UI, GitHub Check, Worker image delivery |
| Reviewable MVP | resizable workspace, diff·finding·evidence·Git graph·history, specialist review, persistent Chat, repository 정책, stale/partial 처리 |
| 후속 release | dependency impact, 관련 test, moved symbol history, ownership 고도화, resolved/reintroduced 추적, enterprise isolation·retention·bisect |

### 2.4 제외 범위

- 사람의 승인 없는 PR merge
- source branch 또는 사용자 code의 자동 수정·push
- 임의의 repository command나 test를 격리 없이 실행하는 기능
- 조직이 승인하지 않은 public model endpoint로의 fallback
- public webhook ingress를 반드시 요구하는 기능
- IDE plugin, mobile native application, 일반-purpose coding agent

## 3. 사용자와 권한 역할

| 역할 ID | 역할 | 주요 목적 | 허용 동작 |
|---|---|---|---|
| ACT-01 | Reviewer | finding과 근거를 검토하고 merge 판단에 활용 | 접근 가능한 repository 조회, Chat, refresh, feedback |
| ACT-02 | PR Author | finding을 이해하고 수정 여부를 판단 | Reviewer와 같은 read 기능, 자신에게 허용된 feedback |
| ACT-03 | Repository Admin | repository review 정책 관리 | `.gcr.yml` 관리, 설치 범위·게시 정책 확인, suppression 감사 |
| ACT-04 | Platform Operator | service·Worker·queue·storage 운영 | deployment, metric/log 확인, 장애 복구. source 본문 열람은 별도 권한 필요 |
| ACT-05 | Security/Auditor | 접근·게시·suppression·정책 변경 감사 | audit 조회·export. source 접근 여부는 조직 정책을 따른다 |

사용자 권한은 application 내부 역할만으로 결정하지 않는다. 매 repository 접근 시 GitHub App 설치 범위와 사용자의 GitHub read 권한을 함께 확인해야 한다.

## 4. 업무 목표와 성공 기준

| ID | 목표 | 성공 기준 | 범위 |
|---|---|---|---|
| BR-001 | 최신 PR 상태를 놓치지 않는다 | active PR 기본 60초, draft/idle PR 5분 polling 목표를 운영 규모에 맞춰 검증한다 | Walking Skeleton |
| BR-002 | 결과의 분석 기준을 명확히 한다 | 모든 report, finding, Chat 답변에 snapshot identity를 연결한다 | Walking Skeleton |
| BR-003 | 자동 finding을 사람이 검증할 수 있게 한다 | 모든 게시 가능한 finding에서 최소 1개의 직접 evidence로 이동할 수 있다 | MVP |
| BR-004 | Findings와 Chat을 함께 사용한다 | desktop에서 두 영역을 동시에 표시하고 navigation 후에도 Chat draft와 stream을 보존한다 | MVP |
| BR-005 | 잘못된 최신 결과 게시를 막는다 | 게시 직전 head와 anchor를 재검증하고 불일치 시 stale 처리한다 | Walking Skeleton |
| BR-006 | 부분 실패를 숨기지 않는다 | 누락된 stage, file, context와 원인을 report coverage에 기록한다 | MVP |
| BR-007 | private code 경계를 유지한다 | 승인되지 않은 endpoint, log, trace, image layer로 source·prompt·token이 유출되지 않는다 | 전 release |
| BR-008 | 운영 비용과 GitHub quota를 통제한다 | repository/run별 budget과 polling reserve를 적용하고 초과 시 deterministic-only partial 결과를 제공한다 | MVP |
| BR-009 | 자동 게시 결과를 중복시키지 않는다 | 같은 snapshot의 run 1개, 각 Check/comment side effect 최대 1회를 보장한다 | Walking Skeleton |
| BR-010 | 제품 언어를 일관되게 제공한다 | UI 설명·상태·오류는 한글, 정확한 technical term은 English를 유지한다 | MVP |

## 5. 주요 사용 사례

### UC-001 PR 변경 자동 감지와 분석

- 행위자: Poll Scheduler, GitHub Adapter, Worker
- 선행 조건: GitHub App이 설치되어 있고 repository가 활성 상태이며 outbound 연결이 허용되어 있다.
- 시작 조건: PR open/reopen, base/head OID 변경, draft 해제 또는 예약된 reconciliation.
- 기본 흐름:
  1. Poll Scheduler가 host/installation quota와 poll state를 확인한다.
  2. GitHub Adapter가 conditional request와 pagination으로 PR 상태를 조회한다.
  3. Snapshot Collector가 OID와 PR state transition을 이전 관측값과 비교한다.
  4. 새 snapshot 또는 재분석 조건이면 idempotency key로 run을 예약한다.
  5. Worker가 repository mirror, detached worktree와 deterministic artifact를 생성한다.
  6. agent pipeline이 finding과 report를 생성한다.
  7. Report Publisher가 최신 head를 재검증하고 Check를 게시한다.
- 대체 흐름: quota/backoff면 다음 실행 시각을 저장한다. 일부 stage 실패면 partial report를 생성한다. head 변경이면 기존 run을 superseded 처리한다.
- 완료 조건: UI에서 run 상태, snapshot, coverage, report를 조회할 수 있다.

### UC-002 Reviewer의 finding 조사

- 행위자: Reviewer
- 선행 조건: Reviewer에게 repository read 권한이 있고 report가 존재한다.
- 기본 흐름:
  1. Reviewer가 LNB Findings에서 priority, confidence, category로 결과를 좁힌다.
  2. finding을 선택하면 Main이 diff anchor를 열고 FNB가 관련 evidence를 표시한다.
  3. Reviewer가 Git graph, History, Ownership 또는 Related tests를 확인한다.
  4. 필요한 경우 오른쪽 Chat에서 선택한 finding이나 code 범위를 질문한다.
  5. evidence chip을 선택하면 근거가 나온 원래 file·line·commit으로 이동한다.
- 완료 조건: LNB, Main, FNB, Chat이 같은 snapshot과 selection을 가리킨다.

### UC-003 수동 refresh

- 행위자: Reviewer
- 선행 조건: repository read 권한이 있다.
- 기본 흐름: Reviewer가 refresh를 요청하면 동일 repository의 중복 요청을 coalesce하고 자동 background scan보다 높은 우선순위로 GitHub 조회를 예약한다.
- 대체 흐름: quota나 backoff 때문에 즉시 시작할 수 없으면 사유와 예상 재시도 시각을 표시한다.
- 완료 조건: 10초 안에 조회를 시작하거나 지연 상태를 UI에 표시한다.

### UC-004 Chat 기반 추가 조사

- 행위자: Reviewer, Chat Agent
- 선행 조건: snapshot이 있고 Chat 사용이 정책상 허용되어 있다.
- 기본 흐름: Chat Agent는 server가 고정한 snapshot에서 허용된 typed read tool만 호출해 답변과 evidence reference를 stream한다.
- 대체 흐름: 권한 회수 시 stream을 종료한다. 새 head가 감지되면 기존 대화는 보존하되 stale badge를 표시하고 새 snapshot으로 자동 혼합하지 않는다.
- 완료 조건: 답변에 사용한 evidence를 UI에서 열 수 있으며 tool call의 tenant/repository/snapshot scope를 사용자가 바꿀 수 없다.

### UC-005 repository 정책과 suppression

- 행위자: Repository Admin, PR Author
- 선행 조건: base branch에 유효한 `.gcr.yml`이 존재하거나 기본 정책을 사용한다.
- 기본 흐름: run은 base branch config와 rule hash를 읽고 finding priority floor, specialist, inline publish, output richness를 적용한다.
- 대체 흐름: PR head가 검사 완화나 권한 확대를 제안해도 해당 run에는 적용하지 않는다. suppression directive는 허용된 scope와 승인 조건을 만족해야 한다.
- 완료 조건: 적용 policy, suppression 이유와 결정 주체를 audit에서 확인할 수 있다.

### UC-006 설치 제거 또는 권한 축소

- 행위자: GitHub Administrator, Reconciliation job
- 시작 조건: GitHub App 제거, repository 접근 범위 축소, 사용자 read 권한 회수.
- 기본 흐름: 새 token 발급과 job 생성을 중단하고 cache·stream을 폐기하며 retention 정책에 따라 purge를 예약한다.
- 완료 조건: 권한 없는 사용자가 API, artifact URL, 기존 Chat stream으로 데이터를 읽을 수 없다.

## 6. 기능 요건

### 6.1 GitHub 연결과 변경 감지

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-GH-001 | 필수 | GitHub App의 installation token으로 GitHub API·GraphQL·Git에 접근해야 한다 | private key가 DB·queue·log에 없고 만료 token 재발급 test가 통과한다 |
| FR-GH-002 | 필수 | Contents Read, Pull requests Read, Checks Read/Write, Metadata Read의 최소 권한으로 동작해야 한다 | inline comment를 끈 설치에서 PR Write 없이 E2E가 통과한다 |
| FR-GH-003 | 조건부 | inline review comment 사용 시에만 Pull requests Write를 요구해야 한다 | feature off일 때 permission 요청과 API 호출이 없다 |
| FR-GH-004 | 필수 | inbound webhook 없이 PR open/reopen, base/head 변경, draft 해제를 polling으로 감지해야 한다 | 각 state transition fixture에서 run 예약 여부가 기대값과 같다 |
| FR-GH-005 | 필수 | `updated_at`은 후보 조회 hint로만 사용하고 base/head OID와 PR state를 source of truth로 사용해야 한다 | 동일 updated_at의 head 변경과 updated_at 변경 없는 fixture를 탐지한다 |
| FR-GH-006 | 필수 | poll state에 cursor, ETag/Last-Modified, 마지막 성공 checkpoint, quota, backoff, 다음 실행 시각을 저장해야 한다 | process 재시작 후 checkpoint부터 재개한다 |
| FR-GH-007 | 필수 | active/idle/draft 상태와 quota에 따라 polling interval을 조절해야 한다 | scheduler 단위 test와 simulated quota test가 통과한다 |
| FR-GH-008 | 필수 | manual refresh를 background scan보다 우선하고 같은 대상의 요청을 coalesce해야 한다 | 동시 refresh N건이 한 번의 GitHub 조회로 합쳐진다 |
| FR-GH-009 | 필수 | installation과 repository 접근 범위를 주기적으로 reconciliation해야 한다 | App 제거·repo 축소 fixture에서 새 job과 token 발급이 중단된다 |
| FR-GH-010 | 필수 | redirect target, DNS resolution과 TLS를 허용 GitHub host 범위에서 검증해야 한다 | allowlist 밖 redirect와 인증서 오류가 fail closed 된다 |
| FR-GH-011 | 후속 | 정책이 허용할 때 internal webhook 또는 DMZ relay를 추가 trigger로 사용할 수 있어야 한다 | polling contract를 바꾸지 않고 event가 동일 detection path로 들어간다 |

### 6.2 Snapshot과 Git 자료 수집

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-SN-001 | 필수 | snapshot을 repository, PR number, base OID, merge-base OID, head OID로 고정해야 한다 | report와 artifact가 동일 snapshot ID를 참조한다 |
| FR-SN-002 | 필수 | 동일 GitHub host·repository·PR·base/head OID의 snapshot 생성을 idempotent하게 처리해야 한다 | concurrent collector 실행 후 snapshot row가 1개다 |
| FR-SN-003 | 필수 | repository별 bare mirror와 run별 detached worktree를 사용해야 한다 | 두 run의 worktree가 서로 ref와 파일을 변경하지 않는다 |
| FR-SN-004 | 필수 | clone/fetch/ref resolution은 검증된 argument vector로 실행하고 shell interpolation을 사용하지 않아야 한다 | option injection·malicious ref test가 차단된다 |
| FR-SN-005 | 필수 | path traversal, symlink escape, Git hook/config 실행, 허용하지 않은 submodule URL을 차단해야 한다 | security fixture에서 sandbox 밖 파일·network 접근이 실패한다 |
| FR-SN-006 | 필수 | raw diff, file index, line mapping과 snapshot manifest를 versioned artifact로 저장해야 한다 | API가 artifact version과 checksum을 반환한다 |
| FR-SN-007 | 필수 | rename, binary, generated file과 oversized file을 구분해야 한다 | Git fixture별 file status와 omission reason이 정확하다 |
| FR-SN-008 | 필수 | force-push, base 이동, merge commit과 shallow history 부족을 감지해야 한다 | fixture에서 merge-base가 정확하거나 명시적으로 unavailable 처리된다 |
| FR-SN-009 | 필수 | run 종료 후 worktree를 삭제하고 bare mirror cache와 artifact의 retention을 분리해야 한다 | ephemeral volume 정리와 lifecycle test가 통과한다 |

### 6.3 분석과 evidence

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-AN-001 | 필수 | diff analyzer가 old/new line mapping, context, rename, binary/generated 판정을 제공해야 한다 | unit fixture와 golden artifact 비교가 통과한다 |
| FR-AN-002 | 필수 | 우선 지원 언어의 parser가 변경 symbol의 kind, range, signature와 parse coverage를 생성해야 한다 | `OD-006`에서 정한 언어 fixture가 통과한다 |
| FR-AN-003 | 필수 | history analyzer가 file/line/symbol 관련 commit, blame와 churn 자료를 제공해야 한다 | 선택 line과 commit의 provenance가 snapshot과 일치한다 |
| FR-AN-004 | 후속 | dependency analyzer가 직접 caller/callee와 edge certainty를 제공해야 한다 | 지원 언어 fixture에서 direct edge와 unknown을 구분한다 |
| FR-AN-005 | 후속 | 관련 test 탐색 결과에 탐색 방식과 confidence를 포함해야 한다 | Related tests 항목마다 근거 edge 또는 naming rule이 있다 |
| FR-AN-006 | 후속 | CODEOWNERS, blame, review history를 서로 다른 ownership 근거로 표시해야 한다 | 한 사람을 단일 owner로 단정하지 않고 출처가 구분된다 |
| FR-AN-007 | 필수 | analyzer output은 versioned schema, checksum, snapshot ID와 생성 version을 포함해야 한다 | 잘못된 version·checksum artifact가 소비되지 않는다 |
| FR-AN-008 | 필수 | 일부 analyzer 실패 시 성공 artifact를 보존하고 omission을 포함한 partial run을 허용해야 한다 | parser 실패 E2E에서 report가 partial로 완료된다 |
| FR-AN-009 | 필수 | 대형 PR은 위험 경로·직접 caller·관련 test·나머지 file 순으로 budget을 배분해야 한다 | budget fixture에서 coverage 순서와 omission이 정책과 같다 |
| FR-AN-010 | 필수 | 동일 snapshot, analyzer version, policy hash의 deterministic artifact는 재사용할 수 있어야 한다 | 재실행 시 checksum이 같고 불필요한 stage가 생략된다 |

### 6.4 Review Agent와 finding

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-RV-001 | 필수 | planner가 change pack을 구성하고 specialist별 입력 범위를 고정해야 한다 | specialist가 허용 범위 밖 source를 요청할 수 없다 |
| FR-RV-002 | 필수 | correctness, security, test specialist를 독립적으로 실행할 수 있어야 한다 | specialist별 enable/disable과 timeout이 분리된다 |
| FR-RV-003 | 필수 | finding은 priority `P0`–`P3`와 별도의 confidence를 가져야 한다 | schema validation과 policy unit test가 통과한다 |
| FR-RV-004 | 필수 | finding에는 category, title, explanation, location, evidence, suggested action, fingerprint를 포함해야 한다 | 필수 field가 없는 model output은 저장되지 않는다 |
| FR-RV-005 | 필수 | verifier가 line 존재, diff relevance, evidence 일치, 중복, stale 여부를 검사해야 한다 | invalid anchor와 unsupported claim fixture가 제거·강등된다 |
| FR-RV-006 | 필수 | 직접 evidence가 없거나 confidence가 낮은 finding을 P3 Check failure 후보로 사용하지 않아야 한다 | policy matrix test가 통과한다 |
| FR-RV-007 | 필수 | model output을 schema와 size limit로 검증하고 표시 전 Markdown을 sanitize해야 한다 | malformed JSON과 XSS fixture가 차단된다 |
| FR-RV-008 | 필수 | model·prompt·policy·tool version과 token budget을 analysis run에 기록해야 한다 | report provenance API에서 해당 값을 조회한다 |
| FR-RV-009 | 필수 | repository text를 untrusted data로 취급하고 system policy·tool 권한으로 해석하지 않아야 한다 | prompt injection golden set에서 tool scope가 변하지 않는다 |
| FR-RV-010 | 후속 | finding fingerprint로 resolved와 reintroduced 상태를 추적해야 한다 | rename·minor line shift fixture에서 동일 finding을 연결한다 |

Priority는 merge 판단 영향도를 나타내고 confidence는 근거의 확실성을 나타낸다. 두 값을 하나의 등급으로 합치지 않는다.

| Priority | 판정 기준 | 기본 처리 |
|---|---|---|
| P0 Praise | 검토할 가치가 있는 좋은 변경 | 요약에만 표시하거나 finding 수에서 제외 가능 |
| P1 Info | 선택적 개선, 명확성, 국소적 중복 등 비차단 정보 | advisory |
| P2 Warning | merge 전에 확인할 가능성이 높은 결함 | reviewer 확인 필요 |
| P3 Critical | 직접적인 보안 취약점, data loss, build 불가 등 merge 차단 후보 | `confidence=high`와 직접 evidence가 있을 때만 Check failure 후보 |

### 6.5 Report와 GitHub 게시

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-RP-001 | 필수 | report에 snapshot, run status, summary, findings, coverage, omissions, provenance를 포함해야 한다 | contract schema와 UI rendering test가 통과한다 |
| FR-RP-002 | 필수 | Check는 queued/running/completed/partial/failed/superseded 상태를 표현해야 한다 | run state transition별 GitHub mock expectation이 일치한다 |
| FR-RP-003 | 필수 | Check/comment 게시 직전에 현재 head OID와 diff anchor를 다시 조회해야 한다 | head 변경 race에서 게시가 중단되고 stale가 된다 |
| FR-RP-004 | 필수 | 외부 게시 side effect에 idempotency key와 저장된 delivery 상태를 사용해야 한다 | retry 후 Check/comment가 한 번만 게시된다 |
| FR-RP-005 | 조건부 | inline comment는 repository policy와 설치 권한이 모두 허용할 때만 게시해야 한다 | 둘 중 하나가 false면 comment API를 호출하지 않는다 |
| FR-RP-006 | 필수 | suppression된 finding과 이유는 공개 report에서 정책에 맞게 감추더라도 audit에는 남겨야 한다 | audit 조회에서 actor·scope·reason·time을 확인한다 |
| FR-RP-007 | 필수 | output richness와 priority floor를 repository별로 적용해야 한다 | `.gcr.yml` fixture별 report 결과가 달라진다 |
| FR-RP-008 | 필수 | base config와 관리자 정책이 충돌할 때 더 제한적인 값을 적용해야 한다 | PR head의 검사 완화 config가 현재 run에 반영되지 않는다 |

### 6.6 Review Workspace UI

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-UI-001 | 필수 | desktop은 LNB, Main, Chat, FNB의 네 영역을 제공해야 한다 | 1440px viewport에서 네 영역이 동시에 표시된다 |
| FR-UI-002 | 필수 | LNB는 Files, Findings, Outline mode를 제공하고 Impact 확장 지점을 유지해야 한다 | keyboard와 pointer로 mode를 변경할 수 있다 |
| FR-UI-003 | 필수 | Main은 file 전체 diff, commit diff, split/unified view와 finding anchor 이동을 제공해야 한다 | E2E에서 선택한 old/new line이 정확히 열린다 |
| FR-UI-004 | 필수 | Chat은 오른쪽 전용 dock에 항상 mount하고 Findings를 보는 동안 사용할 수 있어야 한다 | finding 전환 후 draft와 진행 중 stream이 유지된다 |
| FR-UI-005 | 필수 | FNB는 기본 132px의 compact dock이며 접힘 48px과 resize를 지원해야 한다 | min/max/collapse와 reload 복원이 동작한다 |
| FR-UI-006 | 필수 | LNB 220–420px, Chat 320–560px 범위에서 resize하고 Main 최소 560px을 보호해야 한다 | separator drag와 keyboard resize test가 통과한다 |
| FR-UI-007 | 필수 | layout preference를 사용자·repository별로 저장하고 invalid value를 안전한 기본값으로 복구해야 한다 | reload, schema version 변경, corrupt storage test가 통과한다 |
| FR-UI-008 | 필수 | viewport에 따라 1280px compact, 960px stacked, 720px mobile state로 전환해야 한다 | 지정 viewport에서 overflow와 접근 불가 control이 없다 |
| FR-UI-009 | 필수 | LNB/Main/FNB/Chat selection은 하나의 snapshot-scoped state로 동기화해야 한다 | graph commit·finding·evidence 선택 E2E가 통과한다 |
| FR-UI-010 | 필수 | FNB에 Evidence trail, Git graph, History를 제공해야 한다 | tab이 실제 artifact를 표시하고 concept placeholder로 남지 않는다 |
| FR-UI-011 | 후속 | FNB와 Main maximize view에 Ownership, Impact, Related tests를 제공해야 한다 | 각 결과에서 근거 출처와 snapshot을 열 수 있다 |
| FR-UI-012 | 필수 | Git graph에서 base, merge-base, head와 선택 commit을 구분하고 commit diff로 이동해야 한다 | force-push·merge commit fixture를 올바르게 표시한다 |
| FR-UI-013 | 필수 | loading, empty, partial, stale, permission denied, rate-limited, failed 상태를 구분해야 한다 | 각 state Story/E2E에서 상태와 다음 동작이 보인다 |
| FR-UI-014 | 필수 | 긴 file list와 diff를 virtualize하고 line anchor를 안정적으로 복원해야 한다 | 100 files/5,000 lines fixture에서 interaction이 유지된다 |
| FR-UI-015 | 필수 | UI 기본 언어는 `ko-KR`이며 기술 개념이 흐려지는 용어는 English를 유지해야 한다 | message catalog 검사와 주요 화면 copy review가 통과한다 |
| FR-UI-016 | 필수 | separator, tabs, tree, diff와 Chat은 keyboard 접근과 visible focus를 제공해야 한다 | 자동 accessibility 검사와 keyboard E2E가 통과한다 |

### 6.7 Chat

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-CH-001 | 필수 | conversation을 tenant·repository·PR·snapshot에 고정해야 한다 | 다른 snapshot artifact를 tool로 읽을 수 없다 |
| FR-CH-002 | 필수 | 현재 selection과 사용자가 첨부한 evidence reference를 명시적으로 message에 기록해야 한다 | message provenance에서 scope를 재현한다 |
| FR-CH-003 | 필수 | Chat Agent는 diff, file, finding, history 등 승인된 typed read tool만 사용할 수 있어야 한다 | arbitrary shell/write/network tool 호출이 거부된다 |
| FR-CH-004 | 필수 | 답변을 SSE로 stream하고 reconnect 시 중복 token 없이 이어가거나 명확히 재시도해야 한다 | network interruption E2E가 통과한다 |
| FR-CH-005 | 필수 | 답변에서 사용한 evidence reference를 클릭 가능한 chip으로 제공해야 한다 | chip 선택 시 같은 snapshot의 근거로 이동한다 |
| FR-CH-006 | 필수 | 새 head 감지 시 기존 conversation을 stale로 표시하고 자동으로 새 snapshot에 합치지 않아야 한다 | stale 대화와 새 대화가 분리된다 |
| FR-CH-007 | 필수 | 권한 회수 또는 installation 제거 시 진행 중 stream을 종료해야 한다 | authorization TTL 만료 E2E에서 다음 chunk가 차단된다 |
| FR-CH-008 | 필수 | Chat token·tool-call budget과 timeout을 repository/tenant 정책으로 제한해야 한다 | limit 도달 시 일부 답변과 명확한 종료 사유를 반환한다 |

### 6.8 설정, suppression과 감사

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| FR-CF-001 | 필수 | base branch의 `.gcr.yml`을 run의 신뢰 config로 사용해야 한다 | head-only config 변경이 현재 run 정책을 완화하지 않는다 |
| FR-CF-002 | 필수 | config schema version과 unknown key 처리 정책을 제공해야 한다 | invalid config가 run을 무음으로 완화하지 않고 오류를 표시한다 |
| FR-CF-003 | 필수 | `.gcr/rules/*.md`를 정책 자료로 사용할 수 있으나 system instruction과 tool 권한을 바꾸지 못하게 해야 한다 | malicious rule fixture가 tool scope를 변경하지 않는다 |
| FR-CF-004 | 필수 | inline skip directive는 정확한 finding 또는 line scope와 reason을 가져야 한다 | 광범위하거나 reason 없는 suppression이 거부된다 |
| FR-CF-005 | 필수 | P3 suppression에는 repository 정책이 정한 CODEOWNER 승인을 요구할 수 있어야 한다 | 승인 전후 policy test가 통과한다 |
| FR-CF-006 | 필수 | policy·config commit·rule hash·suppression·게시 동작을 audit해야 한다 | actor, action, target, snapshot, time, result를 조회한다 |
| FR-CF-007 | 후속 | 감사 자료를 조직 정책에 맞는 형식으로 export해야 한다 | 권한이 있는 auditor만 범위 지정 export를 생성한다 |

## 7. Data 요건

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| DR-001 | 필수 | 모든 domain row와 artifact key는 tenant ID를 포함해야 한다 | tenant IDOR integration test가 통과한다 |
| DR-002 | 필수 | repository, pull_request, snapshot, analysis_run, finding, evidence, conversation, message, poll_state, audit_event를 영속화해야 한다 | migration과 repository contract test가 통과한다 |
| DR-003 | 필수 | source/diff와 대용량 analyzer output은 object storage에 저장하고 DB에는 metadata·checksum·scope를 저장해야 한다 | DB backup만으로 source 본문이 노출되지 않는다 |
| DR-004 | 필수 | artifact 접근은 짧은 수명의 scope 제한 URL 또는 API proxy를 사용해야 한다 | 다른 tenant·snapshot에서 URL 재사용이 실패한다 |
| DR-005 | 필수 | report, finding, artifact schema를 versioning하고 backward-compatible reader 또는 migration을 제공해야 한다 | 이전 fixture를 현재 service가 읽는다 |
| DR-006 | 필수 | source artifact, report, Chat, audit log의 retention을 서로 다르게 설정할 수 있어야 한다 | `OD-008` 확정 후 lifecycle E2E가 통과한다 |
| DR-007 | 필수 | installation 삭제 시 새 수집을 중단하고 policy에 따른 purge workflow를 실행해야 한다 | purge job과 audit record가 남고 data access가 차단된다 |
| DR-008 | 필수 | token, private key, secret value는 DB domain table, queue payload, artifact에 저장하지 않아야 한다 | secret scan과 payload inspection이 통과한다 |
| DR-009 | 필수 | timestamps는 UTC로 저장하고 UI에서 `ko-KR` timezone formatting을 적용해야 한다 | timezone fixture에서 저장값과 표시값이 일치한다 |

## 8. 보안과 privacy 요건

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| SEC-001 | 필수 | UI는 조직 SSO/OIDC로 인증하고 GitHub identity를 연결해야 한다 | 미인증·연결 해제 사용자의 repository API가 거부된다 |
| SEC-002 | 필수 | repository 요청마다 사용자 read 권한과 installation 범위를 확인하고 짧은 authorization cache TTL을 사용해야 한다 | 권한 회수 후 TTL 이내 접근이 종료된다 |
| SEC-003 | 필수 | GitHub App private key와 runtime secret은 secret manager 또는 workload identity로 주입해야 한다 | image, manifest, CI log에 secret이 없다 |
| SEC-004 | 필수 | source, diff, prompt, Chat 원문을 application log와 trace attribute에 기록하지 않아야 한다 | telemetry inspection test가 통과한다 |
| SEC-005 | 필수 | 저장·전송 구간을 암호화하고 tenant별 key 적용 확장 지점을 제공해야 한다 | TLS와 storage encryption 설정을 배포 gate에서 검증한다 |
| SEC-006 | 필수 | model 호출은 승인된 private gateway·model·region으로 제한하고 public fallback을 금지해야 한다 | endpoint allowlist 밖 호출이 실패한다 |
| SEC-007 | 필수 | private code를 embedding, feedback 학습, 평가 dataset으로 별도 동의 없이 재사용하지 않아야 한다 | 관련 background job과 export가 기본값에서 없다 |
| SEC-008 | 필수 | Worker와 analyzer sandbox에 default-deny egress를 적용해야 한다 | NetworkPolicy test에서 비허용 endpoint 연결이 실패한다 |
| SEC-009 | 필수 | Worker image를 immutable digest로 배포하고 SBOM, provenance, vulnerability scan, signature 검증을 거쳐야 한다 | unsigned·mutable·critical 취약 image가 차단된다 |
| SEC-010 | 필수 | CI build context와 image layer에 repository clone, runtime config와 secret을 포함하지 않아야 한다 | image history/layer와 build cache scan이 통과한다 |
| SEC-011 | 필수 | application container와 repository command sandbox를 분리하고 승인 command만 실행해야 한다 | arbitrary command, hook, submodule exploit fixture가 실패한다 |
| SEC-012 | 필수 | model output과 repository Markdown을 sanitize하고 CSP 등 browser 방어를 적용해야 한다 | stored/reflected XSS fixture가 차단된다 |
| SEC-013 | 필수 | 감사 log는 append-only 또는 위변조 검출이 가능한 storage로 전달할 수 있어야 한다 | 권한 없는 수정·삭제가 거부된다 |
| SEC-014 | 조건부 | optional webhook mode는 raw-body HMAC, delivery replay 방지, installation 재확인을 적용해야 한다 | 서명 오류·재전송·host 혼동 test가 통과한다 |

## 9. 비기능 요건

### 9.1 성능·확장성

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| NFR-PERF-001 | 필수 | 100 files, 5,000 changed lines 이하의 일반 PR을 5분 안에 completed 또는 partial 처리하는 것을 목표로 한다 | 운영과 유사한 fixture의 p95를 측정한다 |
| NFR-PERF-002 | 필수 | 이미 생성된 diff/file index API의 p95 응답 시간을 500ms 이하로 목표로 한다 | cache warm/cold 조건을 구분한 load test를 기록한다 |
| NFR-PERF-003 | 필수 | file list와 diff는 viewport 중심으로 읽고 render해야 한다 | large fixture에서 browser freeze와 전체 DOM line render가 없다 |
| NFR-SCL-001 | 필수 | Poller와 Worker를 독립적으로 horizontal scale할 수 있어야 한다 | replica 수를 바꿔도 duplicate run·publish가 없다 |
| NFR-SCL-002 | 필수 | host/installation/repository 단위 concurrency와 quota budget을 적용해야 한다 | 한 tenant의 대형 repository가 다른 tenant queue를 고갈시키지 않는다 |
| NFR-SCL-003 | 후속 | queue partition과 object lifecycle을 tenant·workload class별로 조정할 수 있어야 한다 | enterprise load test에서 priority isolation을 확인한다 |

### 9.2 신뢰성·복구

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| NFR-REL-001 | 필수 | 동일 snapshot의 analysis run을 한 번만 생성하고 외부 side effect는 at-most-once로 처리해야 한다 | concurrency와 retry E2E가 통과한다 |
| NFR-REL-002 | 필수 | scheduler 재시작·lease 이전 후 마지막 checkpoint에서 재개하고 2회 interval 안에 정상 주기로 복구해야 한다 | failure injection test로 측정한다 |
| NFR-REL-003 | 필수 | stage별 timeout·retry를 분리하고 마지막 완료 stage부터 안전하게 재개해야 한다 | Worker kill/restart test에서 완료 artifact를 재사용한다 |
| NFR-REL-004 | 필수 | 새 head 감지 후 10초 안에 이전 run과 UI 결과를 stale/superseded로 표시해야 한다 | detection event 후 state transition 시간을 측정한다 |
| NFR-REL-005 | 필수 | schema가 잘못된 model response를 제한 횟수만 재시도하고 partial report로 종료해야 한다 | 무한 retry나 queue poison이 없다 |
| NFR-REL-006 | 필수 | 정기 full reconciliation으로 polling cursor 누락을 복구해야 한다 | 의도적으로 event를 누락한 fixture가 다음 reconciliation에서 수집된다 |

### 9.3 운영·관측성

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| NFR-OPS-001 | 필수 | poll lag, detection lag, queue lag, stage duration, retry, quota, token, schema failure, publish failure metric을 제공해야 한다 | dashboard/query에서 opaque tenant/repo ID 기준으로 조회한다 |
| NFR-OPS-002 | 필수 | `poll/refresh → detection → snapshot → run → stage → publish` correlation을 제공해야 한다 | 하나의 run을 trace ID로 연결할 수 있다 |
| NFR-OPS-003 | 필수 | metric label과 trace에 repository name, path, prompt, source text를 넣지 않아야 한다 | telemetry privacy test가 통과한다 |
| NFR-OPS-004 | 필수 | deployment, rollback, secret rotation, queue drain, poll recovery, purge runbook을 제공해야 한다 | pilot readiness review에서 operator가 절차를 재현한다 |
| NFR-OPS-005 | 필수 | 서비스 health와 dependency readiness를 분리해야 한다 | DB/queue/model 장애 시 health signal이 원인을 구분한다 |

### 9.4 사용성·접근성·호환성

| ID | 수준 | 요건 | 검증 기준 |
|---|---|---|---|
| NFR-UX-001 | 필수 | snapshot, stale, partial, last checked, coverage를 review 판단 지점에 표시해야 한다 | 사용자가 최신성·누락을 한 화면에서 확인한다 |
| NFR-UX-002 | 필수 | destructive하지 않은 선택·panel resize·Chat draft는 navigation과 reload에서 복원해야 한다 | 복원 E2E가 통과한다 |
| NFR-A11Y-001 | 필수 | 핵심 review flow는 mouse 없이 실행 가능해야 한다 | keyboard-only 시나리오와 WCAG 2.2 AA 자동 검사 기준을 만족한다 |
| NFR-I18N-001 | 필수 | 사용자 문구를 message catalog로 분리하고 날짜·숫자·상대시간에 `Intl`을 사용해야 한다 | hard-coded 주요 문구와 locale 오류 검사에서 통과한다 |
| NFR-COMP-001 | 필수 | 조직이 승인한 최신 Chrome과 Edge를 우선 지원해야 한다 | 정확한 version 범위는 `OD-010`에서 확정하고 E2E matrix에 반영한다 |
| NFR-COMP-002 | 필수 | GitHub Enterprise Cloud 또는 선택한 GHES version의 API 차이를 adapter에서 격리해야 한다 | host별 contract suite가 통과한다 |

## 10. 상태와 오류 표시 요건

| 상태 | 사용자에게 보여줄 내용 | 허용 동작 |
|---|---|---|
| queued | 대기 사유와 생성 시각 | refresh 중복 요청은 coalesce |
| running | 현재 stage, 시작 시각, coverage 진행률 | 이전 완료 report 조회 가능 |
| completed | snapshot, 완료 시각, 전체 coverage | finding 조사, Chat, 게시 상태 확인 |
| partial | 완료 결과와 생략 stage/file/context, 사유 | 조사 가능, 재시도 정책에 따라 refresh |
| failed | 실패 stage, 사용자에게 안전한 오류, correlation ID | 권한이 있으면 retry/refresh |
| stale | 현재 head와 report head, 마지막 확인 시각 | 읽기만 가능, 게시 금지, 최신 run 이동 |
| superseded | 대체한 run link | 새 run으로 이동 |
| rate-limited | 영향 범위, retry 시각 | 불필요한 반복 refresh 방지 |
| permission denied | 권한 부족 또는 설치 범위 제외 | source·artifact·Chat 내용 표시 금지 |

오류 문구에 token, endpoint credential, source snippet, 내부 stack trace를 포함하지 않는다. 운영자가 사용할 correlation ID와 사용자가 취할 수 있는 다음 동작을 구분해 표시한다.

## 11. 검수 시나리오

| ID | 시나리오 | 관련 요건 | 통과 조건 |
|---|---|---|---|
| AT-001 | private test repository에 PR을 연다 | FR-GH-004, FR-SN-001, FR-RP-002 | polling이 변경을 감지하고 snapshot·run·Check를 각각 한 번 만든다 |
| AT-002 | 같은 head를 concurrent poller가 읽는다 | FR-SN-002, NFR-REL-001 | snapshot·run·게시가 중복되지 않는다 |
| AT-003 | 분석 중 새 commit을 push한다 | FR-RP-003, NFR-REL-004 | 이전 run은 stale/superseded, 새 run은 다른 snapshot으로 생성된다 |
| AT-004 | finding을 선택하고 Chat으로 질문한다 | FR-UI-009, FR-CH-001, FR-CH-005 | diff·evidence·Chat이 같은 snapshot을 가리키고 evidence로 복귀한다 |
| AT-005 | panel을 pointer와 keyboard로 resize한다 | FR-UI-005~008, FR-UI-016 | min/max를 지키고 reload·responsive 전환 후 유효한 layout이 복원된다 |
| AT-006 | parser 하나와 model specialist 하나를 실패시킨다 | FR-AN-008, FR-RP-001 | 성공 결과가 남고 partial coverage와 omission이 표시된다 |
| AT-007 | PR source에 prompt injection과 malicious filename을 넣는다 | FR-RV-009, FR-SN-004~005 | tool scope·command·network 경계가 변하지 않는다 |
| AT-008 | GitHub App 접근 범위를 축소한다 | FR-GH-009, SEC-002, FR-CH-007 | 신규 수집이 중단되고 API·artifact·stream 접근이 차단된다 |
| AT-009 | Worker image pipeline을 실행한다 | SEC-003, SEC-009~010 | scan/SBOM/provenance/signature 후 digest로 배포되며 secret/source가 image에 없다 |
| AT-010 | oversized PR을 분석한다 | FR-AN-009, BR-006, BR-008 | 위험 경로부터 분석하고 생략 항목·이유·비용 상태를 report에 기록한다 |
| AT-011 | head에서 `.gcr.yml`을 완화한다 | FR-RP-008, FR-CF-001 | 현재 run은 base 정책을 사용하고 변경 자체만 분석한다 |
| AT-012 | stale finding의 inline 게시를 시도한다 | FR-RP-003~005 | head 또는 anchor 불일치로 게시되지 않고 audit에 사유가 남는다 |

## 12. 요건 추적 기준

| 요건군 | 기능설계 책임 영역 | 주 검증 | 목표 milestone |
|---|---|---|---|
| `FR-GH-*` | GitHub Adapter, Poll Scheduler, Reconciliation | contract/integration/E2E | M1 Walking Skeleton |
| `FR-SN-*` | Snapshot Collector, Git sandbox, Artifact Store | unit/security/integration | M1 Walking Skeleton |
| `FR-AN-*` | Deterministic Analyzer | fixture/golden/integration | M2 MVP, 일부 M4 |
| `FR-RV-*` | Agent Orchestrator, Verifier | schema/golden/security | M2 MVP |
| `FR-RP-*` | Report Composer, Publisher | contract/concurrency/E2E | M1–M2 |
| `FR-UI-*` | Web Review Workspace | component/accessibility/E2E | M2 MVP, 일부 M4 |
| `FR-CH-*` | Chat API, Agent, SSE | contract/security/E2E | M2 MVP |
| `FR-CF-*` | Policy package, Audit | unit/integration | M2–M3 |
| `DR-*`, `SEC-*` | DB, storage, identity, platform | migration/security | M1–M3 |
| `NFR-*` | 전체 system | load/failure injection/operational review | M2–M3 |

구체적인 요건 ID와 commit phase 매핑은 `implementation-plan.md`의 추적 표를 따른다.

## 13. 미정 사항과 결정 기한

| ID | 결정 항목 | 기본 가정 | 결정 시점 | 영향 |
|---|---|---|---|---|
| OD-001 | GitHub Enterprise Cloud 또는 GHES version | adapter contract는 둘 다 수용, 첫 E2E target은 미정 | CP-05 시작 전 | 인증, API, update test |
| OD-002 | 허용 outbound endpoint, DNS/TLS inspection | fixed egress IP와 allowlist 사용 | CP-03 시작 전 | NetworkPolicy, certificate bundle |
| OD-003 | 조직/repository/active PR 규모와 detection lag | blueprint의 60초/5분을 설계 목표로 사용 | CP-07 부하검증 전 | polling shard, quota budget |
| OD-004 | installation token broker | GitHub App direct 발급 interface로 시작 | CP-05 시작 전 | secret·identity integration |
| OD-005 | approved model endpoint·region·retention | public fallback 없음 | CP-19 시작 전 | model gateway, privacy test |
| OD-006 | 우선 지원 언어 두 개와 build system | parser interface만 먼저 고정 | CP-18 시작 전 | analyzer adapter, fixture |
| OD-007 | inline comment와 P3 Check failure 정책 | 둘 다 기본 off | CP-24 시작 전 | GitHub permission, policy matrix |
| OD-008 | source/report/Chat/audit retention | 항목별 설정 가능, 실제 기간 미정 | pilot 전 | storage lifecycle, purge SLA |
| OD-009 | CI, private registry, signing/admission 제품 | OCI·OIDC·digest contract만 고정 | CP-12 시작 전 | pipeline manifest |
| OD-010 | 지원 browser version | 조직 관리 Chrome/Edge 최신 version | CP-27 E2E 전 | test matrix |
| OD-011 | runtime platform | Kubernetes manifest 우선, VM adapter 가능 | CP-03 시작 전 | deployment와 secret injection |
| OD-012 | SSO와 GitHub identity 연결 방식 | OIDC subject와 GitHub identity mapping | CP-14 시작 전 | authorization schema |

미정 사항은 해당 commit phase의 시작 전까지 확정한다. 결정이 지연되면 interface와 test double까지만 구현하고 특정 vendor나 정책 값을 code에 고정하지 않는다.

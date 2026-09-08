# Interactive Review Chat 구현 계획

작성일: 2026-09-08. 상태: 사용자 승인 후 P0–P5 구현·검증 진행 중. 운영 반영 완료 여부는 후속 검증 기록을 따른다. 요구사항과 계약은 [설계 문서](interactive-review-chat-design.md)를 따른다.

## 구현 결정

- 운영 Kernel 5.4에서는 Landlock이 지원되지 않고 기존 Worker에서 user namespace 생성도 거부된다. 별도 source sandbox 컨테이너의 좁은 broker가 chroot 준비를 담당하고, 도구는 UID/GID 65534·no-new-privileges·seccomp 아래에서 읽기 전용 파일 트리만 본다. DB·GitHub·ChatGPT Secret은 이 컨테이너에 마운트하지 않는다. 실제 Linux에서 격리 검증 후 활성화한다.
- Chat은 기존 jobs와 다른 `chat_runs` lease queue로 실행하여 구버전 Worker가 새 작업 유형을 가져가는 문제를 피한다. 같은 Worker concurrency 안에서 처리한다.
- 첫 버전의 Chat 근거는 run당 제한된 본문을 DB에 저장하고 checkpoint와 원자적으로 확정한다. 대용량 artifact 분리보다 삭제·인가·트랜잭션 일관성을 우선하며 session 삭제 시 함께 제거한다. 자동 분석의 추가 source는 기존 analysis artifact 보존 정책을 따른다.

## 제공할 결과

사용자가 PR에 대해 질문하면 Worker가 해당 snapshot의 Git 저장소와 실제 파일 트리를 준비하고, base/head의 관련 코드·호출부·테스트를 탐색한다. AI가 사용자에게 판단을 확인하고 답변을 받아 분석을 이어 가며 답변에서 실제 읽은 코드로 이동할 수 있다. 중단·모바일 재접속·Worker 재시작과 계정 호출 제한을 함께 처리한다.

설계 문서에서 제안한 제한 값은 아직 배포되지 않았다. 아래 P0–P5를 첫 제공 범위로 묶는다. 코드 수정·명령 실행 agent나 shared mirror 최적화는 별도 후속 범위다.

## P0. 계약·위협 모델·실행 환경 확정

**작업**

- run, step, question, workspace, source citation, budget의 shared contract와 상태 전이표를 정의한다.
- 기존 session/message API와 report contract를 보존하고 새 기능은 기본 비활성 flag로 도입한다.
- `ToolSandbox` 실행 환경을 먼저 검증한다. 운영 Linux/Kubernetes에서 읽기 전용 mount, 비밀·process 격리, 탐색 도구의 네트워크 차단이 가능한 구성을 선택해 기록한다. 단순 sidecar·chmod를 대안으로 간주하지 않는다.
- DB migration을 설계한다. session별 활성 run, idempotency, fenced lease, 질문 응답, context artifact identity와 account quota key의 제약을 정한다.
- 사용자·repo 삭제와 credential 폐기 시 run, source artifact, workspace가 기존 보존 정책을 따르도록 정의한다.
- 작은 Git fixture를 만든다. 변경되지 않은 helper/test, base tip과 merge-base가 다른 경우, rename/delete, 중복 이름의 symbol, branch 이동, shallow history와 악성 파일명을 포함한다.

**변경 위치**

`packages/contracts/src/`, `packages/db/migrations/`, `apps/runtime/src/config.ts`, `packages/git-engine/src/`, `deploy/helm/git-code-reviewer/`.

**완료 조건**

- 상태 전이·취소·중복 제출·lease 경쟁의 기대 동작을 contract test로 고정한다.
- 빈 DB와 기존 schema에서 migration을 검증한다. 기존 메시지·분석 결과의 읽기 계약이 유지된다.
- 운영과 개발 환경의 sandbox 증거를 확보한다. 이 조건이 충족되지 않으면 code-tool 기능의 운영 활성화를 막는다.

## P1. 공통 Git workspace와 읽기 도구

**작업**

- `packages/git-engine`의 exact fetch를 workspace 생성/획득/갱신/폐기 API로 분리한다. 등록 origin, 사내 CA, credential 전달과 typed Git 오류를 함께 정리한다.
- 실제 `.git` 객체 저장소와 head/base/merge-base detached 파일 트리를 준비한다. checkout 후 blob/소스 일치 검증과 준비 완료 manifest를 생성한다.
- `list_files`, `search_code`, `read_file`, `git_diff`, `git_log`, `git_blame` 도구를 sandbox adapter에 연결한다. Git graph는 관련 코드 후보 조회에 재사용한다.
- path/option 주입, symlink, `.git`, external filter, binary, 큰 파일, submodule/LFS와 미확보 이력을 명시적으로 처리한다.
- per-workspace 및 전체 디스크 quota, clone concurrency, lease와 TTL 정리, Worker 교체 후 동일 SHA 재생성을 구현한다.
- snapshot materialization과 `analysis.run`이 같은 workspace/source provider를 사용하도록 연결한다. 기존 canonical diff/report 생성 순서는 보존한다.
- 코드 context는 실제 조회 범위와 예산 안에서 자동 분석에 추가한다. 새 조회 실패가 기존 report를 무조건 실패시키지 않도록 필수 diff 실패와 보조 context 누락을 구분하고 coverage에 기록한다.

**변경 위치**

`packages/git-engine/src/index.ts` 및 신규 workspace/tool 모듈, `apps/runtime/src/jobs/worker.ts`, `apps/runtime/src/services/`, `packages/analysis-engine/src/`, `deploy/helm/git-code-reviewer/templates/worker-deployment.yaml` 및 필요한 sandbox 배포 구성.

**완료 조건**

- diff에 없는 파일을 실제 local filesystem에서 검색·조회하고 exact blob/line 근거를 반환한다. 원격 파일 API로만 대체하거나 fixture 문장을 반환하면 실패다.
- base tip, merge-base, head 내용이 다른 fixture에서 각각 올바른 결과를 얻는다. branch를 이동해도 기존 run의 결과가 바뀌지 않는다.
- workspace 삭제·Worker 이동 뒤 동일한 revision을 복구한다. 활성 lease의 작업공간은 정리되지 않는다.
- 악성 저장소가 명령·filter를 실행하거나 다른 작업공간·credential을 읽지 못한다.
- 기존 자동 분석 fixture의 finding/summary 구조와 완료 상태가 유지되고 추가 소스의 출처가 기록된다.

## P2. 공통 모델 admission과 streaming/tool adapter

**작업**

- provider adapter에 tool schema/call/result, text delta, usage, AbortSignal을 추가한다. 기존 `generate()`는 호환 wrapper로 유지한다.
- 현재 등록된 ChatGPT account 설정을 새 경로에서도 사용한다. 모델·effort를 run 시작 시 고정하고 tool/streaming capability를 검사한다.
- 자동 분석과 기존/신규 Chat의 실제 upstream 호출을 모두 account-level reservation으로 통과시킨다. 같은 upstream 계정의 중복 등록과 다중 Worker를 처리한다.
- 부모 run별 예산을 영속화한다. unit/summary 호출, provider 내부 재시도, Worker 재시작과 사용자 응답 후 재개가 예산을 초기화하지 못하게 한다.
- 429 `Retry-After`, bounded backoff, quota/auth 오류, refresh 경쟁, timeout/abort 후 불확실한 사용량 처리를 구현한다.
- input/history/context 압축, 출력 예산 예약과 사용량 미제공 상태를 구분한다.

**변경 위치**

`apps/runtime/src/services/chat-model.ts`, `apps/runtime/src/services/analysis-provider.ts`, 신규 model-admission 서비스, `apps/runtime/src/jobs/worker.ts`, `packages/analysis-engine/src/`, `packages/db/migrations/`.

**완료 조건**

- 두 Worker가 같은 계정으로 자동 분석과 Chat을 동시에 실행해도 설정한 동시 호출 한도를 넘지 않는다.
- 429 동안 재요청 폭주·slot 점유가 없고 재시도 횟수와 token/request 예약을 추적할 수 있다.
- 요청 전 실패, 전송 중 손실, 응답 후 DB 저장 실패에서 초과 환급·무한 재시도가 없다.
- 실제 provider가 보내는 delta와 tool call을 파싱한다. 완성 답변을 잘라 보내는 가짜 streaming은 통과 기준이 아니다.
- legacy Chat과 자동 분석의 기존 provider 테스트도 통과한다.

## P3. 영속 agent run과 사용자 확인

**작업**

- 새로운 Chat job 유형과 run API를 추가한다. Server는 202로 응답하고 Worker가 실행한다.
- 질문→도구 선택→로컬 조회→추가 탐색→사용자 확인→재개→근거 포함 답변의 반복 루프를 구현한다.
- model/tool step 결과와 checkpoint를 저장한다. 완료된 도구 결과는 재사용하고 stale Worker 결과는 fencing으로 거부한다.
- `ask_user`의 선택지/자유 입력, 만료, 중복 응답과 실행 중 추가 지시를 구분한다. 응답·capacity 대기에서는 job과 계정 슬롯을 반납한다.
- 중단, partial/failed, provider interruption의 attempt 경계를 저장한다. source가 없거나 모델이 실패하면 demo 응답으로 전환하지 않는다.
- context manifest와 별도 source-file identity를 추가한다. 모델에 실제 전달한 unit만 citation으로 허용한다.
- 기존 memory recall을 단계별 context에 연결하되 집단 우선권, owner 경계와 출처를 유지한다. Chat의 판단은 명시적인 후보 저장만 허용한다.

**변경 위치**

`apps/runtime/src/routes/chat.ts`, `apps/runtime/src/services/chat-answer.ts`, 신규 chat-run/agent/context 서비스, `apps/runtime/src/jobs/worker.ts`, 기존 event hub, `packages/contracts/src/`, `packages/db/migrations/`.

**완료 조건: 첫 end-to-end 기능 검증**

“기존 재시도 정책과 충돌하는가” 질문에 agent가 변경되지 않은 base/head helper를 읽고, 필요한 업무 판단을 사용자에게 물은 뒤 답변을 받아 추가 분석한다. 최종 citation으로 당시 파일·revision·line을 다시 열 수 있어야 한다. 다음 실패 시나리오도 같은 경로에서 검증한다.

- 질문 대기 중 Worker 종료 → 다른 Worker가 응답 이후 같은 run을 재개한다.
- 모델/tool 완료 후 lease 손실 → 결과·assistant 메시지가 중복 확정되지 않는다.
- SSE 구독을 반복해도 추가 모델 호출이 발생하지 않는다.
- 중단 후 늦게 도착한 delta/result가 완료 상태를 덮어쓰지 않는다.
- 근거 파일 접근 권한이 철회되면 기존 링크와 실행 중 새 조회가 차단된다.

## P4. Review Workspace UI

**작업**

- `ChatPanel.tsx`를 run 기반으로 전환하고 실제 text delta, tool timeline, 질문 카드, 추가 지시, 중단과 대기를 표시한다.
- 상태 조회 + sequence 기반 SSE replay로 새로고침·모바일 접속을 복구한다. event 보존 범위를 벗어난 경우 snapshot부터 다시 불러온다.
- 메인 `코드 근거` 탭에 변경되지 않은 파일까지 표시하고 base/merge-base/head·line을 구분한다. 오른쪽 좁은 Chat에 긴 소스를 모두 넣지 않는다.
- 기존 summary/findings 탭, unit 선택, Markdown citation, account/model/effort 제어를 보존한다.
- 개인·집단·PR 대화 출처를 표시하고 새 판단의 메모리 후보 저장을 기존 승인 workflow에 연결한다.
- Enter 전송, Shift+Enter 줄바꿈, IME 조합, 키보드 focus, 화면 읽기 도구의 진행 알림을 검증한다. token마다 과도한 알림은 내보내지 않는다.

**변경 위치**

`apps/web/src/ChatPanel.tsx`, `apps/web/src/api.ts`, `apps/web/src/App.tsx`, 신규 run timeline/question/source viewer 컴포넌트와 인접 테스트.

**완료 조건**

- desktop/mobile에서 분석 중, 도구 조회, 사용자 응답 대기, 호출 대기, 완료, partial, 실패, 중단 화면을 확인한다.
- 동일 run을 두 화면에서 열고 질문에 중복 응답해도 한 번만 재개한다.
- 화면 전환·새로고침 후 질문, 입력 상태와 소스 위치를 복구하고 중복 메시지가 생기지 않는다.
- 실제 AI 실행의 답변·도구 근거 화면을 캡처한다. fixture 검증 화면과 실제 AI 화면을 별도로 표기한다.

## P5. 통합 검증·운영 적용

**작업**

- Docker Compose, VS Code 개발 설정과 Helm에 workspace/sandbox, quota, feature flag 설정을 추가한다. 비밀은 소스나 이미지에 포함하지 않는다.
- 계약·DB integration·로컬 Git fixture·provider 오류·UI 테스트를 모아 전체 회귀를 수행한다.
- run/step duration, clone bytes/cache reuse, 도구 실패·omission, 질문 대기/재개, SSE lag/replay, 계정 queue/429, 모델 전송·token 사용을 계측한다. 소스·프롬프트·개인 답변 원문을 일반 로그에 남기지 않는다.
- 실제 GHES 저장소와 현재 등록된 ChatGPT account로 코드 조회→질문→재개→답변→근거 링크를 확인한다. 저장소 코드 실행이나 GitHub 게시 없이 검증한다.
- 사용자 가이드와 기능 문서에 제공된 범위·보존 기간·실행 제한을 반영한다. 계획 단계의 기능을 이미 사용 가능한 것으로 소개하지 않는다.

**배포 순서**

1. backward-compatible migration과 공통 Worker/provider 기반을 배포하고 신규 Chat flag는 끈다.
2. 내부 계정·허용 저장소에서 활성화한다. 제한 값, Git/CA, 실제 tool capability와 복구를 확인한다.
3. 해당 계정에서 자동 분석과 Chat을 함께 실행해 공통 admission을 검증한다. run별 호출 횟수와 전체 계정 동시 호출을 따로 확인한다.
4. desktop/mobile 완료 화면, 실패·대기·복구 기록과 배포 image/commit 근거를 남긴 뒤 허용 대상을 확대한다.

**Rollback**

새 run 생성을 flag로 중지하고 진행 중 run은 완료·취소·대기 상태를 명시적으로 정리한다. 기존 메시지 조회와 legacy Chat 경로를 유지한다. 추가한 DB schema/근거를 삭제하거나 down migration으로 되돌리지 않는다. 구버전 Worker가 새 job 유형을 claim하지 못하도록 job type/capability 필터와 배포 순서를 검증한다. 이전 바이너리로 복귀해야 하면 새 유형 Worker의 drain을 먼저 완료한다.

**완료 조건**

아래 회귀 표를 통과하고 실제 AI 검증에서 조회한 SHA/파일과 답변 citation이 일치해야 한다. commit/push/배포는 이 계획의 구현이 요청된 이후 기능 작업의 완료 과정에서 수행한다. 이번 계획 문서 작성만으로 운영을 변경하지 않는다.

## 통합 회귀 표

| 검증 | 성공 조건 |
| --- | --- |
| 실제 local source | 실제 Git 객체와 checkout이 있고 diff 밖 파일을 읽는다. base·merge-base·head가 혼동되지 않는다. |
| 변경/이력 | rename/delete, branch 갱신, 얕은 이력, missing SHA, fork ref 실패를 정확히 처리한다. |
| 보안 | traversal, option/pathspec 주입, symlink, 악성 attribute/filter, credential 노출, cross-user/repo source 접근이 차단된다. |
| 제한 | 큰 저장소·파일·출력, clone 시간·디스크 부족, context 초과가 제한 사유로 남는다. 무제한 재시도하지 않는다. |
| 복합 질문 | 관련 기존 코드·테스트를 추가 조회하고 사용자의 답변 이후 실제로 분석을 이어 간다. |
| 복구 | 질문 대기·capacity 대기·모델 진행 중 Worker 종료에서 영속 상태로 복구한다. 불확실한 호출을 공짜로 재시도하지 않는다. |
| 동시성 | 두 Worker·두 탭·중복 요청·stale lease에서 run/질문/메시지/근거가 중복 확정되지 않는다. |
| 모델 | provider streaming/tool 결과, auth/429/timeout/cancel을 구분한다. 자동 분석·legacy Chat도 계정 한도를 공유한다. |
| 근거 | 실제 입력 unit만 인용한다. 변경되지 않은 파일, 다른 revision, 만료된 artifact를 올바르게 표시한다. |
| 메모리 | 집단 우선·개인 격리·PR 메시지 출처·명시적 후보 저장을 유지하고 canonical report를 자동 수정하지 않는다. |
| UI | Enter/Shift+Enter/IME, desktop/mobile, 질문·대기·partial·실패·중단·재연결을 확인한다. |
| 운영 | migration 전후 호환, 오래된 Worker의 job claim, flag rollback, workspace/artifact 정리, Secret/CA 보존을 검증한다. |

## 의존성과 후속 범위

P0 뒤에 P1과 P2를 독립적으로 진행할 수 있다. P3은 두 단계가 모두 필요하다. P4의 UI fixture 개발은 contract 확정 후 가능하지만 실제 기능 완료 판정은 P3과의 연결 후에 한다. P5는 전체 통합 후 수행한다.

shared bare mirror, 전체 repository의 LSP/정밀 호출 graph, 여러 agent의 병렬 탐색, code patch와 test/build 실행은 후속 backlog다. 첫 제공의 clone·기존 코드 조회·사용자 확인·실제 streaming·계정 제한·복구를 이 후속 범위로 미루지 않는다.

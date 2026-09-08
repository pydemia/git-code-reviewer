# 로컬 Git 기반 Interactive Review Chat 설계

작성일: 2026-09-08. 이 문서는 구현 착수 시점의 설계 기준이다. P0–P5 구현을 진행했으며 실제 제공 범위와 설계에서 조정한 내용은 [운영 문서](../docs/operations/interactive-chat.md), 배포 결과는 PRISM-DEV 기록을 따른다. 아래 현재 코드 표는 설계 이전 상태다.

## 1. 적용 범위와 현재 구현

Review Chat을 사용자의 질문에 따라 실제 저장소를 탐색하고, 필요한 판단을 사용자에게 확인한 뒤 분석을 이어 가는 읽기 전용 agent로 확장한다. 코드 분석의 실행 기반은 로컬 Git 저장소와 파일 트리다. 미리 만들어 둔 diff나 report만 모델에 넣는 방식으로 이 요구를 충족했다고 판단하지 않는다.

여기서 **로컬**은 agent가 실행되는 Worker의 디스크를 뜻한다. 운영 환경에서는 Pod/노드의 격리된 작업공간이고 개발 환경에서는 개발자가 지정한 로컬 디렉터리다. 브라우저·모바일에 clone하지 않으며 사용자가 다른 작업에 쓰는 checkout을 재사용하거나 변경하지 않는다.

| 구분 | 현재 코드에서 확인한 동작 | 추가할 동작 |
| --- | --- | --- |
| Git | `packages/git-engine/src/index.ts`가 Git 저장소를 초기화하고 exact base/head SHA를 fetch하여 merge-base, diff, commit 목록을 추출한다. 일반 소스 작업 트리는 checkout하지 않는다. | 실제 Git 저장소와 revision별 파일 트리, 제한된 Git/파일 탐색 도구 |
| 작업공간 | `apps/runtime/src/jobs/worker.ts`가 job별 임시 디렉터리를 만들고 종료 시 삭제한다. 후속 자동 분석은 저장된 diff artifact를 읽는다. | 자동 분석과 Chat이 함께 쓰는 작업공간 관리자, lease 기반 재사용·재생성 |
| Chat context | `chat-answer.ts`가 report의 전체·파일 요약, 여러 findings, 선택 범위, history와 memory를 입력한다. 변경되지 않은 소스·테스트 본문을 추가 조회하지 않는다. | 질문별로 관련 파일, 기존 구현, 호출부, 테스트와 Git 이력을 반복 탐색 |
| Chat 실행 | HTTP 메시지 요청 안에서 `generate(): Promise<string>` 완료를 기다린다. SSE는 완료 이벤트를 제공한다. | 비동기 run, 실제 모델 출력 스트리밍, 도구 진행, 사용자 확인, 중단·복구 |
| 호출 제한 | 사용자별 Chat 동시 실행·시간당 요청 제한과 자동 분석 run별 모델 호출 예산이 있다. | 자동 분석·Chat을 합친 upstream 계정별 admission과 재시도에도 유지되는 예산 |

Demian의 `apps/web/src/components/ChatClient.tsx`, `apps/worker/src/events.ts`, `apps/worker/src/worker.ts`, `apps/worker/src/runtime-bridge.ts`에서 run, event, tool timeline, cancel, reconnect 구조를 참고한다. Demian의 permission UI는 업무 요건을 묻는 clarification과 구분한다. 임의 shell·파일 수정 권한이나 사용자 응답을 기다리는 동안 Worker를 점유하는 방식은 그대로 가져오지 않는다.

### 첫 제공 범위

- 등록된 저장소를 clone/fetch하고 고정된 base·merge-base·head의 실제 파일과 Git 정보를 읽는다. 변경되지 않은 관련 코드도 대상이다.
- AI가 조회 결과에 따라 추가 도구를 선택한다. 기존 report 설명만 필요한 질문은 불필요한 clone과 모델 재호출을 생략할 수 있다.
- 요구사항이 불명확하면 선택지와 자유 입력으로 확인하고 같은 분석을 재개한다.
- 실제 답변 delta, 수행 중인 도구, 확인한 근거, 누락 범위를 표시한다. 새로고침·모바일 재접속·Worker 교체를 처리한다.
- 기존 ChatGPT account·모델·reasoning 설정과 개인/집단 메모리 정책을 유지한다.

코드 수정, dependency 설치, test/build 실행, 임의 shell, commit/push, GitHub 댓글 자동 게시는 포함하지 않는다. 테스트 **소스 조회**는 포함한다. 이후 실행 기능을 추가하려면 별도의 실행 sandbox와 승인 정책을 설계한다. 이 시스템을 Codex CLI 프로세스로 구현하거나 사용자의 Codex 인증 디렉터리를 통째로 마운트하지 않는다.

## 2. 실행 구조

```text
Review Workspace / Mobile
  ├─ Run 생성 · 중단 · 질문 응답 → Server: 인증/인가, 멱등 처리
  └─ 상태 조회 · SSE 재연결      ← event_log: 순서가 있는 영속 이벤트
                                      │
                              PostgreSQL jobs / chat_runs
                                      │
                           Worker: checkpoint 기반 agent loop
                              ├─ RepositoryWorkspaceManager
                              │    ├─ 신뢰된 clone/fetch 준비 단계
                              │    └─ ToolSandbox: local file / Git 읽기
                              ├─ Context ledger / evidence artifacts
                              └─ Account admission → 기존 Model provider

자동 analysis.run ──────────────┘ 공통 workspace/source provider와 account admission 사용
```

Server는 clone이나 긴 모델 요청을 실행하지 않는다. 요청을 DB에 저장한 뒤 run ID를 반환한다. Worker가 lease를 얻어 실행하고 상태·질문·근거·출력 이벤트를 저장한다. 이벤트는 DB commit 후 전달하며 브라우저 연결이 끊겨도 run을 취소하지 않는다.

자동 분석에도 같은 source provider를 연결한다. 기존 window 기반 기본 report 생성은 유지하되 필요한 주변 코드와 base/head 구현을 고정된 작업공간에서 읽게 한다. 첫 버전부터 자동 분석의 코드 조회 경로를 별도 구현으로 남기지 않는다. 자동 분석에 무제한 agent loop를 추가하는 것은 범위가 아니다.

## 3. Git 작업공간

### Revision 고정

실행 시작 시 `snapshotId`, `baseSha`, `mergeBaseSha`, `headSha`를 DB에 고정한다.

- `baseSha`: 해당 snapshot이 채택한 base branch의 tip. 질문에서 기존 base branch 구현을 확인할 때 사용한다.
- `mergeBaseSha`: canonical PR diff의 비교 기준. `baseSha`와 같다고 가정하지 않는다.
- `headSha`: 리뷰하는 변경의 정확한 revision.

PR이나 branch가 갱신되어도 진행 중인 run의 revision을 바꾸지 않는다. UI에 최신 snapshot이 있음을 알리고 사용자가 새 run을 시작하도록 한다. 원래 SHA를 가져올 수 없으면 최신 branch로 대체하지 않고 제한 사유를 반환한다.

### 디렉터리와 준비 절차

```text
WORKSPACE_ROOT/<opaque-workspace-id>/
  repository.git/
  views/head/
  views/base/
  views/merge-base/
```

작업공간 식별자는 서버에서 생성한다. 도구에는 이 절대경로나 다른 사용자의 작업공간 목록을 전달하지 않는다.

1. 사용자의 repository 접근 권한과 등록된 GHES origin/credential을 확인한다.
2. 전용 디렉터리에 clone하거나 현재의 `init + fetch` 구현을 확장해 실제 Git 객체 저장소를 만든다. 모델이 remote URL·credential·fetch refspec을 직접 지정하지 못한다.
3. 고정된 SHA와 commit 객체를 검증하고 필요한 tree/blob을 예산 안에서 확보한다. shallow fetch로 merge-base가 없으면 제한적으로 deepen한다.
4. head와 필요한 base/merge-base를 detached worktree로 구성한다. 도구가 읽을 수 있는 일반 소스 파일 트리를 실제로 제공한다.
5. credential을 제거한 탐색 환경을 열고 workspace lease를 기록한다. checkout 완료 전에는 `workspace.ready`를 내보내지 않는다.

partial clone은 GHES 지원 확인 후 적용하는 최적화다. 도구 실행 중 Git의 lazy fetch로 네트워크 접근이 발생하지 않도록 필요한 객체를 준비 단계에서 확보한다. 누락된 객체는 준비 단계로 되돌아가 제한적으로 가져오거나 `source_unavailable`로 남긴다. 전체 이력을 무제한으로 clone한다는 뜻은 아니다.

Fork PR의 head는 등록된 서비스가 검증한 PR ref 또는 별도로 인가한 origin에서만 가져온다. 지원하지 않는 ref, 삭제된 commit, 해결되지 않은 merge-base, 용량 초과를 구별한다. submodule과 LFS 외부 객체는 첫 버전에서 자동 다운로드하지 않고 해당 범위의 미확보 상태를 표시한다.

### 재사용과 폐기

- 기본 격리 키는 tenant, repository, owner, credential identity/version, snapshot/revision 조합이다. 다른 사용자의 clone·탐색 결과·Chat history를 기본값으로 공유하지 않는다.
- 같은 session의 후속 turn은 유효한 workspace를 재사용할 수 있다. 활성 lease가 없을 때만 TTL/LRU 정리한다. 대기 중 run도 디스크를 영구 점유하지 않는다.
- 재접속이나 Worker 교체 시 workspace가 없어도 고정된 SHA로 재생성한다. 로컬 경로·Worker affinity는 최적화일 뿐 복구의 전제 조건이 아니다.
- DB의 checkpoint, context manifest와 artifact가 근거의 원본이다. Workspace는 폐기 가능한 cache다. private source artifact의 접근 권한과 보존 기간도 별도로 적용한다.
- credential 폐기, 사용자/저장소 삭제, 접근 권한 철회 시 새 도구 실행을 차단하고 관련 workspace를 정리한다. 보존된 근거의 조회 권한도 다시 검사한다.
- 공유 bare mirror는 후속 최적화다. 도입 시 tenant·credential 경계, fetch 잠금, immutable view와 cache poisoning 방지를 검증한다.

기존 `emptyDir` 또는 ephemeral PVC를 사용할 수 있지만 전체 Worker 디스크 한도, workspace별 한도와 동시 준비 개수를 함께 제한한다. replica 증가가 저장소 복제량을 무제한 늘리지 않도록 한다.

## 4. 읽기 전용 도구와 agent loop

| 도구 | 입력 및 결과 |
| --- | --- |
| `list_files` | revision, 제한된 prefix/glob → tracked 파일 목록, 크기·유형·잘림 여부 |
| `search_code` | revision, 검색어, 경로 범위 → 경로·line·주변 snippet. 정규식은 지원 여부와 실행 시간을 제한 |
| `read_file` | revision, repo-relative path, line 범위 → 원문 범위, blob ID, content hash |
| `git_diff` | 허용된 revision 쌍, 경로 → rename/delete를 포함한 제한된 diff |
| `git_log` / `git_blame` | 고정 revision과 경로/line → 제한된 commit 근거. 확보하지 못한 이력은 한계 표시 |
| `find_related_code` | symbol/선택 범위 → 기존 graph와 검색 기반 후보. 호출 관계의 확실성과 추정 구분 |
| `read_review_context` | 기존 summary, finding, 승인된 memory와 출처 → 현 run에 인가된 context |
| `ask_user` | 질문, 선택지, 자유 입력 허용, 필요한 이유 → 영속 질문 생성 후 실행 양보 |

도구는 내부에서 `rg`, 파일 API, Git을 사용하되 tool schema를 검증한 adapter가 인자를 구성한다. 모델이 명령 문자열이나 추가 Git 옵션을 넘기는 API는 제공하지 않는다. 읽기 도구마다 사용자 승인을 요구하지 않는다.

한 run의 흐름은 다음과 같다.

1. 질문·선택한 unit·report·대화의 관련 부분·승인된 메모리를 불러온다.
2. 모델이 바로 답할지, 실제 코드를 더 읽을지, 사용자 판단을 확인할지 결정한다.
3. 코드가 필요하면 workspace를 준비하고 도구 결과를 제한된 context unit으로 전달한다.
4. 모델이 결과를 검토해 다른 파일·revision·호출부·테스트를 추가 조회한다. 단 한 번의 context pack 생성으로 종료하지 않는다.
5. 사용자 질문이 필요하면 checkpoint를 저장하고 Worker/model 슬롯을 반납한다. 응답이 오면 같은 run에서 재개한다.
6. 실제로 모델 입력에 포함한 근거를 인용해 답한다. 실패·예산 소진으로 확보하지 못한 범위는 명시한다.

간단한 질문의 fast path와 코드 탐색은 같은 run/event 계약을 사용한다. 별도 예외 경로에서 호출 제한이나 복구 규칙을 우회하지 않는다. 내부 chain-of-thought를 노출하지 않고 “base의 호출부 검색”, “관련 테스트 읽기”처럼 실제 수행한 행동과 짧은 진행 설명만 보여 준다.

### 실행 예

사용자: “이 변경이 기존 재시도 정책과 충돌하나요? 실패 후 재시작까지 확인해 주세요.”

- head의 변경 함수, base의 기존 구현, merge-base 기준 diff를 읽는다.
- 변경되지 않은 retry helper, 호출부, job 복구 코드와 관련 테스트를 검색한다.
- 코드만으로 정할 수 없는 “재시작 시 횟수를 초기화해야 하는가”를 질문한다. 선택지와 자유 입력을 제공한다.
- 사용자가 “재시작 전 횟수를 유지해야 합니다”라고 답하면 해당 요구를 현재 대화의 판단 기준으로 저장하고 추가 분석한다.
- 답변에 실제 확인한 head/base 코드 범위를 연결하고 테스트를 읽기만 했는지 실행했는지 구분한다. 첫 버전에서는 실행했다고 표현하지 않는다.
- 사용자가 원하면 이 판단을 메모리 후보로 저장한다. repository 집단 메모리의 활성화에는 기존 승인 절차를 거친다.

## 5. 상태, 중단과 복구

`chat_runs.status`는 `queued`, `running`, `awaiting_input`, `waiting_capacity`, `cancelling`, `completed`, `partial`, `failed`, `cancelled`로 제안한다. `preparing_workspace`, `searching`, `reading`, `generating` 같은 진행 단계는 별도 `phase`로 관리한다.

| 상황 | 저장·재개 규칙 |
| --- | --- |
| 질문 응답 대기 | 질문·call ID·checkpoint를 같은 transaction에 저장한다. 작업을 반납하고 사용자 응답 때 재queue한다. 대기 시간을 모델 실행 시간에 합산하지 않는다. |
| 429 또는 공유 capacity 부족 | `resumeAfter`와 예산 ledger를 저장하고 슬롯을 반납한다. UI는 실패나 무한 로딩 대신 대기 이유와 중단 기능을 제공한다. |
| 새로고침·모바일 접속 | run 상태와 마지막 event sequence 이후를 재조회한다. 구독만으로 새 모델 호출이나 새 run을 만들지 않는다. |
| Worker lease 만료 | fence/version을 증가시켜 다른 Worker가 인계한다. 이전 Worker의 이벤트·결과 쓰기는 거부한다. |
| 중단 | DB에 취소 요청을 기록하고 provider/tool에 AbortSignal을 전달한다. 이미 provider에 전송한 호출의 비용까지 취소된다고 보장하지 않는다. |
| 부분 결과 | 유효한 근거와 답변이 있으나 요청 범위 일부를 확인하지 못한 경우 `partial`로 종료한다. 원인·미확인 범위를 함께 저장한다. |
| 실패 | 사용할 수 있는 결과 없이 필수 단계가 실패하면 typed error로 종료한다. 실제 분석을 demo 답변으로 대체하지 않는다. |

lease 복구는 **정확히 한 번의 외부 모델 호출을 보장하지 않는다**. 요청 전 reservation, 요청/step ID, 이후 결과를 저장하고 완료된 도구·모델 step은 재사용한다. 전송 여부가 불확실한 모델 요청은 비용을 환급하거나 성공으로 간주하지 않는다. provider가 idempotency/status 조회를 지원하지 않으면 해당 step을 `interrupted`로 기록하고 예산 내 새 attempt로 재개한다. 앞서 전송한 text delta는 attempt ID로 구분해 UI에서 중복 답변으로 합치지 않는다.

같은 session에는 하나의 활성 run만 허용한다. 실행 중 사용자가 추가로 보내는 지시는 저장한 뒤 다음 안전한 step 경계에서 반영한다. clarification 응답, 실행 중 추가 지시, 새 질문은 API에서 구분한다. 완료 직전에 도착한 추가 지시는 유실시키지 않고 미처리 상태로 반환하거나 다음 turn으로 전달한다.

질문 응답은 owner, run 상태, question ID/version을 확인해 한 번만 반영한다. 오래된 탭의 응답과 중복 제출은 멱등 처리하거나 409로 거부한다. 질문 만료 후 응답도 이미 종료된 run을 되살리지 않는다.

## 6. 근거와 메모리

### 조회한 데이터와 답변 근거의 구분

`context-manifest`는 turn/run의 고정 revision, 도구 호출, 근거 단위, 사용량과 누락 사유를 기록한다. 각 model step에 **실제로 전달한 unit ID**를 따로 기록한다. 검색했지만 입력 한도 때문에 제외한 파일을 모델이 읽은 근거로 표시하지 않는다.

source unit에는 다음 정보를 보존한다.

- snapshot ID, revision 종류(`base`, `mergeBase`, `head`), exact commit SHA
- repo-relative path, line 범위, Git blob ID, content hash와 artifact 참조
- tool call ID, model step ID, truncation·미확보·검색 결과의 불확실성
- 해당할 때만 기존 finding/file/symbol ID

기존 `snapshot_files`는 변경 파일 목록이므로 변경되지 않은 파일을 억지로 추가하지 않는다. 별도 source-file identity를 `(snapshot, revision, path, blob)`에 연결하고 citation이 이를 참조하도록 확장한다. rename과 삭제 파일은 올바른 revision의 경로로 연결한다.

실제 파일은 탐색에 사용하되 citation의 원문 기준은 Git blob이다. checkout의 EOL, encoding, attribute/filter 변환으로 내용이 달라지지 않도록 준비하며 읽은 내용과 blob의 일치 여부를 검증한다. 일치하지 않으면 해당 사실을 표시하고 원본 blob 범위로 인용한다. 바이너리·지원하지 않는 encoding을 임의 문자열로 해석하지 않는다.

근거 본문은 content-addressed artifact에 두고 메시지에는 참조만 저장한다. artifact identity는 run/step/unit을 구별하고 기존 분석 artifact와 충돌하지 않도록 설계한다. 업로드·DB 참조 확정과 orphan 정리를 구분한다. TTL로 근거가 제거되면 “보존 기간 만료”로 표시하고 검증 가능한 링크인 것처럼 남기지 않는다.

### 적용 우선순위

현재 revision의 코드와 검증 가능한 사실을 우선한다. 메모리끼리 충돌하면 **승인된 repository 집단 메모리가 개인 메모리보다 우선**한다. 사용자의 새 답변은 현재 run의 의도·요구사항으로 취급하며 코드 사실이나 집단 메모리를 조용히 덮어쓰지 않는다. 충돌하면 사용자에게 차이를 보여 준다.

GitHub PR 대화는 작성자·PR·작성/수정 시점·revision 관련성을 가진 판단 자료다. 과거 논의를 현재 코드의 사실로 단정하지 않는다. 개인 history, 집단 메모리, PR 원문을 출처별로 구분하며 다른 사용자의 비공개 history를 집단 context로 직접 노출하지 않는다.

Chat에서 얻은 새 문제는 follow-up observation이다. 기존 `unit-comment-block`, 파일 `overall-summary`, 전체 `total-summary`를 자동 수정하지 않는다. 사용자가 메모리 후보 저장 또는 별도 재분석을 명시적으로 선택할 수 있도록 한다.

## 7. 신뢰 경계

등록된 저장소도 내용은 신뢰하지 않는다. 소스·README·AGENTS.md·PR 댓글·검색 결과에 포함된 지시가 도구 권한이나 system 정책을 바꾸지 못한다.

| 경계 | 필수 제약 |
| --- | --- |
| 경로 | 서버 발급 workspace handle, 허용 revision, repo-relative path만 받는다. traversal·절대경로·symlink escape·special file·`.git` 내부 직접 조회를 차단한다. tracked symlink는 대상 문자열만 읽고 따라가지 않는다. |
| Git/검색 인자 | shell 없이 검증한 인자로 실행한다. 옵션 주입·pathspec magic을 차단하고 `--`와 NUL-safe 파일명 처리를 적용한다. 명령·파일·출력·시간 한도를 둔다. |
| checkout | hooks, 외부 diff/textconv, 외부 filter, submodule 자동 실행, 시스템/사용자 Git 설정을 차단한다. 저장소가 선언한 실행 프로그램을 호출하지 않는다. 악의적인 `.gitattributes`도 검증한다. |
| credential | Git credential은 준비 단계에만 주입하고 URL·config·도구 결과·로그에 저장하지 않는다. askpass는 모델에게 보이는 파일 트리 밖에 두고 작업 후 제거한다. 사내 CA는 명시적으로 전달하며 TLS 검증을 끄지 않는다. |
| 도구 실행 환경 | 소스는 읽기 전용, HOME/tmp는 비공개, 환경 변수는 allowlist다. DB, encryption key, ChatGPT/GHES credential, 서비스 계정 token을 도구 프로세스에 전달하지 않는다. |
| sandbox | `ToolSandbox`에서 읽을 수 있는 mount와 network/process 권한을 OS/container 경계로 제한한다. non-root·chmod·환경 변수 제거만으로 sandbox가 완성됐다고 판단하지 않는다. |
| 네트워크 | clone/fetch는 등록된 Git origin만, provider gateway는 등록된 provider만 접근한다. 탐색 도구는 외부 네트워크를 사용하지 않는다. 모델이 새 origin을 제안해도 자동 접근하지 않는다. |
| 인가 | run·질문 응답·SSE·근거 파일마다 owner와 repository 권한을 검사한다. 실행 중 철회도 새 step/출력 전달 전에 확인하고 연결을 종료한다. |

현재 Worker는 DB와 credential 관련 권한을 보유하므로 같은 실행 권한으로 범용 shell을 열지 않는다. sandbox adapter와 배포 구성을 P0/P1에서 먼저 검증한다. Kubernetes NetworkPolicy는 같은 Pod의 컨테이너별로 네트워크를 분리하지 못하므로 sidecar라는 이유만으로 격리가 보장된다고 설명하지 않는다. 지원되는 실행 환경에서 별도 격리 경계를 확보하지 못하면 해당 기능을 활성화하지 않는다.

## 8. 모델 요청과 자원 예산

다음 값은 배포된 설정이 아니라 초기 검증용 제안이다. 실제 저장소·계정의 측정 결과로 조정한다.

| 항목 | 초기 제안 |
| --- | --- |
| Chat 논리 run | 모델 전송 최대 8회, 도구 호출 최대 24회. 재시도와 사용자 응답 후 재개에도 같은 ledger 유지 |
| 코드 context | run 누적 모델 제공 소스 본문 128 KiB, 단일 model step 최대 12개 소스 범위. 관계 탐색 2 hop·테스트 후보 6개를 기본값으로 시작 |
| 단일 파일 조회 | 최대 1 MiB. 큰 파일은 필요한 범위만 읽고 잘림 표시 |
| 작업공간 | 저장소당 2 GiB를 초기 상한으로 평가. Worker 전체 디스크·동시 clone 한도를 추가 적용 |
| 실행 시간 | 도구 30초, fetch 180초, 활성 run 10분. 사용자 응답 대기 최대 30분과 workspace idle TTL 30분은 별도로 계산 |
| 계정 동시 호출 | upstream 계정당 1개를 초기값으로 시작하고 자동 분석·Chat 공통 적용. 기존 사용자별 제한도 유지 |

128 KiB는 토큰 수가 아니다. system prompt, report, history, memory, tool schema/results, 출력 예약을 모두 합친 모델별 입력 한도를 별도로 적용한다. 실제 tokenizer/usage를 사용할 수 없으면 추정치임을 표시하고 보수적 여유를 둔다. history를 압축해도 고정 revision, 사용자 응답, 근거 ID와 누락 사유는 유지한다. 출력·완료 답변 예산을 남기고 새 탐색을 멈춘다.

account admission은 PostgreSQL의 공유 reservation/ledger로 구현한다. 같은 upstream 계정의 중복 등록은 안전한 내부 quota key로 묶고 다른 사용자의 계정 식별 정보를 노출하지 않는다. 단일 프로세스 semaphore로 끝내지 않는다.

- 실제 upstream 추론 요청 직전에 slot과 예산을 예약한다. 내부 provider 재시도도 각각 계산한다.
- 자동 분석의 run별 호출 한도와 Chat의 한도는 별도지만 account-level concurrency, 요청/토큰 window, cooldown은 공유한다. 자동 분석의 하위 unit·요약도 부모 run 예산을 소비한다.
- `Retry-After`가 있는 429는 해당 계정 cooldown으로 저장한다. 없으면 상한이 있는 지수 backoff+jitter와 총 deadline을 적용한다. Worker를 sleep 상태로 오래 점유하지 않는다.
- 인증 실패·명시적 quota 소진·잘못된 요청을 일시 오류처럼 반복하지 않는다. 만료된 credential의 갱신도 계정 단위로 직렬화한다.
- 자동 분석과 Chat 중 하나가 계정을 독점하지 않도록 사용자·작업 종류를 고려해 대기 순서를 정한다. 기다리는 동안 사용자에게 취소·대기 상태를 제공한다.
- 완료·timeout·중단·Worker 손실에서 reservation을 정리하되 불확실한 upstream 사용량을 무조건 환급하지 않는다.

이 서비스 밖에서 소비한 ChatGPT 사용량까지 알 수 있는 것은 아니다. provider가 제공하지 않는 잔여량을 표시하거나 계정 제한이 절대 발생하지 않는다고 보장하지 않는다.

## 9. 영속 데이터와 API

테이블과 필드 이름은 제안이며 migration은 구현 시 다음 가용 번호를 사용한다.

| 데이터 | 역할 |
| --- | --- |
| `chat_runs` | session, idempotency key, 고정 snapshot/provider/prompt/memory/tool policy, 상태·phase, checkpoint, lease/fence, 누적 예산, 취소·재개 시각 |
| `chat_run_steps` | 모델/도구 step과 call ID, 검증된 입력, attempt, 결과·근거 참조, 사용량과 오류. 비밀과 내부 사고 과정은 저장하지 않음 |
| `chat_questions` | run/call, 질문과 선택지, owner, 상태/version, 만료 시각, 한 번만 반영되는 응답 |
| `repository_workspaces` | revision, 격리 키, Worker 위치, lease, 크기, TTL. credential 원문은 저장하지 않음 |
| `source_files`, `chat_run_contexts` | 변경 여부와 무관한 소스 identity, immutable manifest, model step별 실제 입력 근거 |
| `model_budget_reservations` | account quota key, 부모 run, step/attempt, 예약·실사용, 만료·불확실 상태·cooldown |
| 기존 `event_log` / `chat_messages` | `chat_run` scope 이벤트와 사용자에게 보이는 메시지. 기존 메시지 조회 계약 보존 |

run 생성·사용자 메시지·job 등록은 한 transaction으로 처리한다. session별 활성 run 중복을 DB 제약/잠금으로 막는다. question 응답·checkpoint 갱신·재queue도 원자적으로 처리한다.

| API 제안 | 동작 |
| --- | --- |
| `POST /api/v1/chat-sessions/:sessionId/runs` | idempotency key와 질문/선택 범위를 받아 202 + run ID 반환 |
| `GET /api/v1/chat-runs/:runId` | 현재 상태, 질문, 진행·완료 메시지, 누락 범위 |
| `GET /api/v1/chat-runs/:runId/events` | SSE. `Last-Event-ID` 또는 `after` 기반 replay |
| `POST /api/v1/chat-runs/:runId/cancel` | 멱등 취소. 완료된 결과를 삭제하지 않음 |
| `POST /api/v1/chat-runs/:runId/questions/:questionId/responses` | version과 응답을 검증한 뒤 같은 run 재개 |
| `POST /api/v1/chat-runs/:runId/instructions` | 실행 중 추가 지시를 저장하고 다음 step에서 반영 |
| `GET /api/v1/chat-runs/:runId/context/:unitId` | 인가된 실제 소스 범위와 revision·line·근거 metadata 반환 |

기존 메시지 POST는 전환 기간에 유지한다. 새 UI만 새 run API로 옮기고 구형 클라이언트에 동기 응답 대신 202를 갑자기 반환하지 않는다. 기존 경로에도 공통 account admission을 적용한다.

이벤트는 `run.queued`, `workspace.preparing/ready`, `tool.started/completed/failed`, `response.output_text.delta`, `question.requested/answered`, `run.waiting_capacity`, `run.completed/partial/failed/cancelled`로 제안한다. 모든 이벤트에 run ID, step/attempt ID와 단조 증가 sequence를 둔다. delta는 순서를 보존해 묶어서 저장하고 완료 메시지를 확정한다. SSE buffer/backpressure와 event 보존 한도를 둔다. 오래된 cursor가 보존 범위를 벗어나면 상태 snapshot을 다시 받고 이어 붙인다.

현재 `ChatModel.generate()`는 legacy adapter로 유지하고 새 경로는 typed streaming event, tool call/result, usage, AbortSignal을 지원하는 adapter로 확장한다. 등록 계정의 실제 tool/streaming 지원 여부를 검증한다. 미지원 provider는 제한을 표시하며 가짜 token streaming이나 demo 분석으로 대체하지 않는다.

## 10. 화면 배치

기존 메인 탭의 summary와 findings/unit block 구분을 유지한다. 오른쪽 Chat은 대화·질문 응답·진행 상태에 집중하고 긴 소스 본문은 메인에 연다.

- Chat: 실제 답변 스트림, 접을 수 있는 도구 timeline, 사용자 확인 카드, 중단·재개/재시도, 사용한 파일과 호출/조회 예산.
- 메인: citation 선택 시 `코드 근거` 탭에서 base/merge-base/head, 경로, line 범위를 표시한다. 변경되지 않은 파일도 열 수 있어야 한다.
- 완료와 분석 중·사용자 응답 대기·호출 대기·부분 완료·실패를 구분한다. 실패 시 마지막으로 확인한 근거와 재시도 가능한 범위를 보여 준다.
- mobile: 소스를 별도 전체 영역으로 열고 뒤로 가면 기존 대화와 입력 상태를 유지한다. 재접속은 기존 run을 복구한다.
- 현재 계정·모델·effort 선택 UI와 Enter 전송 / Shift+Enter 줄바꿈, IME 조합 중 전송 방지를 유지한다. 실행 중 설정 변경은 현재 run에 소급 적용하지 않는다.

검증할 때 합성 이벤트/fixture 화면과 실제 AI 실행 화면을 구분한다. 기본 report와 추가 분석 결과의 출처도 같은 방식으로 분리한다.

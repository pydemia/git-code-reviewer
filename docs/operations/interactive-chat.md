# Interactive Review Chat 운영

기본 flag는 꺼져 있다. 등록 ChatGPT account와 exact snapshot이 있는 Review에서 활성화한다. `chatAgent.allowedUserIds`에 검증 사용자 UUID를 넣어 canary를 제한하고 실제 모델 검증 후 빈 배열로 모든 허용 사용자에게 제공한다. 설정 변경은 Server 재시작 후 반영된다. 기존 canonical report와 GitHub 게시 동작은 변경하지 않는다.

## 실행

Docker Compose는 native CPU architecture에서 `CHAT_AGENT_ENABLED=true MODEL_ADMISSION_ENABLED=true docker compose --profile agent up --build -d`로 실행한다. 먼저 로컬 `.env`에 `GITHUB_MODE=registry`, `CHAT_MODEL_MODE=registry`, `CREDENTIAL_REGISTRY_ENABLED=true`, `MODEL_ADMIN_ENABLED=true`와 직접 생성한 32-byte base64 `CREDENTIAL_ENCRYPTION_KEY`를 설정하고 UI에서 GitHub·ChatGPT account를 등록한다. Key는 volume의 기존 credential을 복호화하는 데 필요하므로 재시작 때 바꾸거나 Git에 넣지 않는다. PostgreSQL host port는 기존 25432다. macOS의 VS Code Full Development Stack은 `sandbox-exec`로 source 도구를 실행한다. Linux native launch에는 별도 broker socket이 필요하며 격리 환경이 없으면 도구 실행을 거부한다. Apple Silicon의 amd64 에뮬레이션에서 seccomp를 사용할 수 없는 경우 native arm64 image를 사용한다. 격리를 끄는 fallback은 없다.

Helm의 `chatAgent.enabled`와 `modelAdmission.enabled`를 설정한다. 기존 release upgrade에서 `--reuse-values`만 사용하면 새 values가 없을 수 있으므로 `chatAgent`와 `modelAdmission` 전체 설정을 override 파일에 포함한다. Worker의 source-sandbox는 DB·GitHub·모델 Secret 및 service account token을 받지 않는다. Broker에만 chroot·UID 전환·장치 생성 등의 제한된 capability를 부여한다. 자식 도구는 chroot 안에서 UID/GID 65534, no-new-privileges, seccomp로 실행하고 실제 파일은 root 소유 읽기 전용이다. 네트워크 socket 생성, ptrace, process memory, mount와 namespace 진입을 차단한다.

## 한도와 복구

- `CHAT_AGENT_MAX_MODEL_CALLS=8`, `CHAT_AGENT_MAX_TOOL_CALLS=24`, `CHAT_AGENT_CONTEXT_BYTES=131072`. 설정은 실행 시작 시 고정한다.
- 새 Chat의 모델 요청 timeout은 `CHAT_AGENT_MODEL_TIMEOUT_MS=180000`이며 최대 300000까지 설정할 수 있다. run 생성 시 고정하며 기존 Chat의 60000ms 설정과 분리한다. timeout은 `model_request_timeout`과 partial/failed로 표시하고 이미 전송한 요청은 호출 횟수에 포함한다. 부분 출력이 있다는 이유로 완료로 바꾸지 않는다.
- 계정별 inference 동시 1개, 분당 60개·serialized input 합계 1 MiB. 같은 ChatGPT upstream account ID로 묶는다. 정확한 token quota는 아니며 제공자가 보낸 usage는 가능한 경우 ledger에 기록한다.
- 실제 요청마다 영속 ledger를 기록하고 전송 이후 실패·401 재시도도 예산에 포함한다. 429는 Retry-After를 3초–30분 안에서 적용한다. 헤더가 없으면 30초 대기한다. 새 Chat은 Worker slot을 반환하고 `waiting_capacity`로 재개한다. 기존 자동 분석·legacy Chat은 최대 2분 안에서 대기한다.
- 대기 중인 Chat은 계정에 15초짜리 다음 호출 우선권을 등록하고 재시도할 때 갱신한다. 실행 중인 모델 요청은 중단하지 않으며 quota와 429 cooldown도 그대로 적용한다. 만료된 우선권은 다른 요청을 막지 않는다. Chat 활성화 시 Worker concurrency를 2 이상으로 설정하면 한 slot을 Chat용으로 남기고 나머지만 배치 작업에 사용한다. PRISM-DEV는 concurrency 2로 운영한다. 구버전 Worker가 종료되기 전까지는 이 우선순위가 완전히 적용되지 않는다.
- 실행 lease는 30초, heartbeat 5초와 fence로 오래된 Worker의 저장을 막는다. 실행 attempt의 active timeout은 10분, run 만료는 24시간, 사용자 질문은 30분이다. 중단은 최대 다음 heartbeat에 모델을 abort한다. clone 준비가 이미 시작되었다면 그 subprocess의 timeout까지 정리가 늦어질 수 있다.
- workspace key는 사용자·repository·등록 origin·base/head/merge-base SHA·credential version으로 결정한다. 동일 사용자의 질문·capacity 재개는 같은 Pod의 캐시를 재사용한다. 자동 분석은 analysis ID로 격리한다. revision은 정확한 SHA로 fetch하며 shallow depth는 64다. worktree 파일은 Git blob에서 복원해 checkout filter를 실행하지 않는다. symlink·submodule·1 MiB 초과 파일은 materialize하지 않는다. LFS 대용량 객체는 다운로드하지 않는다.
- workspace 상한 기본 2 GiB, file entry 최대 50,000. fetch 도중 250ms 간격의 크기 검사에서 초과를 감지하면 subprocess를 abort하고 fetch 후·파일 생성 중에도 검사한다. filesystem hard quota가 아니므로 검사 사이 임시 초과는 가능하다. 전체 캐시는 3개 workspace 예산으로 admission한다. Pod별 DB advisory lock으로 준비·정리를 직렬화하고 90초 workspace lease를 20초마다 갱신한다. 활성 lease는 30분 TTL 정리에서 제외하며 질문·capacity 대기에서는 lease를 반납한다. workspace volume은 Pod 전용이어야 한다. Pod 간 RWX 캐시나 공용 mirror는 지원하지 않는다.
- source 본문·메타데이터는 run checkpoint와 같은 트랜잭션으로 DB에 저장하고 session 삭제 시 cascade한다. 사용자/repo 권한 철회 시 다음 도구·모델 단계와 source API에서 다시 검사한다. 원본 캐시의 즉시 물리 삭제 대신 접근 차단과 TTL을 사용한다. 자동 분석의 추가 source는 기존 artifact retention을 따른다.

## 검증과 관찰

`GCR_TEST_DATABASE_URL`에 격리된 local PostgreSQL을 지정하고 `pnpm test`를 실행한다. `deploy/sandbox/verify.mjs`는 native Docker에서 실제 Git과 쓰기·탈출·프로세스·네트워크 차단을 검증한다. `kernel-probe.mjs`는 별도 임시 Kubernetes Pod에서 같은 검증을 수행하는 도구이며 운영 Secret을 주입하지 않는다.

`chat_runs`의 status·fence·model_calls·tool_calls·error_code, `chat_run_steps`, `model_request_ledger`, `model_account_capacity`로 진단한다. SSE는 event ID 이후 DB event를 다시 읽고 UI가 3초 polling으로 보완한다. 사용자 입력과 source 본문, credential은 로그에 출력하지 않는다.

문제 발생 시 새 실행 flag를 끄기 전에 활성 run을 중단하거나 완료시킨다. `CHAT_AGENT_ENABLED=false`이면 Worker가 새 queue를 claim하지 않으므로 기존 queued/awaiting 상태는 남아 있으며 재활성화하면 만료 정책에 따라 회수된다. UI는 legacy Chat으로 돌아간다. 기존 report·message와 additive migration은 유지하고 downgrade를 위해 테이블을 삭제하지 않는다.

PRISM-DEV Worker의 종료 유예는 3600초다. SIGTERM 이후 새 작업을 가져오지 않고 자동 분석은 다음 progress 경계에서 저장된 모델 결과를 남긴 채 lease를 반납한다. Sandbox broker는 650초 동안 기존 읽기 요청을 처리해 진행 중 Chat의 10분 active timeout을 보장한다. 종료 유예가 더 짧으면 drain이 중간에 끊길 수 있다.

Worker는 10초마다 만료된 generic job lease를 회수한다. 이전 attempt를 interrupted로 기록하고 최대 3회 복구한다. 기존 max attempt에 도달했어도 이 복구 예산 안에서는 다시 claim할 수 있다. 소진하면 job과 관련 분석/operation을 실패 상태로 확정한다. 모델 ledger·전송 횟수는 초기화하지 않는다. 일반 provider 오류에 대한 재시도와 Worker 소실 복구는 별도다.

`analysis_model_checkpoints`는 분석 ID와 모델 profile·원본 입력 hash별로 정상 model 결과를 저장한다. unit·파일 요약·전체 요약이 저장된 경우 새 attempt는 모델에 재전송하지 않는다. Lease를 잃은 attempt의 checkpoint·snapshot·report 확정은 거부한다. Provider 응답과 DB 저장 사이에 프로세스가 죽은 호출은 재사용을 보장하지 않으며 이미 전송한 예산을 환급하지 않는다. Report의 논리적 model stage 수와 실제 upstream 요청 수(`model_request_ledger`)를 구분한다.

## 대화와 과거 근거

새 run에는 같은 사용자 session의 메시지 ID·role·과거 run ID를 담은 extractive digest와 최근 8개 메시지 발췌를 넣는다. 의미를 새로 생성하는 모델 요약은 아니며 생략 문자 수를 기록한다. 이전 사용자 질문·판단은 `read_conversation(messageId, offset)`으로 8,000자씩 다시 조회한다. 질문·응답은 별도로 출처와 함께 남기고 과거 source는 `read_previous_source(runId, unitId)`로 재조회한다. 다른 session을 읽지 못하며 현행 코드에 관한 주장은 고정 revision 소스로 다시 확인해야 한다. 오래된 tool 본문은 입력이 256 KiB를 넘으면 위치 정보로 압축하고 전체 입력 384 KiB 한도는 유지한다. 집단 메모리 우선권이나 개인 메모리 승인 상태를 바꾸지 않는다.

`run-history` API는 30건씩 cursor pagination한다. 오른쪽 Chat의 `이전 분석과 코드 근거`에서 저장된 답변·질문·응답을 읽고 메인 탭에서 당시 SHA·파일·line을 연다. 현재 run의 streaming/응답/중단은 별도로 유지한다. 선택한 run과 source ID만 sessionStorage에 저장하며 본문은 저장하지 않는다. 다른 기기에서는 서버 이력에서 다시 선택한다.

## 이번 릴리스에서 남긴 범위

기존 snapshot diff materializer는 유지하고 자동 분석의 추가 context와 Chat이 source provider를 공유한다. `find_related_code`는 JS/TS 구문 AST와 Python lexical 분석으로 정의·호출자·피호출자·관련 테스트 후보를 구분한다. 최대 512개 파일·4 MiB를 탐색하고 60개 결과와 생략 범위를 반환한다. Import alias·타입별 method dispatch·overload·동적 호출을 해석하는 전체 semantic graph는 아니다. 코드나 테스트를 실행하지 않는다. 호출·입력 byte 제한은 비용과 재시도를 제한하지만 모든 모델 실패를 방지하지 않는다.

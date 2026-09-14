# 중앙 리뷰 작업 접수

현재는 작업 접수·조회·취소, 보존 처리, 실행 소유권과 registered model 어댑터, 업로드된 소스의 공통 리뷰 입력 복원이 구현되어 있다. 승인된 로컬 컨텍스트와 중앙 knowledge pin의 복원도 구현했다. Worker가 이 경로를 자동 실행하도록 연결했다. 실제 계정과 배포 검증은 아직 남아 있다. `REMOTE_REVIEWS_ENABLED`는 기본 `false`이며 중앙 모델 실행까지 검증하기 전에 운영 환경에서 켜지 않는다.

## API

신규 요청의 `source.review`에는 선택 파일별 변경 종류·rename의 이전 경로·기준 파일의 전송 여부와 캡처 불완전 여부가 필요하다. 해당 정보가 없으면 422 `REMOTE_REVIEW_SOURCE_DESCRIPTION_REQUIRED`를 반환한다. 기존 형식의 작업은 동일 hash로 조회·재전송할 수 있지만 실행기가 변경 정보를 추정해 복원하지는 않는다.

기준 경로는 `/api/v1/repositories/{repositoryId}/remote-reviews`다. 요청에는 해당 서버를 대상으로 발급한 client API key와 `X-GCR-Server-Id`가 필요하다. Browser session cookie는 이 API의 인증 수단이 아니다.

| 요청                       | 권한                                                                          | 응답                                             |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /`                   | `ai:invoke`, 현재 repository reviewer grant, 외부 `chat` 인가, 모델 계정 할당 | 최초 접수 201, 같은 입력의 기존 작업 200         |
| `GET /{requestId}/status`  | `knowledge:read`, 현재 repository 조회 인가, 작업 소유자                      | 접수·실행·취소·만료 상태                         |
| `GET /{requestId}/result`  | status와 동일                                                                 | 완료 결과 200, 아직 결과 없음 409, 결과 만료 410 |
| `POST /{requestId}/cancel` | `ai:invoke`, 현재 repository reviewer grant, 외부 `chat` 인가, 작업 소유자    | queued는 cancelled, running은 cancel-requested   |

접수 body는 `RemoteReviewRequest`, 취소 body는 `{schemaVersion: 1, requestId, payloadHash}` 계약을 사용한다. Source/context·모델·계정·예산·보존 기간은 승인된 payload hash와 일치해야 한다. 계정 선택은 기존 registry의 사용자·그룹·tenant/all 할당과 모델의 허용 reasoning effort를 확인한다. 이 단계에서는 모델 credential을 복호화하거나 provider를 호출하지 않는다.

`outputTokensPerCall`은 선택 항목이다. 현재 registered Codex 전송 구현은 출력 token 상한을 강제하지 못하므로 이 값을 지정한 신규 접수는 422로 거부한다. 값을 몰래 지워 실행하지 않는다. 생략한 요청에는 모델 호출·전체 시간·소스/도구 예산과 출력 바이트 제한을 적용한다. 바이트 제한을 token 상한으로 표시하지 않는다.

Origin 없는 native bearer POST는 위의 명시된 쓰기 경로에서만 받는다. 다른 origin을 명시한 요청은 거부한다. 각 서비스 transaction은 HTTP 인증 결과만 재사용하지 않고 실제 key·현재 사용자·identity·repository grant를 다시 확인한다. 외부 인가 서비스가 거부하거나 응답하지 않으면 접수하지 않는다.

## 재조회와 예산

Idempotency 식별자는 server·tenant·repository·user·client 종류·request ID의 조합이다. API key를 바꿔도 동일하다. 같은 ID의 다른 payload는 409이며 기존 작업의 입력과 예산 예약을 바꾸지 않는다. 기존 요청 조회에는 최초 승인 시각의 5분 제한을 다시 적용하지 않는다.

응답을 받지 못했다면 원래 request ID로 status를 조회하거나 같은 payload를 재전송한다. 404나 통신 실패는 모델이 실행되지 않았다는 증거가 아니다. 새로운 ID로 자동 재실행하거나 로컬 모델로 자동 전환하면 안 된다. `uncertain`은 실행 여부를 확정하지 못한 상태이며 취소 완료와 구분한다.

접수할 때 요청의 최대 `modelCalls`를 사용자·저장소의 최근 1시간 예산에 예약한다. 사용자 예산은 key·worktree·모델 계정·저장소를 가로질러 적용되고, 저장소 예산은 사용자를 가로질러 적용된다. 기본 한도는 사용자 60, 저장소 300이며 각각 `REMOTE_REVIEW_USER_HOURLY_CALLS`, `REMOTE_REVIEW_REPOSITORY_HOURLY_CALLS`로 설정한다. 동시 진행 작업은 사용자 4개, 저장소 32개까지 받는다.

같은 작업 재전송은 예약을 늘리지 않는다. 취소해도 시간 창 안의 예약을 환급하지 않는다. 이 수치는 실제 모델 호출·token 사용량이 아닌 접수 시 예약한 상한이다. Worker의 실제 provider 호출에는 기존 model admission을 별도로 적용해야 한다.

## 저장과 만료

Migration 0047의 `client_review_jobs`는 PR snapshot과 별도다. Payload와 결과는 AES-256-GCM으로 암호화하며 기존 `CREDENTIAL_ENCRYPTION_KEY`를 사용한다. 인증 추가 데이터에는 job ID·payload hash·source/result 용도를 넣는다. Bearer key와 중앙 모델 credential은 작업에 복사하지 않는다.

소스와 결과의 만료 시각은 최초 접수 시 정한다. 같은 요청을 다시 보내도 연장되지 않는다. Queued 취소 시 소스 ciphertext·IV·tag를 즉시 지운다. Running 취소는 소스를 지우고 취소 요청 상태로 남긴다. Provider 작업이 종료됐다는 확인은 worker에서 해야 한다.

만료 함수는 한 번에 최대 512건을 정리한다. Worker의 10초 복구 주기와 retention 명령에 연결했으며 개별 status 조회도 해당 작업의 만료를 반영한다. Worker나 maintenance가 멈추면 물리적 정리는 늦어질 수 있다. 원본 소스 만료 시 queued는 expired, running/cancel-requested는 uncertain으로 바뀐다. 완료 결과가 만료되면 결과 ciphertext·IV·tag를 지우고 expired로 바꾼다. 만료된 결과는 반환하지 않는다.

중복 실행을 막기 위해 요청 ID·payload hash·소유 범위·모델/예산·시각 등 접수 메타데이터는 남긴다. 사용자나 저장소 삭제 시에는 FK cascade로 함께 삭제된다. DB backup에 이미 들어간 데이터의 제거까지 보장하는 기능은 아니다.

신규 접수를 끈 뒤에도 기존 작업의 상태 조회·재조회·취소는 현재 인가 범위 안에서 가능하다. Queued upload를 실제 리뷰로 연결하고 주기적인 인가 확인·취소를 실제 계정에서 검증하는 작업, client UI와 운영 rollout은 P10 후속 작업이다.

## 실행 소유권과 모델 전송 전 기록

Migration 0048은 provider 요청 시작 시각과 다음 접수 가능 시각을 추가한다. Worker가 작업을 가져오면 실행별 UUID를 포함한 owner와 30초 lease를 부여한다. Payload를 열고 lease를 갱신하거나 모델 요청을 보내기 전에는 최초 key의 현재 사용자·identity·repository 범위와 모델 계정 할당을 재검증한다. Key ID만으로 HTTP 인증을 받는 기능은 추가하지 않았다.

`fenceRemoteReviewInvocation`은 model admission의 `beforeSend`에서 호출한다. 용량을 확보하지 못한 대기 상태에는 provider 요청 시작을 기록하지 않는다. 용량 확보 뒤 인가가 실패하면 슬롯을 반환하고 전송하지 않는다. 기록 뒤 프로세스가 종료되면 실제 네트워크 전송 직전이었더라도 재실행을 허용하지 않는다.

Lease가 만료된 작업은 요청 시작 기록이 없을 때만 queued로 복구한다. 기록이 있으면 uncertain으로 남기고 소스를 지운다. 이전 owner는 새 owner의 lease 갱신·모델 전송·완료 저장을 할 수 없다. 완료 저장은 현재 인가와 승인된 client/source/model/account 설정, 파일 범위를 대조하고 암호화된 report와 terminal receipt를 같은 transaction에 기록한다. 취소 이후 늦게 도착한 report는 저장하지 않는다.

`createCentralReviewExecutor`는 공통 `list_files`, `read_file`, `search_code` 선언과 source port만 사용한다. Registered model의 turn과 source tool 응답을 이어 주고 호출 횟수·시간·출력 바이트를 제한한다. Shell이나 별도 source 수집기는 제공하지 않는다. Worker 연결은 아래 실행 절차를 따르며 실제 계정 호출·배포 검증은 남아 있다.


## 승인된 소스 복원

`prepareRemoteReview`는 선택한 파일의 A/M/D/R/T와 rename의 이전 경로, 기준 파일 상태를 payload hash에 포함한다. 기준 파일 상태는 업로드됨·캡처에서 없음·업로드에 없음으로 구분한다. 기준 파일이 캡처에 있지만 전송 승인 목록에 없으면 마지막 상태가 되며 새 파일로 추정하지 않는다. 변경 정보의 선택 파일 집합과 업로드된 실제 file/side도 일치해야 한다. 실행 파일은 공통 runner와 같은 최대 200개다.

`restoreRemoteReviewSource`는 검증된 전송 바이트만 읽는 `ReviewSourceView`를 만든다. Git checkout과 로컬 경로를 보유하지 않고 캡처를 재구성하는 `freeze`도 제공하지 않는다. 원본 snapshot hash와 OID는 client-captured 식별자로 유지하며 서버가 Git tree를 검증했다고 주장하지 않는다. Branch와 HEAD 관측을 전송하지 않으므로 이를 추정하지 않는다.

공통 context·policy·source port·runner가 이 view를 사용한다. 읽기와 줄 수·바이트 예산, read ID 기반 coverage 검증은 로컬 리뷰와 같다. Rename의 이전 파일을 업로드하지 않으면 `needs-context`로 실행 전에 중단하고, 업로드했어도 모델이 읽지 않으면 완료로 인정하지 않는다. 임의의 미전송 경로는 unavailable이며 파일이 실제로 없다고 답하지 않는다.

캡처 실패는 제외 파일 이름 없이 불완전 여부만 전달할 수 있다. 해당 값이 있으면 모든 선택 파일을 읽어도 결과는 partial이다. 컨텍스트 복원은 아래 계약을 사용한다. 빈 context fixture를 일반 요청의 승인된 문서 대신 사용하지 않는다.


## 승인된 컨텍스트와 중앙 기준

신규 요청에는 `context.resolved`가 필요하며 누락되면 422 `REMOTE_REVIEW_CONTEXT_REQUIRED`를 반환한다. 과거 형식의 동일 요청 조회·재전송은 유지한다. `LocalReviewContext.toRemoteContext()`는 준비된 context에서 선택한 local memory/Skill, built-in 버전, 필수 source, 만료 시각과 원래 context hash를 내보낸다. 필수 자료가 없거나 선택 검사가 끝나지 않았으면 내보내지 않는다. 생략된 지식의 ID와 store 경로는 전송하지 않는다.

`restoreRemoteReviewContext`는 client/source 범위·지식 본문 hash·활성 상태·만료·built-in 버전을 검사하고 승인된 자료를 그대로 복원한다. 추가 instructions/memory/skill 문서는 공통 runner의 untrusted JSON에 포함한다. 이 문서가 도구·모델 선택이나 중앙 기준의 우선순위를 바꾸지는 못한다. 선택 자료가 1 MiB를 넘으면 임의로 제거하지 않고 복원을 거부한다.

Centralized context는 manifest와 선택 당시 시각·byte budget·branch, 선택 결과 hash를 전송한다. Branch가 필요한 중앙 기준을 재현하기 위해 이 값은 context의 명시적 승인 대상에 포함된다. 일반 소스 전송에 branch/HEAD를 자동 첨부하는 기능은 아니다. Manifest나 중앙 지식 본문을 client-supplied 문서만으로 대체할 수 없다.

서버의 `remoteReviewContextAuthority`는 원래 manifest가 해당 서버·사용자·저장소의 저장된 온라인 pin과 완전히 일치하는지, 현재 권한 revision과 publication 조합이 유지되는지 확인한다. 해당 pin의 세 bundle을 기존 artifact 서비스에서 읽고 hash·바이트 수·scope를 검사한다. 공통 선택기를 승인 당시 조건으로 실행한 결과가 승인된 selection hash와 같아야 한다. 최신 manifest를 새로 발급하거나 다른 지식으로 대체하지 않는다. Offline lease가 남아 있더라도 중앙 실행에는 유효한 online pin이 필요하다.

복원된 context는 실행 중에도 이 authority를 관측한다. Pin이나 권한을 더 이상 사용할 수 없으면 공통 runner가 취소 신호를 전달한다. 결과의 context hash는 승인된 context 전체와 client/source 범위를 포함하며 작업 완료 저장에서도 대조한다. 원래 클라이언트 context hash는 별도 필드로 보존한다.

소스·컨텍스트·모델 어댑터의 연결 검증은 합성 모델을 사용했다. Worker scheduling·계정 resolver·model admission·heartbeat·취소 후 정리·결과 저장을 연결했다. 실제 계정 검증, client UI, 패키지/VSIX/Helm 전달은 아직 남아 있다.


## Worker 자동 실행

Worker는 중앙 요청과 기존 기준 생성·대화·PR 작업 사이에 실행 기회를 배분하며 전체 `WORKER_CONCURRENCY` 안에서 실행한다. 승인된 소스·context를 복원하고 기존 account registry에서 정확히 지정한 계정·모델·effort를 선택한다. 등록 계정의 admitted HTTP transport와 공통 source tool만 사용한다. 작업 시작부터 승인된 duration을 계산하고 2초마다 소유권·현재 권한·context 유효성을 확인한다. Provider 요청 직전에도 pin과 기존 전송 소유권 fence를 확인한다.

첫 전송 전 용량 부족이면 source와 같은 receipt를 queued로 돌려 재개 시각을 기록한다. 그 뒤 모델 turn 간 용량 대기는 같은 실행과 남은 시간 예산 안에서 처리한다. 이미 전송한 작업 전체를 재실행하지 않는다. 승인 context가 만료되거나 복원되지 않으면 context-unavailable로 종료한다(migration 0049). 잘못된 JSON/출력과 호출 상한 초과는 failed, 종료되지 않은 stream처럼 결과를 확정할 수 없는 전송은 uncertain으로 기록한다.

취소 또는 권한 철회 시 AbortSignal을 보내고 모델 transport 정리를 기다린다. 최대 5초 안에 정리 완료를 확인하지 못한 호출은 uncertain이며 cancelled나 completed로 기록하지 않는다. Cancelled는 이 worker의 전송/실행 종료를 뜻하며 provider 내부 연산 종료나 과금 취소를 보증하지 않는다. 이전 owner와 이미 완료된 receipt는 바꾸지 않는다. Worker 종료가 첫 전송 전이면 같은 요청을 queued로 남긴다.

Helm의 `remoteReviews.enabled`, `userHourlyCalls`, `repositoryHourlyCalls`로 설정하며 기본은 false/60/300이다. Server와 worker의 직접 env에만 실행 활성화 값을 넣고 migration/retention 작업은 중앙 실행을 활성화하지 않는다. 활성화에는 기존 client key·knowledge distribution 설정, 등록 계정 암호화, model admission, local/SAML 인증이 필요하다. Worker에도 client key 활성화와 같은 서버 ID를 전달한다. 배포와 실제 계정 검증 전에는 기본 비활성 값을 유지한다.

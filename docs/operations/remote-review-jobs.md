# 중앙 리뷰 작업 접수

현재는 작업 접수·조회·취소와 보존 처리가 구현되어 있다. 모델 실행 worker와 client executor는 아직 연결하지 않았다. `REMOTE_REVIEWS_ENABLED`는 기본 `false`이며 중앙 모델 실행까지 검증하기 전에 운영 환경에서 켜지 않는다.

## API

기준 경로는 `/api/v1/repositories/{repositoryId}/remote-reviews`다. 요청에는 해당 서버를 대상으로 발급한 client API key와 `X-GCR-Server-Id`가 필요하다. Browser session cookie는 이 API의 인증 수단이 아니다.

| 요청                       | 권한                                                                          | 응답                                             |
| -------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST /`                   | `ai:invoke`, 현재 repository reviewer grant, 외부 `chat` 인가, 모델 계정 할당 | 최초 접수 201, 같은 입력의 기존 작업 200         |
| `GET /{requestId}/status`  | `knowledge:read`, 현재 repository 조회 인가, 작업 소유자                      | 접수·실행·취소·만료 상태                         |
| `GET /{requestId}/result`  | status와 동일                                                                 | 완료 결과 200, 아직 결과 없음 409, 결과 만료 410 |
| `POST /{requestId}/cancel` | `ai:invoke`, 현재 repository reviewer grant, 외부 `chat` 인가, 작업 소유자    | queued는 cancelled, running은 cancel-requested   |

접수 body는 `RemoteReviewRequest`, 취소 body는 `{schemaVersion: 1, requestId, payloadHash}` 계약을 사용한다. Source/context·모델·계정·예산·보존 기간은 승인된 payload hash와 일치해야 한다. 계정 선택은 기존 registry의 사용자·그룹·tenant/all 할당과 모델의 허용 reasoning effort를 확인한다. 이 단계에서는 모델 credential을 복호화하거나 provider를 호출하지 않는다.

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

신규 접수를 끈 뒤에도 기존 작업의 상태 조회·재조회·취소는 현재 인가 범위 안에서 가능하다. 실제 실행 worker의 권한 철회 처리, 계정 재검증, lease와 checkpoint, provider 취소, client UI와 운영 rollout은 P10 후속 작업이다.

# 리뷰 기준 관리 — 2026-09-14

`/review-criteria`에서 저장소별 기준 후보를 등록하고 출처·판단·평가·승인·변경 이력을 관리한다. 기존 집단 메모리와 GitHub PR 논의를 출처로 선택하거나 검토 원문을 직접 입력할 수 있다. 개인 메모리는 공용 기준의 출처로 받지 않는다. 원문의 내용 hash가 바뀌면 다시 확인해야 저장할 수 있다.

기준에는 고정 UUID가 있고 수정할 때마다 새 revision을 만든다. 이전 문서, 원문 snapshot, 평가와 승인 이력은 보존한다. 기존 `review_memories`의 내용·상태·기여자 수는 변경하지 않는다. Migration `0037_review_criteria.sql`은 이 기능의 테이블만 추가한다.

## 검토와 승인

유지관리자는 결함·수정·정상·반증의 네 사례에 코드·관찰 결과·근거를 기록한다. 이 기록은 수동 평가다. 모델 실행이나 테스트 재현 성공을 뜻하지 않는다. 최신 평가가 모두 통과해야 후보를 `evaluated`로 전환하고 명시적인 검토를 거쳐 `shadow`, `active`로 변경할 수 있다. 미해결 질문은 승격할 수 없다. P0/P1과 예외 판단은 작성자와 다른 지정 security/domain owner의 승인이 필요하다. 승인자의 계정·역할·저장소 접근을 승격 시 다시 확인한다.

새 revision은 다시 후보부터 시작한다. 모든 변경에 version을 대조하므로 동시에 수정하거나 승인하면 한 요청만 성공하고 나머지는 409를 받는다. 화면에서 최신 버전을 불러와 다시 검토할 수 있다.

## 정정과 기간·범위 예외

저장소 열람자는 정정·오탐 검토 요청을 제출할 수 있다. 요청 내용은 해당 저장소 열람자에게 공개한다. 유지관리자의 정정 검토 접수는 기준 문서를 수정하지 않으며 실제 변경은 새 revision으로 작성한다.

관찰·활성 기준의 예외 요청에는 적용 범위와 시작·만료 시각이 필요하다. 요청자와 다른 지정 책임자가 승인해야 예외가 생성된다. 승인 시 이미 만료했거나 기준 revision이 바뀐 요청은 거부한다. 유지관리자 또는 지정 책임자는 예외를 철회할 수 있다. 예외 내용과 철회 이력을 함께 보존하며 새 기준 버전에 예외를 자동 승계하지 않는다.

## 접근 권한과 API

기존 웹 로그인·tenant membership·repository grant를 재사용한다. 관리자와 위임된 maintainer가 기준을 변경하고 지정 owner가 고위험 기준과 예외를 승인한다. 일반 사용자에게는 조회·요청 제출만 허용한다. 다른 저장소의 rule/request/exception ID로 접근할 수 없다.

모든 경로의 prefix는 `/api/v1/repositories/:repoId/review-criteria`다. 기존 웹 session과 요청 Origin 검사가 적용된다.

| 경로 | 기능 |
| --- | --- |
| `GET /`, `GET /:ruleId`, `GET /sources` | 목록·상세·사용 가능한 출처 |
| `POST /`, `POST /:ruleId/revisions` | 후보·새 버전 등록 |
| `POST /:ruleId/evaluations`, `POST /:ruleId/actions` | 수동 평가·상태 전이·책임자 승인 |
| `POST /:ruleId/feedback` | 일반 사용자의 정정·예외 요청 |
| `POST /:ruleId/feedback/:requestId/resolution` | 접수·예외 승인·거절 |
| `POST /:ruleId/exceptions/:exceptionId/revocation` | 예외 철회 |
| `GET /roles`, `PUT /roles` | 관리자의 저장소별 역할 위임·철회 |

위임 body는 `{ userId, role, enabled }`이며 role은 `maintainer`, `security-owner`, `domain-owner` 중 하나다. 대상 계정의 tenant·직접 또는 그룹 repository grant를 확인한다. 관리자라는 이유만으로 지정 owner 자격을 부여하지 않는다. 관리자는 화면에서 저장소 유지관리자·보안 책임자·도메인 책임자를 지정하거나 회수할 수 있다. 접근 권한을 잃은 기존 지정자는 회수만 허용한다.

## 검증과 남은 범위

로컬 격리 PostgreSQL을 사용하는 기준 관리·기존 메모리 검사 26개, 전체 build와 변경 파일 lint가 통과했다. Chrome에서 후보 등록→평가→관찰→활성화→reader 정정·예외 요청→owner 승인→maintainer 철회→새 버전→퇴역을 실제 API로 수행했다. 브라우저의 로그인 주체·저장소 목록만 합성 fixture이며 SAML 로그인 검증은 아니다. 모바일 폭에서 수평 넘침이 없음을 확인했다.

최초 브라우저 실패는 기본값이 있는 textarea의 라벨 탐색 문제로 명시적 접근성 이름을 추가했다. 동시 revision 변경의 잘못된 404는 stable rule row를 먼저 잠그도록 수정했다. 저장소 삭제 시 이력 FK의 검사 순서 충돌은 transaction 종료 시 검사하도록 수정했으며 이력 직접 수정·삭제 금지는 유지한다.

이 단계는 기준 관리 기능이다. 불변 bundle 발행·서명된 manifest·client sync는 미구현이며 `active` 기준도 현재 PR·CLI 리뷰에는 적용되지 않는다. 화면에 미발행 상태를 표시한다. P05 전체 완료와 구분하며 실행 증거는 [P05 검증 기록](../../.documents/execution/preventive-review/evidence/P05-criteria-management.json)을 따른다.


## alpha.39 최초 운영 배포

PRISM-DEV `git-code-reviewer` release 51에 alpha.39·chart 0.10.37을 배포했다. Source `b4ca4cc`, release pin `4230448`이며 image digest는 `sha256:f8477a2b9f3513ddba25442d34a02abb51837280369d2811f85969663b9f49a2`다. 기존 DB/TLS·인증·Secret·PVC 설정을 보존했다. Migration 37개, server·worker Ready, 배포된 코드·정적 파일 대조와 Helm test를 확인했다. [운영 검증 기록](../../.documents/execution/preventive-review/evidence/P05-PRISM-deployment.json)을 참고한다.

새 화면은 `https://pr-review.prism.ai/review-criteria`에서 제공한다. 개발 CA의 브라우저 신뢰 등록 여부는 기존 HTTPS 설정을 따른다. 이 릴리스의 모델 자동 생성·bundle 발행·CLI/CD 적용은 제공하지 않는다.


## 모델 후보 생성·역할 위임 후속 변경

기존 등록 모델 계정에서 사용할 계정·모델·추론 수준을 선택하고 검토 초점과 최대 6개 원문을 지정해 후보 생성을 요청한다. `CREDENTIAL_REGISTRY_ENABLED`가 활성화되어야 한다. 선택한 공용 원문 snapshot과 수동 기록만 전송하며 모델에 도구를 제공하지 않는다. 원문의 명령, 모델이 제안한 출처 ID·평가·승인 상태는 받지 않는다. 결과는 항상 `model-candidate` 출처의 `draft`이고 평가와 승인은 기존 절차를 따른다. 수정 이후에도 모델 정보는 최초 후보 생성 정보로 표시한다.

`POST /generations` body는 `{ requestId, accountId, modelName, reasoningEffort, focus, sources }`다. 동일 요청 ID·입력은 다시 접수해도 새 실행을 만들지 않는다. `GET /generations`는 요청자 본인의 최근 20개 상태를 반환하고 `POST /generations/:generationId/cancel`로 대기·실행 중 요청을 취소한다. UI가 접수 응답을 확인하지 못하면 같은 요청을 확인할 수 있다.

Migration `0038_criterion_generation.sql`에 영속 요청 큐를 추가했다. Worker는 기존 동시 실행 한도와 모델 admission을 재사용한다. 사용자당 한 요청만 진행하며 모델 호출은 120초로 제한한다. 3분 실행 기한을 넘긴 요청은 `uncertain`으로 종료하고 자동 재호출하지 않는다. 기존 계정의 401 credential refresh 재시도 1회만 허용하며 이 호출도 admission에 포함한다. 모델 결과를 저장하기 전에 저장소·유지관리·모델 계정 접근과 원문 hash를 다시 확인한다. 취소된 실행의 늦은 결과는 저장하지 않는다.

2026-09-14 후속 통합 검사 30개가 통과했다. 합성 provider를 사용한 요청 중복·claim 경합·원문 변경·권한 회수·형식 오류·실행 유실·취소와 Chrome 후보 생성·조회·역할 부여/회수를 포함한다. 모델 원문 변경 오류를 구체화했고 역할 checkbox는 저장 중 상태를 표시한 뒤 서버 결과를 반영한다. 전체 build, 변경 파일 lint와 이후 runtime/web build도 통과했다. 이 로컬 결과는 실제 provider 호출이나 운영 배포 완료 증거가 아니다. [후속 증거](../../.documents/execution/preventive-review/evidence/P05-criterion-generation.json)를 따른다.


## alpha.40 운영 배포·실제 모델 검증

후속 기능은 PRISM-DEV Helm revision 52, chart 0.10.38, alpha.40으로 배포했다. Source `19ebf42`, release pin `1366f06`, image digest `sha256:875b28b201b1aeb72b1a10f1f99ad675b0c5e8b89d9074e1342b19751ea30e76`다. 마이그레이션은 38개이며 서버·워커·Keycloak Ready, 기존 DB verify-full TLS·local 인증·설정·Secret·PVC·데이터를 보존했다. 01:45:03 KST Helm test와 게시 이미지·운영 코드/정적 파일 대조가 통과했다.

실제 모델 검증에는 임시 reviewer 계정과 polling·리뷰 게시를 끈 전용 repository를 사용했다. 등록된 `gpt-5.6-sol / medium`이 합성 캐시 검토 원문을 처리했으며 admission ledger는 완료 1건이었다. 원문과 hash를 보존한 미평가 draft가 생성됐고 모델의 판단은 `open-question`이었다. 평가나 owner 승인으로 자동 전환되지 않았다. 이 검증은 실제 서비스의 결함 재현을 뜻하지 않는다. 임시 계정·repository·세션은 정리했다.

최초 bootstrap credential 로그인은 401이었으며 기존 계정의 비밀번호를 수정하지 않았다. 성공한 검증은 별도 임시 계정의 실제 local 로그인 경로다. [배포·실제 모델 증거](../../.documents/execution/preventive-review/evidence/P05-generation-PRISM-deployment.json)를 참고한다. 불변 bundle·서명된 manifest·CLI/Commit Defender 적용은 아직 제공하지 않는다.

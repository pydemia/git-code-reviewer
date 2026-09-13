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
| `PUT /roles` | 관리자의 저장소별 역할 위임·철회 |

위임 body는 `{ userId, role, enabled }`이며 role은 `maintainer`, `security-owner`, `domain-owner` 중 하나다. 대상 계정의 tenant·직접 또는 그룹 repository grant를 확인한다. 관리자라는 이유만으로 지정 owner 자격을 부여하지 않는다. 역할 위임 웹 화면은 아직 없다.

## 검증과 남은 범위

로컬 격리 PostgreSQL을 사용하는 기준 관리·기존 메모리 검사 26개, 전체 build와 변경 파일 lint가 통과했다. Chrome에서 후보 등록→평가→관찰→활성화→reader 정정·예외 요청→owner 승인→maintainer 철회→새 버전→퇴역을 실제 API로 수행했다. 브라우저의 로그인 주체·저장소 목록만 합성 fixture이며 SAML 로그인 검증은 아니다. 모바일 폭에서 수평 넘침이 없음을 확인했다.

최초 브라우저 실패는 기본값이 있는 textarea의 라벨 탐색 문제로 명시적 접근성 이름을 추가했다. 동시 revision 변경의 잘못된 404는 stable rule row를 먼저 잠그도록 수정했다. 저장소 삭제 시 이력 FK의 검사 순서 충돌은 transaction 종료 시 검사하도록 수정했으며 이력 직접 수정·삭제 금지는 유지한다.

이 단계는 기준 관리 기능이다. 모델 후보 자동 생성, 불변 bundle 발행·서명된 manifest·client sync는 미구현이며 `active` 기준도 현재 PR·CLI 리뷰에는 적용되지 않는다. 화면에 미발행 상태를 표시한다. P05 전체 완료와 구분하며 실행 증거는 [P05 검증 기록](../../.documents/execution/preventive-review/evidence/P05-criteria-management.json)을 따른다.

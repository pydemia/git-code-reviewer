# 리뷰 지식 발행 상태와 메모리 배포 승인

`/review-criteria`에 현재 저장소의 정책·Skill·리뷰 기준, 집단 메모리, 본인 개인 메모리의 발행 상태를 추가했다. 기준의 `active`와 실제 bundle 발행을 구분한다. 발행 대기·실패·미발행·파일 사용 불가·배포 꺼짐을 각각 표시하며, 발행한 bundle의 sequence·ID·SHA-256·크기·시각과 제외 항목 수를 확인할 수 있다. 상태는 마지막 조회 결과이며 새로고침으로 다시 읽는다. 이 화면은 파일 전체 hash를 검사하는 다운로드 검증을 대신하지 않는다.

서버의 배포 설정이 꺼져 있어도 권한이 있는 사용자는 `GET /review-knowledge/status`에서 꺼짐 상태를 읽을 수 있다. 다른 저장소 또는 다른 사용자의 personal scope는 노출하지 않는다. 지원 지식 contract는 v1이며 비호환 요청은 manifest API의 426 사유로 거부한다. 아직 동기화 보고를 받지 않으므로 `syncObservation`은 `unknown`이다. 화면도 적용·동기화 완료를 추정하지 않는다. 상태 telemetry 수신·보관은 P06의 실제 client 통합과 함께 남아 있다.

배포가 켜진 경우 ‘메모리 배포 내용 검토·승인’에서 검토 가능한 활성 메모리를 선택한다. 목록은 공용 자료의 administrator/위임 maintainer와 개인 자료의 소유자에게만 노출한다. Administrator도 다른 사용자의 개인 자료는 볼 수 없다. `GET /review-knowledge/memories`는 UUID cursor로 최대 100개씩 조회하며 raw 원문·anchor·기여자 정보는 목록에 넣지 않는다.

편집기는 배포할 summary·detail·recommendation·반증·적용 조건·분류·만료 시각을 명시적으로 승인한다. 기존 승인이 있으면 그 내용을 표시하고 새 승인은 설명·권고를 원문에서 자동 복사하지 않는다. 원문 fingerprint가 달라지면 409를 표시하고 작성 중인 내용은 보존한다. ‘현재 입력을 버리고 최신 상태 불러오기’를 누르면 기존 편집기를 즉시 닫은 뒤 새 fingerprint를 읽는다. 늦은 응답이나 저장 완료가 다른 저장소/메모리의 편집 상태를 덮어쓰지 않도록 요청을 취소하고 unmount를 확인한다.

승인 완료는 projection과 outbox 저장을 뜻한다. 화면의 승인 안내 이후 worker가 실제 bundle을 발행해야 상태가 갱신된다. 개인 component만 바뀌는 흐름과 실제 다운로드 bytes를 함께 검증했다. [서명·다운로드 계약](review-knowledge-distribution.md)을 따른다.

검증은 격리 PostgreSQL, 실제 파일 저장, Chrome과 합성 메모리로 수행했다. 권한별 목록·pagination, 발행 실패·artifact unavailable·disabled 상태, source 변경 후 입력 보존·재확인·키보드 승인, 다운로드 결과, 데스크톱·390px 모바일 화면을 확인했다. 첫 화면 재검증에서 최신 상태 요청 직후 이전 form에 입력할 수 있는 짧은 구간을 발견해 동기적으로 편집기를 비우도록 수정했다. 수정 후 배포 API/화면 18개 검사가 통과했다. 앞선 전체 관련 suite 118개와 build/lint 기록은 [검증 증거](../../.documents/execution/preventive-review/evidence/P05-knowledge-management.json)에 있다.

이 문서는 로컬 구현 기록이다. PRISM-DEV 배포 증거는 별도로 남긴다. 명시적 높은 sequence rollback, repository remote resolve·출처 상세 API, client 인증·원자적 cache·sync와 상태 보고는 이 변경으로 완료되지 않는다.

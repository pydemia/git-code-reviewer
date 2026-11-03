# PR 리뷰 원문·상태·위치 이력

중앙 GitHub/GHES 수집은 REST의 리뷰 상태, 리뷰 ID, 답글 대상, 현재/원래 commit·줄 범위와 diff hunk를 보관한다. 본문이 없는 제출된 승인·기각 리뷰도 수집하며 원문 공백을 유지한다. 제출 시각이 없는 pending review는 수집하지 않는다. 원래 줄 번호를 현재 줄 번호로 대체하지 않는다.

REST inline comment의 node_id와 GraphQL comment id를 연결해 thread id·isResolved·isOutdated를 읽는다. GitHub와 GHES의 같은 origin에 있는 GraphQL endpoint만 사용하며 설치 경로 prefix를 보존한다. 댓글 본문이나 토큰을 query URL에 넣지 않고 읽기 query와 기존 GitHub credential만 사용한다.

관측된 상태는 `threadObservation=observed`와 boolean으로 표시한다. API 미지원·오류·없는 PR·부분 응답·cursor 반복·페이지 중 상태/범위 변경은 값을 추정하지 않고 unknown으로 남긴다. 스레드/댓글 pagination은 한 PR에서 합계 최대 20개 GraphQL 요청, 요청 전체 20초와 응답당 2 MiB로 제한한다. 한도에 도달하면 partial이며 앞 페이지만 읽고 전체 수집 성공으로 표시하지 않는다. 승인, merge, 해결된 스레드나 줄 번호 누락은 코드 결함 수정의 증명이 아니다. 원문 삭제/접근 불가 확인은 별도 후속 범위다.

## 저장과 조회

Migration 0046은 기존 body-only `github_pr_message_versions`를 유지하고 `github_pr_message_observations`에 원문·상태·위치 snapshot과 SHA-256, 수집 시작/관측 시각을 기록한다. 같은 snapshot의 반복 관측은 새 이력을 만들지 않지만 A→B→A 변화는 별도 이력이다. 기존 자료에 관측하지 않은 상태·위치를 소급 생성하지 않는다.

PR별 저장을 직렬화하며 늦게 도착한 수집 응답이나 더 오래된 원문 수정 시각은 최신 상태를 덮어쓰지 않는다. 동시 시작 시각이 같고 내용이 충돌하면 기존 관측을 보존한다. 동일 source의 반복 수집은 knowledge outbox를 늘리지 않는다.

`GET /api/v1/repositories/:repoId/pulls/:number/review-memory-sources/:sourceId/history`는 현재 저장소 조회 권한과 PR/source 소속을 확인한다. 응답은 `private, no-store`이며 최근 50건과 `nextCursor`를 반환한다. 다음 페이지는 `?cursor=<nextCursor>`로 조회한다. 중앙 웹 session의 읽기 기능이며 로컬 결과 제출 API나 client key의 새 권한을 추가하지 않는다.

PR 대화 화면에서 현재/원래 위치, 리뷰 상태, 답글 대상을 보고 변경 이력을 펼칠 수 있다. 원문과 diff는 실행되지 않는 text다. 빈 본문으로 Memory 후보를 자동 생성하지 않는다.

## 기준과 배포 승인

기준의 GitHub source 참조에는 body `contentHash`와 관측 snapshot `observationHash`를 함께 고정한다. 원문을 선택한 뒤 리뷰 상태·위치가 바뀌면 오래된 관측 hash로 후보를 생성할 수 없다. 모델 후보 생성 입력에도 실제 관측 metadata를 제공하며 승인 없는 자동 활성화는 하지 않는다.

기존 승인된 기준 또는 memory projection의 출처 관측이 달라지면 다음 발행에서 해당 내용을 제외한다. 기존 불변 bundle을 수정하지 않고 재검토·재승인하도록 한다. Legacy 자료의 첫 metadata 관측도 출처 변경이므로 승인된 항목의 재검토가 필요할 수 있다. 중앙에서 새로운 기준을 승인·발행하면 로컬이 기존 단방향 동기화로 받는다. 로컬 source·결과·대화는 중앙으로 보내지 않는다.

REST 필드의 의미는 [GitHub review 문서](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28)와 [review comment 문서](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28)를 따른다.

## PR 대화의 주기 수집과 재시도

Migration 0047의 `pull_request_conversation_sync`는 PR 목록 ETag와 별도로 due time·성공/실패·실행권을 저장한다. 목록이 304여도 due 대화를 읽으며 원천 수집 한 건의 실패가 다른 PR 처리나 저장된 metadata를 되돌리지 않는다. PR당 실패 backoff는 30초부터 최대 30분이다.

한 repository poll에서 최대 10개 PR을 due 순서로 처리한다. 실행권은 DB에서 획득하고 2분 후 만료된다. 재시작·다중 poller에서도 같은 PR을 동시에 소유하지 않으며 이전 소유자의 늦은 응답은 저장·성공 처리를 할 수 없다. REST 수집은 60초, endpoint별 최대 20페이지다. 끝을 확인하기 전에 REST 페이지 한도에 도달하면 CONVERSATION_PAGE_LIMIT으로 남기며 부분 대화를 전체 성공으로 취급하지 않는다.

추적하던 open PR은 종료를 관측한 뒤 7일 동안 후속 논의를 읽고 reopen하면 다시 계속 추적한다. Migration에서는 기존 open PR과 최근 7일 안에 갱신됐으며 이미 원문을 수집한 closed PR만 등록한다. 처음 발견한 과거 closed PR은 metadata만 보관한다. 관리자 범위 지정 없는 전체 과거 대화 backfill은 하지 않는다.

PR 대화 화면의 원문 수집 상태는 대기·수집 중·최근 성공·실패/재시도·기간 만료와 마지막 성공 시각을 표시한다. 원문 수집 성공과 GraphQL 스레드 관측 여부는 구분한다. 많은 페이지의 cursor를 다음 작업으로 넘겨 재개하는 backfill, 명시적 삭제/접근 불가 확인과 webhook 보정은 남은 P12-C02 범위다.

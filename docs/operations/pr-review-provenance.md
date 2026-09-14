# PR 리뷰 원문·상태·위치 이력

중앙 GitHub/GHES 수집은 REST의 리뷰 상태, 리뷰 ID, 답글 대상, 현재/원래 commit·줄 범위와 diff hunk를 보관한다. 본문이 없는 제출된 승인·기각 리뷰도 수집하며 원문 공백을 유지한다. 제출 시각이 없는 pending review는 수집하지 않는다. 원래 줄 번호를 현재 줄 번호로 대체하지 않는다.

API에서 제공하지 않은 thread resolved/outdated 상태는 null이다. 승인, merge, 줄 번호 누락이나 목록에서 빠진 사실을 결함 해결·삭제로 추정하지 않는다. GraphQL thread 상태와 삭제/접근 불가 확인, 최근 종료 PR 증분 회수는 후속 P12 범위다.

## 저장과 조회

Migration 0046은 기존 body-only `github_pr_message_versions`를 유지하고 `github_pr_message_observations`에 원문·상태·위치 snapshot과 SHA-256, 수집 시작/관측 시각을 기록한다. 같은 snapshot의 반복 관측은 새 이력을 만들지 않지만 A→B→A 변화는 별도 이력이다. 기존 자료에 관측하지 않은 상태·위치를 소급 생성하지 않는다.

PR별 저장을 직렬화하며 늦게 도착한 수집 응답이나 더 오래된 원문 수정 시각은 최신 상태를 덮어쓰지 않는다. 동시 시작 시각이 같고 내용이 충돌하면 기존 관측을 보존한다. 동일 source의 반복 수집은 knowledge outbox를 늘리지 않는다.

`GET /api/v1/repositories/:repoId/pulls/:number/review-memory-sources/:sourceId/history`는 현재 저장소 조회 권한과 PR/source 소속을 확인한다. 응답은 `private, no-store`이며 최근 50건과 `nextCursor`를 반환한다. 다음 페이지는 `?cursor=<nextCursor>`로 조회한다. 중앙 웹 session의 읽기 기능이며 로컬 결과 제출 API나 client key의 새 권한을 추가하지 않는다.

PR 대화 화면에서 현재/원래 위치, 리뷰 상태, 답글 대상을 보고 변경 이력을 펼칠 수 있다. 원문과 diff는 실행되지 않는 text다. 빈 본문으로 Memory 후보를 자동 생성하지 않는다.

## 기준과 배포 승인

기준의 GitHub source 참조에는 body `contentHash`와 관측 snapshot `observationHash`를 함께 고정한다. 원문을 선택한 뒤 리뷰 상태·위치가 바뀌면 오래된 관측 hash로 후보를 생성할 수 없다. 모델 후보 생성 입력에도 실제 관측 metadata를 제공하며 승인 없는 자동 활성화는 하지 않는다.

기존 승인된 기준 또는 memory projection의 출처 관측이 달라지면 다음 발행에서 해당 내용을 제외한다. 기존 불변 bundle을 수정하지 않고 재검토·재승인하도록 한다. Legacy 자료의 첫 metadata 관측도 출처 변경이므로 승인된 항목의 재검토가 필요할 수 있다. 중앙에서 새로운 기준을 승인·발행하면 로컬이 기존 단방향 동기화로 받는다. 로컬 source·결과·대화는 중앙으로 보내지 않는다.

REST 필드의 의미는 [GitHub review 문서](https://docs.github.com/en/rest/pulls/reviews?apiVersion=2022-11-28)와 [review comment 문서](https://docs.github.com/en/rest/pulls/comments?apiVersion=2022-11-28)를 따른다.

# 리뷰 이력 reader API

G02는 중앙에 저장된 PR 이력과 출처 지침의 조회를 제공한다. Commit Defender에서 이 API를 사용하는 구현은 G03 범위다. 원문을 읽기 위해 분석 실행이나 메모리 승인을 먼저 할 필요는 없다.

## 인증과 조회 범위

기존 `knowledge:read` API key와 `X-GCR-Server-Id`를 사용한다. key의 tenant·저장소 범위와 현재 사용자·저장소 권한을 매 요청에 확인한다. 아래 GET에는 `clientKnowledgeRead`가 적용된다. 브라우저 세션도 같은 저장소 reader 인가를 따른다.

모든 응답은 `Cache-Control: private, no-store`, `Vary: Cookie, Authorization`을 반환한다. key 회수나 저장소 권한 철회 뒤에는 다시 접근할 수 없다. reader credential로 수집·지침 작성·활성화 요청을 보낼 수 없다. GCR에 local diff·파일 내용·질문·리뷰 결과를 보내는 검색 API는 없다.

기준 경로는 `/api/v1/repositories/{repositoryId}/review-history`다.

| GET 경로 | 허용 query | 응답 |
| --- | --- | --- |
| 기준 경로 | `pullNumber`, `limit`, `cursor`, `revision` | PR 목록, 저장 코멘트·답글 수, 수집 범위, 관리 권한 |
| `/pulls/{number}/messages` | `parentId`, `limit`, `cursor`, `revision` | 코멘트 목록. 본문은 500자 excerpt로 제한 |
| `/pulls/{number}/messages/{sourceId}` | 없음 | 원문 전체, GitHub ID·URL, 상위 코멘트·리뷰 ID, 파일·commit 위치, 현재 관측 hash |
| `/pulls/{number}/messages/{sourceId}/versions` | `cursor` | 이미 저장된 본문 버전. 본문·hash·위치·GitHub 수정 시각·저장 시각 |
| `/pulls/{number}/messages/{sourceId}/history` | `cursor` | REST·스레드·본문·조회 상태의 관측 snapshot |
| `/collections/{collectionId}` | 없음 | 명시한 PR 목록, PR별 완료·시도·오류, 미완료 재개 위치, 수집 상한 |
| `/guidance` | `sourceId`, `limit`, `cursor` | 이력 원문에서 작성한 공용 지침 목록 |
| `/guidance/{guidanceId}` | 없음 | 요약·적용 조건·반증·출처 hash, 초안/활성/비활성 상태, 재검토 필요 여부 |

목록 `limit`은 기본 20, 최대 50이다. 본문 버전과 관측 이력은 10개씩 반환한다. `nextCursor`가 null이면 끝이다. cursor는 저장소·조회 조건·revision에 묶인 불투명 문자열이다. 다른 조건에서 재사용하면 400이며, 수집 등으로 revision이 바뀌면 `HISTORY_REVISION_CHANGED` 409를 반환한다. 호출자는 같은 목록의 첫 페이지부터 다시 읽어야 한다. 이미 받은 페이지와 새 revision의 페이지를 합치지 않는다.

`revision`은 현재 페이지 묶음을 확인하는 값이다. 원문 식별은 `sourceId`, 본문 식별은 `contentHash`, REST·스레드 관측 식별은 `observationHash`를 사용한다. 본문이 같아도 위치·스레드 상태는 바뀔 수 있다. 답글의 `parentId`는 저장된 상위 코멘트를 가리키며, 상위 원문이 없으면 null이다. 일반 댓글·리뷰·inline 코멘트의 GitHub ID 공간은 `kind`로 구분한다.

## 수집 상태와 한계

중앙 화면은 `/review-history`에 있다. 저장소 관리자는 이미 등록된 PR 번호를 최대 20개 지정해 수집할 수 있다. 수집 POST에는 `requestKey` UUID와 `pullNumbers`만 받는다. 같은 requestKey의 같은 범위는 같은 작업을 반환하며, 다른 범위로 재사용하면 409다. job 실행권·재시도·중단 회수는 기존 worker를 사용한다. 완료된 PR은 같은 작업 재실행에서 다시 읽지 않는다.

현재 구현은 명시한 PR 번호 목록을 받는다. 기간만 입력해 과거 전체 PR을 탐색하는 기능은 추가하지 않았다. REST endpoint별 최대 20페이지, 페이지당 100개라는 기존 상한을 유지한다. 끝까지 읽지 못한 응답으로 수집 완료나 코멘트 부재를 확정하지 않는다.

`coverage.state`는 `uncollected`, `collecting`, `failed`, `collected`다. `uncollected`인 PR에도 과거에 저장한 원문이 있을 수 있다. `collected`는 `lastCompleteAt`의 제한된 조회가 완료됐다는 의미다. 보관한 코멘트가 전체 응답에 없으면 `upstreamState: not-returned`로 표시하고 원문·버전·이력을 유지한다. 이 상태만으로 삭제 원인을 확정하지 않는다.

본문 버전과 상세 관측 이력은 서로 다른 저장 기록이다. 상세 관측 기능 도입 전에 저장한 본문 버전도 조회하며, 당시 기록하지 않은 스레드·위치 정보를 현재 값으로 채워 넣지 않는다. 수집 전에 수정·삭제된 내용은 복원하지 못한다. GitHub REST와 별도 스레드 조회는 하나의 원자적 snapshot이 아니므로 조회 사이에 생긴 변화까지 같은 시점의 사실로 보장하지 않는다. resolved·merged·수정 답글은 코드 수정 검증의 대체 증거가 아니다.

## 출처 지침과 발행

저장소 관리자는 원문을 열어 요약, 출처 해석, 검토 지침, 적용 조건, 반증 지침을 작성한다. `sourceId`, `contentHash`, `observationHash`가 현재 원문과 같아야 초안을 저장할 수 있다. 저장한 초안의 `활성화·발행`은 한 번의 작업으로 기존 collective memory를 활성화하고 publication projection과 outbox를 갱신한다. 개인 후보나 정족수 승격을 거치지 않는다.

활성화 응답의 `publicationRequested`는 발행 요청 상태다. 발행 완료는 기존 `/review-knowledge/status`, 서명된 manifest와 immutable bundle로 확인한다. 원문이 변경되거나 최근 조회에서 반환되지 않으면 `needsReview`를 표시하고 새 발행 및 기본 리뷰의 해당 지침 사용에서 제외한다. 이미 실행 중인 분석의 immutable context와 기존 offline lease 정책은 그대로 유지한다. 새 내용은 현재 원문에서 새 초안으로 작성하며 기존 지침은 비활성화할 수 있다.

기존 Skill·central knowledge bundle 형식은 바꾸지 않았다. collective bundle의 memory ID로 `/guidance/{guidanceId}`를 조회하면 실제 원문의 ID·PR·URL·hash로 이어진다. 기존 개인 메모리와 원문은 새 공용 지침 목록이나 bundle로 자동 전환하지 않는다.

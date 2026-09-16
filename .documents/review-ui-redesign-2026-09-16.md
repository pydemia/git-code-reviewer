# 리뷰 이력·관측 화면 재설계

대상은 저장된 PR 코멘트를 읽고 출처와 수정 이력을 확인하는 작업, 저장소별 리뷰 관측 현황을 파악하는 작업이다. API·권한·수집 범위·원문 저장 형식은 유지한다.

## 참고 자료와 적용

`agent-skills` 원격 main `f5d3e0df7b6bf08f82938f273ffe9e09c466c66d`의 `skills/product-ui-ux-design/SKILL.md`와 `skills/web-publishing/SKILL.md`를 읽었다. 로컬 skill 저장소의 미커밋 파일과 checkout은 변경하지 않았다.

- [GitHub PR comments](https://docs.github.com/en/pull-requests/how-tos/review-pull-requests/commenting-on-a-pull-request): 일반 대화와 코드 위치 코멘트, 답글과 스레드 상태를 분리하는 정보 구조. 쓰기·resolve 기능은 복제하지 않는다.
- [GitHub Comments panel](https://github.blog/changelog/2026-02-19-access-all-pull-request-comments-without-leaving-the-new-files-changed-page/): 선택한 PR과 코멘트 문맥을 유지하면서 원문을 읽는 흐름. 원문은 페이지 맨 아래가 아닌 해당 코멘트 안에서 펼친다.
- [Primer Timeline](https://primer.style/product/components/timeline/): 문서와 실제 컴포넌트 화면을 확인했다. 작성자 영역, 연결선, 본문 영역의 관계를 사용하되 기존 GCR 색상·폰트·버튼을 유지한다.

## 화면 결정과 구현 계약

리뷰 이력은 상단 제목·저장소 선택, 왼쪽 PR 탐색 목록, 오른쪽 선택 PR의 대화로 구성한다. 제목 검색은 현재 불러온 목록에 적용하며 범위를 명시한다. PR 번호는 기존 `pullNumber` reader 조회 API로 전체 저장 이력에서 바로 열고, URL로 지정한 과거 PR도 첫 페이지 밖에서 조회한다. 추가 수집은 하지 않는다. 목록 페이지네이션과 중복 제거를 유지한다. 작성자·날짜·유형·파일 위치가 본문 위에 있고 부모가 로드된 답글은 같은 스레드 안에서 표현한다. 원문이 없는 부모나 일부 페이지의 답글을 완전한 스레드처럼 표시하지 않는다.

코멘트 목록은 Markdown 미리보기이며 원문 펼침 시 기존 detail API로 완전한 본문을 조회한다. Markdown은 기존 react-markdown·remark-gfm을 재사용해 표·목록·인용·코드·링크를 지원한다. raw HTML과 스크립트·위험 URL은 실행하지 않고 원격 이미지도 자동으로 불러오지 않는다. 코드 제안은 코드로 표시하며 적용 기능을 만들지 않는다. 본문 버전과 관측 이력에도 같은 렌더러를 사용하고 원문 텍스트 확인 수단을 남긴다. 원문·답글·수정·관측 시점과 현재 결함 여부를 혼동하지 않는다.

리뷰관측은 선택 기간의 범위와 핵심 수치, PR 최신 상태·기준 판단, 실행 비용·발행·다운로드의 순서로 읽는다. 집계 근거와 미관측 항목은 접을 수 있는 설명 영역으로 옮기되 수치가 실제보다 완전해 보이지 않게 표본 제한과 미완료 상태는 계속 표시한다. 추정 성공률·새 지표·가짜 PR 목록은 만들지 않는다.

두 화면은 기존 CSS 변수(--surface, --surface-subtle, --border, --text, --muted, --accent)를 쓴다. 800px 이하에서 이력 목록과 대화를 세로로 전환하고 긴 경로·코드·표는 내부에서 스크롤한다. 원문 버튼은 aria-expanded와 연결된 본문을 제공하고 버튼/검색/select의 키보드 탐색을 유지한다. 로딩·빈 결과·실패·권한 부족을 서로 다르게 표시한다.

## 검증

기존 회귀와 실제 브라우저에서 PR 선택·검색·답글·원문 펼침·Markdown·본문 버전·오류 상태·모바일 overflow를 확인한다. 합성 fixture와 실제 저장 이력 검사를 구분하고 새 PR·댓글·과거 수집·모델 호출은 하지 않는다.

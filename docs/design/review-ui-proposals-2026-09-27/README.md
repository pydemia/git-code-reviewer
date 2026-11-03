# GCR 리뷰 화면: 색상 5안 · UI 5안

2026-09-27. 선택을 위한 설계 시안이며 실서비스의 스타일·동작·배포는 바꾸지 않았다.

`index.html`을 브라우저에서 열면 색상과 화면 구조를 독립적으로 선택할 수 있다. 처음 표시되는 C1 + U1은 비교용 기본 조합이다. 선택은 URL에 기록하며 사용자 설정이나 local storage에 저장하지 않는다. API·모델 호출은 없다.

로컬 미리보기:

```sh
python3 -m http.server 18087 --bind 127.0.0.1 --directory docs/design/review-ui-proposals-2026-09-27
```

- 비교 도구: <http://127.0.0.1:18087/>
- 색상 비교: <http://127.0.0.1:18087/?sheet=colors>
- UI 비교: <http://127.0.0.1:18087/?sheet=uis>
- 선택 예시: <http://127.0.0.1:18087/?palette=C3&ui=U2>

## 수정하려는 표현

현재 `ReviewReportPanel.tsx`의 `.report-unit`은 finding마다 테두리·그림자·색 띠를 반복한다. `.priority-border-p0`부터 `.priority-border-p3`까지 왼쪽 띠의 색을 바꾼다. 이번 시안은 이 띠를 제거하고 심각도를 아이콘 + 기존 P0~P3 라벨로 표시한다. 색은 상태·선택·링크처럼 의미가 있는 곳에만 쓴다.

기존 청록 `#176B5D`, warning `#B54708`, danger `#B42318`, 코드 줄 강조 `#FFF8C5`를 유지한다. Markdown, 코드 인용, 파일·행·SHA, 수정 제안의 별도 박스, 원문·답글·수정 이력·출처의 조회 흐름도 유지하는 설계다. 첨부 화면에 없는 PR 번호·작성 시각·답글·수정 이력은 시안 데이터로 만들지 않았다. 본문의 과거 관측을 현재 코드의 결함으로 재판정하지 않았다.

## Colormap 후보

| 선택 | 기반 colormap                     | UI 방향                                                   | 주요 UI 파생 색상                                     |
| ---- | --------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| C1   | 그레이블루 (`gray-blue`)          | 중립 회색·청회색. 코드를 읽는 현재 제품과 가장 가까움     | canvas `#F5F6F4`, text `#20252D`, secondary `#5B6E7E` |
| C2   | Modern Vintage (`modern-vintage`) | 따뜻한 백색·살몬·청록. 리뷰 이력의 편집 문서 느낌         | canvas `#FBF9FA`, text `#1C181F`, secondary `#28626A` |
| C3   | Neutral Blue (`neutral-blue`)     | 차가운 회청색·잉크색. 표·필터와 코드 탐색을 분명하게 구획 | canvas `#F2F6F7`, text `#0B3845`, secondary `#436F83` |
| C4   | Ryde (`ryde`)                     | 민트·올리브·회갈색. 주색과 자연스럽게 이어지는 낮은 채도  | canvas `#FAFFFC`, text `#2D3029`, secondary `#585340` |
| C5   | 베이지네이비 (`beige-navy`)       | 린넨·네이비. 긴 원문·답글·수정 문맥을 읽는 방향           | canvas `#F7F5EF`, text `#25313B`, secondary `#426A7E` |

다섯 안 모두 주색은 `#176B5D`다. 원본 6색은 `palettes.json`의 `source_palette.swatches`에 원래 순서와 정확한 값으로 보존했다. `tokens`는 제품 역할에 맞춘 파생안이며 원본 colormap을 수정하지 않는다. `token_provenance`는 기존 GCR 값·등록된 역할 값·UI 파생 값을 구분한다. 별도 브랜드 변경이나 agent-skills registry 저장은 수행하지 않았다.

보통 크기 텍스트에 실제 사용하는 본문·metadata·링크·심각도·보조색의 전경/배경 19쌍씩 총 95쌍을 계산했다. 최솟값은 C1 4.703:1, C2/C4/C5 4.837:1, C3 4.751:1이다. C1 원본 청회색 `#6A7B8B`는 흰 바탕 대비 4.358:1로 일반 텍스트에 부족해 UI의 secondary를 `#5B6E7E`로 파생했다. 원본 swatch는 그대로 남겼다. 이 결과는 색 대비 확인이며 전체 제품의 접근성 인증은 아니다. 계산은 `contrast.json`에 기록했다.

## UI 후보와 실제 참고한 구조

| 선택           | 공식 reference                                                                                                                    | GCR에 적용한 구조                                                                              | 적합한 작업 / 고려할 비용                                                         |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| U1 Primer      | [Timeline](https://primer.style/product/components/timeline/), [PageLayout 등 컴포넌트](https://primer.style/product/components/) | 파일 탐색 → 코드 인용 → 코멘트 스레드. 코멘트 헤더에만 severity. 출처는 우측 여백과 펼침 영역  | GitHub PR 댓글에 익숙한 검토. 기존 renderer·탐색을 재사용하기 가장 쉬움           |
| U2 Material UI | [Drawer](https://mui.com/material-ui/react-drawer/), [List](https://mui.com/material-ui/react-list/)                              | 목적지 rail + 파일 List + 하나의 낮은 elevation Paper. 둥근 모서리는 control·선택·Paper에 제한 | 설정·입력 UI까지 일관되게 확장. MUI theme과 기존 CSS 경계·의존성·bundle 확인 필요 |
| U3 Carbon      | [Data table](https://carbondesignsystem.com/components/data-table/usage/)                                                         | 심각도·제목·위치·관점 비교표 + 선택 행의 펼친 코드·본문. 네모난 구획과 촘촘한 행               | 큰 PR의 의견 분류·비교. 작은 화면은 보조 열을 줄이고 상세 영역을 확보해야 함      |
| U4 Ant Design  | [List](https://ant.design/components/list/)                                                                                       | 왼쪽 의견 목록 + 오른쪽 상세. 상세는 카드 중첩 없이 제목·구분선·본문으로 구성                  | 리뷰 관측·이력의 빠른 이동. 목록 선택·상세 URL·revision 고정·focus 복원 설계 필요 |
| U5 Editorial   | [shadcn Typeset](https://ui.shadcn.com/docs/typeset)                                                                              | 본문 외곽 박스 없이 목차·타이포그래피·출처 여백. 코드 인용과 수정 제안만 구획                  | 긴 원문·답글·수정 이력 읽기. 촘촘한 업무 목록에는 별도 행 구조를 함께 사용        |

문서의 실제 컴포넌트 예시·구조와 동작 설명을 확인한 뒤 제품의 콘텐츠에 맞게 재배치했다. 위 화면은 각 라이브러리를 설치해 구성한 제품 코드가 아닌 HTML/CSS 구조 시안이다. Material UI는 [MIT 라이선스](https://github.com/mui/material-ui/blob/master/LICENSE)의 오픈소스 React 라이브러리다. U2를 선택하더라도 Pro/Premium 제품이나 유료 템플릿을 전제하지 않는다.

사용자는 **C5 + U1/U2 혼합**을 선택했고 기존 code diff 보존을 요청했다. [통합 시안·결정 기록](hybrid-decision.md)에 실제 기존 diff·리뷰 renderer를 사용하는 화면과 보존할 동작을 정리했다. 원래 후보 5개와 색상 5개는 비교 자료로 유지한다.

## 선택 후 제품에 반영할 범위

색상과 화면은 `C1 + U2`처럼 따로 선택할 수 있다. 한 화면에서 다섯 UI 라이브러리를 섞지 않는다. 선택한 방향을 다음 화면에 연결한다.

- PR 목록: 기존 열·분석 상태·revision 선택을 유지하며 선택한 token·행·필터·control을 적용한다.
- 리뷰 workspace: 코드·Summary·Comments·Chat의 현재 revision 고정과 resizable layout을 보존한다. 스레드/표/목록·상세의 표현 변경은 데이터 계약을 바꾸지 않는다.
- 리뷰 관측·이력: 원문 목록·읽기 영역·출처·답글·본문 버전은 같은 디자인 계열로 구성한다. 메모리 활성화·발행 상태를 원문 조회 상태와 구분한다.
- 프로필·Prompt·Client 설정: 이미 분리한 navigation과 스크롤 책임을 유지하고 선택한 control을 적용한다.

현재 `ReviewMarkdown`, `ReviewCodeReference`, `ReviewGrade`, revision deep link, GitHub exact-SHA permalink, 사용자 접근 권한과 API를 재사용한다. 본문을 장식용 panel로 감싸거나 Markdown parser를 새로 만들지 않는다. 잘못된 locator, 실패·partial·stale, 자료 없음·권한 철회 등을 성공으로 바꾸지 않는다.

## 시안 구현·검증

스킬은 `agent-skills`의 `colormap-management`, `editorial-frontend-ui`, `product-ui-ux-design`, `reference-research`, `web-publishing`, `frontend-development`와 설치된 `reference-led-frontend`를 사용했다. 사용자 checkout을 전환하지 않고 `origin/main`의 파일을 읽었다. 스킬 사이트의 직접 페이지는 웹 도구에서 열리지 않아 등록된 저장소 파일을 근거로 삼았다.

- GCR 기준 source: `79249fc678977861e3be07e62d1b46c38411349d`
- agent-skills 기준 source: `da0408070cfb49ea33e47b2354d87c02135da65c`
- 원본 registry 경로: `library/colormaps/colormaps.json`; SHA-256은 `palettes.json`에 기록.
- 기존 GCR: React 19 / Vite / plain CSS / react-markdown + remark-gfm. 제품 dependency를 추가하지 않았다.
- 시안: semantic HTML·CSS·JavaScript. 원본 screenshot 내용의 정적 fixture다. 긴 Markdown 표시는 parser 검증이 아닌 문단·inline code·fenced code·표의 레이아웃 확인이다.
- 키보드 radio 선택, 색상/UI의 독립 선택, URL 보존, 출처 펼침을 실제 브라우저에서 확인했다.
- 다섯 안을 1280px 데스크톱과 390px 모바일에서 확인했다. 긴 코드·표의 가로 스크롤은 내부 영역이 담당한다. U3의 모바일 표 폭과 펼친 행의 colspan을 수정한 뒤 재검증했다.
- 조회 중·의견 없음·조회 실패를 구분했다. 실패에는 alert를 사용하고, 빈 상태는 리뷰 의견 0건을 표시한다.
- JavaScript 구문 검사·Prettier·`git diff --check`를 실행한다. 제품 source가 변경되지 않아 제품 build·배포·모델 호출은 하지 않는다.

`browser-checks.json`에 브라우저 확인 근거, `images/`에 실제 렌더링 이미지를 저장했다. 시안의 제품 navigation·표 펼침 예시는 구조 설명이며 전체 제품 동작 검증이 아니다. 서버·Extension Host·Safari/Firefox·실제 스크린리더 검증은 이번 시안 범위에 포함하지 않는다.

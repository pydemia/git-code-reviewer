# C5 · U1/U2 통합안과 기존 code diff

2026-09-27. 사용자의 선택은 **C5 + U1/U2 혼합**이다. 브라우저에 열려 있던 U5는 선택으로 해석하지 않았다. 기존 code diff를 보존한다는 요구를 함께 반영했다.

## 확인 가능한 통합 시안

- [비교 보드에서 통합안 보기](http://127.0.0.1:18087/?palette=C5&ui=U1%2BU2&state=normal)
- [통합 화면만 보기](http://127.0.0.1:18087/hybrid-build/review-hybrid.html?palette=C5&state=normal)

제품의 `ReviewDiff`와 `ReviewReportPanel`을 그대로 import해 구성한 별도 설계 fixture다. API·모델 실행·운영 데이터 조회 없이 브라우저에서 사용할 수 있다. 현재 제품 entry, dependency, API, 인증, 사용자 설정과 배포는 바꾸지 않았다. 실제 제품의 전체 UI 개편 완료를 뜻하지 않는다.

첨부 이미지에는 전체 patch가 없었다. 시안의 `samples/` 파일 2개, `aaaaaaaa` / `bbbbbbbb` snapshot, 의견은 상호 작용을 확인하기 위한 합성 자료다. 실제 PR·source SHA·실제 분석 결과로 다루지 않는다.

## 선택을 화면에 연결한 방식

| 구획           | 적용 방향                                                  | 보존하는 기능                                                                          |
| -------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 색상           | C5 베이지네이비의 canvas·surface·text·metadata·border 역할 | 기존 청록 `#176B5D`, warning `#B54708`, danger `#B42318`, 코드 행 강조 의미            |
| 탐색           | U2의 목적지 rail + 파일 List + 평평한 작업 영역            | 파일 선택, 코드·리뷰 표시 전환, 탐색 영역 접기                                         |
| code diff      | 실제 기존 `ReviewDiff` 재사용                              | Split/Unified, merge base/head 행 번호, 추가·삭제 부호와 색, 인라인 의견, 코드 행 이동 |
| 상세 의견      | U1의 metadata 헤더 + 코드 근거 + 스레드 본문               | 실제 `ReviewMarkdown`, 파일·행·snapshot 표기, 수정 제안 별도 박스                      |
| 코드/의견 관계 | 기존 workspace처럼 위쪽 diff·아래쪽 Comments               | 의견 선택 시 같은 파일·같은 snapshot의 정확한 행 선택; 각 영역 내부 스크롤             |

옆 색 띠와 반복 그림자를 제거한다. 심각도는 기존 P0~P3 라벨과 헤더에서 표시한다. 수정 제안에만 별도 박스를 유지한다. diff는 코드 인용으로 대체하지 않으며 어두운 코드 영역과 변경 색도 유지한다.

U1/U2의 구조를 혼합하며 Primer와 MUI 라이브러리를 동시에 설치한다는 뜻은 아니다. 이 시안은 기존 React/CSS 컴포넌트를 재사용한다. [Primer Timeline](https://primer.style/product/components/timeline/)의 코드·코멘트 관계와 [Material UI Drawer](https://mui.com/material-ui/react-drawer/), [List](https://mui.com/material-ui/react-list/)의 탐색/작업 구획은 기존 후보의 근거를 재사용했다.

C5 원본 swatch·순서·provenance는 `palettes.json`에 보존한다. `#F7F5EF` canvas, `#FFFEFB` surface, `#25313B` 본문, `#526570` metadata, `#426A7E` 보조색을 역할별로 사용한다. 이번 통합안에서도 기존 `contrast.json`의 C5 색 대비 근거를 재사용한다. diff의 기존 어두운 색상은 보존 대상이며 C5의 일반 텍스트 대비 결과로 대신 검증했다고 표시하지 않는다.

## 사용 절차

1. 비교 보드에서 C5와 `U1+U2 선택안`을 연다. 원래 후보 5개는 계속 비교할 수 있다.
2. 왼쪽에서 파일을 선택하고 위쪽의 Split/Unified로 같은 patch를 비교한다.
3. `인라인 의견`을 켜고 행 옆 코멘트 버튼을 누르면 해당 줄의 의견으로 focus가 이동한다.
4. 아래 의견의 `코드에서 보기` 또는 제목을 누르면 정확한 행을 선택한다. 리뷰 전용 보기에서도 코드/리뷰 화면으로 돌아온다.
5. 코드·리뷰 사이 경계선을 드래그하거나 focus 후 위/아래 화살표로 영역 높이를 조절한다.

시안의 인라인 의견은 첫 화면에서 접어 diff 전체를 먼저 볼 수 있게 했다. 기능을 삭제한 것이 아니며 제품 기본 설정은 바꾸지 않는다. 실제 제품의 기존 resizable workspace, Summary·Comments·Chat와 분석 도구, revision 선택·deep link·출처 API·권한 처리는 향후 제품 반영에서 유지할 대상이다. fixture에는 실행되지 않는 도구·Chat·운영 버튼을 흉내 내어 추가하지 않았다.

## 소스·빌드

- 제품 기준: `79249fc678977861e3be07e62d1b46c38411349d`.
- 시안 소스: `apps/web/design/review-hybrid.tsx`, `review-hybrid.css`, `review-hybrid.html`.
- 재생성: `node apps/web/design/build-review-hybrid.mjs`.
- 생성 산출물: 이 디렉터리의 `hybrid-build/`. 기존 static server 18087에서 원래 후보와 함께 제공한다.
- 타입 확인: `pnpm exec tsc -p apps/web/design/tsconfig.json --noEmit`.
- 일반화한 시안 비교 Skill의 예제·목적은 바꾸지 않았다. 이 통합안은 GCR 프로젝트 설계에만 저장한다.

검증 결과와 screenshot·hash는 `hybrid-checks.json` 및 `images/hybrid-*.jpg`에 기록한다. 실제 제품 반영·배포, 운영 PR 데이터, 모델 실행, Extension Host 검증과는 구분한다.

## 2026-09-28 제품 반영

사용자가 commit·push·build·publish를 요청해 C5 token과 U1 코멘트 헤더, U2 목적지 rail을 실제 제품에 반영한다. 위의 “제품을 바꾸지 않았다”는 2026-09-27 시안 작성 당시의 상태다. `hybrid-build/`와 `hybrid-checks.json`, screenshot은 당시 합성 fixture 검증을 그대로 보존하며 운영 검증으로 대체하지 않는다.

제품은 `apps/web/src/theme.css`의 semantic token을 공유한다. `ReviewReportPanel`의 severity 옆 띠·그림자를 제거하고 metadata 헤더와 본문·별도 수정 제안 박스를 유지한다. 실제 `ReviewDiff`의 Split/Unified, snapshot·행 번호, 인라인 의견·행 이동, 파일·Outline·Impact, Chat, Summary·하단 도구, revision 선택과 기존 크기 조절을 재사용한다. 인라인 의견 본문도 기존 안전한 `ReviewMarkdown`으로 렌더링한다. 목적지 rail은 980px 이하에서 숨기고 기존 상단 탐색을 이용한다.

리뷰 관측은 필터 toolbar·집계·구획을 구분선으로 나누고 반복 외곽 박스를 줄인다. 이력은 선택 행의 옆 띠를 제거하며 원문·답글·본문 버전·출처 구조를 유지한다. API·모델·계정·권한·사용자 설정·package dependency는 변경하지 않는다. MUI의 탐색 구조를 참고해 기존 React/CSS로 구현하며 새 UI framework는 설치하지 않는다.

제품 검증과 게시·배포 결과는 `docs/operations/review-ui-c5-2026-09-28.md` 및 연결된 증거에 기록한다. 시안의 실제 제품 import를 다시 build하면 해당 시점의 컴포넌트를 사용하므로 기존 fixture hash와 구분해 기록해야 한다.

# Review Markdown·block 이동·Chat 검증 — 2026-09-08

구현 commit은 `d8ea3c1`이다. 이번 변경은 Web UI에 한정하며 Server/Worker contract, DB schema, 모델·GHES 설정을 변경하지 않았다. PRISM-DEV 재배포는 이번 요청에 포함되지 않아 수행하지 않았다. 클러스터는 source `74cdc05`, application `0.8.0-alpha.12`, Helm revision 22 배포 기록을 유지한다.

## 구현

- `ReviewMarkdown.tsx`: PR 전체 요약·파일 요약·Comments의 문제/영향/수정 제안을 CommonMark·GFM으로 렌더링한다. 제목, 강조, 목록, 표, fenced code, inline code, task list를 지원한다. Raw HTML을 실행하지 않으며 위험 URL을 필터링하고 외부 image는 alt text로 대체한다. Markdown component·plugin 정의는 안정된 참조를 유지하고 같은 text는 memo로 재사용한다. 기존 report 본문은 재작성하지 않는다.
- `review-block-navigation.ts`: 파일 요약과 Comment article 본문·여백을 기존 `onFindingSelect`/`onFileSelect`에 연결한다. 내부 link/button/summary/control, 텍스트 선택과 modifier 클릭은 제외한다. Keyboard는 기존 native button을 그대로 사용한다. PR 전체 요약에는 임의의 파일 anchor를 만들지 않는다.
- `ChatPanel.tsx`: App에서 기존 component를 분리했다. Account·Model·Effort를 입력창 다음 DOM 위치로 옮겼다. 본문·입력·select 14px, header 15px, 입력창 5줄·최소 140px다. 400px 이하 panel에서는 Account를 별도 줄로 배치하고 mobile Chat 최소 높이는 560px다. Session·draft·전송 handler는 기존 App의 것을 그대로 사용한다.

Renderer 선택과 보안 설정은 [react-markdown 문서](https://github.com/remarkjs/react-markdown)와 [remark-gfm 문서](https://github.com/remarkjs/remark-gfm)를 기준으로 했다. HTML을 직접 주입하는 경로는 추가하지 않았다.

## 확인 결과

| 항목 | 결과 |
| --- | --- |
| 정적 검사 | ESLint, 전체 workspace TypeScript 검사, Web production build, 변경 source Prettier 검사, git diff 검사 통과 |
| 자동 테스트 | 전체 202건 통과 / DB integration 22건 skip, 42 files 중 38 passed / 4 skipped. 이번 작업에서는 별도 integration DB를 띄우지 않음 |
| Web 회귀 | 27건 통과. 신규 6건은 Markdown 구조·XSS/image 차단, block 이동 예외, Chat DOM 순서·로딩·오류·비활성·pending 상태를 검증 |
| Markdown 표시 | 합성 report의 heading, strong, 목록, 표와 fenced code를 실제 Browser DOM과 desktop screenshot으로 확인 |
| Block 이동 | 파일 요약 본문과 Comments 본문 클릭 모두 Code로 전환되고 `data-selected-line=10` 확인. 파일 요약 접기는 Summary에 머물며 정상 동작 |
| Chat 입력 | Shift+Enter 줄바꿈, Effort 변경 시 draft 유지, Enter로 합성 전송 handler 실행과 draft 초기화 확인. 실제 모델 호출 없음 |
| 반응형 | 1440×1000, 1000×800, 390×844에서 문서 가로 overflow 없음. 입력창 실측 140px·본문 14px, selector가 composer 아래에 있음. Mobile selector 2열·Chat 높이 560px 확인 |
| Browser 오류 | 의미 있는 내용과 control이 렌더링되고 Vite 오류 overlay·Browser error 없음 |

Browser 검증은 실제 React component와 CSS를 사용한 loopback 합성 harness에서 진행했다. 실제 로그인·GHES API·모델·PR 게시 E2E는 수행하지 않았다. Desktop 증거는 `.impeccable/review/markdown-chat-desktop.png`다. Mobile은 DOM·계산된 배치로 확인했으며 Browser의 element screenshot에서 올바른 영역이 캡처되지 않아 그 파일은 증거로 남기지 않았다. 검증용 Browser·Vite와 임시 harness는 종료·삭제했다.

Impeccable 검토는 기존 gray/teal 스타일, Korean/English 개발 용어, native control과 focus 순서를 유지하는 범위로 적용했다. 최종 detector의 warning 4건은 기존 3px 측면 border이며 변경한 규칙이 아니다. 사용자 참조 화면의 severity 표시와 기존 admin/inline 스타일을 유지했다. 새 구조의 overflow·grid 오류는 확인되지 않았다.

Build의 기존 Zod annotation warning과 500kB 초과 chunk warning은 실패가 아니다. 새 Markdown parser를 포함한 JS bundle은 636.66kB, gzip 187.70kB다. Parser를 가벼운 자체 regex 구현으로 되돌리지 않았으며 route별 code splitting은 이번 범위에 포함하지 않았다.

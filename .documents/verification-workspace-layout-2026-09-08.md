# Workspace 배치 검증 — 2026-09-08

## 범위와 환경

사용자가 요청한 8개 UI 항목을 기존 gray/teal workspace에 반영했다. 선행 구현 commit은 `6224ee6`이며 최종 보완·가이드·검증 기록은 후속 commit에 포함한다. Server/Worker 분석 contract, DB schema, 모델 설정, GHES credential과 PR 게시 설정은 변경하지 않았다. 이번 작업은 commit·push까지이며 PRISM-DEV는 기존 Helm revision 21, source `d9f9418` 상태다.

Web production build를 loopback HTTP server로 제공하고 동일 origin의 API 응답만 합성 fixture로 대체했다. 화면의 `org-name/repo-name`, PR #42, account·model·comment는 UI 검증용이다. 실제 GHES·모델 호출, Chat 전송, PR 댓글 게시는 수행하지 않았다. Integration test는 별도 PostgreSQL 16 container의 tmpfs DB에서 실행했다.

## 요청별 확인

| 항목 | 구현과 확인 근거 |
| --- | --- |
| Files 기본 펼침 | 모든 ancestor를 펼치고 사용자가 접은 경로만 기억한다. 서로 다른 최상위 폴더·중첩 폴더의 모든 파일이 최초 render에 존재한다. Static render test와 browser tree에서 확인했다. |
| LNB toggle | 메인 toolbar의 버튼이 `aria-expanded`와 `aria-controls`를 제공한다. 숨김 상태에서 panel과 separator가 사라지고 Main이 넓어진다. 다시 표시해도 ‘모두 접기’ 상태가 보존됐다. |
| Chat 너비 | 기본 569px로 기존 316px의 약 1.8배다. 1440px viewport에서 LNB 244px, Main 627px, Chat 569px를 확인했다. 1000px에서는 180/360/460px로 제한하고 화면을 넓히면 저장된 크기로 돌아왔다. |
| Comments 이동 | 메인은 Code·Summary만 제공한다. 하단 Comments가 Evidence를 대체하며 상세 문제·영향·수정 제안, 코드 이동, 위치 확인·GHES 원문을 제공한다. FNB 기본 높이는 border 포함 280px다. Summary 안의 상세 comment block 수는 0이다. |
| Summary 순서 | PR 전체 요약이 파일별 검토보다 앞에 나온다. 파일별 details는 모두 open이다. 600자보다 긴 전체 요약도 접지 않는다. 별도 total-summary가 없는 report에는 누락 안내를 표시한다. |
| 기본 inline comment | 선택하지 않은 상태에서 현재 파일의 head·mergeBase comment 2개와 marker 2개가 표시됐다. Split·Unified static render, 같은 line의 복수 의견, 다른 파일 제외, file-level·diff 밖 anchor를 test했다. |
| Diff 강조 | Comments에서 mergeBase line 42로 이동했을 때 selected line은 1개였다. 범위의 각 줄에 outline을 반복하지 않는다. +/− 배경과 양쪽 line 번호를 보존한다. |
| Comment 너비 | inline block의 최대 너비는 880px이며 좁은 화면에서는 좌우 합계 48px 여백을 둔다. 긴 설명은 줄바꿈하고 코드 diff와 별도로 읽는다. |

## 회귀·접근성 확인

- `pnpm lint`, `pnpm typecheck`, Web production build, 수정한 source의 Prettier 검사, `git diff --check` 통과.
- `GCR_TEST_DATABASE_URL`을 isolated local DB로 지정한 전체 suite: **218 tests / 39 files, skip 없음**.
- Browser: 2048×1197, 1440×1000, 1000×800, 390×844에서 배치·문서 가로 overflow를 확인했다. 1440·1000·390px에서 문서 가로 overflow가 없었다.
- Chat separator에서 ArrowLeft로 569→585px, 하단 separator에서 ArrowUp으로 280→296px를 확인했다. Home으로 기본 크기를 복원했다. 저장값 v1의 이전 기본값만 v2로 이전하며 직접 조절한 값은 유지하는 unit test가 있다.
- Main → Comments → Chat 순으로 DOM을 배치해 모바일의 화면 순서와 Tab 이동 순서를 맞췄다. 숨겨진 LNB는 focus 대상에서 제외되며 toggle은 남는다. 모바일에도 Comments·Git graph·Impact·Tests label을 표시한다.
- 기존 `tool=evidence` deep link는 Comments로 해석한다. Finding link는 analysis revision·side·line을 유지한다.
- 정상 상태에 browser error가 없었다. 빈 report는 전체 요약 누락·comment 없음 안내, 분석 중에는 진행 banner와 Comments 대기 안내를 표시했다. Snapshot API의 의도적인 503에는 Code 오류와 하단 재시도 안내가 표시된다.
- 가이드에서 569px/280px, panel toggle, FNB Comments, 펼침 기본값, line 이동과 기본 inline 표시 안내를 확인했다.
- Vite build의 Zod `@__PURE__` annotation 경고는 기존 dependency 경고이며 build 실패가 아니다.

## Layout·polish 검토

Impeccable의 layout 지침에 따라 Code·Summary의 읽기 영역, 상세 Comments, revision-bound Chat을 분리했다. 기존 palette·서체·severity는 유지했다. Source assessment 뒤 layout scan을 실행했으며 결과는 `[]`였다. 변경 후 scan도 `[]`다. 연관 정보는 PR/파일/의견으로 묶고 panel별 독립 scroll을 유지한다. 긴 전체 요약은 Main에서, 긴 상세 의견은 FNB와 inline 영역에서 읽는다. Empty/error/pending 상태는 각 영역에 남아 주변 탐색을 막지 않는다. 실제 운영 report의 전량 렌더링 부하나 screen reader의 음성 출력까지 측정한 결과는 아니다.

검토 과정에서 모바일 tab label 숨김과 Split/Unified control 축소를 보완했다. 넓은 화면과 모바일의 합성 fixture screenshot은 다음과 같다.

- `.impeccable/review/layout-wide-code.png`
- `.impeccable/review/layout-desktop-summary.png`
- `.impeccable/review/layout-mobile-code.png`
- `.impeccable/review/layout-mobile-summary.png`

검증용 Browser·loopback server·PostgreSQL container는 작업 종료 시 정리한다. 임시 fixture와 중간 screenshot은 삭제하며 위 screenshot과 이 기록만 repository에 보존한다.

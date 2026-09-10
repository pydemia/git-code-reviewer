# 개인 Prompt 검증 기록 — 2026-09-08

프로필에서 본인의 Review Chat 지침을 편집하는 기능을 검증했다. Backend `f06d329`, UI·문서 `41febd2`를 push했고 후속 요청으로 PRISM-DEV application `0.8.0-alpha.14` / Helm revision 24에 배포했다. 아래는 개발 검증 기록이며 배포 검증은 [PRISM-DEV 배포 문서](../deploy/environments/prism-dev/README.md)에 별도로 기록한다.

## 구현 범위

기준은 [제품 정의](../PRODUCT.md), [기능설계서 5.10](functional-design.md#510-chat), [인계 기록의 개인 Prompt 절](handoff.md), [PersonalPromptForm](../apps/web/src/PersonalPromptForm.tsx), [ProfilePage](../apps/web/src/ProfilePage.tsx), [스타일](../apps/web/src/styles.css)이다.

프로필 정보와 비밀번호 변경 사이에 8줄 textarea, 최대 4,000자 표시, 저장·내용 비우기를 추가했다. 저장한 지침은 기존 대화를 포함해 본인의 다음 Chat 질문부터 적용되며 공동 PR 분석·게시와 다른 사용자에게 적용되지 않는다. 내용 비우기는 초안만 지우고 저장해야 해제된다. 저장 중에는 입력과 버튼을 잠그고 실패하면 초안을 유지하며 오류 알림으로 focus를 옮긴다.

## 기존 디자인 유지

기존 프로필 화면의 국소 확장으로 처리했다. 회색 바탕·흰색 작업 영역·teal action, Noto Sans KR 기반 서체, 섹션 사이 구분선과 간격을 계승한다. 편집기는 기존 surface·text·border·accent 변수를 사용하며 공통 command button, 알림, keyboard focus 스타일을 재사용한다. 모바일에서도 기존 한 열 배치와 전체 너비 버튼을 따른다.

새 시각 체계나 재사용 token을 도입하지 않아 [DESIGN.md](../DESIGN.md)와 [design.json](../.impeccable/design.json)은 변경하지 않았다. Impeccable의 기존 화면 확장 지침에 따라 기능별 상태와 검증 결과만 이 문서에 기록했다.

독립 finish review의 판정은 이번 개인 Prompt UI 범위에서 `ship`이다. Typography·material·ground·layout·states·a11y가 기존 기준에 일치하며 수정 요구는 없었다. Detector는 새 영역에서 경고를 발견하지 않았고 기존 다른 영역의 3px 측면 border 경고 4건은 유지했다.

## 검증 결과와 화면 증거

아래 실행 결과는 구현·검증 세션과 독립 finish review의 인계 결과이며 문서화 과정에서 다시 실행하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 자동 테스트 | 312 tests / 52 files 통과, skip 0 |
| 실제 DB integration | 격리된 로컬 PostgreSQL 16에서 migration 18개 적용·재실행, 사용자 분리, 재연결 후 영속성, 원문 없는 audit, 최대 길이와 해제 확인 |
| 정적 검사·빌드 | ESLint, 전체 TypeScript, Web production build 통과 |
| Browser 동작 | 실제 ProfilePage + 합성 API로 저장·재조회, 실패 시 초안 유지·alert focus, 저장 전 비우기의 비영속성, 저장 후 해제 확인 |
| 반응형·오류 | 1440×1000·390×844 두 viewport 모두 가로 overflow 없음, Browser 오류 0건 |

기존 full-page 캡처 두 장을 확인했으며 추가 촬영하지 않았다. 화면의 사용자와 Prompt는 합성 검증 데이터다.

- [Desktop — viewport 1440×1000](../.impeccable/review/profile-prompt-desktop.png)
- [Mobile — viewport 390×844](../.impeccable/review/profile-prompt-mobile.png)

## 검증 한계

Browser의 합성 API 검증과 실제 PostgreSQL integration은 별도로 수행했다. 실제 서버·DB를 연결한 Browser E2E 결과는 아니다. 개발 검증에서 실제 LLM·GHES 호출과 클러스터 배포는 수행하지 않았으므로 이 검증만으로 모델의 개인 지침 준수 정확도나 배포 성공을 입증하지 않는다. 후속 배포에서는 migration·workload·health·인증 차단·Web asset 일치를 확인했으며 실제 모델 호출은 실행하지 않았다. 접근성 판정은 제공된 화면·구현·상태 동작의 검토 범위다.

기존 Zod annotation·500kB bundle warning은 남아 있다. PRISM-DEV에는 migration `0018_personal_chat_prompt.sql`이 적용됐고 기존 사용자 7명의 Prompt는 빈 값으로 유지됐다.

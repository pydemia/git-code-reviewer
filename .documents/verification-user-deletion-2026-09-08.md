# 사용자 삭제 검증 기록 — 2026-09-08

관리자 사용자 목록에서 계정을 삭제하는 기능을 검증했다. Backend `7a38da4`, UI·가이드 `47770d4`를 push했고 PRISM-DEV application `0.8.0-alpha.15` / Helm revision 25에 배포했다. 이 문서는 개발 검증 결과이며 배포 검증은 [PRISM-DEV 배포 문서](../deploy/environments/prism-dev/README.md)에 별도로 기록한다.

## 구현 범위

기준은 [제품 정의](../PRODUCT.md), [사용자 관리 설계 6절](local-account-authentication.md#6-사용자-삭제-2026-09-08), [AdminPage](../apps/web/src/AdminPage.tsx), [UserDeleteDialog](../apps/web/src/UserDeleteDialog.tsx), [스타일](../apps/web/src/styles.css)이다.

사용자 행의 관리 영역에 휴지통 버튼을 추가했다. 확인창에는 대상 계정, 로그인·권한 회수 범위, 개인 Chat의 retention과 공동 기록 보존, 같은 username·Subject의 재등록 제한을 표시한다. Local username 또는 외부 Subject를 입력해야 삭제할 수 있으며 확인값의 앞뒤 공백을 제거한 뒤 일치 여부를 검사한다. 현재 로그인한 계정의 삭제는 UI와 서버에서 막는다.

확인창은 기존 native dialog 방식을 따른다. 처음 열면 취소 버튼에 focus를 두고 요청 중에는 입력·닫기를 잠그며 중복 제출을 막는다. 실패하면 확인값을 유지하고 dialog 내부 alert로 focus를 옮긴다. 취소·Escape로 닫으면 실행 버튼으로 돌아가며 성공하면 목록에서 해당 행을 제거하고 사용자 heading으로 focus를 옮긴다.

서버는 migration `0019_user_deletion.sql`의 `deleted_at`으로 삭제를 기록한다. 모든 세션, Local password hash, 개인 Prompt, group claim과 직접 repository grant를 정리하고 tenant membership을 비활성화한다. 사용자 row·identity, 개인 Chat, 공동 PR report·분석 설정의 참조와 audit은 보존한다. 개인 Chat은 다른 사용자에게 이전하지 않고 기존 retention을 따른다. 같은 identity는 다시 등록하거나 bootstrap·외부 로그인으로 복원할 수 없다. 외부 Identity Provider의 원본 계정은 변경하지 않는다.

## 기존 디자인 유지

Operate 화면인 기존 Admin Users의 국소 확장으로 처리했다. 회색 바탕·흰색 작업 영역·teal action과 선택 상태, Noto Sans KR 기반 서체, 조밀한 사용자 행을 계승한다. 삭제 버튼은 기존 icon button과 Lucide 아이콘을 쓰며 확인창은 기존 dialog의 크기·테두리·그림자·backdrop, label/input, 취소·danger command button과 keyboard focus 스타일을 재사용한다.

새 palette·서체·재사용 token·시각적 구성 규칙을 도입하지 않아 [DESIGN.md](../DESIGN.md)와 [design.json](../.impeccable/design.json)은 변경하지 않았다. Impeccable의 문서화 handoff에 따라 이번 기능의 상태·반응형 수정·검증 범위만 이 문서에 기록했다.

독립 finish review에서 모바일 가로 overflow(F1)와 중간 너비에서 삭제 버튼이 잘리는 문제(F2)를 발견했다. 사용자 표에 가로 scroll을 허용하고 표 내부 switch의 위치 기준을 지정하는 CSS 두 규칙을 적용했다. 후속 verdict는 `ship`이며 F1·F2 두 finding을 resolved로 판정한 범위다. Detector는 한 번 실행했으며 기존 다른 영역의 3px 측면 border 경고 4건만 남았다.

## 검증 결과와 화면 증거

아래 실행 결과는 구현·검증 세션과 독립 finish review에서 인계받았다. 문서화 과정에서는 소스와 기존 캡처를 확인했으며 테스트·Browser 동작을 다시 실행하거나 화면을 재촬영하지 않았다.

| 검증 | 결과 |
| --- | --- |
| 전체 자동 테스트 | 323 tests / 54 files 통과, skip 0 |
| 실제 DB integration | 격리된 로컬 PostgreSQL 16에서 migration 19개 적용·재실행. 신규 7개 테스트로 삭제 후 권한 회수·재로그인 차단, 관리자 동시 변경, audit 실패 시 rollback 등을 확인 |
| 정적 검사·빌드 | 전체 TypeScript, ESLint, Web production build 통과 |
| Browser 확인값 | 실제 사용자 목록·삭제 dialog 컴포넌트와 합성 API로 빈 값·불일치 시 삭제 비활성화, 정확한 identity 입력 후 제출 가능 확인 |
| Browser 실패·취소 | HTTP 503 실패 시 확인값 유지·alert focus, Escape로 닫은 뒤 실행 버튼 focus 복원 확인 |
| Browser 성공 | HTTP 204 성공 시 사용자 행 2개 → 1개, 사용자 heading focus, 해당 성공 시나리오의 삭제 요청 1회 확인 |
| Desktop | viewport 1440×1000에서 확인창 내용·입력·action 배치 확인 |
| Mobile | viewport 390×844에서 document·body 너비 모두 390px. 확인창 문구와 action이 화면 안에 표시됨 |
| 중간 너비 | viewport 1024×900, 사용자 표 너비 766px. 표 내부 가로 scroll 후 삭제 버튼 hit test 통과, document 너비 1024px 유지 |

기존 캡처 세 장을 직접 열어 확인했다. 화면의 계정과 오류 응답 제어는 합성 검증 데이터이며 실제 운영 사용자 삭제 장면이 아니다.

- [Desktop — 삭제 확인창, viewport 1440×1000](../.impeccable/review/user-delete-desktop.png)
- [Mobile — 삭제 확인창, viewport 390×844](../.impeccable/review/user-delete-mobile.png)
- [1024px — 표 내부 scroll 후 삭제 버튼 focus](../.impeccable/review/user-delete-1024.png)

## 검증 한계

Browser의 합성 API 검증과 실제 PostgreSQL integration은 별도로 수행했다. 실제 서버·DB를 연결한 Browser E2E 결과는 아니다. 개발 검증에서는 실제 운영 사용자를 삭제하거나 LLM을 호출하거나 GHES 데이터를 변경하지 않았다. 접근성 확인은 제공된 화면과 구현, 검증한 focus·입력·오류 동작 범위에 한정한다.

기존 Zod annotation·500kB bundle warning은 남아 있다. 후속 배포에서 PRISM-DEV migration 0019 적용·checksum, 신규 workload·health와 Web asset hash를 확인했다. 운영 사용자 7명은 유지됐으며 삭제된 계정은 0명이다. 운영 계정을 삭제하는 검증은 수행하지 않았다.

# PR 댓글 알림 등급과 보고서 파일 목록

PR 댓글의 최소 알림 등급을 저장소별로 설정한다. 기본값은 **P2 Warning 이상**, 다른 선택지는 **P3 Critical만**이다. 분석 강도, 모델·reasoning, 전체 보고서의 finding은 바꾸지 않는다. migration `0054_review_comment_min_priority.sql`은 기존 저장소에도 P2를 설정하며 게시 활성화 여부는 보존한다.

관리자 → GHES 연결 → 저장소 → PR 댓글 알림 등급에서 선택한다. 저장 성공/실패는 기존 메시지 영역에서 표시한다. 다음 정상 댓글 게시부터 적용하며 설정 변경 자체가 재분석이나 기존 댓글 갱신을 예약하지 않는다. 게시 도중 설정이 바뀌면 쓰기 직전 확인에서 재시도해 현재 값을 사용한다.

필터는 canonical artifact와 이전 형식의 댓글 경로에 모두 적용한다. 낮은 등급이 제외되면 전체 요약을 댓글에서 생략하고 파일 요약은 남은 의견에서 구성한다. 이전 지적 비교는 전체 보고서에서 확인한다. 필터 결과가 비어도 “문제없음”으로 판정하지 않으며 실제 분석 상태·커버리지·제한은 보존한다. 의견 없는 파일과 “분석 가능한 변경 line이 없습니다.” 안내는 사람이 읽는 목록과 Markdown에서 제외한다. 원본 JSON, 파일 탐색기, 저장된 분석 결과는 유지한다.

UI는 `reference-led-frontend`와 agent-skills의 `frontend-development` 지침에 따라 기존 GHES 저장소 설정 위치·native select·저장 메시지와 디자인 토큰을 재사용했다. 별도 배너·카드 화면이나 새 디자인 라이브러리를 도입하지 않았다. 출처는 기존 `AdminPage.tsx`의 저장소 설정과 승인된 `ReviewReportPanel.tsx` 구조다.

## 검증

- 보고서 UI·Markdown·게시 단위 테스트 36건 통과. P2 기본값, P3만 선택, 요약에 제외된 의견이 다시 나타나지 않는지, 원본 보존, 필터 결과 0건과 incomplete 상태를 확인했다.
- 독립 PostgreSQL의 저장소 lifecycle 통합 테스트 7건 통과. 기본값·조회·P3/P2 저장·잘못된 등급 거부·일반 사용자 쓰기 차단을 확인했다. 등급만 변경할 때 기존 polling/게시 설정과 job 수가 유지된다. 기존 정책에 따라 비관리자에게는 404를 반환한다.
- web/runtime typecheck, 변경 TypeScript ESLint, production build, Helm lint·연결 시험 통과. 기존 Vite의 큰 bundle 경고는 남아 있다.
- PRISM-DEV 기존 PR #1024의 실제 보고서: 1,045개 중 검토 완료 26개, finding 25개. 의견이 있는 파일 16개만 Summary에 표시된다. 빈 line 안내는 0개다.
- 실제 Chrome 1440px/420px에서 기본 P2 설정과 보고서를 확인했다. 설정 변경·재조회·저장 실패는 운영 화면의 API 응답만 대체해 검증했다. DB 저장은 앞의 독립 PostgreSQL 검사 근거를 사용한다. 운영 API의 설정 쓰기와 외부 PR 댓글 게시는 0회다.
- 보고서 화면이 자동으로 요청하는 기존 chat session 생성도 브라우저에서 차단했다. 보고서 screenshot의 chat 403은 이 읽기 전용 검사 때문에 발생한 표시다. 이를 운영 chat 기능 장애로 판정하지 않았다. 해당 요청을 예상하지 않은 첫 검사 assertion은 실패로 남기고 차단 사실을 기록하는 검사로 수정했다.
- 브라우저의 native popup 방향키 선택은 검증 완료로 간주하지 않았다. `selectOption`에 의한 값 전환과 focus/Tab 이동을 구분해 기록한다. 첫 스크립트는 Code 탭에서 Summary를 기다려 timeout됐고, 두 번째는 native 방향키 순서에서 timeout됐다. 두 시도 모두 검증 세션을 로그아웃했고 실패를 통과 수에 넣지 않았다.

## 배포와 보존

PRISM-DEV / `git-code-reviewer`: app `0.8.0-alpha.68`, chart `0.10.64`, Helm revision `78`. Server·Worker 새 deployment는 각각 Ready 1/1이다. 기존 Worker의 종료는 원래 drain/grace에 맡기고 강제로 삭제하지 않았다.

- 코드 commit: `d27f433` (보고서 목록), `c0f76ec` (알림 등급).
- 이미지 source: `e56f659`; 배포 pin: `66b12f8`.
- 이미지 digest: `sha256:8adef4f66a2b8d9f9ce9ece11047fe5aa35de1c89c130fd75931a91867559fd6`.
- OCI chart: `oci://registry-1.docker.io/pydemia/git-code-reviewer:0.10.64`.
- chart digest: `sha256:780f912781fc190b1c1af90fccb6332b9e7d93e4abe34dd1ee93582353b375ee`. 다시 받은 package는 원본과 byte 단위로 같다.

배포 전후 12개 보존 대상 테이블의 행 hash가 같다. 기존 migration 53개의 checksum도 같고 새 migration 1개만 추가했다. Helm values는 image tag/digest만 바뀌었다. DB는 TLSv1.3·verify-full을 유지한다. HTTP·HTTPS의 기존 로그인, HttpOnly/SameSite/Secure 속성, 로그아웃 후 401을 확인했다. 기존 계정과 사용자 설정은 변경하지 않았다. 검증 세션·Helm 시험 Pod·작업용 registry 인증 파일은 정리했다.

검증 자료와 화면은 `artifacts/operations/large-pr-1024-2026-09-19/`에 있고 재현에 필요한 hash·결과는 [기계 판독용 기록](evidence/pr-comment-priority-2026-09-19.json)에 보관한다. Commit Defender artifact·설치, Marketplace는 변경하지 않았다.

## 대형 PR 후속 계획

[구현 계획](../../.documents/large-pr-analysis-implementation-plan.md)은 저장된 #1024 snapshot을 읽고 현재 planner의 호출량을 계산한 결과다. 500개 파일·128회 호출 제한 때문에 일부만 검토됐으며 해당 실행에는 429 실패가 기록되지 않았다. 전체 파일 manifest, 영향 그룹·경계 검토, 내구성 있는 재개, 계정별 admission·backoff, 계층 요약을 commit 단위로 정리했다.

이번 변경은 의견 표시·알림 정책까지다. LP01~LP05 엔진 구현과 #1024 재분석은 수행하지 않았고 추가 모델 호출은 0회다. 전체 파일 검토 완료나 새로운 rate-limit 대응의 실효성을 확인했다고 표시하지 않는다.

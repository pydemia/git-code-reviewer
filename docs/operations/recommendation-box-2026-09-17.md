# 리뷰 이력의 수정 제안 박스와 재사용 프런트엔드 가이드

사용자가 선호한 기존 보고서의 수정 제안 디자인을 리뷰 이력 Markdown에도 적용했다. 원문에 명시된 `수정 제안` 제목·강조 구획만 기존 색상·테두리·여백으로 묶는다. 다음 섹션과 출처 링크는 박스 밖에 둔다. 저장 원문과 코드 라인 보고서의 기존 디자인은 유지한다.

원문 펼침, 본문 버전, 관측 snapshot과 미리보기에 적용했다. 기존 Markdown의 HTML·위험 URL·외부 이미지 차단을 유지한다. Markdown 4건, 실제 Chrome/독립 PostgreSQL의 이력 통합 10건, web typecheck·변경 TypeScript lint·production build·Helm lint를 통과했다. 기존 큰 bundle에 대한 Vite 경고는 남아 있다.

## 배포 확인

- PRISM-DEV / git-code-reviewer: app `0.8.0-alpha.67`, chart `0.10.63`, Helm revision `77`, deployed.
- 이미지 source: `36b251748701a2be54d06474d39b82e4920d747a`. 배포 pin commit: `0200941`.
- 이미지 digest: `sha256:e68fa38cf45261909cc39c85d0db7712083be46f09564243663ddd88764e887b`.
- OCI chart digest: `sha256:62b4059117dc5003d5714eedbbf2515e6effe10e4cbfaf3e3b7a4469c99f76ef`. 다시 받은 chart와 원본 package가 byte 단위로 같다.

Server·Worker deployment가 각각 Ready 1/1이며 Helm 연결 시험을 통과했다. 운영 Chrome에서 HTTP 주소로 PR #917 원문에 수정 제안 박스 19개가 렌더링됨을 확인했다. 1440px·420px 화면을 직접 확인했고 가로 넘침·JavaScript 오류·UI의 API 쓰기 요청이 없었다. PR #917·#915의 기존 이력을 조회했으며 추가 수집·실제 모델 호출은 하지 않았다.

HTTP·HTTPS 로그인, 쿠키 속성, 허용하지 않은 Origin 거부, 로그아웃 후 401을 확인했다. 배포 전후 확인 대상 12개 테이블의 행 hash와 migration 53개가 같고 DB는 TLSv1.3·verify-full을 유지한다. Helm values는 image tag/digest만 바뀌었다. 검증 세션과 Helm 시험 Pod, 작업용 registry 인증·Docker 설정·private values를 정리했다. 이전 worker는 기존 종료 유예에 맡겼다. 사용자 브라우저의 강제 reload는 하지 않았다.

화면은 `artifacts/operations/recommendation-box-2026-09-17/recommendation-desktop.png`와 `recommendation-mobile.png`에 보관했다. [기계 판독용 근거](evidence/recommendation-box-2026-09-17.json)에 package·screenshot hash와 검증 결과를 기록했다.

## 프롬프트와 스킬

`agent-skills`의 `codex/reference-led-frontend` 브랜치에 별도로 저장했다. source commit은 `c7a7beb`, 생성 결과 commit은 `af229fb`다. 기존 checkout과 사용자가 작성한 미추적 `prompts/`를 보존하기 위해 별도 worktree를 사용했다.

- 프롬프트: `prompts/reference-led-frontend.md`
- 스킬: `skills/reference-led-frontend/SKILL.md`
- 편집 원본: `library/references/reference-led-frontend-prompt.md`, `reference-led-frontend-skill.md`

실제 reference 선택과 적용 근거, agent-skills의 설계·publishing·frontend 단계 연결, 기존 컴포넌트 재사용, 의미 없는 배너·패널·박스 반복 방지, 승인된 수정 제안 박스 유지, Markdown·상태·접근성·실제 브라우저 검증 기준을 담았다. 모든 제품에 GitHub 화면이나 수정 제안 박스를 강제하지 않는다.

원본 검증·export 일치 검사를 통과했고 저장소 테스트는 20개 통과·3개 skip·실패 0개다. skip은 환경을 지정하지 않은 Codex discovery와 Windows 전용 검사다. skill-creator validator도 통과했다. 로컬 `~/.codex/skills/reference-led-frontend`에 선택 설치했으며 export와 설치본의 SHA-256이 일치한다. 새 세션에서 `$reference-led-frontend`로 호출할 수 있도록 저장했으며 현재 열린 세션의 스킬 목록 갱신이나 UI 선택까지 검증했다고 주장하지 않는다.

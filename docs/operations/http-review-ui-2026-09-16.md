# HTTP 로컬 로그인과 리뷰 화면 재배포

사용자가 요청한 HTTP 접속 지원과 리뷰 이력·리뷰관측 재설계를 함께 반영했다. 로컬 계정과 비밀번호, 데이터, TLS 설정을 유지한다. `agent-skills`의 `product-ui-ux-design`과 `web-publishing`을 적용했으며 [참고 자료와 화면 결정](../../.documents/review-ui-redesign-2026-09-16.md)에 실제 확인한 GitHub PR comments·Primer Timeline 자료를 기록했다.

## 변경 사항

리뷰 이력은 왼쪽 PR 탐색과 오른쪽 대화 스레드로 구성했다. 작성자·시각·코멘트 종류·파일 위치·답글 관계를 본문과 구분한다. 원문은 해당 코멘트 안에서 펼치며 본문 버전·관측 이력·출처 지침은 필요한 때 열 수 있다. 제목은 불러온 목록에서 검색하고 PR 번호는 기존 reader API로 전체 저장 이력에서 조회한다. 첫 페이지 밖의 과거 PR도 URL과 번호로 바로 열린다. 새 수집이나 분석을 요청하지 않는다.

기존 Markdown 렌더러로 원문·본문 버전·관측 snapshot의 표·코드·목록·인용·링크를 표시한다. 원문 텍스트도 확인할 수 있다. raw HTML·위험 URL을 실행하지 않고 외부 이미지도 자동으로 요청하지 않는다. 원문을 읽는 데 지침 승인 절차를 추가하지 않았다.

리뷰관측은 기간·저장소와 핵심 집계, PR별 최신 상태, 기준 판단, 실행·발행·다운로드 기록의 순서로 재구성했다. 집계 범위·비교 불가·미관측·partial·실패를 유지하며 분석 완료를 결함 해결로 표시하지 않는다. 모바일에서는 한 열로 바뀐다.

HTTP 로그인은 `auth.local.httpOrigin: http://pr-review.prism.ai`를 명시해 허용한다. HTTPS는 기존 Secure 쿠키, HTTP는 별도 HttpOnly 쿠키를 사용한다. Origin 누락·다른 Origin은 계속 거부하고 프록시 header를 신뢰해 허용 주소를 넓히지 않는다. DB TLS와 인증서를 유지하며 HTTPRoute에 일괄 redirect를 추가하지 않는다. [설정과 한계](http-local-access.md)를 따른다. HTTP에서 사용할 수 없는 `crypto.randomUUID()` 호출은 기존 `browserUuid()`로 대체했고 클립보드 미지원 시 수동 복사 안내를 표시한다.

## 검증

- HTTP 설정·로컬 세션·기존 인증·config 회귀: 54개 통과. SAML·client credential 회귀: 46개 통과.
- 이력·관측 API/실제 Chrome·profile·Markdown: 33개 통과. HTTP UUID 기존 테스트 3개 통과. 중복 실행을 제외한 합계 136개다.
- Chrome 통합 검증은 독립 PostgreSQL의 합성 PR로 Markdown 표·코드·답글·수정 이력, 외부 이미지/HTML 억제, 목록 검색, 첫 페이지 밖 PR의 URL·번호 조회, 관리자 지침 활성화·reader 쓰기 UI 차단, API 장애 표시, desktop/mobile overflow를 확인했다. 시험 DB는 종료 후 삭제했다. 운영 데이터에 시험 지침을 발행하지 않았다.
- Runtime·web typecheck, 변경 TypeScript ESLint, web production build, Helm lint/render를 통과했다. 잘못된 HTTP hostname은 Helm과 runtime 설정 검사에서 거부한다.

첫 alpha.65 운영 점검에서 PR #917이 첫 20건 밖에 있는 경우 직접 열리지 않는 문제를 확인했다. 기존 번호 조회 API를 연결하고 해당 조건을 브라우저 회귀에 추가한 alpha.66을 최종 배포한다. 초기 배포용 Secret의 bootstrap 비밀번호는 현재 admin 비밀번호와 달라 첫 로그인은 401이었다. 비밀번호를 초기화하지 않았으며 이전에 사용자가 제공한 현재 비밀번호로 HTTP·HTTPS 로그인과 세션 폐기를 검증했다. 비밀번호·쿠키·세션 토큰은 기록에 포함하지 않는다.

## 배포 및 운영 결과

| 항목                        | 최종 결과                                                                 |
| --------------------------- | ------------------------------------------------------------------------- |
| 환경                        | PRISM-DEV / git-code-reviewer                                             |
| app / chart / Helm revision | 0.8.0-alpha.66 / 0.10.62 / 76, deployed                                   |
| image source                | `1f39f00557eb308baf08576e0496c54b7364d30f`                                |
| 배포 pin source             | `ecd20537c2a0bb51cb9caa8512f55d5ce55c4166`                                |
| image digest                | `sha256:b9928071516c9101625eb162d3d66fc6ea2bbd684cd03f6fc9ea1573ae42cbbc` |
| OCI chart digest            | `sha256:564b7547c4b42e3e48fbf1a5cfa23d2701c28d859dac2e501bab22f157d79e5e` |

Linux amd64 이미지를 배포했고 OCI에서 다시 받은 chart와 원본 package가 byte 단위로 일치했다. 기존 Helm values에서 image tag/digest와 명시한 HTTP Origin만 바뀌었다. Server 1/1, Worker 1/1 deployment와 worker·sandbox 두 container가 Ready이고 Helm 연결 시험도 성공했다. 이전 worker의 종료는 기존 SIGTERM 유예에 맡겼으며 강제 삭제하지 않았다.

실제 외부 주소로 HTTP·HTTPS 로그인, `/api/v1/me`, 허용되지 않은 Origin 403, 로그아웃 204와 폐기 후 401을 확인했다. HTTPS는 개발 CA 검증을 유지했다. 두 방식 모두 기존 admin 계정을 사용했으며 비밀번호를 변경하지 않았다. HTTPS의 CD 자격증명 목록은 200, HTTP는 기존 보호대로 401이다.

운영 Chrome에서 실제 HTTP 주소(`isSecureContext=false`)로 PR #917의 전체 원문 Markdown과 리뷰관측 화면을 읽었다. PR #917은 저장 코멘트 46건·답글 10건, #915는 16건·답글 3건을 기존 API로 확인했다. desktop 1440px·mobile 420px에서 가로 넘침과 JavaScript 오류가 없고 UI가 만든 API 요청은 GET뿐이었다. 실제 화면 screenshot은 작업용 `artifacts/operations/http-review-ui-2026-09-16/`에 보관했고 hash를 근거에 기록했다.

기존 사용자 7명·chat account 7건·analysis 192건·report 184건·review memory 5건 등 확인 대상 12개 테이블의 행 hash가 보존됐다. migration 53개와 checksum이 같고 DB 실제 세션은 TLSv1.3·verify-full이다. Secret 12개, PVC 2개, HTTPRoute 4개의 UID·데이터/연결이 유지됐다. ConfigMap 7개 중 runtime 설정에 `LOCAL_HTTP_ORIGIN`만 추가됐다. 별도 identity release revision 2와 인증서도 유지했다.

실제 모델 호출·추가 과거 수집·신규 PR·외부 댓글 게시를 하지 않았다. 검증 세션은 로그아웃 후 401을 확인했고 독립 시험 DB·Helm test Pod·작업용 registry 인증 파일·Docker config·private Helm values를 정리했다. 사용자 브라우저·VS Code를 강제로 reload하지 않았다. CD 2.12.6 설치본과 공통 client artifact 버전은 이번 서버/UI 수정에서 변경하지 않았다.

[기계 판독용 검증 근거](evidence/http-review-ui-2026-09-16.json)에 source·package hash, 로그인 결과, 배포 상태와 보존 검사를 기록했다.

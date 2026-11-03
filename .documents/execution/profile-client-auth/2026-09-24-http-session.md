# HTTP 프로필 접근과 Commit Defender 연결 수정

PRISM-DEV에서 `yjkim1`은 활성화된 `administrator` 계정이다. 사용자 로그인 직후 실제 Chrome에서 메인 화면·관리 메뉴가 열리는 반면 `내 프로필` 클릭은 `/login?returnTo=%2Fprofile`로 되돌아가는 증상을 확인했다.

HTTP 로컬 로그인은 기존에 허용된 `LOCAL_HTTP_ORIGIN`과 `gcr_http_session`을 사용한다. 일반 인증과 프로필 API는 이를 인정하지만, 프로필의 클라이언트 키 목록 API는 `gcr_session`만 요구했다. 이 API가 반환한 401을 공통 프런트엔드 API 함수가 로그인 만료로 처리하면서 프로필 화면 전체를 이동시켰다. 관리자 권한 문제가 아니며 비밀번호·권한 변경은 필요하지 않다.

키 발급·철회에도 같은 불일치가 있었다. 별도 Origin 검사가 HTTPS `PUBLIC_BASE_URL`만 인정했고, 발급 시 재인증에는 HTTPS 쿠키만 전달했다. 이제 이 경로들이 일반 인증과 동일한 `browserSessionCookie` 및 `isAllowedBrowserOrigin`을 사용한다. HTTP 허용 범위는 기존에 명시한 local origin으로 제한하며, SAML·HTTPS·Bearer 분리·저장소 권한·세션 재인증·CSRF 검증은 유지한다. 내려받는 연결 설정의 서버 주소는 기존 HTTPS 주소와 CA·공개 검증키를 유지한다.

기존 `ProfilePage`와 `ClientCredentialsPanel`의 화면·연결 절차를 재사용했다. 별도 메뉴나 새 인증 체계를 추가하지 않았다.

## 검증

- 수정 전 새 통합 테스트는 HTTP 세션의 키 목록 조회에서 `CLIENT_WEB_REAUTHENTICATION_REQUIRED`, 401로 실패했다.
- 수정 후 격리 PostgreSQL에서 client credentials, HTTP sessions, browser session 설정, profile 관련 35개 검사를 통과했다.
- 관리자와 일반 사용자 각각 HTTP·HTTPS 로그인 후 프로필, 키 목록, HTTPS 연결 설정 조회, 키 발급, Bearer 사용, 철회, 로그아웃 후 거부를 검사했다. HTTP 변경 요청에 stale HTTPS 쿠키가 함께 있어도 HTTP 세션을 사용한다.
- Origin 누락·외부 주소·다른 포트·`null`·위조 proxy header와 웹/API key 혼용을 거부한다. 기존 사용자·저장소 접근 경계 검사도 통과했다.
- Runtime typecheck, ESLint, Prettier, runtime build를 통과했다. 전체 package·runtime·web을 Linux amd64 image로 빌드했다. 격리 DB와 시험 키·세션은 시험 종료 시 제거했다.
- 실제 image를 network none·read-only filesystem으로 실행해 비 root 사용자, 정적 asset, 경로 이탈 거부, 이전 bundle 중복 및 build secret 미포함을 확인했다. Helm strict lint와 기존 manifest 비교도 통과했고 init·hook·retention을 포함한 7개 이미지 참조가 새 digest로 고정됐다.

## 배포와 운영 확인

- 제품 source: `29551cd7856009f8ea5f3890d1723e4a29df0edc`.
- 배포 pin: `0c265983f2f5a6e04f04f8fb3b3c9e5b3df4262c`.
- PRISM-DEV / git-code-reviewer: app `0.8.0-alpha.77`, chart `0.10.73`, Helm revision **85**, `deployed`.
- Image digest: `sha256:85b83130ecec44e376a01b6260b82722bb5966cb7550c23452e97f759f186bcb`.
- Chart OCI digest: `sha256:fda9977ea5aabaec69d3cc5ce2b2a1de4842eab18907e54e7529546c90f0ff4c`.
- Chart package SHA-256: `998a612c628e78c5b0f565748c9ae497fdd4f82619aad1235f4adc174862e591`. Registry에서 다시 받은 chart와 byte 단위로 일치했다.

새 server 1/1, worker 1/1과 worker·source-sandbox 두 container가 Ready다. Helm 연결 시험도 Succeeded다. HTTP·HTTPS startup/live/ready·system·profile HTML 및 클라이언트 인증 설정은 200이고 system version은 alpha.77이다. 인증 없는 profile·key 목록 API는 401로 거부했다. HTTPS 인증서 검증을 유지했다. 기존 worker는 종료 유예로 Terminating 상태였으며 강제로 삭제하지 않았다.

`yjkim1`이 직접 로그인한 기존 HTTP 세션으로 `내 프로필` 클릭과 새로고침 모두 `/profile`에 머무는 것을 확인했다. 관리자 프로필, Commit Defender 선택, 저장소 선택, API key 발급 양식과 기존 key 목록이 표시됐다. 선택한 저장소의 공개 연결 JSON 다운로드 버튼에서 성공 안내를 확인했다. 운영 key 발급·철회는 실행하지 않았으며 이 동작은 격리 통합 테스트로 검증했다. 다운로드 파일 원문의 byte 대조는 하지 않았다. 화면 캡처는 브라우저 도구의 시간 초과로 저장하지 못했으며 실제 DOM·화면 상태 확인과 구분한다.

배포 전후 17개 테이블의 전체 행 hash가 같다. 사용자 8명, local credential 7건, client key 8건, 보고서 272건, 분석 280건, 리뷰 메모리 10건, 작업 409건, 모델 요청 ledger 10,126건을 포함한다. migration 58개와 checksum도 같다. DB는 `verify-full`, 실제 세션 TLSv1.3를 유지한다.

기존 운영 Secret 12개와 identity release Secret 2개, ConfigMap 7개, PVC 2개, HTTPRoute 4개의 UID·data/spec을 보존했다. GCR의 Helm release 이력 갱신은 보존 대조에서 제외했다. identity release revision 2는 바뀌지 않았다. Helm user values는 `image.tag`와 `image.digest`만 변경됐다. 계정·비밀번호·개인 Prompt·클라이언트 설정을 변경하지 않았다.

Docker Hub 접속 시간 초과와 GitHub push 연결 실패는 재시도 후 완료됐다. 전역 Docker·Git 설정과 인증서는 변경하지 않았다. Helm watch 연결이 잠시 끊긴 뒤 복구되어 upgrade가 완료됐다. 실제 모델 호출·외부 PR 댓글은 0회다. 시험 PostgreSQL, Helm 시험 Pod, 임시 Helm values·manifest·Docker config를 정리했으며 사용자가 로그인한 브라우저 세션은 유지했다.

## 연결 위치

`내 프로필 → 클라이언트 연결`에서 Commit Defender와 저장소를 선택한다. API key를 발급하고 같은 저장소의 연결 JSON을 내려받은 뒤 CD의 Central Review Connection에서 JSON과 key를 각각 입력한다. 기존 링크 `설치·연결 절차와 사용 예시`도 같은 영역에 있다.

[검증 JSON](2026-09-24-evidence.json)에 버전·artifact hash·회귀와 운영 확인 결과를 기록했다.

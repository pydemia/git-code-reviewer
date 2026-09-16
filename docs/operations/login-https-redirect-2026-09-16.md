# 로그인 INVALID_ORIGIN 수정 — 2026-09-16

사용자가 로그인 화면의 “허용되지 않은 요청입니다.” 오류를 보고했다. Server 로그에서 `/auth/local/login` POST가 403으로 거절된 것을 확인했다. `PUBLIC_BASE_URL`은 `https://pr-review.prism.ai`인데 HTTP listener의 `git-code-reviewer-route`도 backend에 직접 연결되어 HTTP 로그인 화면을 제공하고 있었다.

빈 body로 재현한 결과 HTTP Origin은 403 `INVALID_ORIGIN`, HTTPS Origin은 주소 검사를 통과한 뒤 400 `INVALID_REQUEST`였다. 이는 비밀번호 검증 이전의 차단이다. 사용자 브라우저의 실제 URL은 직접 확인하지 않았으며, HTTP 접속에서 보고된 것과 동일한 메시지를 재현한 근거로 수정했다.

`deploy/environments/prism-dev/httproute.yaml`의 HTTP backend 연결을 HTTPS port 443으로 보내는 301 RequestRedirect로 교체했다. 같은 환경의 identity HTTPRoute와 같은 방식이다. Server-side dry-run과 diff를 확인한 후 PRISM-DEV에 적용했다. HTTPS route, 인증·Origin 검사, 비밀번호·계정·Secret은 변경하지 않았다. 이 route는 기존처럼 Helm release 외부의 환경 manifest로 관리한다. app alpha.64와 chart 0.10.60 / Helm revision 74를 그대로 사용하며 image 재빌드와 Helm 재배포는 필요하지 않다.

확인 결과:

- HTTP `/`와 `/login?returnTo=%2F`는 301로 HTTPS의 같은 경로·query에 이동한다. HTTPS 응답은 인증서 검증을 유지한 상태에서 200이다. 표준 HTTPS port 443은 Location에서 생략된다.
- HTTPS Origin의 빈 로그인 요청은 400 `INVALID_REQUEST`로 body 검증 단계에 도달한다.
- HTTP Origin과 외부 Origin은 여전히 403 `INVALID_ORIGIN`이다.
- Gateway가 새 route generation에 대해 Accepted·ResolvedRefs=True를 보고한다.

실제 비밀번호를 보내는 로그인이나 사용자 세션 생성은 수행하지 않았다. 이미 HTTP로 열려 있던 화면은 `https://pr-review.prism.ai/login`으로 새로 열고 기존 계정으로 로그인한다. 앞선 배포 검사에는 로그인 화면의 HTTP→HTTPS 경로 확인이 빠져 있었다. 이후 PRISM-DEV 배포 확인에는 위 redirect 및 로그인 Origin 검사를 포함한다.

[재현·수정 후 검증 근거](evidence/login-https-redirect-2026-09-16.json)

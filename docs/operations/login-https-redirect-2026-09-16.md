# 로그인 INVALID_ORIGIN 조사 — 2026-09-16

> 현재 상태: 아래의 일괄 HTTP→HTTPS redirect는 앞단 TLS 종료 구성을 보존하기 위해 철회했다. Envoy HTTP listener는 원래대로 GCR에 전달한다. 사용자 주소가 `http://pr-review.prism.ai/login?returnTo=%2F`임을 확인해 브라우저 HTTP Origin과 설정된 HTTPS public URL의 불일치가 확인됐다. 아래 초기 수정 기록은 이력으로 보존한다.

사용자가 로그인 화면의 “허용되지 않은 요청입니다.” 오류를 보고했다. Server 로그에서 `/auth/local/login` POST가 403으로 거절된 것을 확인했다. `PUBLIC_BASE_URL`은 `https://pr-review.prism.ai`인데 HTTP listener의 `git-code-reviewer-route`도 backend에 직접 연결되어 HTTP 로그인 화면을 제공하고 있었다.

빈 body로 재현한 결과 HTTP Origin은 403 `INVALID_ORIGIN`, HTTPS Origin은 주소 검사를 통과한 뒤 400 `INVALID_REQUEST`였다. 이는 비밀번호 검증 이전의 차단이다. 사용자 브라우저의 실제 URL은 직접 확인하지 않았으며, HTTP 접속에서 보고된 것과 동일한 메시지를 재현한 근거로 수정했다.

`deploy/environments/prism-dev/httproute.yaml`의 HTTP backend 연결을 HTTPS port 443으로 보내는 301 RequestRedirect로 교체했다. 같은 환경의 identity HTTPRoute와 같은 방식이다. Server-side dry-run과 diff를 확인한 후 PRISM-DEV에 적용했다. HTTPS route, 인증·Origin 검사, 비밀번호·계정·Secret은 변경하지 않았다. 이 route는 기존처럼 Helm release 외부의 환경 manifest로 관리한다. app alpha.64와 chart 0.10.60 / Helm revision 74를 그대로 사용하며 image 재빌드와 Helm 재배포는 필요하지 않다.

확인 결과:

- HTTP `/`와 `/login?returnTo=%2F`는 301로 HTTPS의 같은 경로·query에 이동한다. HTTPS 응답은 인증서 검증을 유지한 상태에서 200이다. 표준 HTTPS port 443은 Location에서 생략된다.
- HTTPS Origin의 빈 로그인 요청은 400 `INVALID_REQUEST`로 body 검증 단계에 도달한다.
- HTTP Origin과 외부 Origin은 여전히 403 `INVALID_ORIGIN`이다.
- Gateway가 새 route generation에 대해 Accepted·ResolvedRefs=True를 보고한다.

실제 비밀번호를 보내는 로그인이나 사용자 세션 생성은 수행하지 않았다. 이미 HTTP로 열려 있던 화면은 `https://pr-review.prism.ai/login`으로 새로 열고 기존 계정으로 로그인한다. 앞선 배포 검사에는 로그인 화면의 HTTP→HTTPS 경로 확인이 빠져 있었다. 이후 PRISM-DEV 배포 확인에는 실제 브라우저 주소·TLS 종료 위치와 로그인 Origin 검사를 포함한다. 앞단 TLS 종료 후의 HTTP listener에 일괄 redirect를 적용하지 않는다.

[재현·수정 후 검증 근거](evidence/login-https-redirect-2026-09-16.json)

## 앞단 TLS 종료 구성 확인과 redirect 철회

사용자가 `브라우저 HTTPS → 앞단 TLS 종료 → Envoy HTTP(80)` 구성을 알려 주었다. 이 경우 Envoy 80에서 일괄 HTTPS redirect를 하면 동일한 외부 HTTPS URL로 반복 이동할 수 있으므로 HTTPRoute의 backendRefs를 복원해 PRISM-DEV에 적용했다. 인증 guard·PUBLIC_BASE_URL·Secure 쿠키는 변경하지 않았다.

추가로 받은 실제 브라우저 URL은 `http://pr-review.prism.ai/login?returnTo=%2F`였다. 이 주소의 브라우저 Origin은 HTTP이며, 내부망 또는 중간 TLS 종료 여부와 무관하게 현재 HTTPS public URL과 일치하지 않는다. 현재 설정의 로그인 주소는 `https://pr-review.prism.ai/login?returnTo=%2F`다. HTTP 브라우저 로그인을 지원하도록 인증을 완화하거나 cookie의 Secure 속성을 제거하지 않았다.

Envoy HTTP 80에 `Origin: https://pr-review.prism.ai`, `X-Forwarded-Proto: https`로 보낸 빈 로그인 요청은 400 INVALID_REQUEST로 body 검증 단계에 도달했다. 따라서 내부 HTTP 전송 자체는 차단 원인이 아니다. HTTP·외부 Origin은 여전히 403 INVALID_ORIGIN이다. HTTP GET에는 redirect 없이 200을 반환한다. 실제 계정 로그인은 대신 수행하지 않았다.

인증 방식은 AUTH_MODE=local로 계정·비밀번호를 사용한다. Envoy 443의 직접 연결에서 확인한 서버 인증서는 `PRISM-DEV GCR Development CA` 발급, CN `auth.pr-review.prism.ai`, SAN `auth.pr-review.prism.ai`·`pr-review.prism.ai`, 만료 `2026-12-12T15:15:15Z`다. 공개 인증서 fingerprint는 Gateway Secret `envoy-gateway-system/git-code-reviewer-gateway-tls`의 tls.crt와 일치한다. 이는 Envoy 직접 HTTPS 경로의 인증서이며 별도 앞단 TLS 종료 장비의 인증서까지 확인했다는 뜻은 아니다. 사용자가 제시한 HTTP 브라우저 URL에서는 TLS 인증서가 사용되지 않는다.

[최종 경로·Origin 검증](evidence/upstream-tls-2026-09-16.json)

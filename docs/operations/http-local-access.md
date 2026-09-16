# HTTP 환경의 로컬 계정 로그인

TLS 종료 장비 뒤에서 GCR에 HTTP로 전달하는 구성은 `PUBLIC_BASE_URL`을 브라우저의 HTTPS 주소로 설정한다. 내부 전달 방식만으로 HTTPS 쿠키를 해제하거나 HTTPRoute를 강제로 redirect하지 않는다.

브라우저에서도 HTTP로 접속해야 하는 내부망은 로컬 계정 인증에 한해 추가 Origin을 명시할 수 있다.

```yaml
publicBaseUrl: https://pr-review.prism.ai
auth:
  mode: local
  local:
    httpOrigin: http://pr-review.prism.ai
```

런타임의 대응 환경변수는 `LOCAL_HTTP_ORIGIN`이다. 기본값은 비어 있으며 기존 HTTPS 전용 동작을 유지한다. HTTPS public URL과 같은 hostname의 정확한 HTTP Origin만 허용한다. 별도 포트는 명시할 수 있으나 경로·끝 슬래시·사용자 정보·query·fragment는 허용하지 않는다. Origin이 없거나 다른 주소인 상태 변경 요청은 계속 거부한다. `X-Forwarded-Proto` 또는 `Host`를 따라 허용 범위를 넓히지 않는다.

HTTPS 로그인은 `gcr_session`(Secure, HttpOnly, SameSite=Lax), HTTP 로그인은 `gcr_http_session`(HttpOnly, SameSite=Lax)을 사용한다. 서로 다른 이름을 사용하므로 이전 HTTPS 쿠키가 있는 브라우저에서도 HTTP 로그인이 가능하다. 로그아웃은 해당 세션을 폐기하고 비밀번호 변경은 기존과 같이 사용자의 모든 세션을 폐기한다. 계정과 비밀번호는 그대로 사용한다.

HTTP 로그인은 암호화되지 않은 연결이다. 인터넷 공개 환경에는 사용하지 않는다. SAML과 CD 연결용 자격증명 발급·회전은 HTTPS 세션을 계속 요구한다. DB TLS, HTTPS listener, 기존 인증서 설정은 변경하지 않는다. 해당 설정을 끄면 HTTP 쿠키 인증도 비활성화된다.

확인 항목:

- HTTP에서 로그인 후 리뷰 목록 조회·로그아웃이 가능한지 확인한다.
- HTTPS에서도 로그인하고 `gcr_session`의 Secure 속성이 유지되는지 확인한다.
- 앞단 TLS 종료 뒤 내부 HTTP 전달만 사용하는 환경은 `httpOrigin` 없이 HTTPS 로그인으로 검증한다.
- 허용하지 않은 Origin·누락 Origin의 상태 변경 요청이 403인지 확인한다.

PRISM-DEV에서는 `deploy/environments/prism-dev/values.yaml`에 HTTP Origin을 명시한다. 기존 HTTPRoute는 backend로 전달하고 HTTPS route도 유지한다.

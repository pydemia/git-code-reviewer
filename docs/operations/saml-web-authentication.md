# SAML 앱 인증 설정

P03-C03은 앱의 SAML 경로와 세션 검증을 제공한다. 운영 PRISM-DEV는 `AUTH_MODE=local`을 유지한다. 계정 provisioning, IdP 상태 수집, companion Keycloak 배포와 복구·운영 전환을 검증하기 전에는 운영 인증 방식을 변경하지 않는다.

## 서버 설정

| 환경 변수                | 값과 조건                                                                  |
| ------------------------ | -------------------------------------------------------------------------- |
| `AUTH_MODE`              | `saml`                                                                     |
| `PUBLIC_BASE_URL`        | HTTPS origin. 사용자 정보·query·fragment·하위 path 없이 설정               |
| `SAML_ENTITY_ID`         | 선택. 기본값은 public origin + `/auth/saml/metadata`                       |
| `SAML_IDP_ISSUER`        | 승인된 IdP의 정확한 HTTPS issuer                                           |
| `SAML_IDP_ENTRY_POINT`   | 같은 IdP origin의 Redirect SSO/SLO endpoint                                |
| `SAML_IDP_METADATA_URL`  | 같은 IdP origin의 승인된 metadata URL. Redirect는 허용하지 않음            |
| `SAML_IDP_METADATA_FILE` | 선택. 승인된 metadata의 절대 경로. 지정하면 해당 파일을 trust pin으로 사용 |
| `SAML_PRIVATE_KEY_FILE`  | RSA 2048bit 이상 SP signing private key의 mounted 절대 경로                |
| `SAML_PUBLIC_CERT_FILE`  | 위 key와 일치하는 유효기간 내 SP X.509 certificate의 mounted 절대 경로     |

Metadata URL은 file mode에서도 승인된 원본을 식별하는 설정으로 요구한다. 파일이 지정됐으면 네트워크 장애의 fallback으로 사용하지 않고 그 파일만 검증한다. 파일이 없으면 startup 때 URL을 조회하며 10초 timeout·128 KiB 한도를 적용한다. Issuer·Redirect SSO/SLO endpoint·유효한 RSA signing certificate가 계약과 맞아야 한다. 응답 안에 들어 있는 임의의 인증서를 신뢰하지 않는다. 이 commit에는 실행 중 자동 metadata refresh가 없으므로 키 overlap을 포함한 metadata 갱신·restart 절차는 C07/C08에서 검증해야 한다.

Serve process에만 SP key·metadata가 필요하다. Worker·migration·retention command는 이 파일을 요구하지 않는다. Helm/Compose의 SAML 설정과 Secret mount는 P03-C07의 범위다.

## 인증 경로와 실패 처리

`GET /auth/login` 또는 `/auth/saml/login`은 서명된 AuthnRequest를 만든다. `returnTo`는 검증된 앱 내부 경로만 받는다. 응답은 `POST /auth/saml/acs`에서 처리하며 다른 변경 요청에는 Origin 검사를 적용한다. `/auth/saml/metadata`는 서명된 SP metadata를 반환한다.

사용자는 기존 GCR `users.id`와 persistent NameID의 명시적 mapping으로 식별한다. 이메일·display name·IdP claim으로 계정을 만들거나 GCR role/groups/subject를 덮어쓰지 않는다. 활성화된 mapping과 확인 시각이 5분 이내인 security state가 있어야 세션을 만들고 사용할 수 있다. C03 자체는 이 state를 갱신하지 않는다.

`POST /auth/logout`은 해당 SessionIndex의 앱 세션을 먼저 폐기한 뒤 `{redirectTo}`를 반환한다. 브라우저가 해당 URL로 이동하며 `GET /auth/saml/slo`에서 서명된 응답을 소비한다. 동일 경로는 서명된 IdP LogoutRequest도 처리한다. 다른 SessionIndex나 client grant 전체 폐기는 이 일반 SLO의 동작이 아니다. DB 실패 또는 응답 유실 때 UI는 완료 여부를 확인하지 못했다고 표시한다.

Transaction은 최대 5분이며 탭마다 `Secure; HttpOnly; SameSite=None; Path=/`인 `__Host-` cookie를 사용한다. 일반 세션은 `gcr_session`·SameSite=Lax이며 최대 8시간과 IdP session 만료 중 짧은 기한을 적용한다. Log에는 SAML query·assertion·cookie·library 원문 오류를 남기지 않는다. 오류 페이지는 정적 안내와 로그인 화면으로 돌아가는 링크만 표시한다.

## 재현

`pnpm test:saml-contract`는 암호학적 계약 fixture를 실행한다. `pnpm build` 후 `pnpm smoke:saml-application`은 격리된 PostgreSQL·Keycloak과 실제 앱 instance 두 개를 만들고 설치된 Chrome에서 HTTPS 로그인·로그아웃을 수행한다. 고정된 container image가 로컬에 있어야 한다. 운영 DB·realm·사용자·OS trust store를 사용하지 않는다. 결과 파일은 `GCR_SAML_EVIDENCE`에 새 절대 경로를 지정해 보관할 수 있으며 기존 파일을 덮어쓰지 않는다.

Chrome headless 시험은 Native Safari 검증을 대체하지 않는다. [P03 실행 기록](../../.documents/execution/preventive-review/P03.md)에 통과한 항목과 남은 gate를 기록한다.

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

Serve process에만 SP key·metadata가 필요하다. Worker·migration·retention command는 이 파일을 요구하지 않는다. Helm 연결은 아래 절차로 준비한다. Compose overlay와 실제 운영 전환은 아직 미완료다.

## Helm 설정과 전환 준비

[SAML values 예시](../../deploy/helm/git-code-reviewer/values.saml.example.yaml)는 같은 공유 PostgreSQL과 [identity companion](../../deploy/helm/gcr-identity/README.md)을 연결하는 준비용 overlay다. Chart의 현재 alpha.37 image 기본값은 P03-C06 연결 격리 코드보다 이전 버전이다. 현재 runtime source를 빌드·검증·게시한 새 digest를 지정해야 한다. 예시에는 digest를 비워 둬 그대로 설치할 수 없으며 실제 DNS·TLS·Secret·DB·CNI 검증을 대신하지 않는다. 기존 bundled PostgreSQL release를 외부 DB 예시로 전환해 삭제하지 않도록 환경별 기존 values와 자원 소유권을 보존한다.

`auth.saml.idpIssuer`에서 Keycloak의 `/protocol/saml`과 `/protocol/saml/descriptor`를 파생한다. SP Entity ID는 `publicBaseUrl` + `/auth/saml/metadata`가 기본이며 같은 public origin의 URL로 명시적으로 고정할 수 있다. HTTPS origin·realm·관리 API path를 검증하고 master realm·기본 port 443의 중복 표기·dot path·query·userinfo를 허용하지 않는다. Public origin은 끝의 `/` 한 개를 허용한다. Metadata ConfigMap을 지정하면 승인한 파일만 사용하고, 비워 두면 승인한 URL에서 조회한다.

| 설정                                                | 소비 범위                                                                                                                                                                                                  |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.saml.signingSecret`의 private key/certificate | Server만 `/run/secrets/saml-sp`에 read-only mount. TLS 인증서·IdP key·서비스 계정 Secret과 분리한다.                                                                                                       |
| `auth.saml.metadataConfigMap`                       | 선택한 metadata pin을 server에만 mount. `metadataKey`는 원본 ConfigMap key를 지정한다.                                                                                                                     |
| `secrets.auth`의 `auth.saml.sessionSecretKey`       | SAML server는 이 key만 `SESSION_SECRET`으로 참조한다. Auth Secret 전체를 envFrom으로 가져오지 않는다.                                                                                                      |
| `identity.existingSecret`의 `clientSecretKey`       | Server와 worker에만 `/run/secrets/identity-admin/client-secret`으로 mount. GCR app·DB·migrator Secret과 이름을 공유하지 않는다.                                                                            |
| `<release>-identity` ConfigMap                      | Server와 worker만 소비한다. Issuer·Entity ID·관리 URL/client ID·관리/수집 flags를 담고 credential 원문은 담지 않는다.                                                                                      |
| `trustedCa.existingConfigMap`                       | 기존 Node CA bundle 설정을 재사용한다. 사내 Git/model CA를 유지하면서 public IdP·private 관리 API의 승인 CA를 포함한다. 비워 두면 Node의 기본 trust를 사용한다. DB CA는 별도 `database.tls` 설정을 따른다. |

Migration Job·migration wait init·retention·source-sandbox container에는 새 identity ConfigMap, SP key, 관리 credential을 전달하지 않는다. Source-sandbox sidecar는 worker와 네트워크 namespace를 공유하므로 NetworkPolicy로 같은 Pod 내부의 두 container를 구분하지 못한다. Credential/mount 분리와 source sandbox 실행 제한을 별도로 유지한다.

Local 로그인 상태에서 `identity.adminEnabled=true`, `identity.securityEnabled=false`로 계정 생성·명시적 연결을 먼저 준비할 수 있다. 이때 server/worker에는 identity 관리 설정만 필요하고 SP key·metadata는 mount하지 않는다. 계정 mapping과 보안 이벤트 수집을 검증한 뒤 security를 활성화한다. `auth.mode=saml`은 admin/security 둘 다 true, 공유 DB 격리·verify-full TLS, legacy Keycloak dependency off, NetworkPolicy on, `autoJoinDefaultTenant=false`를 요구한다. Local credential 종료와 복구 검증은 P03-C08의 별도 단계다.

Identity를 활성화할 때는 server/worker 각각 desired·surge·terminating Pod를 포함해 `peakReplicas >= 2 * replicas + 1`을 요구한다. 예시는 server/worker 각 1 replica·pool 6, 각 peak 3으로 `18 + 18 + retention 2 = 38`을 기존 `gcr_app` 한도 42 안에 둔다. 실제 운영 replica·drain 시간·부하를 유지하면서 예산을 다시 계산하고, 이전 terminating Pod가 남은 상태에서 rollout을 겹치지 않는다. 이 allowance가 controller의 절대 Pod 수 상한은 아니다. DB role 한도나 전체 인스턴스 예산을 values만으로 바꿀 수 없다.

`identity.adminBaseUrl`은 public issuer와 다른 private HTTPS origin의 `/admin/realms/<동일 realm>`이다. Token 요청은 계속 public issuer의 `/protocol/openid-connect/token`으로 나간다. 따라서 server와 worker 모두 public issuer HTTPS와 private admin API에 접근할 수 있어야 한다. Realm의 최소 권한 service account를 사용하며 `admin-cli`나 master 관리자 credential을 넣지 않는다.

`identity.networkPolicy.publicPeers/publicPort`와 `adminPeers/adminPort`는 server/worker 전용 egress를 만든다. Companion Service 443의 Pod target은 8443이므로 adminPort 기본값은 8443이다. 실제 Gateway·외부 TLS proxy의 주소/target port와 CNI의 NAT 처리를 확인한다. 상대편 ingress도 허용해야 하며 DNS 확인은 Pod 안에서 수행한다. 기존 `networkPolicy.additionalEgress`나 별도 정책이 넓은 접근을 허용하면 정책은 합산된다. Admin API를 공통 egress에 넣으면 migrator/retention에도 접근이 열릴 수 있으므로 전체 렌더 결과를 함께 검토한다.

외부 관리 credential/CA를 교체한 뒤에는 `identity.configurationRevision`을 바꿔 server/worker를 재시작한다. SP key/metadata만 바꾸면 `auth.saml.configurationRevision`으로 server만 재시작한다. Metadata는 시작 시 읽으므로 ConfigMap 내용 변경만으로 현재 프로세스의 신뢰 키가 바뀌지 않는다. 서명 키 overlap·철회·credential 폐기·중단된 요청 처리는 실제 Keycloak 검증과 함께 수행한다.

```sh
pnpm --filter @gcr/runtime build
# Node 22가 기본 node가 아니면 GCR_VERIFY_NODE에 해당 executable 경로를 지정한다.
python -B scripts/verify-saml-chart.py --baseline 5b694de
python -B scripts/verify-shared-database-chart.py --baseline 5b694de
```

검증은 manifest와 허용/거부 규칙, compiled 설정 로더·SP key/certificate·승인 metadata 로딩을 확인한다. SAML URL 응답은 fixture이며 실제 HTTPS 신뢰·IdP·DB 접속·browser login·CNI를 증명하지 않는다. 현재는 이미지/Helm 게시·Compose·운영 계정 mapping/복구·SAML 전환 전 단계다.

## 인증 경로와 실패 처리

`GET /auth/login` 또는 `/auth/saml/login`은 서명된 AuthnRequest를 만든다. `returnTo`는 검증된 앱 내부 경로만 받는다. 응답은 `POST /auth/saml/acs`에서 처리하며 다른 변경 요청에는 Origin 검사를 적용한다. `/auth/saml/metadata`는 서명된 SP metadata를 반환한다.

사용자는 기존 GCR `users.id`와 persistent NameID의 명시적 mapping으로 식별한다. 이메일·display name·IdP claim으로 계정을 만들거나 GCR role/groups/subject를 덮어쓰지 않는다. 활성화된 mapping과 확인 시각이 5분 이내인 security state가 있어야 세션을 만들고 사용할 수 있다. C03 자체는 이 state를 갱신하지 않는다.

`POST /auth/logout`은 해당 SessionIndex의 앱 세션을 먼저 폐기한 뒤 `{redirectTo}`를 반환한다. 브라우저가 해당 URL로 이동하며 `GET /auth/saml/slo`에서 서명된 응답을 소비한다. 동일 경로는 서명된 IdP LogoutRequest도 처리한다. 다른 SessionIndex나 client grant 전체 폐기는 이 일반 SLO의 동작이 아니다. DB 실패 또는 응답 유실 때 UI는 완료 여부를 확인하지 못했다고 표시한다.

Transaction은 최대 5분이며 탭마다 `Secure; HttpOnly; SameSite=None; Path=/`인 `__Host-` cookie를 사용한다. 일반 세션은 `gcr_session`·SameSite=Lax이며 최대 8시간과 IdP session 만료 중 짧은 기한을 적용한다. Log에는 SAML query·assertion·cookie·library 원문 오류를 남기지 않는다. 오류 페이지는 정적 안내와 로그인 화면으로 돌아가는 링크만 표시한다.

## 재현

`pnpm test:saml-contract`는 암호학적 계약 fixture를 실행한다. `pnpm build` 후 `pnpm smoke:saml-application`은 격리된 PostgreSQL·Keycloak과 실제 앱 instance 두 개를 만들고 설치된 Chrome에서 HTTPS 로그인·로그아웃을 수행한다. 고정된 container image가 로컬에 있어야 한다. 운영 DB·realm·사용자·OS trust store를 사용하지 않는다. 결과 파일은 `GCR_SAML_EVIDENCE`에 새 절대 경로를 지정해 보관할 수 있으며 기존 파일을 덮어쓰지 않는다.

Chrome headless 시험은 Native Safari 검증을 대체하지 않는다. [P03 실행 기록](../../.documents/execution/preventive-review/P03.md)에 통과한 항목과 남은 gate를 기록한다.

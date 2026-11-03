# Keycloak 사용자 관리

P03-C04는 GCR 관리자 화면에서 조직 계정을 생성·연결하고 초대 또는 비밀번호 재설정 메일을 요청하는 기능이다. 기본값은 비활성화다. 계정 생성과 연결은 SAML 로그인 허용에 필요한 security freshness를 부여하지 않는다. 이벤트 수집과 재활성화는 P03-C05, Helm 설정과 실제 인증 전환은 P03-C07–C08에서 이어서 구성한다.

## 설정

Server와 Worker에 동일한 provider binding과 사용자 관리 service account를 설정한다. `AUTH_MODE=local`에서도 조직 계정을 미리 준비할 수 있다. SAML 인증을 활성화할 때 필요한 별도의 서명 키와 trust metadata 설정은 [SAML 앱 인증](saml-web-authentication.md)을 따른다.

| 설정                                | 조건                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `IDENTITY_ADMIN_ENABLED`            | 기본 `false`. 명시적으로 `true`인 경우에만 관리 API·화면·processor 활성화                                   |
| `PUBLIC_BASE_URL`                   | query·fragment·경로 없는 HTTPS origin                                                                       |
| `SAML_IDP_ISSUER`                   | 승인된 HTTPS `/realms/<realm>` URL. `master` 금지                                                           |
| `SAML_ENTITY_ID`                    | 생략하면 `${PUBLIC_BASE_URL}/auth/saml/metadata`                                                            |
| `KEYCLOAK_ADMIN_CLIENT_ID`          | 해당 realm의 confidential service client. `admin-cli`·`security-admin-console` 금지                         |
| `KEYCLOAK_ADMIN_CLIENT_SECRET_FILE` | secret을 마운트한 절대 경로. 일반 파일·UTF-8·16 KiB 이하                                                    |
| `KEYCLOAK_ADMIN_BASE_URL`           | 선택. 내부 관리 origin을 사용할 때도 issuer와 같은 realm·context path의 `/admin/realms/<realm>` 경로여야 함 |

Client credentials grant만 사용한다. Service account token은 process memory에 최대 60초 보관하며 DB·로그에 저장하지 않는다. HTTP redirect를 따르지 않고 요청별 제한 시간은 최대 10초다. 응답 JSON은 최대 512 KiB이며 upstream body나 예외 원문을 API 오류에 넣지 않는다.

실제 Keycloak 26.7.3 검증에서는 `realm-management/manage-users`만 role과 client scope에 부여하고 `fullScopeAllowed=false`로 설정했다. Realm 설정 변경·client 생성·signing key 생성·master realm 사용자 조회는 모두 403이었다. 이 권한은 해당 realm의 사용자 관리 권한이며 특정 GCR 사용자만 관리하도록 제한하는 fine-grained policy는 아니다. GCR 전용 realm과 별도의 service account를 사용한다.

Realm User Profile의 unmanaged attribute policy는 `ADMIN_EDIT`로 설정한다. GCR은 생성한 계정에 다음 관리 속성을 기록한다.

- `gcr.identity.user-id`: 기존 또는 새 GCR 사용자 ID
- `gcr.identity.operation-id`: 최초 생성 작업 ID
- `saml.persistent.name.id.for.<SP entity ID>`: `G-<작업 UUID>` 형태의 persistent NameID

해당 SP 속성이 실제 서명된 SAML NameID와 일치하는지 Keycloak 26.7.3에서 확인했다. 일반 사용자 account API에서는 세 속성을 읽거나 바꿀 수 없었다. Wildcard NameID 속성은 연결에 사용하지 않는다. 근거는 [동일 버전 SAML 구현](https://raw.githubusercontent.com/keycloak/keycloak/26.7.3/services/src/main/java/org/keycloak/protocol/saml/SamlProtocol.java), [Admin REST 계약](https://www.keycloak.org/docs-api/26.7.3/rest-api/index.html), [User Profile 관리](https://www.keycloak.org/docs/latest/server_admin/)다.

## 관리자 작업

관리자 페이지의 사용자 탭에서 조직 계정 관리를 연다. 모든 요청은 현재 활성 administrator와 GCR authorization을 확인한다. 작업을 실행하는 Worker도 관리자·대상 사용자·기존 subject·현재 claim을 다시 확인한다.

계정을 새로 만들 때는 로그인 이름·이메일·표시 이름·GCR 역할·소속 테넌트를 지정한다. GCR 사용자는 처음에 비활성이고 로컬 credential은 생성하지 않는다. Keycloak 계정도 비활성·비밀번호 없음으로 생성한다. 관리 속성 확인, 명시적 identity 연결, Keycloak 활성 상태 readback을 마친 뒤 GCR 사용자를 활성화한다. 비밀번호 입력·초기 비밀번호 표시·자동 초대는 없다.

기존 GCR 사용자를 선택해 companion 계정을 생성하면 원래 ID·subject·역할·membership·리뷰 이력을 유지한다. 기존 Keycloak 계정을 연결할 때는 GCR 대상 사용자와 Keycloak UUID를 지정하고 조회된 사용자명·이메일·활성 상태를 확인한다. Worker는 제출한 사용자명·이메일·persistent NameID를 다시 비교한다. 이메일이나 사용자명 일치만으로 연결하지 않으며 이미 연결된 identity를 덮어쓰지 않는다. SP NameID가 아직 없으면 해당 계정으로 조직 로그인을 한 번 시도해 Keycloak이 생성한 SP 식별자를 조회한 뒤 명시적으로 연결한다. 이 시도 자체가 GCR 계정을 만들거나 로그인 권한을 주지는 않는다.

초대와 재설정 메일은 활성화된 명시적 연결에만 요청한다. 관리자는 현재 이메일을 입력하며 전송 직전에 Keycloak의 현재 이메일과 비교한다. 링크의 수명은 30분이다. 초대는 이메일 확인과 비밀번호 변경, 재설정은 비밀번호 변경을 요구한다. GCR은 action token·메일 원문·비밀번호를 받거나 저장하지 않는다. UI의 `메일 요청 접수`는 Keycloak이 요청을 수락했다는 뜻이며 실제 외부 수신함 도착을 보장하지 않는다.

비밀번호 재설정 요청에는 모든 GCR 세션 종료 확인이 필요하다. 요청을 DB에 접수하는 transaction에서 먼저 해당 사용자의 모든 GCR 세션을 삭제하고 security epoch를 증가시키며 freshness를 폐기한다. 같은 요청을 다시 전송해도 epoch를 또 증가시키지 않는다. Worker가 Keycloak 전체 세션을 종료한 뒤 재설정 메일을 요청한다. 원격 실패가 이미 폐기한 GCR 세션을 되살리지 않는다.

## 중복·장애·재시도

Migration 0034는 기존 operation/outbox에 provider binding·request fingerprint·메일 dispatch marker를 추가한다. 기존 행은 그대로 두며 provider binding 없는 legacy 작업은 새 Worker가 처리하지 않는다.

클라이언트 request UUID와 provider·관리자 ID에서 dedupe key를 계산한다. 같은 요청을 반복하면 같은 작업을 반환하고 payload가 달라지면 409를 반환한다. 응답을 받지 못한 화면은 원래 UUID와 payload를 보존한다. `같은 요청 다시 확인`은 새 계정을 만드는 요청이 아니다.

Worker는 PostgreSQL `SKIP LOCKED`와 2분 claim lease로 작업을 가져온다. 사용자·provider당 진행 중인 작업은 하나다. 생성 응답을 잃으면 정확한 사용자명으로 조회한 뒤 사용자 ID·operation ID·SP NameID 관리 속성과 요청한 profile을 모두 비교한다. 일치해야 기존 계정을 재사용한다. Claim을 잃은 Worker의 늦은 완료는 DB에 반영하지 않는다.

확인 가능한 읽기 장애는 제한된 backoff로 최대 5회 시도한다. 실패한 생성·연결은 사용자와 operation을 보존하고 관리자가 같은 작업을 재시도할 수 있다. 별도의 identity가 이미 생성된 경우에도 동일한 연결을 재사용한다. 다른 사용자에 연결하거나 기존 subject를 바꾸지 않는다.

메일 요청은 원격 호출 **전** DB에 dispatch marker를 commit한다. 이후 timeout·응답 유실·Worker 중단은 `IDENTITY_EMAIL_UNCONFIRMED`로 표시하고 자동 또는 같은 작업의 수동 재발송을 막는다. 호출 전에 process가 죽었어도 같은 보수적 규칙을 적용하므로 실제 메일이 없을 수 있다. 수신 여부 확인 후 필요한 경우 관리자가 별도의 새 메일 작업을 요청한다. SMTP 장애도 upstream 오류 원문 없이 이 상태로 표시될 수 있다.

GCR에서 사용자를 차단하거나 삭제하면 같은 transaction에서 진행 중인 작업 claim을 폐기하고 identity를 비활성화하며 세션·freshness를 폐기한다. 원격 응답이 늦게 돌아와도 앱 사용자를 다시 활성화하지 않는다. 현재 일반 사용자 편집 API는 연결된 비활성 계정의 직접 재활성화를 거부한다. Keycloak 차단 outbox와 직접 변경 이벤트, 확인된 재활성화는 P03-C05 범위다.

## 검증과 재현

Node 22, Docker, OpenSSL, 설치된 Google Chrome을 사용한다. GCR·Keycloak PostgreSQL schema와 계정·realm·Docker network·SMTP sink는 실행마다 별도로 만들고 정리한다. 실제 운영 DB·사용자 credential·OS keychain을 사용하지 않는다.

```sh
pnpm install --frozen-lockfile
pnpm build
GCR_SAML_EVIDENCE=/absolute/new-evidence.json pnpm smoke:keycloak-admin
```

Image digest와 재현 환경은 [P03 실행 증거](../../.documents/execution/preventive-review/P03.md)를 따른다. SMTP sink는 예약된 `example.test` 주소만 수락하고 메시지 내용을 버린다. 테스트는 메일 수만 기록하며 외부 메일을 발송하지 않는다. HTTPS는 생성한 TLS leaf를 시험 process에만 pin한다. 시스템 trust store를 바꾸거나 TLS 검사를 끄지 않는다.

Chrome component 회귀는 `apps/web/src/identity-administration.browser.test.ts`에 있다. 실제 통합 smoke는 compiled LoginPage·AdminPage, 실제 HTTP API·PostgreSQL outbox·Keycloak·SMTP를 사용한다. Queue 처리는 production processor를 명시적으로 호출하므로 Worker scheduling 증거와 구분한다. Native Safari·사용자가 보는 VS Code UI·운영 SAML 전환을 이 headless 결과로 완료 처리하지 않는다.

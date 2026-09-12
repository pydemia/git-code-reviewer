# Commit Defender 중앙 연결 인증

작성일: 2026-09-11  
상태: 구현 계획. Client용 token/API key를 발급하거나 인증 코드를 변경하지 않음.  
관련 문서: [실행 모드·sync 설계](./client-review-knowledge-sync-design.md), [Keycloak SAML·공유 PostgreSQL 배포안](./keycloak-saml-deployment-design.md)

## Keycloak UI 로그인과 GCR client 인가

후속 결정에 따라 **Web UI 로그인은 자체 배포한 Keycloak의 SAML 2.0으로 처리한다.** 앞선 외부 IdP 배제·GCR 비밀번호 직접 검증 계획은 이 결정으로 대체한다. 외부 SaaS·추가 federation은 요구하지 않는다. Keycloak은 GCR과 같은 운영 범위에 배포하고 PostgreSQL 인스턴스는 공유하되 database·DB role·secret은 분리한다.

사용자 관리 진입점은 GCR 관리 화면으로 유지한다. 계정 생성·암호 재설정·MFA 등 identity 작업은 backend가 제한된 Keycloak Admin API로 요청하고 Keycloak이 credential의 원본을 보관한다. GCR은 `users.id`, 앱 활성/차단, 역할, tenant membership, repository grant, 개인 메모리 owner를 관리한다. SAML claim으로 앱 관리자 권한을 자동 부여하지 않는다. 기존 사용자 ID와 리뷰·메모리 이력은 유지하되 기존 비밀번호 hash를 그대로 Keycloak에 이식할 수 있다고 가정하지 않는다.

SAML은 브라우저 사용자의 신원을 확인하는 경계다. Commit Defender/CLI가 SAML assertion을 보관하거나 API bearer로 보내지 않는다. 기존 기획의 GCR 내부 client authorization code·device grant·access/refresh token·API key 발급은 유지하며, 승인 사용자를 확인하는 웹 session만 SAML 로그인으로 얻는다. 이는 추가 구현 항목이고 SAML 설치만으로 완성되지 않는다. 범용 SSO 제품·동적 third-party client 등록·OIDC ID token 발급은 GCR 구현 범위에 넣지 않는다.

```text
브라우저 ── GCR 로그인 ──→ Keycloak 로그인·MFA
         ←─ GCR ACS ←──── 서명된 SAML response
                    └─ GCR 사용자 연결·웹 session 생성
Commit Defender ── GCR 웹 승인 ──→ GCR client 인가 모듈
                ←─ code / access·refresh token ──┘
Commit Defender ── GCR 발급 bearer ──→ GCR API
                                      scope·repo·개인 메모리 인가
```

중앙 배포에 `AUTH_MODE=saml`을 추가할 계획이다. 현재 runtime과 Helm에는 이 mode가 없으므로 환경 변수만 바꿔 배포할 수 없다. `local`은 별도 standalone 서버 설치용으로 남길 수 있지만 SAML 장애 시 자동 비밀번호 fallback으로 노출하지 않는다. 개발용 기본 사용자도 운영 인가를 우회할 수 없다. 이번 변경은 문서에 한정하며 운영 설정을 바꾸지 않는다.

Commit Defender의 standalone은 중앙 계정·Keycloak을 요구하지 않는다. Centralized의 `login`과 `api-key`는 같은 GCR 사용자·권한 체계를 따르며 Keycloak identity에 연결된다. 외부 모델 제공자의 계정 사용 여부는 중앙 사용자 인증과 별개다.

## 인증 수단

Centralized 연결에는 서버 주소 외에 해당 사용자의 접근 권한을 증명하는 credential이 필요하다. 모든 설치에 공통 비밀키를 배포하지 않고, 사용자·기기 또는 자동화 주체별로 발급·폐기할 수 있는 credential을 사용한다. Standalone은 중앙 credential 없이 동작한다.

| 방식             | 대상                      | 사용 절차                                                                                          |
| ---------------- | ------------------------- | -------------------------------------------------------------------------------------------------- |
| `login` — 기본   | 일반 개발자의 VS Code·CLI | Keycloak SAML 로그인 후 GCR에서 client 연결을 승인하고 GCR 발급 access/refresh token을 저장        |
| `api-key` — 선택 | 수동 연결 환경            | GCR 화면에서 이름·repository·scope·만료일을 지정해 발급한 개인 API key를 client 보안 입력창에 등록 |

API key도 사용자에게 귀속되며 본인의 현재 권한보다 넓게 발급할 수 없다. 자동화가 여러 사람을 대표해야 하면 별도 service principal을 설계하며 개인 키를 팀 공용으로 복사하지 않는다. Service principal에는 본인이라는 명목으로 사람의 개인 메모리를 제공하지 않는다. Machine-to-machine 전용 인증은 후속 범위다.

중앙 연결 credential, GitHub/GHES PAT, 모델 제공자의 API key·계정 로그인은 서로 다른 자격 증명이다. Commit Defender의 기존 `aiProvider/apiKey` 설정을 중앙 서버 인증으로 재사용하지 않는다. 중앙 모델 계정의 credential이나 웹 session cookie를 client에 복사하지 않는다.

Extension Marketplace publisher 인증도 별개다. 게시 credential은 개발·릴리스 CLI에서만 사용하고 extension이나 중앙 sync로 전달하지 않는다. 게시 전에는 [로컬 VS Code 실동작 검증·CLI 인증 절차](./client-extension-release-plan.md)를 통과해야 한다.

## 사용자가 보는 연결 과정

```text
Centralized 선택 → 서버 URL 입력·확인
  ├─ 로그인으로 연결 → 중앙 로그인 → repository·권한 승인
  └─ API key로 연결 → 비밀 입력창에서 키 등록 → 접근 범위 확인
        ↓
연결된 사용자·기기·repository·scope·만료 표시
        ↓
Manifest·Skill·메모리 sync
```

`commitDefender.centralized.authMethod`는 `login` 또는 `api-key`를 선택하는 비밀이 아닌 설정으로 제안한다. 서버가 게시한 실제 구현·활성화된 방식만 표시하며 GCR 내부 client 로그인 모듈이 준비되지 않은 버전에는 login이 가능하다고 표시하지 않는다. Key/token 원문을 VS Code settings나 `.commit-defender/hook.json`에 넣는 설정은 제공하지 않는다. `API key 등록/교체` 명령은 masked 입력으로 받아 OS credential store에 저장한다. Token은 URL query, shell argument, Git 파일, 진단 로그에 기록하지 않는다.

권한 화면은 읽기와 쓰기를 분리한다. 최초 sync의 기본 권한은 `rules:read`, `memories:read`이며, 원문 추가 조회는 `sources:read`, feedback 제출은 `feedback:submit`, 결과 metadata 제출은 `reviews:submit`, 중앙 모델 호출은 `ai:invoke`로 각각 추가 동의한다. Local provider로 리뷰한다면 `ai:invoke`는 필요 없다. 정책 관리 권한은 기본 client credential에 넣지 않는다.

## 브라우저 로그인과 headless 연결

VS Code처럼 OS의 기본 브라우저와 안전한 callback을 쓸 수 있는 환경은 GCR 내부의 Authorization Code + PKCE `S256` flow를 사용한다. 브라우저는 사용자가 지정한 GCR 승인 URL에서 시작해 서버에 사전 등록된 Keycloak 로그인으로 이동하고 GCR ACS로 돌아온다. Native client의 브라우저·PKCE 보안 절차는 [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252.html)를 따른다.

1. Commit Defender가 verifier·challenge·state를 생성해 GCR에 연결 승인을 요청한다.
2. GCR이 Keycloak SAML 로그인 또는 유효한 SAML 기반 웹 session으로 사용자를 확인한다. 비밀번호는 Keycloak 로그인 화면에서만 입력하며 GCR이나 client에 저장하지 않는다.
3. GCR 승인 화면에서 기기 이름, tenant, 접근할 repository, scope를 사용자가 확인한다. 이미 로그인했다는 이유로 미승인 client 권한을 자동 발급하지 않는다.
4. GCR이 사용자·client ID·callback·PKCE challenge·승인 범위에 묶인 짧은 수명의 일회성 code를 발급한다.
5. Client가 GCR token endpoint에 code와 verifier를 보내고, 서버가 transaction에서 일회성 소비와 현재 권한을 확인해 access/refresh token을 발급한다.

SAML의 AuthnRequest·RelayState transaction과 client PKCE의 state·verifier·승인 transaction은 분리하고 서버에서 연결한다. SAML 응답을 client callback으로 전달하거나 한쪽 state를 다른 프로토콜의 검증 대신 사용하지 않는다.

Client는 public client이며 extension에 전역 `client_secret`을 심지 않는다. Redirect는 등록한 callback 또는 검증된 loopback callback으로 제한하고 `state`·issuer·client ID·PKCE·만료·일회성을 검증한다. Code/token을 임의 redirect URL에 보내지 않는다. Callback에 access/refresh token을 직접 싣지 않는다.

Remote CLI 등 callback을 받을 수 없는 환경에는 GCR 내부에서 Device Authorization Grant를 제공한다. Client가 GCR에서 `device_code`, 사용자 확인 코드, GCR 확인 URL을 받고 사용자가 다른 브라우저에서 같은 GCR 계정으로 로그인·승인하면 token을 교환한다. 확인 화면에는 요청한 기기 이름·scope·repository와 코드를 표시하며, 이름만으로 실제 기기를 인증했다고 취급하지 않는다. [RFC 8628](https://www.rfc-editor.org/rfc/rfc8628.html)

Device code는 GCR이 추측하기 어려운 난수로 발급해 digest·만료·승인 상태를 저장하고, 사용자 코드의 시도 횟수와 요청 속도를 제한한다. Client는 GCR이 지정한 polling interval과 `slow_down`을 지키고 승인 거절·만료에는 polling을 끝낸다. GCR 웹의 기기 승인·API key 생성·폐기 요청에는 CSRF 방어와 명시적인 사용자 확인을 적용한다. Code/token 응답은 로그·공유 cache에 남기지 않는다.

## Token·API key 수명과 저장

Code·token·API key를 모두 GCR에서 발급·관리한다. 다음 수명은 배포 초기 제안값이며 GCR의 보안 정책에서 더 짧게 제한할 수 있다. 발급 화면과 client에 실제 만료일을 표시한다.

| 종류                      | 제안 수명·동작                             | 보관                                                                        |
| ------------------------- | ------------------------------------------ | --------------------------------------------------------------------------- |
| Authorization/device code | 최대 10분, 일회성                          | GCR에 code digest·PKCE/승인 조건·만료 상태 저장                             |
| Access token              | 15분                                       | Client 메모리/credential broker. GCR에는 digest·grant 참조·만료 저장        |
| Refresh token             | 30일 미사용 만료, 최대 90일 후 재승인 제안 | OS credential store. GCR은 digest와 rotation family·폐기 상태 관리          |
| 수동 API key              | 기본 30일, 조직 상한 내 만료일 지정        | 최초 발급 시 한 번만 표시. Client는 OS credential store, 서버는 digest 저장 |

GCR의 access/refresh token과 API key는 최소 256-bit의 암호학적 난수로 opaque secret을 발급하고 서버에는 digest만 저장한다. 기존 웹 session과 별도의 client grant·credential 테이블을 사용한다. 원문 secret을 재조회하거나 웹 session cookie를 client token으로 대체하지 않는다. API key는 refresh token이 아니며 만료되면 교체하거나 GCR 브라우저 로그인으로 전환한다. Client용 ID token·JWT 발급은 MVP의 필수 기능으로 넣지 않는다.

서버는 사용자·tenant·허용 repository 집합·scope·서버 audience·credential 상태를 기록한다. Scope와 audience를 최소화하고 refresh token을 회전시키는 방향은 [OAuth 보안 권고 RFC 9700](https://www.rfc-editor.org/rfc/rfc9700.html#section-2.2.2)에 따른다. API 요청은 HTTPS의 `Authorization: Bearer <credential>`를 사용하며 token 응답은 공유 cache에 저장하지 않는다.

Refresh rotation·재사용 탐지는 GCR 인증 모듈이 담당한다. Server transaction에서 이전 refresh token을 일회성 소비하고 새 token을 발급하며 이미 사용한 token의 재사용을 탐지하면 family를 폐기한다. Client의 공통 broker가 VS Code·CLI·hook의 갱신 요청을 직렬화해 정상 동시 실행을 token 재사용 공격으로 만들지 않는다. 응답 유실로 새 refresh token 보유 여부가 불명확해지면 이전 token을 무한 재시도하지 않고 재인증 상태로 전환한다.

기기별 발급은 관리·개별 폐기를 위한 구분이다. Bearer credential을 탈취한 공격자가 다른 기기에서 사용하는 것을 기기 이름·ID만으로 차단할 수는 없다. 필요하면 DPoP 등 proof-of-possession을 별도 단계로 검토하며 MVP에서 하드웨어 결합 인증을 제공한다고 표시하지 않는다.

## 요청마다 확인할 권한

Credential의 발급 당시 권한과 사용자의 현재 권한의 교집합만 허용한다. 매 manifest·artifact·원문·feedback·모델 요청에서 credential 만료/폐기, 사용자 활성 상태, tenant membership, repository grant, endpoint별 scope를 확인한다. API key가 발급된 뒤 repository 권한이 사라지면 그 키로 계속 읽을 수 없어야 한다.

개인 메모리 owner는 bearer principal에서 정한다. Body/query로 전달된 `ownerUserId`를 신뢰하지 않으며 admin 사용자가 로그인했다고 일반 sync token을 모든 사용자 개인 메모리용으로 확대하지 않는다. 개인과 집단 bundle 모두 URL·UUID·hash를 아는 것만으로 열람할 수 없다.

인증되지 않은 요청과 권한 부족을 구분한다. 폐기·만료 token은 재인증을 요구하고, 유효 token의 scope/repository 권한 부족은 인가 오류로 처리한다. 어느 경우에도 기존 browser cookie나 개발용 기본 사용자로 조용히 대체하지 않는다. Browser 승인 화면은 기존 웹 인증을 쓰지만 client sync endpoint는 전용 bearer guard를 통과해야 한다.

하나의 동기화 작업에서 token이 갱신돼도 같은 principal·scope인지 확인한다. Server·계정 변경, 사용자 비활성화, 권한 철회가 확인되면 새 다운로드·context 사용을 중단한다. 이미 전송한 source나 읽은 자료를 되돌렸다고 주장하지 않는다.

## 폐기·장애·Standalone

중앙의 `연결 기기·API keys` 화면에서 이름, 사용자, 승인된 repository·scope, 생성/만료/마지막 사용 시각과 폐기 상태를 확인한다. 본인은 자기 credential을, 위임된 관리자는 권한 범위 안에서 credential을 폐기할 수 있다. 원문 token은 목록이나 감사 로그에서 표시하지 않는다.

현재 기기 연결 해제, 특정 key 폐기, 모든 기기 로그아웃, 계정 비활성화의 범위를 구분한다. GCR이 credential·grant·사용자 상태를 요청마다 서버 저장소에서 확인해 다음 요청부터 차단한다. Grant 폐기는 연결된 access/refresh token을 모두 무효화한다. 일반 웹 logout은 해당 GCR 웹 session을 먼저 끝내고 Keycloak SAML SLO를 요청한다. 모든 기기 logout·계정 차단·비밀번호 재설정·계정 침해 대응에는 GCR client grant·API key 폐기도 포함한다. Keycloak 계정 차단이나 SAML SLO만으로 GCR이 발급한 token까지 자동 폐기되지는 않는다. 두 시스템의 상태 전달·장애 시 보안 freshness 제한은 [배포안의 수명주기](./keycloak-saml-deployment-design.md#사용자-차단과-로그아웃)를 따른다.

일반 서버 장애에는 서명된 offline lease가 허용하는 마지막 중앙 snapshot을 사용할 수 있다. 반면 명시적인 인증 실패·권한 철회를 확인한 상태에서 중앙 cache 사용을 계속하지 않는다. 설정이 허용하면 중앙 자료를 제외한 local memory·Skill로 standalone 리뷰를 수행한다. 인증이 없다는 이유로 사용자의 local 자료를 삭제하지 않는다.

Offline client에 대한 즉시 철회는 보장하지 않는다. 최대 offline 유효 기간과 재접속 시 인가 확인으로 노출 기간을 제한한다. Lease는 offline 자료 사용 조건이며 중앙 API에 다시 접근할 수 있는 access token을 대신하지 않는다.

서버 인증도 별도로 확인한다. TLS·확인한 server identity는 접속 대상을, bundle 서명은 받은 정책·메모리의 출처/무결성을 확인한다. Client access token/API key는 중앙 서버에 사용자의 권한을 증명한다. Bundle 검증용 공개키는 사용자 로그인 credential이 아니다. 서버 URL을 바꾸거나 다른 origin으로 redirect됐을 때 기존 token을 전달하지 않는다.

## 현재 구현과 추가할 코드

현재 GCR은 local/OIDC/proxy 웹 인증을 제공하고 `user_sessions`에는 session digest·사용자·만료를 저장한다. SAML SP와 client 전용 authorization/device grant, scope 제한 bearer token, 개인 API key 관리 API는 아직 없다. SAML 검증 후 기존 session 계약을 확장해 재사용하되 웹 session과 client credential 수명은 분리한다. Identity linking·SAML transaction/replay 저장소·Keycloak 상태 연동도 추가해야 한다. [인증 진입점](../apps/runtime/src/auth/index.ts#L41), [session 조회](../apps/runtime/src/auth/index.ts#L350), [session table](../packages/db/migrations/0002_worklist.sql#L21)

GCR 내부에 허용 client 등록, authorization/device transaction, 승인 grant·scope/repository 제약, access/refresh credential과 token family, 개인 API key, 감사 이벤트의 DB 계약을 추가한다. Bearer guard, code 교환·refresh·device 승인·key 발급·폐기 route는 GCR runtime에서 제공한다. Client core에는 OS credential adapter, GCR 로그인/키 등록, token broker, 서버·계정 전환 처리를 추가한다. HTTP 인증 코드를 각 VS Code/CLI/MCP adapter에 중복 구현하지 않는다.

제안 endpoint는 다음과 같다. GCR이 자기 API의 authorization/token 기능을 제공하며 config에는 같은 GCR 서버의 client endpoint와 실제 지원 기능만 게시한다. Browser 로그인에서만 서버가 승인한 Keycloak IdP로 이동한다. Client가 임의 issuer를 추가하거나 bearer token을 IdP·다른 origin에 전달하는 redirect는 허용하지 않는다.

| API                                           | 목적                                                                             |
| --------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/v1/client-auth/config`              | GCR 서버 식별·자체 auth endpoint·public client ID·API audience 안내. Secret 없음 |
| `GET /api/v1/client-auth/authorize`           | SAML 기반 GCR 웹 session으로 PKCE code flow 승인 시작                            |
| `POST /api/v1/client-auth/authorize/decision` | 로그인 사용자의 client 연결 승인·거절. CSRF 검증                                 |
| `POST /api/v1/client-auth/device`             | Headless용 device code·사용자 코드·GCR 확인 URL 발급                             |
| `POST /api/v1/client-auth/device/decision`    | 로그인 사용자의 device 연결 승인·거절. CSRF 검증                                 |
| `POST /api/v1/client-auth/token`              | Authorization/device code 교환 또는 refresh rotation                             |
| `GET /api/v1/client-auth/me`                  | Bearer principal·실효 scope·만료 상태 확인                                       |
| `POST /api/v1/client-auth/revoke`             | 자기 grant 또는 API key와 연결 credential 폐기                                   |
| `GET /api/v1/me/client-credentials`           | 웹 로그인 사용자의 기기·key 목록                                                 |
| `POST /api/v1/me/client-credentials`          | 웹 사용자 확인 후 scope 제한 API key 발급                                        |
| `DELETE /api/v1/me/client-credentials/:id`    | 자기 credential과 연결 token 폐기                                                |

우선 SAML 로그인·기존 사용자 연결·차단 전달을 검증하고 scope·bearer guard·폐기와 수동 key 발급, GCR 내부 PKCE 로그인, headless device flow, client token broker를 순서대로 연결한다. 구현되지 않은 flow는 config에서 지원한다고 게시하지 않는다. 핵심 검증은 다른 사용자/tenant/repo 접근 거부, 개인 메모리 격리, 낮은 scope의 모델 호출 거부, 폐기 후 접근 거부, code 재사용·PKCE 실패·redirect 위조·CSRF·device polling 제한, refresh 동시 실행·응답 유실, 서버 변경 시 credential 비전송, 401/403과 단순 offline의 구분이다.

인증 모듈은 sync·모델 실행과 별도로 테스트하고 운영 공개 전 보안 검토를 수행한다. Keycloak 운영·SAML SP 검증과 별개로 GCR 발급 client credential의 갱신·폐기·복구 책임은 GCR에 남는다. 표준 보안 절차를 생략한 비밀번호 직접 교환 flow나 기기 공통 비밀키로 구현 범위를 줄이지 않는다.

# Keycloak SAML 로그인과 공유 PostgreSQL 배포안

작성일: 2026-09-11  
상태: 설계. 인증 코드·Compose·Helm·운영 DB·DNS는 변경하지 않음.  
관련 문서: [client 인증](./client-authentication-design.md), [정책·메모리 sync](./client-review-knowledge-sync-design.md), [통합 기획](./preventive-review-platform-plan.md)

## 배포 결정

Web UI 로그인은 자체 운영하는 Keycloak의 SAML 2.0으로 처리한다. GCR은 Service Provider(SP), Keycloak은 Identity Provider(IdP)다. Keycloak 로그인 화면에 GCR 표시명·로고·한국어 theme을 적용할 수 있지만 비밀번호 입력 화면을 GCR에 복제하거나 iframe으로 삽입하지 않는다.

Keycloak은 GCR과 함께 운영하는 서비스로 추가한다. 별도 SaaS·사내 IdP·LDAP federation은 필수 구성에 넣지 않는다. 앞선 “외부 IdP를 제외하고 GCR이 비밀번호까지 직접 검증한다”는 결정은 이 안으로 대체한다. 사용자 관리 메뉴와 앱 권한은 GCR에 남기고 credential의 원본은 Keycloak으로 옮긴다.

**PostgreSQL 인스턴스/클러스터 하나에 `git_code_reviewer`, `git_code_reviewer_keycloak` database를 분리한다.** Schema만 나누거나 앱 테이블에 Keycloak 테이블을 함께 만들지 않는다. Database 연결 대상은 Keycloak 설정으로 지정할 수 있다. [Keycloak database 설정](https://www.keycloak.org/server/db)

```text
사용자 브라우저
  ├─ HTTPS → pr-review.prism.ai → GCR Server / UI
  └─ HTTPS → auth.pr-review.prism.ai → Keycloak
                   SAML 요청 / 응답 ↕ GCR ACS

GCR Server ── 앱 API·session·인가 ──────┐
GCR Worker ── 리뷰 작업 ────────────────┤
GCR Migrator ── 앱 migration ───────────┤→ PostgreSQL 공유 자원
                                     │   ├─ git_code_reviewer
Keycloak ── identity·password·MFA ──────┘   └─ git_code_reviewer_keycloak

Commit Defender ── GCR 발급 bearer → GCR sync / review API
```

`auth.pr-review.prism.ai`는 제안 hostname이며 DNS·인증서·접근 가능 여부를 확인하거나 생성한 것은 아니다. 실제 도메인은 환경 설정으로 지정한다. 관리 콘솔용 hostname을 따로 두더라도 DNS 분리만으로 접근 통제가 되지는 않는다.

## 관리 주체와 저장 데이터

| 항목                                                            | 관리·원본                                     |
| --------------------------------------------------------------- | --------------------------------------------- |
| 로그인 화면, 비밀번호 hash, MFA, 인증 시도 제한, IdP session    | Keycloak / identity DB                        |
| 사용자 관리 메뉴, 생성·차단·암호 재설정 요청                    | GCR UI / backend의 Keycloak Admin API adapter |
| `users.id`, 앱 활성 상태·역할, tenant membership, repo grant    | GCR / 앱 DB                                   |
| 리뷰·chat·개인/집단 메모리·Skill·정책                           | GCR / 앱 DB·기존 artifact 저장소              |
| SAML identity 연결, 요청·replay 방지, 웹 session                | GCR / 앱 DB                                   |
| Commit Defender 연결 승인, access/refresh token digest, API key | GCR / 앱 DB·client OS credential store        |

GCR은 Keycloak DB를 직접 조회·수정하지 않는다. 계정 생성·초대·암호 재설정 요청은 realm 범위의 최소 권한 service account로 Admin REST API를 호출한다. 그 service account의 machine token은 backend에서만 쓰며 사용자 UI 로그인이나 Commit Defender token과 구분한다. `master` realm 관리자 credential을 GCR runtime에 주지 않는다. 비밀번호 재설정은 Keycloak 화면으로 연결하고 SMTP·발신 도메인 설정도 배포 선행 조건에 넣는다. [Keycloak Admin REST API](https://www.keycloak.org/docs-api/latest/rest-api/index.html)

앱 DB와 Keycloak API 간에는 단일 transaction이 없으므로 `pending → provisioned/failed` 상태와 outbox·재시도·감사 기록을 둔다. 생성 응답이 유실돼도 같은 계정이 중복 생성되지 않도록 operation ID와 저장된 identity 연결로 재조정한다. 생성·연결이 끝나지 않은 계정에는 앱 권한을 부여하지 않는다. Keycloak 장애 시 관리 화면에는 미완료 상태를 표시한다.

## SAML 로그인 계약

Realm은 `git-code-reviewer`, SAML client의 Entity ID는 GCR metadata URL로 제안한다. `master` realm에서 앱 사용자를 인증하지 않는다. GCR에서 시작하는 SP-initiated 로그인만 먼저 지원한다.

| 항목                       | 제안 값                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------- |
| GCR 모드                   | 신규 `AUTH_MODE=saml`                                                               |
| IdP Entity ID              | `https://auth.pr-review.prism.ai/realms/git-code-reviewer`                          |
| IdP metadata               | `https://auth.pr-review.prism.ai/realms/git-code-reviewer/protocol/saml/descriptor` |
| SP Entity ID·metadata      | `https://pr-review.prism.ai/auth/saml/metadata`                                     |
| 로그인 시작                | `GET /auth/saml/login`                                                              |
| Assertion Consumer Service | `POST /auth/saml/acs`                                                               |
| Single Logout Service      | `/auth/saml/slo`, 채택한 POST/Redirect binding을 metadata에 명시                    |
| AuthnRequest / Response    | 서명된 Redirect 요청 / POST 응답                                                    |
| 신원 식별                  | 안정적인 persistent NameID, 별도 관리 API 연결용 Keycloak user ID                   |

Keycloak SAML client는 정확한 ACS·SLO 주소만 허용하고 wildcard redirect를 두지 않는다. Client Signature Required, 응답·assertion 서명, AuthnStatement를 활성화하며 SHA-256 이상 알고리즘을 사용한다. IdP-initiated SSO는 비활성화한다. Persistent NameID가 이메일·표시 이름 변경과 무관하게 유지되는지 선택 버전으로 검증한다. [Keycloak SAML client 설정](https://www.keycloak.org/docs/latest/server_admin/#_saml_clients)

로그인은 다음 순서로 진행한다.

1. GCR이 만료가 있는 AuthnRequest ID·browser nonce·안전한 앱 내부 복귀 경로를 앱 DB에 저장한다. RelayState에는 복귀 URL 대신 일회성 transaction 식별값을 사용한다.
2. 브라우저가 Keycloak으로 이동해 로그인·MFA를 수행한다. GCR에는 비밀번호가 전달되지 않는다.
3. Keycloak이 브라우저 POST로 GCR ACS에 서명된 SAML Response를 보낸다.
4. GCR이 검증 후 transaction·Response ID·Assertion ID를 원자적으로 소비한다. 다른 server replica에서도 같은 응답을 재사용할 수 없어야 한다.
5. 승인된 identity를 기존 `users.id`에 연결하고 사용자 활성 상태·권한을 확인한 뒤 새로운 GCR session을 발급한다. 이후 API는 기존 앱 session·인가 경계를 사용한다.

### ACS 검증과 cookie

유지보수 중인 SAML SP 라이브러리를 Fastify에 연결하며 XML signature 검증 코드를 직접 작성하지 않는다. 라이브러리 선정 PoC에서 아래 조건을 테스트하고 기본값에만 의존하지 않는다.

- 신뢰한 IdP issuer·서명 키, signed element 자체, Audience, Destination, Recipient, `InResponseTo`, SubjectConfirmation, NotBefore/NotOnOrAfter, 요청·응답의 일회성을 모두 확인한다. 응답에 포함된 임의 인증서를 신뢰 키로 채택하지 않는다.
- XML external entity/DTD·외부 schema fetch를 차단하고 body·압축 해제 크기를 제한한다. 중복 ID·복수 assertion·signature wrapping·약한 알고리즘을 거부한다. 서명이 검증된 assertion에서만 신원을 읽는다.
- 로그인 transaction은 최대 5분, 허용 clock skew는 최대 60초를 초기 제안값으로 둔다. Replay 기록은 허용 시간까지 남기며 모든 replica가 공유한다.
- SAML POST의 cross-site cookie 조건을 고려해 짧은 수명의 `Secure; HttpOnly; SameSite=None` transaction cookie를 host-only로 사용한다. 서버 nonce와 함께 검증하며 평소 `gcr_session`은 `SameSite=Lax`를 유지한다. 실제 hostname 조합·멀티탭·Safari/Chrome에서 검증한다.
- ACS에는 SAML 전용 요청 결합 검증을 적용한다. 일반 변경 API의 CSRF 방어를 전체 해제하지 않는다. 사용자 생성·client 승인·key 발급에는 기존 session 기반 CSRF 방어를 적용한다.
- SAML XML·assertion·cookie·비밀번호·개인정보를 access log·오류 응답·분석 모델 context에 남기지 않는다.

검증 항목은 [OWASP SAML 보안 지침](https://cheatsheetseries.owasp.org/cheatsheets/SAML_Security_Cheat_Sheet.html)을 따른다. TLS 인증서, IdP assertion 서명 키, SP 요청 서명 private key는 다른 용도로 관리한다. Metadata는 관리자가 승인한 HTTPS 위치에서만 갱신하며 새 signing key의 겹치는 전환 기간을 둔다. 응답 처리 중 임의 URL을 조회하지 않는다. Assertion 암호화는 PII 분류에 따라 추가하되 서명 검증을 대체하지 않는다.

### 기존 계정과 권한 유지

현재 `users.oidc_subject` 단일 필드를 SAML NameID로 덮어쓰지 않는다. 별도 `user_identities`에 provider·IdP issuer·SP Entity ID·NameID format/value와 `users.id`를 연결한다. NameQualifier가 있으면 함께 검증·저장한다. Keycloak 관리 API용 immutable user ID도 별도 저장한다. 이메일만 일치한다는 이유로 기존 관리자 계정·개인 메모리와 자동 연결하지 않는다.

관리자가 확인한 일대일 migration mapping으로 기존 `users.id`, subject 기반 repo grant, 리뷰 작성자와 개인 메모리 owner를 보존한다. 새 계정은 초대·승인된 identity만 활성화하며 tenant 자동 가입은 기본 off다. 기존 `upsertUser`의 로그인마다 role/groups를 claim으로 덮어쓰는 경로는 SAML에 재사용하지 않는다. SAML의 표시 이름·이메일은 profile 정보이고 앱 관리자 역할·repository grant의 원본은 GCR이다.

기존 비밀번호 hash는 Keycloak과의 형식 호환을 가정하지 않는다. 기본 migration은 계정 사전 생성·identity mapping·Keycloak 초기 비밀번호 설정 초대다. 본인 확인이 필요한 연결 절차와 관리자 복구 계정을 pilot에서 검증한다. SAML 전환 계정의 기존 local 로그인은 닫고 credential은 보존 기간 뒤 폐기한다. 이를 Keycloak 로그인 실패 시 우회 경로로 사용하지 않는다.

## 사용자 차단과 로그아웃

GCR 관리 화면에서 앱 계정 차단·모든 기기 로그아웃·암호 재설정을 시작하면 먼저 GCR session·client grant·API key를 폐기하고 outbox로 Keycloak 차단/로그아웃/재설정 요청을 전달한다. Keycloak API 실패 때문에 GCR 차단을 취소하지 않는다. 재활성화는 반대로 양쪽 상태 확인이 끝난 뒤 허용한다.

일반 웹 logout은 현재 GCR session을 즉시 삭제하고 서명된 SAML SLO를 요청한다. SLO 응답과 IdP 발 LogoutRequest는 issuer·서명·NameID·SessionIndex·replay를 검증한다. 일반 SLO는 해당 웹 session을 끝내며 명시적인 모든 기기 폐기와 구분한다. 브라우저 종료·IdP logout·SAML만으로 장기 client token까지 자동 철회된다고 가정하지 않는다.

운영 중 Keycloak Console에서 직접 계정을 차단하거나 credential을 변경하는 경우도 처리해야 한다. 계정 enabled 상태 조회와 security/admin event 수집·재조정이 필요하다. 이 이벤트 전달은 SAML에 기본 내장된 GCR webhook이라고 가정하지 않고 별도 구현한다. 일반 운영은 GCR 관리 경로를 사용하며 Console은 제한된 운영자·복구 작업용으로 둔다.

초기 보안 freshness 목표는 최대 5분이다. 활동 중인 identity의 상태와 credential 변경 이벤트 수집의 연속성이 확인된 때만 확인 시각을 갱신한다. 수집 공백·유실이 있으면 관련 session/grant를 보수적으로 폐기하거나 재인증시키며, 단순 API 성공을 이벤트 동기화 완료로 처리하지 않는다. Freshness가 만료되면 해당 사용자의 보호 API·token 발급/갱신을 `503 IDENTITY_UNAVAILABLE`로 막는다. 확인된 차단·폐기는 즉시 GCR 인가 상태에 반영한다. 상태 조회 부하·이벤트 보존/중복/복구를 검증하기 전에는 이 지연 목표를 보장한다고 표시하지 않는다.

GCR 웹 session은 기존 8시간 상한과 assertion의 SessionNotOnOrAfter 중 더 짧은 값으로 제한한다. Freshness 제한은 session·API key 수명과 별도로 적용한다. Keycloak 장애 시 신규 로그인은 불가하고 기존 인증 요청도 이 확인 유효 기간까지만 허용한다. SAML 장애를 `AUTH_MODE=development/local`로 자동 전환하지 않는다.

Commit Defender는 [기존 offline lease·standalone fallback](./client-review-knowledge-sync-design.md)을 유지한다. 통신/서비스 장애에는 유효한 중앙 cache를 사용할 수 있지만 명시적 권한 철회에는 사용할 수 없다. Offline client의 즉시 철회는 보장하지 않는다.

## PostgreSQL 공유와 격리

| 연결 주체                   | Database                     | 제안 DB role        | 권한                                           |
| --------------------------- | ---------------------------- | ------------------- | ---------------------------------------------- |
| GCR Server·Worker·Retention | `git_code_reviewer`          | `gcr_app`           | 필요한 앱 DML·sequence 접근, 다른 DB 접근 없음 |
| GCR migration Job           | `git_code_reviewer`          | `gcr_migrator`      | 앱 schema 소유·migration 전용                  |
| Keycloak                    | `git_code_reviewer_keycloak` | `gcr_keycloak`      | 자기 DB/schema 소유·Keycloak migration         |
| DB bootstrap/복구 작업      | 관리 DB                      | 별도 DBA credential | role·database 생성·복구, runtime에 미주입      |

두 runtime role에 서로의 membership, SUPERUSER, CREATEDB, CREATEROLE, REPLICATION, BYPASSRLS를 주지 않는다. 각 database의 `PUBLIC CONNECT/TEMP`와 불필요한 schema `PUBLIC CREATE`를 회수하고 해당 role에만 필요한 권한을 다시 부여한다. 기존 ACL·소유권·default privilege·기존 연결도 확인한다. Database 이름만 나누면 접근이 차단된다는 가정은 하지 않는다. [PostgreSQL 권한](https://www.postgresql.org/docs/17/ddl-priv.html)

현재 Compose는 `POSTGRES_USER=git_code_reviewer`를 앱 연결에도 사용한다. 공식 PostgreSQL image의 초기 사용자는 superuser이므로 기존 볼륨의 실제 role 권한을 확인하고 별도 DBA와 non-superuser runtime role로 전환해야 한다. 이 image의 init script는 빈 데이터 디렉터리에서만 실행되므로 이미 존재하는 볼륨에는 재실행 가능한 명시적 DB provisioning 작업을 제공한다. 볼륨 삭제·재생성으로 해결하지 않는다. [공식 PostgreSQL image 초기화 동작](https://hub.docker.com/_/postgres)

GCR과 Keycloak의 비밀번호·DB URL secret은 분리한다. GCR은 `postgresql://.../git_code_reviewer`, Keycloak은 `jdbc:postgresql://<shared-db>:5432/git_code_reviewer_keycloak`에 접속한다. 운영 DB 연결은 TLS와 서버 인증서 검증을 사용하고 DB 포트를 인터넷에 공개하지 않는다. 테이블 cross-database join·foreign data wrapper·dblink로 identity를 공유하지 않는다.

동일 인스턴스의 CPU·메모리·I/O·disk·connection·failover는 공유된다. Database 분리는 논리적 접근·migration 경계이며 물리적 성능·장애 격리가 아니다. Keycloak 로그인 폭주나 schema upgrade가 리뷰 DB를 압박할 수 있으므로 별도 connection pool 상한과 resource budget을 둔다.

초기 산정 예시는 GCR server 2개 × pool 10, worker 2개 × pool 10, Keycloak 2개 × pool 10으로 상시 최대 60개다. 여기에 retention·migration·provisioning·모니터링·장애 조치 여유분과 운영자 예약을 더해 실제 PostgreSQL 한도 이하로 제한한다. 이는 측정값이나 현재 배포 크기가 아니며 pilot 결과로 조정한다. Replica 증설 시 pool도 함께 계산한다.

## Compose와 Kubernetes 구성

### Local·통합 검증용 Compose

기존 `compose.yaml`의 standalone 개발 경로는 유지하고 신규 `compose.identity.yaml` overlay를 설계한다. 추가 서비스는 `identity-db-provision`, `keycloak`, `identity-configure`, TLS reverse proxy이며 PostgreSQL 서비스·data volume은 기존 하나를 사용한다. Keycloak용 두 번째 PostgreSQL 컨테이너나 DB volume을 만들지 않는다.

Identity overlay에서 앱을 `AUTH_MODE=saml`·운영에 준하는 session 보안으로 바꾸고 development 기본 사용자 인증을 끈다. 로컬 HTTPS hostname 두 개·신뢰된 개발 인증서를 준비해 실제 POST callback을 검증한다. 기존 DB host port `25432`는 유지하되 loopback에만 bind하거나 불필요하면 제거한다. 컨테이너 사이 DB 연결은 계속 `postgres:5432`다.

시작 순서는 PostgreSQL ready → role/두 DB provisioning → GCR migration 및 Keycloak bootstrap → realm/SAML client 구성 → 양쪽 metadata 신뢰 확인 → 로그인 smoke test다. Provisioning은 DB 이름·소유권·ACL을 확인하고 예상과 다르면 중단한다. 매 재시작마다 사용자·realm을 삭제하거나 비밀번호를 초기화하지 않는다.

### 운영 Kubernetes

GCR chart와 별도로 수명주기를 관리하는 작은 `gcr-identity` companion chart/release를 추가하는 안을 채택한다. 같은 namespace 또는 명시적 NetworkPolicy로 연결한 namespace에서 운영하며 PostgreSQL은 기존 managed 서비스 또는 기존 GCR PostgreSQL 하나를 사용한다. Identity release에는 PostgreSQL dependency를 넣지 않는다.

현재 앱 chart의 legacy Keycloak dependency는 `keycloak.enabled=false`로 유지해 중복 배포를 막는다. Companion은 검증한 공식 `quay.io/keycloak/keycloak` 기반 image를 정확한 version·digest로 고정한다. 기존 Bitnami 설정에 공식 image만 바꾸면 command·경로가 호환된다고 가정하지 않는다. 선택 버전의 PostgreSQL 17 지원·업그레이드 경로·보안 공지를 구현 시 확인하고 `latest`나 현재 legacy pin을 그대로 운영 기본값으로 채택하지 않는다.

다음은 **추가할 설정 계약의 예시**이며 현재 chart에서 바로 실행할 수 있는 values는 아니다.

```yaml
gcr:
  authMode: saml
  publicBaseUrl: https://pr-review.prism.ai
  databaseSecret: gcr-app-db
  saml:
    idpMetadataUrl: https://auth.pr-review.prism.ai/realms/git-code-reviewer/protocol/saml/descriptor
    entityId: https://pr-review.prism.ai/auth/saml/metadata
    signingKeySecret: gcr-saml-sp
    identityAdminSecret: gcr-identity-admin-client
identity:
  hostname: https://auth.pr-review.prism.ai
  realm: git-code-reviewer
  replicas: 2
  database:
    host: shared-postgresql.internal
    port: 5432
    name: git_code_reviewer_keycloak
    user: gcr_keycloak
    credentialSecret: gcr-keycloak-db
  databasePoolMax: 10
  embeddedPostgresql: false
```

Companion의 Keycloak 설정은 `KC_DB=postgres`, 위 DB의 `KC_DB_URL`, 별도 `KC_DB_USERNAME/KC_DB_PASSWORD`, 고정 `KC_HOSTNAME`으로 구성한다. TLS 종료 프록시 뒤에서는 private hop에 한해 `KC_HTTP_ENABLED=true`, 검증한 `KC_PROXY_HEADERS=xforwarded`를 사용한다. 프록시가 전달 헤더를 덮어쓰고 backend 직접 접근을 차단해야 한다. [Keycloak hostname](https://www.keycloak.org/server/hostname), [reverse proxy](https://www.keycloak.org/server/reverseproxy)

Health·metrics를 활성화한 optimized image를 빌드하고 `start --optimized`로 실행한다. `start-dev`는 운영에 쓰지 않는다. Image에 probe용 curl이 있다고 가정하지 않는다. [공식 container 배포](https://www.keycloak.org/server/containers)

- 초기 production은 Keycloak replica 2개·anti-affinity·PDB를 제안한다. 선택 버전의 supported cache discovery·클러스터 통신을 구성하고 한 replica 중단 시 진행 중 SAML login이 유지되는지 검증한다. DB와 ingress까지 HA가 아니면 end-to-end HA로 표기하지 않는다.
- Startup/readiness/liveness를 구분한다. 활성화된 health/metrics의 management port `9000`은 cluster 내부 probe·모니터링만 허용한다. DB 장애를 무조건 pod 재시작으로 처리하지 않는다. [Keycloak health](https://www.keycloak.org/observability/health)
- Public ingress는 사용자 로그인·realm protocol·필요 정적 자원만 허용한다. `/admin`·관리 API는 VPN/관리 ingress 및 GCR backend service account 경로로 제한한다. Public hostname으로 admin path를 우회 접근할 수 없는지 테스트한다.
- GCR만 identity 관리 API에 접근하고 worker는 접근하지 않는다. Keycloak은 공유 DB·필요 SMTP·클러스터 통신 등 승인한 egress만 사용한다. Secret은 역할별로 mount하고 realm JSON·values·Git에 원문 비밀을 넣지 않는다.
- Bootstrap 관리자 secret은 설치/복구에만 사용한다. 초기 설정 후 임시 관리자를 정리하고 명명된 운영자 계정·MFA를 사용한다. Realm 갱신 Job과 서버 시작을 분리해 재배포가 사용자·서명 키를 재생성하지 않도록 한다.

## 백업·업그레이드·복구

공유 PostgreSQL의 PITR/물리 backup과 database별 logical backup을 조합한다. Keycloak DB에는 인증 비밀이 있으므로 backup·WAL도 암호화하고 접근 권한을 제한한다. Realm export만으로 사용자·session·credential을 포함한 DB 복구가 완료된다고 취급하지 않는다. SP private key·운영 secret·realm 설정·identity mapping도 복구 범위에 넣는다.

Migration은 GCR migrator와 Keycloak schema upgrade가 각각 자기 DB에만 수행한다. Keycloak upgrade 전에 같은 버전의 image·DB 복원본으로 rehearsal하고 schema 변경 후 image tag만 내리는 rollback을 허용하지 않는다. 초기 운영은 유지보수 창을 기본으로 하며 해당 버전 조합에서 검증한 경우에만 rolling upgrade를 사용한다.

Database별 복구 시 `users.id ↔ Keycloak user ID/NameID` 연결과 차단 상태가 서로 다른 시점으로 돌아갈 수 있다. 인증을 닫은 상태에서 양쪽 복구 시점을 확인·대조하고 복원된 GCR session·client grant·API key를 폐기한 뒤 재로그인을 요구한다. 공유 인스턴스 전체 rollback으로 무관한 리뷰 데이터를 되돌리지 않도록 DB별 복구 절차도 마련한다.

## 현재 코드와 구현 단계

현재 구현을 확인한 결과는 다음과 같다. 아래 차이는 환경 변수만으로 해결되지 않는다.

| 현재 상태                                            | 필요한 변경                                                          |
| ---------------------------------------------------- | -------------------------------------------------------------------- |
| Runtime `AUTH_MODE`는 development/local/oidc/proxy   | saml config·SP adapter·login/ACS/metadata/SLO·UI 진입 추가           |
| 웹 session과 `users.oidc_subject` 중심 연결          | identity mapping·SAML transaction/replay·SessionIndex·freshness 저장 |
| OIDC upsert가 role/groups를 갱신                     | SAML identity와 앱 인가 원본 분리, 기존 owner/subject 보존           |
| Helm schema에 saml 없음                              | schema·ConfigMap/Secret·validation·chart test에 saml 추가            |
| Legacy Keycloak helper가 OIDC·자기 PostgreSQL을 강제 | 이 배포에서는 기존 dependency off, 새 companion·공유 DB 사용         |
| Realm bootstrap이 OIDC client·client secret 전제     | SAML metadata·SP 인증서·정확한 callback 구성, 별도 Admin API client  |
| Compose에 PostgreSQL 한 개·개발 기본 사용자          | 두 DB/role provisioning·identity overlay·TLS·non-superuser 전환      |
| Client 전용 bearer grant·key 미구현                  | SAML 웹 session과 별개로 기존 client 인증 계획 구현                  |

확인 근거: [runtime config](../apps/runtime/src/config.ts#L28), [인증·session](../apps/runtime/src/auth/index.ts#L41), [사용자 upsert](../apps/runtime/src/auth/index.ts#L296), [Compose](../compose.yaml#L1), [Helm validator](../deploy/helm/git-code-reviewer/templates/_helpers.tpl#L173), [Helm schema](../deploy/helm/git-code-reviewer/values.schema.json#L359).

| 단계                  | 구현 범위                                                                       | 종료 조건                                                                   |
| --------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| A · 인증 PoC          | 지원 image·SAML 라이브러리 선정, TLS·서명·cookie·persistent identity 검증       | 실제 Keycloak 로그인·logout, 위조·만료·replay·다른 audience 차단            |
| B · DB·배포 기반      | 두 DB/role·기존 볼륨 provisioning, companion/Compose, secret·probe·backup       | PostgreSQL 자원 하나만 배포되고 양방향 cross-DB 접근 실패, 재시작·복원 성공 |
| C · GCR 전환          | SAML runtime/UI, identity mapping, 기존 계정 migration, GCR 사용자 관리 adapter | 기존 이력·개인 메모리·권한 유지, 계정 생성/차단/복구·freshness 검증         |
| D · Local client 연결 | GCR scoped key·PKCE/device flow·broker·폐기 연동                                | SAML assertion 복사 없이 CD 연결·sync, 사용자별 격리·offline fallback 검증  |
| E · 운영 반영         | stage rehearsal·관리자 pilot·점진 전환·모니터링·복구 연습                       | 일반/관리자 로그인, 차단·키 회전·장애·pool 부하 기준 충족 후 확대           |

운영 배포 전에는 특히 cross-replica replay, 로그인 도중 pod 교체, SAML POST cookie 누락, 이메일 변경·계정 재생성 시 owner 혼동, 관리자 claim 주입, Keycloak 직접 차단과 event 수집 중단, DB pool 고갈, 기존 볼륨 유지, backup 복원 후 credential 부활을 검증한다. 운영 가이드의 기존 OIDC·분리 DB 설명은 현재 구현 문서로 남기고 구현 완료 시 SAML 배포 절차를 별도 추가한다.

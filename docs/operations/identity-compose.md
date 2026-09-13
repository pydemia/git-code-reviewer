# Local Compose 인증 환경

`compose.identity.yaml`은 기존 `compose.yaml`에 겹쳐 사용하는 로컬 통합 구성이다. 개발용 자동 인증과 DB·앱 host port를 제거하고 HTTPS proxy, 별도 DB role, optimized Keycloak 2 replica를 연결한다. PostgreSQL 서비스와 논리 volume 이름은 기존 하나를 유지한다. Kubernetes 운영 배포는 [companion chart](../../deploy/helm/gcr-identity/README.md)와 [GCR SAML 설정](saml-web-authentication.md)을 따른다.

Compose 모델, credential/TLS 준비, HTTPS proxy와 명시적 `identity-configure` 작업을 구현했다. 실제 PostgreSQL 17.11·optimized Keycloak 26.7.3 arm64에서 반복 구성, 두 replica와 개별 교체, 같은 volume을 사용한 DB container 재생성, TLS 오류 거부를 검증했다. [검증 기록](../../.documents/execution/preventive-review/evidence/P03-C07-identity-containers.json). GCR image·공개 proxy를 포함한 브라우저 SAML, 기존 운영 볼륨 전환·백업 복원과 운영 배포는 남아 있다.

## 입력과 이미지

Docker Compose 2.24.4 이상이 필요하다. 기본 mapping/ports 병합이 개발 설정을 남기지 않도록 `!override`와 `!reset`을 사용한다. 기존 `compose.yaml`은 수정하지 않는다. [Compose 병합 규칙](https://docs.docker.com/reference/compose-file/merge/).

세 image는 검증한 `repository@sha256:<digest>`로 지정한다. 준비 도구는 tag만 받은 입력을 거부한다. 직접 환경 파일을 작성할 때도 이 조건을 지켜야 하며 Compose 자체가 digest 형식을 검증하는 것은 아니다.

| 변수                 | 요구 조건                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GCR_RUNTIME_IMAGE`  | C06 이후 runtime·DB provisioning CLI를 포함한 image. 기존 alpha.37에는 해당 코드가 없다.                                                               |
| `GCR_IDENTITY_IMAGE` | [optimized Dockerfile](../../deploy/identity/Dockerfile)로 만든 Keycloak 26.7.3 image. 공식 image만 지정하면 사전 augmentation 계약이 성립하지 않는다. |
| `GCR_POSTGRES_IMAGE` | 원래 PostgreSQL 17 data volume과 호환성을 검증한 Docker Official image digest. Alpine/Debian image를 임의 교체하지 않는다.                             |

Entrypoint와 proxy는 checkout 파일을 read-only Compose config로 mount한다. Image 내부 코드와 구분해 검증 기록에 파일 hash를 남긴다. Checkout 변경을 반영할 때는 소비 서비스를 명시적으로 재생성한다.

`KC_HTTP_MANAGEMENT_HEALTH_ENABLED=true`는 optimized image의 빌드 단계에도 지정한다. 실행 단계에만 추가한 image는 Keycloak 26.7.3의 빌드 옵션 불일치 검사에서 종료됐다. Health·metrics·관리 포트 배치를 image와 실행 설정에 함께 고정하며 시작 시 재빌드하지 않는다. [공식 container 빌드 절차](https://www.keycloak.org/server/containers).

새 로컬 환경은 세 image 변수를 검증한 값으로 설정한 뒤 다음 명령으로 준비한다. 이미 존재하는 부모 디렉터리 아래의 새 절대 경로를 지정한다.

```sh
node scripts/prepare-identity-compose.mjs --fresh /absolute/new-identity-directory
```

도구는 저장소 밖의 새 디렉터리만 만든다. 이미 있으면 실패하며 기존 credential을 회전하거나 덮어쓰지 않는다. 임의 `COMPOSE_PROJECT_NAME`을 생성해 기본 개발 프로젝트의 volume을 선택하지 않는다. Docker 서비스·기존 volume·OS trust·`/etc/hosts`는 변경하지 않는다.

`configuration-plan.json`에는 realm, 공개 GCR/IdP origin, private admin origin과 이 환경의 고유 `configurationId`를 기록한다. Plan과 Compose origin이 다르면 구성 작업은 인증 정보를 전송하기 전에 중단한다. 기존 관리 realm의 origin·Entity ID를 바꾸는 작업은 자동 처리하지 않는다. Plan과 credential 파일을 함께 백업하고 재시작·복구 시 동일한 configuration ID를 유지한다.

| 파일                                                                   | 소비 주체                                                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `compose.env`, `database-plan.json`                                    | Compose와 명시적 DBA 작업. 새 plan에는 `legacyOwner`가 없다.                             |
| `dba-password`                                                         | PostgreSQL 최초 DBA와 유지보수 도구                                                      |
| `configuration-plan.json`                                              | 명시적 realm/client 구성 작업. 비밀 원문을 허용하지 않는다.                              |
| `configuration-access-token`                                           | 최초 bootstrap 이후 운영자가 별도로 준비한 관리 access token. 준비 도구가 만들지 않는다. |
| `app-db-password`                                                      | server·worker·retention과 DBA 도구                                                       |
| `migrator-db-password`                                                 | migration과 DBA 도구                                                                     |
| `keycloak-db-password`                                                 | Keycloak과 DBA 도구                                                                      |
| `session-secret`, `sp-signing-key`, `sp-signing-cert`                  | GCR server                                                                               |
| `credential-encryption-key`, `identity-admin-client-secret`            | GCR server·worker                                                                        |
| `proxy-tls-key/cert`, `keycloak-tls-key/cert`, `postgres-tls-key/cert` | 각 HTTPS proxy·private Keycloak HTTPS·PostgreSQL TLS                                     |
| `bootstrap-admin-username/password`                                    | bootstrap overlay를 지정한 Keycloak만                                                    |
| `ca.crt`, `ca.key`                                                     | CA bundle은 검증에 사용한다. CA private key는 어떤 container에도 mount하지 않는다.       |

새 디렉터리는 0700, private 소비 파일은 0640, CA private key는 0600이다. `GCR_SECRET_GID`는 실제 생성 파일의 group이며 non-root 소비 container에 보조 group으로 추가한다. 파일 기반 Compose secret은 bind mount이므로 uid/gid/mode 속성만 지정해 소유권이 변한다고 가정하지 않는다. 기존 파일 permission을 변경하는 기능은 없다. 실제 Docker 파일 접근은 container 시험에서 확인해야 한다. [Compose secrets](https://docs.docker.com/compose/how-tos/use-secrets/).

CA는 로컬 환경 전용이다. TLS leaf와 별도 SAML SP 인증서는 90일 유효하며 재시작 시 자동 재생성하지 않는다. Node와 Keycloak은 mount한 CA를 사용하고 PostgreSQL은 hostname을 검증하는 TLS 연결을 받는다. Browser는 승인한 로컬 CA와 DNS 설정이 별도로 필요하다. 기본 주소는 `https://gcr.test:8443`과 `https://identity.test:8443`이며 준비 시 `GCR_PUBLIC_HOST`, `GCR_IDENTITY_HOST`, `GCR_HTTPS_PORT`로 변경할 수 있다.

## 기존 PostgreSQL volume

`--fresh`에서 만든 비밀번호를 기존 volume에 적용하지 않는다. 기존 volume은 `POSTGRES_USER` 환경 변수를 바꿔도 DBA role이 생성되지 않는다. 기존 credential·데이터 백업과 복원 검증을 마친 뒤 별도 DBA를 먼저 준비하고 [shared PostgreSQL 절차](shared-postgresql.md)를 따른다.

기존 Compose project 이름과 `git-code-reviewer-postgres` 논리 volume의 실제 이름을 대조한다. 별도 DBA·기존 비밀번호 파일·승인된 TLS material로 입력 디렉터리를 구성하고 plan의 `legacyOwner`에 퇴역할 기존 앱 login을 지정한다. Entrypoint는 image major와 `PG_VERSION` 모두 17인지 검사한다. 이는 major 변경 방지이며 배포판·collation·extension 호환성의 증거는 아니다.

DBA 적용 시 기존 app·worker·Keycloak 연결이 없어야 한다. Worker의 3600초 종료 유예를 존중하고 임의로 kill하지 않는다. 현재 로컬 overlay의 `max_connections=100`과 기존 설정이 다른 경우 전환 전에 연결 예산과 설정을 맞춘다. Volume 삭제나 무관한 instance 설정 변경으로 전환 문제를 해결하지 않는다.

## 명시적 시작 순서

항상 같은 환경 파일과 Compose file 집합을 사용한다. 먼저 병합 검증만 실행한다.

```sh
docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml config --quiet
```

선택한 HTTPS port와 identity bridge `172.29.240.0/27`의 기존 사용 여부를 확인한다. Proxy 고정 IP는 `.2`, gateway는 `.1`, Keycloak 동적 IP 범위는 `.16/28`이다. 필요하면 `GCR_IDENTITY_SUBNET`, `GCR_IDENTITY_IP_RANGE`, `GCR_IDENTITY_GATEWAY`, `GCR_PROXY_IDENTITY_IP`를 일관되게 설정한다. 다른 Docker network를 제거하지 않는다.

준비된 새 환경 또는 유지보수 창에서 PostgreSQL을 시작한다. `identity-db-provision`은 자동 dependency가 아니며 기본 command는 `--inspect`다.

```sh
docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml up -d --wait --wait-timeout 600 postgres

docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml --profile identity-ops \
  run --rm --no-deps identity-db-provision
```

결과의 대상 DB·role·소유권·ACL·연결 예산을 확인한 뒤 명시적 적용을 선택한다.

```sh
docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml --profile identity-ops \
  run --rm --no-deps identity-db-provision --apply /run/config/database/plan.json

docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml run --rm --no-deps migrate
```

최초 Keycloak bootstrap에만 추가 파일을 지정한다. 이때 1 replica와 임시 master 관리자 credential을 사용한다. 정상 시작 파일에는 bootstrap credential mount가 없다.

```sh
docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml -f compose.identity.bootstrap.yaml \
  up -d keycloak identity-proxy
```

다음 명령으로 realm/client의 변경 예정 항목을 조회한다. `--inspect`의 종료 코드 0은 조회 성공을 뜻하며 구성 완료 여부는 JSON의 `converged`로 확인한다.

```sh
docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml -f compose.identity.bootstrap.yaml \
  --profile identity-ops run --rm --no-deps identity-configure

docker compose --env-file /absolute/new-identity-directory/compose.env \
  -f compose.yaml -f compose.identity.yaml -f compose.identity.bootstrap.yaml \
  --profile identity-ops run --rm --no-deps identity-configure \
  --apply /run/config/identity/plan.json
```

새 realm은 비활성으로 생성한다. 정확한 ACS/SLO·persistent NameID·요청/응답/assertion 서명, service account의 `manage-users`/`view-events` role/scope, `ADMIN_EDIT` user profile과 보안 event store를 적용하고 다시 조회한 뒤 활성화한다. 설정이 확인되지 않으면 비활성 상태에 남으며 다음 명시적 실행에서 이어간다. 이미 정상 운영 중인 realm/client가 비활성인 경우 자동으로 재활성화하지 않는다.

관리 client의 기본 client scope는 `basic`, `roles`, `service_account`다. `basic`은 C05 수집기가 확인하는 서비스 계정 `sub` claim을 제공한다. Keycloak 26.7.3이 자동으로 연결하는 `service_account`도 기대 구성에 포함한다. Scope와 URI 집합의 반환 순서는 비교에서 제외하며 추가 항목·누락·잘못된 타입은 여전히 불일치로 처리한다. 관리 role은 `manage-users`와 `view-events`만 부여한다. [해당 버전의 기본 scope 구현](https://raw.githubusercontent.com/keycloak/keycloak/26.7.3/services/src/main/java/org/keycloak/protocol/oidc/OIDCLoginProtocolFactory.java).

기존 realm/client는 관리 표식과 origin/Entity ID가 일치해야 한다. 표식이 없거나 client secret이 다르면 덮어쓰지 않는다. 추가 관리 권한·group·외부 client mapping·custom protocol mapper·사용자가 편집할 수 있는 identity 속성·진행 중 client-secret rotation도 중단 조건이다. 원인을 확인한 뒤 별도 운영 절차로 수정해야 하며 자동 adoption·realm import·user CRUD·key 생성·secret rotation으로 해결하지 않는다.

정상 상태에서 재실행하면 변경 목록이 비어 있다. Secret을 포함하는 쓰기 전에 target realm의 admin event details 비활성을 확인한다. Client secret은 생성 때만 전달하고 재실행 시 기존 값과 비교한다. 모든 변경 후 readback을 검사한다. 여러 관리 작업이나 운영자 변경과 동시에 실행하지 않는다. Keycloak Admin API는 이 작업 전체를 하나의 transaction이나 compare-and-swap으로 묶지 않으므로 유지보수 중 단일 실행자로 사용한다. [26.7.3 Admin API](https://www.keycloak.org/docs-api/26.7.3/rest-api/index.html).

최초 bootstrap 이후에는 추가 bootstrap 파일을 제외하고 `configuration-access-token` 파일에 명명된 운영자가 승인한 짧은 수명의 관리 token을 준비해 같은 명령을 실행한다. Normal configurer는 해당 token만 사용하며 GCR runtime에는 전달하지 않는다. Token 파일은 다른 private 소비 파일처럼 0640과 같은 group을 사용한다. Bootstrap 모드가 만든 자체 로그인 session에만 종료 시 logout을 요청하며 실패하면 작업도 실패로 보고한다. 운영자가 제공한 token의 session은 건드리지 않는다. Private 관리자 로그인·MFA·복구 경로 검증은 C08에서 마쳐야 한다.

구성 작업은 CA와 hostname을 검증하는 private HTTPS만 사용하고 redirect를 따르지 않는다. 요청 한도는 30초, 전체 작업 한도는 10분이며 응답은 512 KiB 이하의 JSON만 읽는다. 응답 불명 쓰기는 자동 재전송하지 않는다. 다음 명시적 실행에서 소유 표식·client ID·secret과 현재 상태를 다시 확인한다. 오류·결과에는 비밀번호·token·upstream body를 기록하지 않는다.

구성과 metadata 신뢰, 관리 API 권한의 실제 token, 공유 DB와 proxy를 거친 브라우저 동작을 확인한 뒤 server·worker를 시작한다. 아래 infrastructure 시험은 공개 proxy와 GCR server·worker를 시작하지 않으므로 브라우저 통합 gate가 별도로 필요하다.

명명된 운영자·MFA·복구 경로를 확인하고 임시 관리자를 제거한 뒤 bootstrap 파일 없이 Keycloak을 명시적으로 재생성해 2 replica로 전환한다. 환경 변수만 제거해도 기존 DB의 관리자 계정이 삭제되지는 않는다. 로그인 중 replica 교체·계정/서명 key 보존·SMTP·C08 복구까지 검증해야 전환을 완료할 수 있다.

## SMTP 입력

새 plan에는 SMTP 주소나 credential을 추정해 넣지 않는다. 승인된 SMTP가 준비되면 `configuration-plan.json`의 `smtp`에 `host`, 정수 `port`, `from`, `tls` (`starttls` 또는 `tls`), 변경 식별자인 `revision`을 추가한다. `fromDisplayName`과 인증이 필요한 경우의 `username`은 선택 값이다. 같은 revision으로 host/from/TLS/user 값이 달라지면 중단한다. SMTP 설정이나 비밀번호를 변경할 때는 revision도 명시적으로 변경한다.

비밀번호는 plan에 넣지 않는다. SMTP 인증을 사용할 때만 별도 0640 `smtp-password` 파일을 준비하고 Compose file 목록의 마지막에 `-f compose.identity.smtp.yaml`을 추가한다. 이 overlay는 configurer 한 곳에만 해당 파일을 mount한다. 같은 revision과 설정으로 재실행하면 SMTP 비밀번호를 다시 쓰지 않는다. 인증 없는 승인된 TLS relay에는 SMTP credential overlay가 필요하지 않다.

SMTP가 plan에 없으면 기존 SMTP 설정을 유지하고 결과에 `unmanaged-delivery-unverified`를 표시한다. 구성했어도 `configured-delivery-unverified`다. 이 명령은 테스트 메일을 발송하지 않으며 실제 발신 도메인·TLS·수신함 도착은 별도로 검증해야 한다.

## 네트워크·종료·검증

DB bridge를 app·migration·identity·DBA로 나눠 migrator·retention·DBA 도구가 Keycloak과 bridge를 공유하지 않게 한다. Server와 worker는 private `https://keycloak:8443/admin/realms/git-code-reviewer`와 public issuer token endpoint를 사용한다. 공개 hostname은 proxy의 application bridge alias로 연결되며 host와 container port를 동일하게 사용한다.

Proxy는 auth hostname에서 `/realms/git-code-reviewer`와 `/resources` 경계가 맞는 경로만 전달한다. `/admin`, `/realms/master`, `/health`, `/metrics`와 중복 Host·우회 path를 차단하고 전달 헤더를 다시 작성한다. SAML POST·Set-Cookie·Location·SSE를 보존한다. 현재 GCR은 SSE를 사용하며 이 proxy는 WebSocket upgrade를 지원하지 않는다. Proxy health는 CA/hostname을 검증한 자체 TLS listener 상태로, backend 준비 완료를 뜻하지 않는다.

Compose bridge는 Kubernetes NetworkPolicy의 per-port/CIDR 제한을 제공하지 않는다. 같은 bridge의 신뢰 주체는 상대의 다른 listening port에도 연결할 수 있다. `application-egress`와 `identity-egress`는 provider·SMTP 외 목적지를 자동 제한하지 않으므로 별도 host 정책과 승인된 relay가 필요하다. 이 구성을 운영 CNI 격리 증거로 사용하지 않는다.

Keycloak readiness는 관리 port 9000에서 확인한다. Compose는 startup/readiness/liveness를 각각 구현하지 않으며 unhealthy 상태만으로 자동 재시작하지 않는다. 종료 유예는 Keycloak·PostgreSQL·server·proxy 120초, worker 3600초다. Keycloak pool은 replica당 6개, plan은 교체·종료 중인 replica까지 5 × 6 = 30개를 산정한다. App pool은 server·worker당 6개로 기존 role 예산 42 안에 둔다. 증설·연속 교체는 별도 산정해야 한다.

PostgreSQL healthcheck는 TCP listener를 확인한다. 최초 initdb가 사용하는 임시 Unix socket 서버만 열린 상태를 준비 완료로 취급하지 않는다.

```sh
node scripts/verify-identity-proxy.mjs
node scripts/verify-identity-compose.mjs
node scripts/verify-identity-configuration.mjs
```

Node 22와 OpenSSL, Docker Compose, 빌드된 runtime이 필요하다. Proxy 시험은 실제 Node HTTPS listener와 HTTP fixture backend를 사용한다. Compose 시험은 temporary credential/CA로 모델을 render하고 네 command의 compiled config를 읽으며 SAML metadata 응답은 fixture다. Docker 서비스·운영 DB·Keycloak·OS trust를 변경하지 않고 끝나면 임시 private 파일을 제거한다. `GCR_IDENTITY_PROXY_EVIDENCE`, `GCR_IDENTITY_COMPOSE_EVIDENCE`에 새 파일 경로를 지정하면 비밀 원문 없는 JSON을 저장한다.

Configuration 시험은 상태를 유지하는 Admin API fixture로 재실행·중단 복구·쓰기 범위·충돌 거부를 검사한다. 실제 Node HTTPS에서는 TLS 거부·redirect/응답 제한·timeout·bootstrap session 정리와 CLI `inspect/apply`를 확인한다. Keycloak의 sparse representation에 맞춰 비활성 `authorizationServicesEnabled`의 생략을 처리하되 필요한 다른 boolean의 누락은 허용하지 않는다. [해당 버전 응답 생성 코드](https://raw.githubusercontent.com/keycloak/keycloak/26.7.3/server-spi-private/src/main/java/org/keycloak/models/utils/ModelToRepresentation.java). `GCR_IDENTITY_CONFIGURATION_EVIDENCE`에는 새 결과 파일 경로를 지정한다.

실제 Compose infrastructure 시험은 다음처럼 로컬에 있는 optimized image의 digest를 명시해 실행한다.

```sh
GCR_IDENTITY_IMAGE='<verified-local-repository>@sha256:<digest>' \
  node scripts/verify-identity-containers.mjs
```

이 시험은 새 Compose project·PostgreSQL 17 volume·임시 CA/credential을 만들고 실제 adapter·DBA CLI·Keycloak·구성 CLI를 실행한다. 생성한 realm의 계정·비밀번호·서명 key·client ID를 반복 구성, 두 replica 전환과 개별 교체, PostgreSQL container 재생성 전후에 비교한다. 각 replica를 직접 지정해 검사하며 잘못된 DB CA·hostname의 기동 실패도 확인한다. 종료 시 해당 project의 container·network·volume과 private 파일을 제거한다. 인증 관리 작업은 pinned Node 22 image를 사용하고 DBA CLI는 현재 checkout의 빌드 결과를 read-only로 mount한다. GCR server·worker image, 공개 proxy·브라우저 SAML, 기존 운영 볼륨 전환·백업 복원·SMTP 전달 검증은 별도다.

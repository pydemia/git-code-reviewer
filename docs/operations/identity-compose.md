# Local Compose 인증 환경

`compose.identity.yaml`은 기존 `compose.yaml`에 겹쳐 사용하는 로컬 통합 구성이다. 개발용 자동 인증과 DB·앱 host port를 제거하고 HTTPS proxy, 별도 DB role, optimized Keycloak 2 replica를 연결한다. PostgreSQL 서비스와 논리 volume 이름은 기존 하나를 유지한다. Kubernetes 운영 배포는 [companion chart](../../deploy/helm/gcr-identity/README.md)와 [GCR SAML 설정](saml-web-authentication.md)을 따른다.

현재 checkpoint는 Compose 모델, credential/TLS 준비 도구, entrypoint와 HTTPS proxy 구현까지다. 재실행 가능한 `identity-configure` realm/client 작업, 이 overlay의 실제 PostgreSQL 기존 볼륨 전환·Keycloak 2 replica·브라우저 SAML 시험은 남아 있다. 전체 stack을 바로 시작해 로그인할 수 있는 완료 상태로 취급하지 않는다.

## 입력과 이미지

Docker Compose 2.24.4 이상이 필요하다. 기본 mapping/ports 병합이 개발 설정을 남기지 않도록 `!override`와 `!reset`을 사용한다. 기존 `compose.yaml`은 수정하지 않는다. [Compose 병합 규칙](https://docs.docker.com/reference/compose-file/merge/).

세 image는 검증한 `repository@sha256:<digest>`로 지정한다. 준비 도구는 tag만 받은 입력을 거부한다. 직접 환경 파일을 작성할 때도 이 조건을 지켜야 하며 Compose 자체가 digest 형식을 검증하는 것은 아니다.

| 변수                 | 요구 조건                                                                                                                                              |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GCR_RUNTIME_IMAGE`  | C06 이후 runtime·DB provisioning CLI를 포함한 image. 기존 alpha.37에는 해당 코드가 없다.                                                               |
| `GCR_IDENTITY_IMAGE` | [optimized Dockerfile](../../deploy/identity/Dockerfile)로 만든 Keycloak 26.7.3 image. 공식 image만 지정하면 사전 augmentation 계약이 성립하지 않는다. |
| `GCR_POSTGRES_IMAGE` | 원래 PostgreSQL 17 data volume과 호환성을 검증한 Docker Official image digest. Alpine/Debian image를 임의 교체하지 않는다.                             |

Entrypoint와 proxy는 checkout 파일을 read-only Compose config로 mount한다. Image 내부 코드와 구분해 검증 기록에 파일 hash를 남긴다. Checkout 변경을 반영할 때는 소비 서비스를 명시적으로 재생성한다.

새 로컬 환경은 세 image 변수를 검증한 값으로 설정한 뒤 다음 명령으로 준비한다. 이미 존재하는 부모 디렉터리 아래의 새 절대 경로를 지정한다.

```sh
node scripts/prepare-identity-compose.mjs --fresh /absolute/new-identity-directory
```

도구는 저장소 밖의 새 디렉터리만 만든다. 이미 있으면 실패하며 기존 credential을 회전하거나 덮어쓰지 않는다. 임의 `COMPOSE_PROJECT_NAME`을 생성해 기본 개발 프로젝트의 volume을 선택하지 않는다. Docker 서비스·기존 volume·OS trust·`/etc/hosts`는 변경하지 않는다.

| 파일                                                                   | 소비 주체                                                                          |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `compose.env`, `database-plan.json`                                    | Compose와 명시적 DBA 작업. 새 plan에는 `legacyOwner`가 없다.                       |
| `dba-password`                                                         | PostgreSQL 최초 DBA와 유지보수 도구                                                |
| `app-db-password`                                                      | server·worker·retention과 DBA 도구                                                 |
| `migrator-db-password`                                                 | migration과 DBA 도구                                                               |
| `keycloak-db-password`                                                 | Keycloak과 DBA 도구                                                                |
| `session-secret`, `sp-signing-key`, `sp-signing-cert`                  | GCR server                                                                         |
| `credential-encryption-key`, `identity-admin-client-secret`            | GCR server·worker                                                                  |
| `proxy-tls-key/cert`, `keycloak-tls-key/cert`, `postgres-tls-key/cert` | 각 HTTPS proxy·private Keycloak HTTPS·PostgreSQL TLS                               |
| `bootstrap-admin-username/password`                                    | bootstrap overlay를 지정한 Keycloak만                                              |
| `ca.crt`, `ca.key`                                                     | CA bundle은 검증에 사용한다. CA private key는 어떤 container에도 mount하지 않는다. |

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

다음 단계는 전용 realm·서명된 SAML client·`manage-users`/`view-events` service account·보호 profile·event store·SMTP 구성과 readback이다. 해당 `identity-configure` 작업은 후속 구현 대상이다. 사용자·realm signing key·기존 credential을 삭제/재생성하는 realm import로 대체하지 않는다. 구성과 metadata 신뢰를 확인하기 전에는 server·worker를 시작하지 않는다.

명명된 운영자·MFA·복구 경로를 확인하고 임시 관리자를 제거한 뒤 bootstrap 파일 없이 Keycloak을 명시적으로 재생성해 2 replica로 전환한다. 환경 변수만 제거해도 기존 DB의 관리자 계정이 삭제되지는 않는다. 로그인 중 replica 교체·계정/서명 key 보존·SMTP·C08 복구까지 검증해야 전환을 완료할 수 있다.

## 네트워크·종료·검증

DB bridge를 app·migration·identity·DBA로 나눠 migrator·retention·DBA 도구가 Keycloak과 bridge를 공유하지 않게 한다. Server와 worker는 private `https://keycloak:8443/admin/realms/git-code-reviewer`와 public issuer token endpoint를 사용한다. 공개 hostname은 proxy의 application bridge alias로 연결되며 host와 container port를 동일하게 사용한다.

Proxy는 auth hostname에서 `/realms/git-code-reviewer`와 `/resources` 경계가 맞는 경로만 전달한다. `/admin`, `/realms/master`, `/health`, `/metrics`와 중복 Host·우회 path를 차단하고 전달 헤더를 다시 작성한다. SAML POST·Set-Cookie·Location·SSE를 보존한다. 현재 GCR은 SSE를 사용하며 이 proxy는 WebSocket upgrade를 지원하지 않는다. Proxy health는 CA/hostname을 검증한 자체 TLS listener 상태로, backend 준비 완료를 뜻하지 않는다.

Compose bridge는 Kubernetes NetworkPolicy의 per-port/CIDR 제한을 제공하지 않는다. 같은 bridge의 신뢰 주체는 상대의 다른 listening port에도 연결할 수 있다. `application-egress`와 `identity-egress`는 provider·SMTP 외 목적지를 자동 제한하지 않으므로 별도 host 정책과 승인된 relay가 필요하다. 이 구성을 운영 CNI 격리 증거로 사용하지 않는다.

Keycloak readiness는 관리 port 9000에서 확인한다. Compose는 startup/readiness/liveness를 각각 구현하지 않으며 unhealthy 상태만으로 자동 재시작하지 않는다. 종료 유예는 Keycloak·PostgreSQL·server·proxy 120초, worker 3600초다. Keycloak pool은 replica당 6개, plan은 교체·종료 중인 replica까지 5 × 6 = 30개를 산정한다. App pool은 server·worker당 6개로 기존 role 예산 42 안에 둔다. 증설·연속 교체는 별도 산정해야 한다.

```sh
node scripts/verify-identity-proxy.mjs
node scripts/verify-identity-compose.mjs
```

Node 22와 OpenSSL, Docker Compose, 빌드된 runtime이 필요하다. Proxy 시험은 실제 Node HTTPS listener와 HTTP fixture backend를 사용한다. Compose 시험은 temporary credential/CA로 모델을 render하고 네 command의 compiled config를 읽으며 SAML metadata 응답은 fixture다. Docker 서비스·운영 DB·Keycloak·OS trust를 변경하지 않고 끝나면 임시 private 파일을 제거한다. `GCR_IDENTITY_PROXY_EVIDENCE`, `GCR_IDENTITY_COMPOSE_EVIDENCE`에 새 파일 경로를 지정하면 비밀 원문 없는 JSON을 저장한다.

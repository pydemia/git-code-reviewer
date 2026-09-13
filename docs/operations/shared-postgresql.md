# 공유 PostgreSQL DB·역할 분리

P03-C06의 DBA provisioning 도구다. 단일 PostgreSQL cluster에 GCR과 Keycloak DB를 분리한다. 기존 볼륨에서도 명시적으로 실행하며 image entrypoint의 최초 초기화에 의존하지 않는다. 이 도구를 앱 시작 시 자동 실행하지 않는다.

DBA 도구와 runtime의 TLS·역할 검사, 서버·워커/retention과 migration의 Secret 분리를 구현했다. Compose overlay·companion chart 연결, 운영 DB 전환과 복구 검증은 남아 있다. PRISM-DEV에 이 도구를 적용한 상태가 아니다.

## 권한 계약

| 주체           | Database                     | Schema·객체 권한                                                                                      |
| -------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `gcr_app`      | `git_code_reviewer`          | public schema USAGE, 앱 table SELECT/INSERT/UPDATE/DELETE, sequence USAGE/SELECT, 앱 function EXECUTE |
| `gcr_migrator` | `git_code_reviewer`          | public schema와 앱 객체 소유, migration 전용                                                          |
| `gcr_keycloak` | `git_code_reviewer_keycloak` | public schema와 자기 객체 소유, Keycloak migration 수행                                               |
| 별도 DBA       | 관리 DB 및 두 앱 DB          | Database 소유, role·DB provisioning과 복구                                                            |

Database 소유자는 DBA로 유지한다. Migrator와 Keycloak에는 자기 public schema의 소유권을 부여하므로 새 schema나 DB를 만들 권한은 없다. 이 구성은 설계의 DB별 migration 경계를 schema 소유권으로 구현한다.

세 managed role은 LOGIN·NOINHERIT·NOSUPERUSER·NOCREATEDB·NOCREATEROLE·NOREPLICATION·NOBYPASSRLS다. 상호 membership과 다른 role로의 membership을 허용하지 않는다. GCR 앱은 table 소유권, TRUNCATE, trigger 생성, migration ledger 변경, TEMP 권한을 받지 않는다. `schema_migrations`는 SELECT만 허용한다.

두 앱 DB와 관리 DB·template DB의 PUBLIC CONNECT/TEMP를 회수하고 각 managed role에 해당 앱 DB의 CONNECT만 부여한다. `postgres`, `template1`에도 앱 계정으로 접속할 수 없다. Schema PUBLIC 권한과 table·column·sequence·function의 기존 grant를 정리한다. 새 migrator 객체에 대한 기본 권한도 설정한다. Global default privilege는 global 범위에서 회수해야 한다. [PostgreSQL 권한](https://www.postgresql.org/docs/17/ddl-priv.html), [기본 권한 변경](https://www.postgresql.org/docs/17/sql-alterdefaultprivileges.html).

Cluster 전역의 `REASSIGN OWNED`를 사용하지 않는다. 기존 public table/view/materialized view/sequence/function의 소유권을 개별 전환하며 index·owned sequence는 연결된 table을 따른다. 기존 migration SQL과 checksum, 앱 데이터, Keycloak 데이터는 수정하지 않는다.

## 실행 전제

- GCR·Keycloak 전용 cluster여야 한다. 대상 DB·관리 DB·postgres·template0/1 이외 DB가 있으면 중단한다. 다른 서비스와 공유하는 cluster의 ACL을 이 도구로 일괄 변경하지 않는다.
- 별도 DBA superuser로 관리 DB에 접속한다. 기존 앱 계정과 동일한 DBA credential을 사용하지 않는다. Compose의 초기 앱 계정이 superuser인 경우 먼저 별도 DBA를 준비한다.
- 이미 적용한 backup과 복구 절차를 확인하고 maintenance window에서 실행한다. 서버·워커·retention·migration·Keycloak을 중지하고 모든 기존 연결이 닫힐 때까지 기다린다. 종료 유예 중인 worker도 포함한다. 다른 DBA 변경도 같은 시간에 수행하지 않는다.
- `legacyOwner`에는 퇴역시킬 기존 GCR login을 지정한다. 새 cluster에는 이 필드를 생략한다. 이 role의 비밀번호는 바꾸지 않지만 적용 후 NOLOGIN으로 남는다. Membership이 있으면 자동 제거하지 않고 중단한다.
- 예상하지 못한 role marker·상승된 속성·role 설정·parameter/tablespace grant·소유권·ACL·schema·extension·사용자 type·foreign server·large object·SECURITY DEFINER routine·event trigger가 있으면 중단한다. 현재 GCR migration과 기본 Keycloak public schema를 대상으로 하며 범용 PostgreSQL 이관 도구가 아니다.

Role 이름은 `gcr_app`, `gcr_migrator`, `gcr_keycloak`으로 고정한다. 기존 managed role은 해당 두 DB에 대한 도구의 marker와 안전한 속성이 있어야 한다. 기존 DB 이름을 잘못 지정해 빈 신규 DB로 옮겨 가는 일을 피하도록 실행 전 read-only 결과에서 대상 DB와 객체 목록을 확인한다.

## 명령과 Secret

먼저 `pnpm --filter @gcr/db build`로 CLI를 빌드한다. 동일 파일은 runtime image의 `/app/packages/db/dist/provision-cli.js`에도 포함된다. 기본 앱 entrypoint와 별개의 명령이다.

다음 환경 변수는 DBA 작업에만 전달한다. CLI는 credential 값을 인자로 받지 않으며 결과와 오류에 비밀번호·접속 URL·CA 내용을 출력하지 않는다.

| 변수                               | 값                                               |
| ---------------------------------- | ------------------------------------------------ |
| `GCR_DBA_HOST`, `GCR_DBA_PORT`     | PostgreSQL TLS hostname·port                     |
| `GCR_DBA_DATABASE`, `GCR_DBA_USER` | 관리 DB·별도 DBA login                           |
| `GCR_DBA_PASSWORD_FILE`            | DBA 비밀번호 파일                                |
| `GCR_DBA_CA_FILE`                  | DB 서버 CA PEM 파일, hostname과 인증서 검증 유지 |
| `GCR_APP_PASSWORD_FILE`            | 새 GCR runtime 비밀번호 파일                     |
| `GCR_MIGRATOR_PASSWORD_FILE`       | 새 GCR migration 비밀번호 파일                   |
| `GCR_KEYCLOAK_PASSWORD_FILE`       | 새 Keycloak DB 비밀번호 파일                     |

Read-only 검사에는 DBA 파일만 필요하다. `--apply`에는 세 role의 파일도 필요하다. 비밀번호는 공백 없는 printable ASCII 24–256자로 준비하며 세 role과 DBA가 같은 값을 재사용하지 않는다. SQL에는 평문 대신 client에서 만든 SCRAM-SHA-256 verifier를 전달한다. 파일·환경을 로그에 덤프하지 않는다.

```sh
node packages/db/dist/provision-cli.js --inspect deploy/postgres/shared-plan.example.json
node packages/db/dist/provision-cli.js --apply deploy/postgres/shared-plan.example.json
```

예시 plan을 환경에 맞게 복사·수정해 사용한다. 명령은 위 표의 환경과 Secret 파일이 이미 준비된 상태를 전제로 한다. 예시 파일에 비밀번호를 넣지 않는다. DBA Secret은 서버·워커·Keycloak Pod에 mount하지 않는다.

평문 연결은 격리된 loopback fixture에 한해 `GCR_DBA_ALLOW_LOOPBACK_PLAINTEXT=true`로 명시할 수 있다. Host가 `127.0.0.1`, `::1`, `localhost`일 때만 허용한다. Cluster 서비스 hostname에는 이 예외가 적용되지 않는다.

## Runtime 연결과 migration 대기

`DATABASE_ISOLATED_ROLES=true`이면 서버·워커·retention·`wait-migrations`는 `gcr_app`, `migrate`는 `gcr_migrator`로 접속한다. `migrate`에는 `MIGRATION_DATABASE_URL` 또는 `MIGRATION_DATABASE_HOST/PORT/NAME/USER/PASSWORD_FILE`을 별도로 전달한다. 설정이 없거나 불완전하면 앱 credential로 대체하지 않는다. 앱 command에 `MIGRATION_DATABASE_*`를 전달해도 시작을 거부한다.

TLS는 `DATABASE_TLS_MODE=verify-full`과 `DATABASE_TLS_CA_FILE`로 설정한다. Migrator만 다른 CA가 필요하면 `MIGRATION_DATABASE_TLS_CA_FILE`로 지정할 수 있다. CA chain과 설정한 DNS hostname 또는 IP SAN을 모두 검사한다. 연결 URL의 `sslmode`, `sslrootcert`, `host`, `user`, `password` 같은 override를 허용하지 않는다. 격리 모드 URL은 `application_name`만 추가할 수 있다. `DATABASE_TLS_MODE=legacy`·역할 분리 비활성 기본값은 기존 연결 방식을 유지한다.

Pool이 새 연결을 앱에 넘기기 전에 실제 session/current role, TLS, DB·schema 소유권, role 속성·membership, 다른 DB의 CONNECT, parameter 권한과 앱의 DDL·migration ledger 쓰기 권한을 검사한다. 검사 실패 연결은 폐기한다. 실제 role의 connection limit이 그 프로세스의 pool보다 작아도 시작하지 않는다. 이미 열린 연결의 권한을 주기적으로 감사하는 기능은 아니므로 운영 중 권한 변경은 별도 DBA 절차로 관리한다.

`wait-migrations`는 배포 image의 SQL 파일 이름·SHA-256과 ledger를 조회한다. 누락된 migration은 기본 10분 동안 기다리고 기존 checksum이 바뀌면 즉시 실패한다. 구 image가 rolling upgrade 중 재시작할 수 있도록 더 높은 version의 ledger row는 허용한다. SQL의 하위 호환성을 대신 검증하지는 않는다. 제한 시간은 `MIGRATIONS_WAIT_TIMEOUT_MS`로 100–900000ms 사이에서 지정한다. DB 연결·조회에 걸린 제한 시간만큼 최종 종료가 늦어질 수 있다.

CA와 비밀번호 파일은 프로세스 시작 시 읽는다. Secret/ConfigMap 내용만 변경해도 기존 pool이 새 값을 읽지는 않는다. 교체 후 서버·워커를 정상 종료 유예를 지켜 재시작하고 신규 migration/retention Job도 새 값을 읽는지 확인한다.

## Helm 적용 순서

[격리 overlay 예시](../../deploy/postgres/isolated-helm.example.yaml)는 기존 환경 values 위에 적용하는 DB 설정이다. Runtime Secret, migrator Secret, PostgreSQL bootstrap Secret과 TLS private-key Secret을 분리하며 앱에는 CA ConfigMap만 mount한다. 예시의 HBA는 Unix socket 연결과 SCRAM으로 인증하는 TLS TCP 연결을 허용하고 평문 TCP를 거부한다. 기존 bootstrap 설정과 PVC는 유지한다. 인증서 SAN에는 실제로 접속할 서비스 이름을 포함해야 한다.

역할 분리 모드에서는 Deployment init container가 앱 credential로 `wait-migrations`만 실행한다. 전용 migration Job에만 migrator Secret을 mount한다. 외부 PostgreSQL은 `pre-install,pre-upgrade`, 번들 PostgreSQL upgrade는 `pre-upgrade` hook을 사용한다. 번들 최초 install의 Job은 PostgreSQL과 함께 생성되는 일반 Job이며 미리 준비한 DBA provisioning을 기다릴 수 있다. 최초 설치에도 별도 DBA provisioning 실행이 필요하다.

기존 번들 DB를 전환할 때는 **백엔드 TLS 준비와 역할 전환을 한 Helm upgrade에 몰아넣지 않는다**. `pre-upgrade` migration은 PostgreSQL StatefulSet 갱신보다 먼저 실행되므로 아직 TLS가 없는 DB에는 새 TLS credential로 연결할 수 없다.

1. Backup과 복구 검증 후 기존 앱 설정을 유지한 채 PostgreSQL 인증서를 설치하고 TLS를 활성화한다. 이 단계에는 기존 평문 앱 접속이 계속 필요할 수 있다. 실제 TLS·SAN 검증을 통과한 뒤 앱 연결을 verify-full로 전환한다.
2. Maintenance에서 모든 앱·worker drain·retention·migration·Keycloak 연결을 닫고 별도 DBA로 inspect/apply를 실행한다. 기존 값과 새 비밀번호 파일·plan이 일치하는지 확인한다.
3. Backend HBA의 평문 접속 거부를 확인한 뒤 역할별 Secret과 격리 overlay로 앱을 올린다. Migration Job·앱 대기·서버·워커·retention과 데이터 보존을 검증한다.

예시는 이 최종 상태를 나타내며 전환 자체를 자동화하지 않는다. 운영에 쓰는 Bitnami image의 persisted-volume 재시작이 퇴역한 login을 다시 활성화하거나 소유권·권한을 바꾸지 않는지도 전환 전에 검사해야 한다. 이 checkpoint의 격리 테스트는 공식 PostgreSQL image를 사용하며 그 Bitnami 동작을 증명하지 않는다.

Chart는 Secret 재사용·누락된 CA·비활성 번들 TLS·너무 작은 pool·rollout peak 누락·합산 connection 한도 초과를 거부한다. Worker pool은 `worker.databasePoolMax`로 지정하거나 서버 값을 상속한다. 두 Deployment는 격리 모드에서 `maxSurge: 1`, `maxUnavailable: 0`을 사용한다. 종료 유예 중인 worker가 여럿이면 실제 peak에 맞춰 budget을 늘리거나 이전 worker 종료를 기다린다.

오프라인 연결 명세 검증은 Helm과 Python 3·PyYAML이 필요하다. `python3 scripts/verify-shared-database-chart.py --baseline af7df5038956e2cb45d3f69a7094190cdf5f8097`은 Secret/CA·역할·pool·hook 배치와 기존 비활성 기본값의 명세 보존을 검사한다. Cluster에는 접속하지 않는다.

## 재실행과 중간 실패

Read-only 검사와 초기 검사에서는 DB를 변경하지 않는다. 다른 provisioner는 PostgreSQL advisory lock으로 배제한다. 초기 검사를 통과하면 managed login과 legacy login을 잠시 비활성화하고 새 연결과 경합한 세션을 다시 검사한다. 연결을 강제 종료하지 않는다. 세션이 남아 있으면 작업을 중단하고 유지 보수 상태를 유지한다.

Database 생성은 transaction 안에서 수행할 수 없으므로 여러 DB의 변경 전체가 원자적이지 않다. Role 생성·marker 설정과 각 DB의 schema 전환은 별도 transaction으로 처리한다. 생성 중 실패한 DB는 닫힌 채 남을 수 있다. 도구 marker가 일치하는 세 role이 모두 NOLOGIN이고 DB owner가 접속 DBA인 유지 보수 상태만 재실행할 수 있다. 예상하지 못한 상태를 수동으로 덮어쓰거나 볼륨을 삭제하지 않는다.

성공한 재실행은 기존 role의 SCRAM verifier와 파일의 비밀번호를 비교하며 일치할 때만 진행한다. 비밀번호가 달라지면 초기 검사 단계에서 실패한다. 자동 password rotation·realm 초기화·테이블 초기화는 수행하지 않는다. 비밀번호 교체는 별도 운영 절차다.

두 DB의 ACL과 schema 설정을 마친 후 cross-DB CONNECT가 남지 않았는지 다시 검사하고 managed login을 활성화한다. Legacy login은 NOLOGIN으로 남는다. 앱 배포의 Secret과 TLS 설정을 전환하고 실제 migration·health·로그인·업무 데이터 보존을 검증한 뒤 maintenance window를 종료한다.

## Connection budget

예시 plan은 server 2 × 10 + worker 2 × 10 + retention 2 = `gcr_app` 42개, migration 2개, Keycloak 3 × 10 = 30개를 산정한다. Replica 수에는 rollout surge와 종료 유예 중인 프로세스를 포함한다. 연속 배포로 기존 worker가 더 많이 남으면 plan도 다시 산정해야 한다.

여기에 별도 연결 5개와 운영 여유 10개를 더해 89개다. 이 값은 운영 측정값이 아니다. 도구는 실제 `max_connections`에서 PostgreSQL 자체 reserved connection을 뺀 한도와 비교하고 초과하면 적용하지 않는다. 산정한 role별 합계를 `CONNECTION LIMIT`로 설정한다. 각 앱의 pool·replica 설정은 배포 구성에도 동일하게 반영해야 한다. 이 도구만으로 Kubernetes replica 수를 제한하지는 않는다.

DB 분리는 CPU·메모리·I/O·디스크·장애를 물리적으로 격리하지 않는다. 별도 DB restore와 같은 cluster 내 복구 연습은 P03-C08에서 수행한다.

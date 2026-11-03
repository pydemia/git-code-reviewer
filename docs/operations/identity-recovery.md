# 인증 데이터 복구 검증

P03-C08의 앱 DB 복구 rehearsal을 제공한다. 합성 데이터를 별도 PostgreSQL에 넣고 실제 `pg_dump`/`pg_restore`를 실행했다. 운영 DB 복구 명령이나 운영 SAML 전환 완료 기록은 아니다. [실행 증거](../../.documents/execution/preventive-review/evidence/P03-C08-app-recovery.json)에 사용 버전, source hash, 성공·실패 시도와 남은 범위를 기록한다.

## 로컬 재현

Node 22와 PostgreSQL native binary가 필요하다. `GCR_TEST_POSTGRES_BIN`은 `postgres`, `initdb`, `pg_ctl`, `createdb`, `pg_dump`, `pg_restore`가 있는 절대 경로다. 실제 확인한 버전은 Homebrew PostgreSQL 18.3이다. 운영용으로 고정한 PostgreSQL 17 container와 별개의 시험이다.

```sh
pnpm build:packages
pnpm --filter @gcr/runtime build
GCR_TEST_POSTGRES_BIN=/opt/homebrew/Cellar/postgresql@18/18.3/bin \
  LOG_LEVEL=silent \
  node scripts/with-native-test-postgres.mjs node scripts/verify-identity-recovery.mjs
```

선택 환경 변수 `GCR_TEST_POSTGRES_EVIDENCE`와 `GCR_IDENTITY_RECOVERY_EVIDENCE`에 아직 없는 JSON 파일의 절대 경로를 지정하면 각각 PostgreSQL 실행·정리 기록과 복구 검사 결과를 저장한다. 부모 디렉터리는 먼저 만들어야 한다. 기존 결과 파일은 덮어쓰지 않는다.

Harness는 private 임시 디렉터리에 새 cluster를 초기화한다. 무작위 비밀번호의 SCRAM 인증과 loopback TCP만 사용하며 시스템 PostgreSQL 설정·데이터를 변경하지 않는다. 복구 스크립트는 소유 표식과 실제 `data_directory`를 대조한 뒤 무작위 이름의 두 DB를 생성한다. 종료 시 만든 DB와 파일, 해당 cluster만 정리한다. 성공 판정에는 복구 스크립트의 `success: true`, 두 기록의 `cleanup: true`, 명령의 exit 0이 모두 필요하다.

이 백업은 시험 중에만 존재한다. Custom dump를 메모리에서 AES-256-GCM으로 암호화한 뒤 private 파일로 저장하고 인증 검증 후 복원한다. 키는 임시 process 안에만 있으며 종료 후 백업을 재사용할 수 없다. 운영 backup 보관·KMS·WAL 암호화·PITR을 구현한 도구로 사용하지 않는다. `--no-owner --no-acl`로 복원하므로 DBA role/ACL 복구 증거도 아니다.

## 검증한 동작

- 사용자 ID·기존 subject·role/group·개인 prompt, local credential, tenant membership, repository grant, 개인 memory owner, 분석·report와 migration checksum을 복원 전후 대조한다. 보안 폐기 뒤에도 의도한 enabled/updated 시각 변경 외 사용자 속성과 리뷰 자료가 유지된다.
- 동일한 SAML mapping의 재연결은 기존 identity ID를 반환한다. 같은 NameID를 다른 앱 사용자에게 연결하거나 새 Keycloak user ID로 바꾸려는 요청은 `SAML_MAPPING_CONFLICT`로 거부한다.
- 암호화한 dump의 일부를 바꾸면 복원 전에 인증 검증이 실패한다.
- 백업 후 원본 DB에서 차단한 사용자가 과거 복원본에서는 활성 상태로 돌아오고, 복원된 SAML session으로 `/api/v1/me`가 200을 반환하는 위험을 실제 compiled 앱에서 재현한다. 이후 별도로 확보한 차단 결정을 적용하고 인증 상태를 폐기하면 같은 요청은 401이다.
- 유효한 local 비밀번호 hash와 이전 local session이 복원돼도 `AUTH_MODE=saml`에서 local 로그인은 404, 이전 local session은 401이다. Local credential을 지우거나 새 비밀번호를 만드는 방식으로 시험을 통과시키지 않는다.
- 잘못된 expected subject의 차단 요청은 충돌로 거부한다. 정확한 사용자 ID·subject에 기존 lifecycle 경로로 차단을 다시 적용한 뒤 모든 사용자의 session을 삭제하고 credential epoch를 증가시킨다. Pending OIDC/SAML transaction을 제거하고 이전 AuthnRequest의 소비 실패를 확인한다. Keycloak 원격 폐기 요청은 durable outbox에 남는다.
- 복원본을 처리하는 동안 별도 원본 DB의 현재 사용자·차단 상태·개인 자료·리뷰 이력은 되돌아가지 않는다.

앱 경로는 `Fastify.inject`로 검사한다. SAML session 생성에 넘기는 검증 완료 assertion 값과 IdP metadata는 합성 fixture다. 실제 IdP 로그인·서명 검증·브라우저 cookie·네트워크 TLS를 이 복구 시험에서 검증했다고 해석하지 않는다.

## 운영 복구 절차의 남은 조건

운영 적용 전에는 인증과 관련 worker의 접근을 닫는 실제 유지보수 절차, 복구 시점 대조, 별도 보안 기록의 확보 방법을 확정하고 같은 배포 구성으로 rehearsal해야 한다. 현재 스크립트가 운영 접근 차단을 자동 수행하지는 않는다.

앱 DB와 Keycloak DB의 복구 시점, 사용자 ID·persistent NameID·Keycloak user ID, 최근 차단·삭제·비밀번호 변경을 대조한다. 이메일이나 표시 이름으로 자동 연결하지 않는다. 이번 시험의 백업 후 차단 결정은 별도 원본 fixture에서 읽었다. 실제 장애에서 원본이나 외부 보안 기록을 확보할 수 없다면 과거 복원본만으로 최신 차단 상태를 복원했다고 판단할 수 없으며 인증을 열지 않는다.

확인된 차단은 먼저 GCR에 적용한다. 복원된 session과 진행 중 인증 transaction을 폐기하고 IdP의 복원된 session도 종료해야 한다. P03의 `user_client_credential_epochs`는 향후 client 폐기를 위한 연결 지점이다. 아직 없는 P04 access/refresh token·API key의 실제 폐기를 완료했다고 표시하지 않는다.

Keycloak DB 복구는 검증한 동일 image·schema 조합에서 수행한다. Schema upgrade 이후 image tag만 낮추는 방식으로 DB rollback을 대신하지 않는다. Realm export 외에 DB·credential·session·realm signing key, SP private key와 운영 Secret을 포함한 복구·키 회전·관리자 복구 검증이 필요하다. 공유 PostgreSQL의 role/ACL·TLS·PVC, 다른 DB 보존과 pool 제한도 별도 확인한다.

복원본에서 기존 계정 연결·초대·실제 메일 전달·관리자 및 일반 사용자 SAML 로그인·logout·IdP 직접 차단·collector 공백·재인증을 검증한 뒤 단계적으로 전환한다. 현재 앱 DB 시험만으로 C08이나 P03 전체를 완료 처리하지 않는다.

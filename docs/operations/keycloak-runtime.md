# Keycloak runtime 이미지

상태: ARM64 local image build 완료, runtime 전체 검증 미완료. [실행 기록](../../.documents/execution/preventive-review/evidence/P03-C07-optimized-image.json)의 부분 성공과 실패 시도를 구분한다. Registry 게시·운영 배포를 진행할 수 있는 완료 상태는 아니다.

`deploy/identity/Dockerfile`은 SAML contract에서 선택한 공식 Keycloak 26.7.3 index digest를 고정한다. PostgreSQL, health, metrics를 build 단계에서 활성화하고 최종 image는 `start --optimized`로 실행한다. Runtime에서 augmentation을 수행하거나 realm을 자동 import하지 않는다.

Build context는 `deploy/identity`이며 Dockerfile 외의 파일을 제외한다. DB 비밀번호, bootstrap 관리자 credential, TLS private key, realm export를 image에 넣지 않는다. Build JVM heap은 768 MiB, 사용 processor 수는 2로 제한한다. 이 설정은 build 명령에만 적용되며 runtime JVM 크기를 고정하지 않는다. [공식 optimized container 절차](https://www.keycloak.org/server/containers)를 따르되 upstream index를 tag와 함께 고정한다.

```sh
docker build --network=none \
  --build-arg REVISION="$(git rev-parse HEAD)" \
  -t gcr-identity:26.7.3-gcr.1-local deploy/identity

pnpm --filter @gcr/db build
node scripts/verify-keycloak-runtime.mjs > keycloak-runtime.json
```

검증에는 Node 22, Docker, OpenSSL과 미리 내려받은 PostgreSQL 18.6 image가 필요하다. Fixture는 image를 자동 pull하지 않는다. 다른 빌드를 검사할 때는 `GCR_IDENTITY_IMAGE`로 정확한 image reference를 지정한다. 결과의 local image ID와 Dockerfile·검증 script SHA-256을 보관하고 공개 image의 digest와 혼동하지 않는다.

## 실행 계약

- UID/GID `1000:1000`, read-only root, capability 전체 제거, privilege escalation 금지로 실행한다. `/tmp`와 `/opt/keycloak/data`만 쓰기 가능한 임시 volume으로 제공한다. Identity 데이터는 PostgreSQL에 보존한다.
- 공유 PostgreSQL의 `git_code_reviewer_keycloak` DB에 `gcr_keycloak`으로 접속한다. Database role 생성과 ACL 관리는 [DBA provisioning](shared-postgresql.md)이 담당한다.
- `KC_DB_TLS_MODE=verify-server`, `KC_DB_TLS_TRUST_STORE_FILE`로 신뢰 CA와 DB hostname을 검증한다. URL override에 비밀번호나 TLS 완화 option을 넣지 않고 `KC_DB_URL_HOST/PORT/DATABASE`를 각각 설정한다.
- Keycloak 26.7.3의 `KCRAW_DB_PASSWORD`를 사용해 비밀번호에 포함된 `${...}`를 설정 expression으로 해석하지 않게 한다. [DB 설정 안내](https://www.keycloak.org/server/db)의 현재 내용만으로 호환성을 가정하지 않고 실제 고정 image로 확인한다.
- Pool initial/min/max는 명시한다. Runtime fixture는 `1/1/10`을 검사한다. Companion chart의 기본값은 종료 중인 Pod까지 포함한 peak replica 5개와 role connection limit 30에 맞춰 `1/1/6`이다. [Chart 연결 예산](../../deploy/helm/gcr-identity/README.md#replica와-연결-예산)을 따른다. 관찰된 연결 수가 한도 이내라는 결과는 peak load 검증을 대신하지 않는다.
- Cache는 `jdbc-ping`, replica 간 통신은 embedded mTLS를 사용한다. Management port 9000은 public ingress에 연결하지 않는다. DB 연결 readiness와 process liveness를 분리한다.
- Bootstrap 관리자 credential은 초기 설치·복구 중에만 제공한다. 테스트용 bootstrap 사용자는 운영 계정 구성을 대신하지 않는다. 반복 배포가 기존 사용자·realm key를 재생성하지 않도록 runtime 시작과 realm 설정 작업을 분리한다.

## 로컬 검증 범위

`scripts/verify-keycloak-runtime.mjs`는 UUID label로 소유한 Docker network와 containers를 만들고 종료 시 그 label을 재확인해 정리한다. 기존 cluster·DB·VS Code·모델 계정은 사용하지 않는다. DB는 새 임시 데이터 디렉터리로 시작한다. 기존 운영 PostgreSQL image/PVC의 재시작 검증은 P03-C06의 별도 evidence다.

Fixture는 공유 DB provisioning과 앱 migration 후 실제 Keycloak schema를 생성한다. 두 replica, realm 사용자와 비밀번호, 서명 key, 반복 DBA 적용과 재시작, DB TLS의 잘못된 CA/hostname 거부를 검사한다. Keycloak Admin API·사용자 인증 요청과 DB 연결은 fixture CA를 검증한다. Health port만 loopback HTTP로 조회한다. Local health/admin port 공개는 테스트 실행 중 loopback에 한정한다.

테스트 realm의 password grant client는 credential 보존 확인에만 사용한다. 실제 SAML 브라우저 흐름·public admin 경로 차단·NetworkPolicy·SMTP·부하·운영 복구는 companion/Compose 및 P03-C08의 별도 검증 대상이다. 테스트용 관리자·사용자 인증 요청에는 초기 JVM 준비 시간을 포함해 30초, health 조회에는 5초 제한을 적용한다. 운영 GCR Admin API adapter의 10초 제한을 변경하거나 검증한 결과로 해석하지 않는다. 이 fixture의 성공만으로 운영 SAML 전환이나 C07 전체 완료를 선언하지 않는다.

## PRISM-DEV 선행 조건

2026-09-13 16:58 KST에 현재 Gateway와 로컬 DNS resolver를 읽기 전용으로 확인했다. `envoy-gateway-system/envoy-gateway`에는 HTTP 80, TCP 6333 listener가 있고 HTTPS listener는 없다. `pr-review.prism.ai`는 조회되지만 제안한 `auth.pr-review.prism.ai`는 조회되지 않았다. [사전 점검 기록](../../.documents/execution/preventive-review/evidence/P03-C07-gateway-preflight.json)을 참고한다.

GCR과 identity hostname의 HTTPS 진입점·인증서·DNS를 준비해야 운영 SAML로 전환할 수 있다. 기존 HTTPRoute를 그대로 둔 채 `AUTH_MODE=saml`만 바꾸는 배포는 성립하지 않는다. 이번 점검에서 Gateway, DNS, Secret, DB, Helm release는 변경하지 않았다.

이후 사용자가 Mac의 `/etc/hosts`에 인증 주소를 등록하고 HTTPRoute 추가를 요청했다. `identity-httproute.yaml`은 적용됐으며 companion이 제공할 `git-code-reviewer-identity:80`을 참조한다. Service 미배포로 `BackendNotFound` 상태다. [Companion chart](../../deploy/helm/gcr-identity/README.md)는 공개 Service 80, private 관리 HTTPS Service 443, management 9000과 해당 NetworkPolicy를 구현했다. 로컬 명세 검증과 API dry-run까지 완료했으며 실제 기동·CNI 검증·배포는 남아 있다. [Route 적용 기록](../../.documents/execution/preventive-review/evidence/P03-C07-identity-route.json)은 앞선 읽기 전용 점검과 별개다. Pod의 이름 조회와 HTTPS 연결은 아직 확인하지 않았다.

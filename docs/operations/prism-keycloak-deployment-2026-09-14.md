# PRISM-DEV Keycloak 배포 — 2026-09-14

Keycloak을 실제 `PRISM-DEV/git-code-reviewer` namespace에 Helm으로 설치했다. 앞선 로컬 Docker 검증과 구분한다. GCR의 로그인 방식은 `local`을 유지하며 운영 GCR의 SAML 로그인 전환은 이번 배포에 포함하지 않았다.

| 항목 | 배포 결과 |
| --- | --- |
| Identity release | `git-code-reviewer-identity`, revision 2, `deployed` |
| Identity chart | 게시된 `gcr-identity` 0.1.0, tgz SHA-256 `a4f655fe77b603237dcb25a0b3b8f94bff52360dde04b58a39a9884c655b1b27` |
| Keycloak image | `docker.io/pydemia/gcr-identity@sha256:227f5e4fe2aee7e229a14d03d264e083ff070015d11f44439d3453810d3830a9` · Keycloak 26.7.3 · 실제 amd64 Pod 2개 |
| GCR release | revision 50, chart 0.10.36, app 0.8.0-alpha.38, 기존 image 유지 |
| Identity origin | `https://auth.pr-review.prism.ai` |
| Private admin | `https://git-code-reviewer-identity-admin.git-code-reviewer.svc` |
| GCR origin | 기존 HTTP 유지, `https://pr-review.prism.ai` 추가 |
| Identity DB | 기존 PostgreSQL의 `git_code_reviewer_keycloak`, 전용 `gcr_keycloak` role, connection limit 30 |

## 적용한 설정

[Identity values](../../deploy/environments/prism-dev/identity-values.yaml)는 별도 companion release를 구성한다. 최초 설치는 `bootstrap.existingSecret=git-code-reviewer-identity-bootstrap`을 지정했다. Realm 구성 후 revision 2에서 bootstrap 환경변수를 제거했으며 재시작할 때 realm을 import하지 않는다. 설치용 임시 관리자 계정과 Secret은 후속 관리 설정을 위해 남아 있다. 상시 관리자·MFA 전환을 완료했다고 해석하지 않는다.

기존 PostgreSQL에 [서버 TLS overlay](../../deploy/environments/prism-dev/postgresql-identity-tls-values.yaml)를 먼저 적용했다. 이후 [GCR DB TLS overlay](../../deploy/environments/prism-dev/application-database-tls-values.yaml)로 server·worker·migration·retention에 CA를 mount하고 `DATABASE_TLS_MODE=verify-full`을 전달했다. 기존 GCR role과 DB·PVC를 유지했다. Keycloak role의 평문 및 다른 DB 접속은 HBA에서 거부한다. 기존 GCR role의 평문 허용 HBA는 호환성을 위해 남아 있으며 앱의 실제 연결은 모두 TLS다. 전체 앱 role 분리·HBA 최종 전환과 구분한다.

Gateway에 GCR hostname 두 개에 한정한 HTTPS listener를 추가했다. 기존 HTTP·Qdrant listener는 보존했다. [JSON patch](../../deploy/environments/prism-dev/identity-gateway-listeners.patch.json)는 최초 변경 전 listener 목록을 검사하므로 이미 적용한 Gateway에 재실행하지 않는다. Shared Envoy LoadBalancer에 외부 주소가 할당되지 않아 [HTTPS entry Service](../../deploy/environments/prism-dev/identity-https-entry.yaml)로 기존 hosts 주소 `10.250.107.189:443`을 연결했다. 기존 공용 Service의 다른 포트는 수정하지 않았다.

[HTTPS routes](../../deploy/environments/prism-dev/identity-https-routes.yaml)는 GCR과 identity를 연결한다. 기존 identity HTTPRoute는 HTTPS로 redirect한다. Identity는 `/realms/git-code-reviewer`와 `/resources`만 공개하며 `/admin`, `/realms/master`, `/health`는 공개 route에서 404다. Proxy 신뢰 주소는 조회한 Envoy Pod `192.168.139.32/32`다. Proxy Pod IP가 바뀌면 identity values의 신뢰 주소를 갱신해야 한다.

TLS 인증서는 이 환경 전용 개발 CA로 발급했다. CA private key와 서버 private key는 별도 Kubernetes Secret에 보관하고 Git에는 [공개 CA 인증서](../../deploy/environments/prism-dev/certs/development-ca.crt)만 저장한다. 사용자 OS·브라우저 신뢰 저장소는 변경하지 않았다. 브라우저의 인증서 신뢰 등록은 별도이며 이번 HTTP 검증은 해당 CA를 명시적으로 신뢰한 클라이언트로 수행했다.

## Realm과 실제 검증

[명시적 구성 Job](../../deploy/environments/prism-dev/identity-configure-job.yaml)이 `git-code-reviewer` realm, persistent NameID와 서명을 요구하는 GCR SAML client, realm 범위 관리 service account와 역할·이벤트 설정을 생성했다. SAML client의 entity ID는 `https://pr-review.prism.ai/auth/saml/metadata`, ACS는 `/auth/saml/acs`, SLO는 `/auth/saml/slo`다. Secret은 파일로 mount한다. 파일 안전성 검사와 Node main-module 판정에 맞게 `subPath` mount를 사용한다.

실제 클러스터에서 확인한 결과:

- Keycloak 2/2, GCR server·worker 각각 1/1 Ready. Identity revision 2에 bootstrap 환경변수가 없다.
- PostgreSQL 통계에서 Keycloak과 GCR 연결 모두 TLS 1.3. GCR 자체 연결은 `verify-full` 설정과 SSL session을 함께 확인했다.
- 실제 operator Job에서 Keycloak DB TLS 접속 성공, 같은 credential의 평문 접속 및 GCR DB 접속은 각각 SQLSTATE `28000`으로 거부됐다.
- HTTPS GCR readiness·system API와 Keycloak SAML metadata는 CA·hostname 검증 후 200. 공개 관리자·master realm·health는 404.
- 구성 후 `--inspect` 결과는 `converged: true`, 추가 작업 0개다. PostgreSQL·Keycloak 재기동 후 SAML entity ID·서명 인증서가 유지됐다.
- GCR Helm test는 2026-09-14 00:36:29 KST에 통과했다.
- 기존 사용자 7명, Chat 계정 7개, repository grant 2개, membership 7개, memory 4개, local credential 6개의 비교 hash가 일치했다. 분석 155건·report 147건, 활성 provider 설정, migration 36개의 checksum을 보존했다.

DB TLS 적용 전 실제 앱 DB를 `pg_dump --format=custom`으로 백업하고 AES-256-GCM으로 암호화했다. 암호화 readback은 확인했으며 이 백업의 restore를 이번에 다시 실행하지 않았다. 암호화 key는 `git-code-reviewer-identity-preparation-backup` Secret에 있다. 백업과 상세 실행 기록은 ignored `artifacts/operations/P03-prism-identity/`에 보관한다.

## 중간 문제와 남은 범위

첫 구성 Job은 ConfigMap symlink 때문에 main-module 실행 판정이 맞지 않아 exit 0으로 끝났지만 실제 구성을 수행하지 않았다. 완료 상태만으로 성공 처리하지 않고 로그·realm 확인 후 `subPath` mount로 수정해 실제 구성을 실행했다. 개발 인증서에는 strict X.509 검증에 필요한 SKI/AKI를 보완하고 재발급했다. Private key는 변경하지 않았다.

PostgreSQL 재기동 중 GCR 연결이 일시 중단됐고 server·worker를 재시작해 복구했다. Worker는 DB 연결 실패 뒤 health server만 살아 있는 상태가 관측돼 명시적인 rollout restart가 필요했다. 무중단 배포로 보고하지 않는다. DB 장애 후 worker loop 종료·복구 처리는 후속 수정 대상이다. 최초 작업 직전 실행 중인 모델 분석 job은 없었으며 기존 데이터 보존 검증은 통과했다.

실제 GCR session을 사용하는 SAML 로그인·계정 mapping·SMTP 발송·운영 관리자 MFA는 미완료다. 이번 배포는 실제 Keycloak과 DB/TLS·realm·route 구성의 검증이며 앱 로그인 전환 완료를 뜻하지 않는다. [기계 판독 증거](../../.documents/execution/preventive-review/evidence/P03-PRISM-identity-deployment.json)를 함께 확인한다.

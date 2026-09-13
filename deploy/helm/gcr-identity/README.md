# GCR Identity companion

공식 Keycloak 26.7.3으로 만든 optimized image를 별도 release로 실행한다. 기존 공유 PostgreSQL의 identity DB를 사용한다. PostgreSQL, realm import, Secret, HTTPRoute는 이 chart가 생성하지 않는다. GCR chart의 `keycloak.enabled`는 false로 유지한다.

현재 상태는 **로컬 명세 검증 단계**다. Published image digest, 실제 CNI·proxy 검증, Keycloak 전체 runtime 검증과 운영 SAML 전환은 아직 완료되지 않았다. [이미지 준비 기록](../../../docs/operations/keycloak-runtime.md)과 [P03 실행 기록](../../../.documents/execution/preventive-review/P03.md)을 함께 확인한다.

## 준비할 값과 외부 자원

`values.example.yaml`은 설정 형식을 보여 주는 준비용 예시다. `example.test`, `192.0.2.10/32`, selector를 실제 환경 값으로 확인해 바꾼다. Image repository/digest가 비어 있으므로 예시만으로 배포할 수 없다. Chart는 임의의 기본 credential, mutable tag, 평문 public origin, 비어 있는 허용 peer를 받아들이지 않는다.

| 설정                               | 선행 자원·조건                                                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `image.repository`, `image.digest` | `deploy/identity/Dockerfile`로 빌드·검증하고 registry에 게시한 optimized image. 로컬 image ID나 upstream의 build 전 image digest를 대신 넣지 않는다.           |
| `hostname`                         | 사용자와 GCR Pod가 조회·신뢰하는 고정 HTTPS origin. Gateway 앞 TLS 종료와 전달 헤더 처리를 실제 연결로 확인한다.                                               |
| `adminHostname`                    | 관리 Service로 연결되는 별도의 private HTTPS origin. 예시는 `https://git-code-reviewer-identity-admin.git-code-reviewer.svc`다.                                |
| `tls.existingSecret`               | 해당 private hostname SAN을 가진 `tls.crt`·`tls.key`. DB password·bootstrap Secret과 분리한다.                                                                 |
| `database.host/name/username`      | [DBA provisioning](../../../docs/operations/shared-postgresql.md)으로 준비한 identity DB와 `gcr_keycloak`. PostgreSQL의 TLS 인증서 SAN이 host와 일치해야 한다. |
| `database.existingSecret`          | `passwordKey`에 DB password만 가진 기존 Secret. `KCRAW_DB_PASSWORD`로 참조하므로 `${...}`도 literal로 전달한다.                                                |
| `database.tls.existingConfigMap`   | PostgreSQL 인증서의 CA bundle. `verify-server`를 고정하며 평문·검증 생략 선택지를 제공하지 않는다.                                                             |
| `networkPolicy`                    | 실제 proxy·GCR server/worker·DB·DNS Pod의 namespace/label 또는 승인한 IP CIDR. 각 상대편의 정책도 연결을 허용해야 한다.                                        |
| `outboundTrust`                    | 필요한 경우 private SMTP/HTTPS CA bundle. Secret의 private key를 CA ConfigMap에 넣지 않는다.                                                                   |

Secret과 CA는 외부에서 관리한다. Mount는 read-only이며 TLS key는 UID/GID 1000과 fsGroup 1000에 읽기 권한을 준다. Secret의 존재·내용·인증서 유효성·실제 role 권한은 offline Helm render로 확인할 수 없다. DB password처럼 env로 읽는 Secret을 교체할 때 `configurationRevision`을 바꿔 Pod를 순차 재시작하고 새 연결을 검증한다.

`bootstrap.existingSecret`은 최초 설치나 명시적 복구 중에만 지정한다. 임시 username/password를 분리된 key에 저장하고 password는 충분한 entropy의 base64url 문자로 생성해 Keycloak 설정 expression 문자가 들어가지 않게 한다. Master realm 초기 생성에만 적용되며 기존 관리자 복구를 자동 수행하지 않는다. Realm 설정·운영 계정/MFA 준비·임시 계정 제거 후 bootstrap 값을 비우고 rollout한다. 재시작에 realm JSON을 import하거나 기존 사용자·key를 덮어쓰는 Job은 없다. 반복 배포의 실제 보존 검증은 별도 runtime/복구 검사로 수행한다.

## 포트와 접근 경로

Release 이름을 `git-code-reviewer-identity`로 하거나 예시의 `fullnameOverride`를 사용하면 다음 Service를 만든다.

| Service                                      | Pod port   | 허용 source                                                |
| -------------------------------------------- | ---------- | ---------------------------------------------------------- |
| `git-code-reviewer-identity:80`              | HTTP 8080  | `networkPolicy.proxy.peers`의 Gateway/proxy                |
| `git-code-reviewer-identity-admin:443`       | HTTPS 8443 | `adminPeers`의 GCR server·worker와 지정한 관리 Pod         |
| `git-code-reviewer-identity-management:9000` | HTTP 9000  | 선택한 `monitoringPeers`; node의 kubelet probe는 별도 경로 |

공개·관리 Service는 같은 Keycloak의 HTTP/HTTPS listener를 참조한다. **Service 이름이나 `KC_HOSTNAME_ADMIN`은 경로별 접근 통제가 아니다.** Public Gateway에는 realm protocol·resources만 연결해야 한다. PRISM의 [별도 HTTPRoute](../../environments/prism-dev/identity-httproute.yaml)는 `/realms/git-code-reviewer`, `/resources`를 Service 80으로 연결한다. `/admin`, `/realms/master`, health·metrics를 공개하지 않는다. 이 chart는 이미 적용된 route를 채택하거나 수정하지 않는다.

Public proxy는 TLS를 종료하고 `X-Forwarded-*`를 실제 요청 값으로 덮어써야 한다. `trustedAddresses`에는 proxy에서 Pod로 연결할 때 관찰한 source IP/CIDR를 넣는다. 공개 VIP나 모든 Pod CIDR를 근거 없이 신뢰 주소로 사용하지 않는다. HTTP 8080은 그 proxy와의 private hop에 한해 활성화한다. [Keycloak reverse proxy 문서](https://www.keycloak.org/server/reverseproxy)의 전달 헤더·경로 통제를 실제 Gateway에서 확인해야 한다.

GCR에는 `KEYCLOAK_ADMIN_BASE_URL=<adminHostname>/admin/realms/git-code-reviewer`와 CA trust, realm 범위의 최소 권한 client credential이 필요하다. 현재 adapter의 token URL·SAML metadata는 **public issuer**를 사용하므로 server/worker가 `hostname`의 HTTPS에도 연결되어야 한다. Identity ingress 허용만으로 GCR egress가 열리지는 않는다. [GCR SAML Helm 설정](../../../docs/operations/saml-web-authentication.md#helm-설정과-전환-준비)은 해당 Secret/CA·server/worker egress를 연결한다. 두 chart의 실제 배포·통합 검증은 남아 있다.

관리 Service는 private REST API 경로를 제공한다. 운영자의 브라우저 Admin Console은 private DNS/VPN과 master realm 로그인 경로를 별도로 검증해야 한다. Public route가 master realm을 막는 상태에서 `adminHostname`만 설정해 Admin Console 로그인이 완료된다고 가정하지 않는다.

NetworkPolicy는 identity Pod만 선택하고 ingress/egress를 모두 제한한다. namespace와 podLabels는 같은 peer의 AND 조건이다. Cache 7800/57800은 같은 release·namespace의 identity Pod끼리만 허용하며 `jdbc-ping`과 embedded mTLS를 사용한다. 외부 SMTP는 기본 차단이고 승인한 host/port peer를 추가해야 한다. Database ACL, SMTP TLS, CNI enforcement는 정책 명세만으로 증명되지 않는다. Kubernetes 정책은 합산되므로 다른 정책이 이 Pod를 선택해 넓은 허용을 추가하는지도 점검한다. Node 트래픽과 hostNetwork/IP 변환의 동작은 [Kubernetes NetworkPolicy 문서](https://kubernetes.io/docs/concepts/services-networking/network-policies/) 및 실제 CNI 조건을 따른다.

## Replica와 연결 예산

기본 replica는 2개이며 preferred anti-affinity·topology spread와 `minAvailable: 1` PDB를 둔다. 노드·DB·Gateway까지 HA라는 뜻은 아니다. 일반 Pod 교체는 surge 1·unavailable 0으로 진행하고 Keycloak 종료 지연 10초·drain 60초보다 긴 120초 유예를 준다. Startup은 management `/health/started`에 600초, readiness는 `/health/ready`, liveness는 `/health/live`를 사용한다. DB 장애에 의한 readiness 실패를 liveness 실패와 동일하게 다루지 않는다.

종료 중인 Pod는 [Deployment surge 계산에서 제외](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/#terminating-pods)될 수 있다. 따라서 한 번의 rollout 예산은 desired 2 + surge 1 + terminating allowance 2 = 5로 잡고 pool min/initial/max를 `1/1/6`으로 둔다. `5 × 6 = 30`은 C06의 Keycloak role connection limit 30에 맞는다. Chart는 `peakReplicas >= 2 * replicas + 1`과 `peakReplicas * pool.max <= connectionLimit`을 검사한다. Scale 변경 시 예산도 함께 바꿔야 한다.

이 값은 Kubernetes Pod 수의 절대 상한이나 peak 부하 성능 보장이 아니다. 이전 rollout·terminating Pod가 정리되기 전에 다음 rollout을 겹치지 않는다. 장시간 종료·node 단절·운영 도구의 추가 연결을 관찰하고 필요하면 DBA 전체 예산과 실제 role 한도를 조정한다. Role limit을 확인하지 않고 values의 숫자만 늘려 배포하지 않는다. Keycloak schema upgrade는 해당 image·DB 복원본의 rehearsal 뒤 유지보수 창에서 별도 수행하며, 이 일반 교체 strategy를 버전 간 DB 호환성 보장으로 사용하지 않는다.

## 검증과 배포 조건

```sh
python -B scripts/verify-identity-chart.py

# 실제 환경별 values, published image, Secret/CA, DB, DNS/TLS, policies를 준비한 뒤:
helm template git-code-reviewer-identity deploy/helm/gcr-identity \
  --namespace git-code-reviewer --values /private/path/identity-values.yaml
```

검증 script는 synthetic image reference로 Helm lint·schema 음성 사례·Service/Secret/TLS/probe wiring과 NetworkPolicy 규칙의 허용/거부 matrix를 검사한다. Cluster에 쓰거나 Keycloak을 시작하지 않는다. 배포 전에는 실제 image와 환경에서 두 replica의 realm/user/signing key 보존·교체 중 SAML·DB TLS/pool·SMTP·public admin 우회 차단·관리 API 및 모니터링 접근을 확인해야 한다. 현재 PRISM의 HTTPRoute `BackendNotFound`를 해소하기 위해 이 미검증 예시를 그대로 설치하지 않는다.

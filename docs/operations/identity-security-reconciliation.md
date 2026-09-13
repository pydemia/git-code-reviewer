# Identity security reconciliation

P03-C05 개발 기록이다. 현재 PRISM-DEV 배포는 P03-C04의 alpha.36이며 아래 수집기와 lifecycle 구현은 아직 배포하지 않았다. 관리자 차단·재활성화·전체 기기 로그아웃 API와 UI를 추가했으며 최종 검증과 배포를 준비한다. 운영 companion 구성은 C07에서 검증한다.

## 이벤트를 읽는 조건

Keycloak 26.7.3의 기본 JPA event store를 사용한다. 전용 service account에는 `manage-users`와 `view-events`를 부여한다. 이벤트 읽기 권한으로 이벤트 삭제나 설정 변경은 할 수 없어야 한다. 관리자 이벤트의 representation 저장은 비활성으로 유지한다.

수집기는 `requiredSecurityEventTypes`의 성공 이벤트를 모두 저장하는지 검사한다. 비밀번호·인증 수단 변경, 연합 계정 연결 변경, 계정 잠금·삭제, 세션 종료를 포함한다. 이벤트 보존 기간은 최소 1시간이다. 배포 단계에서 JPA store, 5분 이하의 Keycloak transaction timeout, 각 노드의 30초 이내 시각 오차를 확인해야 한다. REST 응답만으로 이 서버 설정을 증명했다고 간주하지 않는다.

매 수집에서 새 client-credentials token을 발급하고 JWT의 `jti`와 `CLIENT_LOGIN` 이벤트의 `details.token_id`를 메모리에서 대조한다. 별도로 자기 service-account의 `gcr.security.probe` 속성만 변경하고 readback과 해당 관리자 이벤트를 확인한다. 기존 속성은 보존한다. 사용자 비밀번호나 일반 사용자의 속성을 확인용으로 바꾸지 않는다.

각 stream은 최근 5분과 지연 transaction을 위한 5분 중복 구간, 시각 오차 30초를 한 번에 읽는다. 한 stream이 500건을 초과하거나 응답 크기·형식·realm·시각이 유효하지 않으면 불완전한 관찰로 처리한다. timestamp 정렬에 offset pagination을 붙여 손실 없는 cursor라고 가정하지 않는다. 규모가 이 한도를 넘으면 인증 상태를 갱신할 수 없으므로 운영 전 부하에 맞는 수집 방식 검토가 필요하다.

이전 두 확인 이벤트가 모두 남아 있고 새 확인 이벤트와 설정 검사가 성공해야 연속된 관찰로 인정한다. 초기 수집, 기록 삭제·보존 실패, realm 교체, 장시간 중단은 기존 계정의 세션과 credential epoch를 폐기하고 다시 확인한다. 단순 통신 실패는 마지막 확인 시각을 유지하며 최대 5분이 지나면 기존 인증 계층이 `IDENTITY_UNAVAILABLE`로 거부한다.

## DB와 세션 처리

`0035_identity_security_reconciliation.sql`은 provider 수집 lease와 확인 지점, event ID hash의 소비 기록, IdP logout outbox, 세션별 tombstone을 추가한다. 이벤트 원문·representation·IP 주소·JWT·비밀번호는 저장하지 않는다. 기존 사용자 ID·subject·권한·tenant membership·local credential은 migration으로 변경하지 않는다.

차단·삭제·재설정과 수집된 보안 변경은 같은 사용자 관리 lock을 사용한다. GCR 세션 삭제, identity epoch 증가, freshness 제거, 원격 logout outbox 저장을 한 transaction으로 commit한 뒤 Keycloak을 호출한다. 원격 실패는 이 폐기를 취소하지 않는다. 만료되거나 교체된 lease의 완료는 거부한다.

GCR의 명시적 차단·삭제는 identity에 `idp_disabled_by_gcr`도 남긴다. Outbox는 Keycloak 비활성 readback과 전체 logout을 확인한 뒤 완료된다. 이후 IdP에서 직접 활성화하더라도 이 차단 의도를 다시 적용한다. 이미 비활성인 계정에는 같은 PUT을 반복하지 않는다. 자기 logout으로 생긴 이벤트가 확인된 비활성 상태를 다시 원격 작업으로 만드는 순환도 차단한다. IdP profile 불일치에 따른 GCR의 인증 차단은 이 명시적 IdP 차단 의도와 구분한다.

`user_client_credential_epochs`는 P04 client credential 발급·검증이 사용할 폐기 기준이다. P04가 아직 구현되지 않았으므로 이 테이블 갱신을 실제 refresh/access token 폐기 완료라고 보고하지 않는다.

일반 IdP 로그아웃은 `LOGOUT` 또는 `USER_SESSION_DELETED`의 세션 ID로 해당 GCR 웹 세션만 삭제한다. 실제 Keycloak의 세션 ID는 UUID가 아닌 opaque 문자열일 수 있다. SAML SessionIndex의 첫 부분과 비교하며 client credential epoch를 올리지 않는다. Tombstone은 해당 세션의 지연 ACS도 거부한다.

전체 폐기 시점과 원격 logout 완료 시점에 로그인 barrier를 기록한다. 그 전에 시작한 AuthnRequest의 응답은 나중에 도착해도 세션을 만들 수 없다. 새 profile 확인은 같은 identity·epoch·provider 확인 지점에 대해서만 commit할 수 있다.

Freshness는 원격 logout acknowledgment, 활성 GCR 사용자·identity, 정확한 Keycloak ID와 persistent NameID·qualifier, 활성 IdP profile이 모두 일치할 때 갱신한다. 유효기간은 DB에 저장한 이벤트 수집 시작 시각에서 5분이다. 반복한 profile GET으로 이 시각을 미루지 않는다. 비활성 또는 연결 정보가 달라진 identity는 비활성으로 남기며 별도의 확인된 관리자 작업으로 재활성화한다.

## 관리자 차단·재활성화·전체 기기 로그아웃

기존 `/api/v1/admin/identity/operations`에 `disable`, `enable`, `logout-all` 요청을 추가한다. 사용자는 기존 GCR ID와 현재 subject로 지정하며 `revokeAllSessions: true`가 필요하다. 동일 request ID·actor·provider·payload의 재전송은 원래 작업을 반환한다. 다른 payload로 같은 요청을 재사용하면 거부한다. 관리자 화면은 서버가 capability로 제공한 작업만 표시한다.

차단과 전체 기기 로그아웃은 GCR 세션을 먼저 폐기하고 원격 대기열을 저장한다. 차단은 사용자와 identity를 즉시 비활성화한다. 전체 기기 로그아웃은 계정 활성 상태를 유지한다. 두 요청은 기존 활성 계정 작업을 supersede하며 원래 요청자가 나중에 권한을 잃더라도 폐기를 계속한다. 완료 상태는 같은 mapping의 요청 epoch 이상을 IdP에서 확인한 후에만 기록한다. 마지막 활성 관리자를 차단할 수는 없다.

`0036_identity_lifecycle_operations.sql`은 작업에 `expected_security_epoch`를 추가한다. 재활성화 요청은 현재 보안 수집 상태가 정상이고 대상이 비활성일 때만 접수한다. 작업 중에도 GCR 사용자·identity를 비활성으로 유지하고 IdP 차단 의도를 저장한다. 원격 활성화 뒤 process가 종료되거나 결과를 확인하지 못하면 security worker가 이 차단 의도를 다시 적용한다.

재활성화는 변경 전 연속된 이벤트 수집, 현재 관리자 권한과 mapping·epoch 확인, IdP 활성화와 전체 logout, 활성 profile readback, 변경 후 이벤트 수집 순서로 처리한다. 자기 service-account가 만든 해당 사용자 UPDATE·logout 이벤트만 앞선 관찰과 비교해 현재 작업의 결과로 연결한다. 현재 작업 lease·actor·mapping·epoch가 모두 유효한 경우에만 이 이벤트를 중복 폐기 없이 소비한다. 다른 actor의 변경, realm 전체 폐기, 일반 세션 tombstone은 계속 적용한다. 이 과정에서 대상 epoch가 바뀌면 이벤트와 폐기를 저장하고 재활성화는 실패로 남긴다.

최종 transaction은 권한·mapping·epoch를 다시 확인하고 GCR 접근 허용, IdP 차단 의도 해제, epoch acknowledgment, 새 로그인 barrier와 freshness, 작업 완료를 함께 저장한다. 이전 process의 만료된 작업은 자동 재실행하지 않는다. 명시적 재시도는 현재 관리자가 다시 승인하고 최신 epoch로 묶는다. 차단·삭제 등으로 supersede된 요청은 재시도할 수 없다. 직전에 발생한 보안 이벤트가 뒤늦게 수집돼 실패한 경우에도 상태를 확인한 후 명시적으로 다시 요청한다.

각 realm의 provisioning·재활성화·security pass는 전용 PostgreSQL connection의 session advisory lock으로 직렬화한다. 원격 호출 중 SQL transaction이나 row lock은 유지하지 않는다. Connection 손실이나 90초 작업 한도 이후에는 추가 IdP 호출을 거부하고 개별 HTTP 요청에도 기존 10초 timeout을 적용한다. Lock connection은 반환 시 폐기한다. Worker는 계정 생성/메일, 재활성화, 보안 수집에 순서대로 실행 기회를 주며 계정 background task를 리뷰 실행 슬롯에서 제외한다.

## 실행과 남은 검증

`IDENTITY_SECURITY_ENABLED` 기본값은 `false`이며 활성화하려면 `IDENTITY_ADMIN_ENABLED`와 전용 service-account 연결이 필요하다. Worker의 background pass가 수집, 제한된 logout outbox 처리, 최대 25개 profile 확인을 실행한다. HTTP·worker health loop는 네트워크 완료를 기다리지 않는다.

실제 PostgreSQL 검사는 복수 connection의 lease 경합, 중복 이벤트, transaction rollback, 원격 실패·늦은 완료, ACS barrier와 세션별 tombstone, profile 조회로 유효기간이 늘어나지 않는 조건을 다룬다. 별도의 disposable Keycloak·PostgreSQL·Chrome fixture는 실제 Admin API와 SAML 이벤트를 사용한다. Processor를 직접 호출한 검증과 실제 worker scheduling 검증은 구분한다.

2026-09-13 12:31:17–12:32:20 KST의 격리 환경 검사는 production collector의 명시적 GCR 차단, 실제 Keycloak 재활성화 감지와 재차단, 원격 작업 대기열이 비워지는 조건까지 통과했다. 당시 검증 source hash는 결과 파일과 일치했다. 사용자 차단 transaction은 fixture에서 직접 실행했으며 관리자 API/UI 전체 검증을 대신하지 않는다.

2026-09-13 13:17:02–13:18:03 KST의 격리 검사에서는 실제 UPDATE·logout 이벤트 확인 뒤 GCR 재활성화, 원격 acknowledgment와 freshness를 확인했다. 별도의 전체 기기 로그아웃 요청은 실제 worker loop에서 처리했으며 DB pool 2개·리뷰 concurrency 1 설정을 사용했다. 이후 compiled lifecycle UI까지 포함한 검증을 추가했다. 최종 결과와 원본 hash는 P03 실행 기록의 후속 evidence에 기록한다.

운영 설정·부하·복구 검증과 배포, native Safari·VS Code 검증은 별도 항목으로 유지한다. Runtime과 migration 배포 시에도 `AUTH_MODE=local`, `IDENTITY_ADMIN_ENABLED=false`, `IDENTITY_SECURITY_ENABLED=false`를 보존한다. 운영 SAML 전환은 C06–C08의 DB·companion·복구 검증 후 별도로 진행한다.

근거: [Keycloak 26.7.3 Admin REST API](https://www.keycloak.org/docs-api/26.7.3/rest-api/index.html), [JPA security event query](https://github.com/keycloak/keycloak/blob/26.7.3/model/jpa/src/main/java/org/keycloak/events/jpa/JpaEventQuery.java), [SAML SessionIndex 구성](https://github.com/keycloak/keycloak/blob/26.7.3/services/src/main/java/org/keycloak/protocol/saml/SamlSessionUtils.java).

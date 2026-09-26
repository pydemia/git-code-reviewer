# Client API key와 지식 다운로드

현재 reader key의 서버·transport 계약이다. 사용자 발급·연결 절차는 [클라이언트 연결](client-connections.md), 설치와 예시는 [설치·연결 가이드](../product/getting-started.md)를 따른다. 실제 전달 검증 범위는 G03/G04 실행 기록에 구분한다.

`CLIENT_API_KEYS_ENABLED`와 Helm `clientApiKeys.enabled`는 기본 false다. 활성화하려면 지식 발행·배포와 signing server ID, `local` 또는 `saml` 인증, HTTPS public URL이 필요하다. Runtime의 비운영 환경에서만 명시적인 loopback HTTP fixture를 허용하며 Helm 활성화는 HTTPS를 요구한다. 기존 migration 0001–0040을 수정하지 않고 0041에 `client_api_keys`를 추가한다.

## 발급과 폐기

로그인한 웹 사용자는 `POST /api/v1/me/client-credentials`에 `name`, `clientId`, `tenantId`, `repositoryIds`, `scopes`, `lifetimeDays`를 보낸다. `clientId`는 `commit-defender` 또는 `gcr-cli`, 현재 지원 scope는 `knowledge:read` 하나다. Repository는 한 tenant 안에서 명시적으로 1–100개를 선택하며 현재 DB 권한과 Cerbos 인가를 모두 확인한다. `lifetimeDays`를 생략하면 30일, 정수로 지정하면 1–90일, 명시적으로 `null`을 보내면 No expiration(만료 없음)이다. 발급·목록·client identity의 `expiresAt: null`은 시간 만료가 없다는 뜻이다. 사용자당 유효한 키는 무기한 키를 포함해 50개까지다. Owner를 body로 지정할 수 없다.

원문 `token`은 발급 응답에서만 반환한다. UUID 식별자 뒤에 256-bit 난수를 포함하는 opaque secret이며 서버에는 전체 token의 SHA-256 digest를 저장한다. 목록·감사 기록에는 원문이나 digest를 포함하지 않는다. 생성·폐기 요청은 웹 세션과 정확한 Origin을 요구한다. 쿠키를 client token으로 복사하거나 모델/GHES credential로 대체하지 않는다.

`GET /api/v1/me/client-credentials`는 본인 키의 이름·client·scope·repository·생성/만료/폐기 시각을 최대 100개 반환한다. `nextCursor`가 있으면 `?cursor=<id>`로 다음 페이지를 조회한다. `DELETE /api/v1/me/client-credentials/:keyId`는 본인 키만 폐기하며 반복 폐기는 같은 폐기 상태를 유지한다. 일반 웹 logout은 이미 발급한 API key를 폐기하지 않는다.

## 인증과 인가

`GET /api/v1/client-auth/config`는 실제 활성화된 방법만 게시한다. 현재 `api-key`만 구현했으며 PKCE·device·refresh flow는 게시하지 않는다. `GET /api/v1/client-auth/me`는 bearer principal의 user·tenant·실효 repository·scope·key 만료를 반환한다. 무기한 키도 폐기·사용자 비활성·권한 철회·비밀번호/identity epoch 변경을 매 요청에서 검사한다. 지식 manifest의 온라인 5분 freshness와 서명된 offline lease는 key 수명과 별개이며 그대로 유지된다.

키는 `Authorization: Bearer <token>`과 `X-GCR-Server-ID`로 전달한다. Bearer 읽기 경로는 client `me`, client repository identity, repository별 지식 `manifest`·`bundles`, 원문 이력·답글·본문 버전·관측·출처 연결 지침이다. Authorization header가 있으면 웹 쿠키·proxy assertion·development 사용자로 인증을 대체하지 않는다. 키로 사용자 관리·메모리 승인·모델 실행 API를 호출할 수 없다. 기존 웹의 지식 조회는 기존 세션으로 계속 동작한다.

매 요청에서 발급 server·auth mode·user epoch, 키 만료/폐기, 현재 user·tenant·repository·membership·grant를 확인한다. Local 키는 비밀번호 변경 시각까지 정확히 비교한다. PostgreSQL의 microsecond를 JavaScript Date로 잘라 저장하지 않는다. SAML 키는 발급 session의 identity ID·security epoch를 고정하고 현재 identity 활성·검증 상태와 freshness를 확인한다. 개인 bundle owner는 bearer user로 결정하며 요청 body나 다른 웹 쿠키로 바뀌지 않는다. HTTP 304 전에도 동일하게 인가한다.

| 조건                                                                    | 결과                       |
| ----------------------------------------------------------------------- | -------------------------- |
| 없는/틀린/만료된 키, 다른 server audience                               | 401                        |
| 폐기·user epoch 변경·계정 비활성·비밀번호/identity epoch 변경·범위 이탈 | 403                        |
| SAML security freshness 만료                                            | 503 `IDENTITY_UNAVAILABLE` |
| 지원하지 않는 client contract                                           | 426                        |

DB에서 확인한 발급 범위와 현재 권한의 교집합이 적용된다. 요청이 이미 시작된 뒤의 철회를 모든 in-flight 응답에 소급 취소한다고 주장하지 않는다. 클라이언트는 현재 연결·서명/lease와 이미 관측한 철회를 확인해 진행 중 중앙 자료 사용을 중단한다. offline 상태에서 새 서버 철회를 즉시 발견한다고 보장하지 않는다.

## Client HTTP transport

`KnowledgeHttpTransport`는 `TrustedCentralBinding`과 같은 `bindingId`의 `readToken()` credential port를 받는다. OS credential 조회·IPC·refresh 직렬화는 host/broker 책임이며 이 transport에 웹 쿠키나 전역 credential discovery가 없다. 각 요청에서 binding을 재확인하고 취소된 credential 조회가 늦게 끝나도 HTTP를 시작하지 않는다.

URL의 base path를 유지하고 GET만 사용하며 redirect를 따라가지 않는다. HTTPS는 인증서와 hostname 검증을 끌 수 없고 개발 CA는 공개 인증서를 명시적으로 주입한다. Manifest 응답은 64 KiB, bundle stream은 동기화 core의 서명된 크기와 2 MiB 제한을 따른다. Manifest 304·401·403·503 등의 상태를 cache core에 전달하며 서버의 오류 본문을 진단 메시지로 복사하지 않는다.

검증에는 격리된 실제 PostgreSQL, 실제 local 로그인과 key 발급 API, 로컬 HTTP listener, signed publication·암호화 cache, 별도 TLS listener와 임시 인증서를 사용한다. SAML key의 freshness/epoch 검증은 저장된 합성 identity fixture를 사용한다. 이 테스트는 실제 Keycloak 로그인→client 승인이나 macOS/Linux 설치 client의 검증을 대체하지 않는다. 테스트에서 외부 모델을 호출하지 않는다.

키 관리 UI, PKCE·device·refresh family, OS broker·CD/CLI 연결 화면, remote 매핑, 중앙 context resolver와 실제 리뷰 및 배포가 남아 있다. [검증 증거](../../.documents/execution/preventive-review/evidence/P04-client-api-keys.json)를 따른다.

## Repository identity for local binding

`GET /api/v1/client-repositories/:repoId` accepts a `knowledge:read` client key and returns the authorized server/tenant/repository/instance identity plus the GitHub web base URL, owner and repository name. It checks current key scope, tenant membership, repository grants and enabled state. Browser cookies alone do not authorize this route. The response is private/no-store, and URL userinfo, query and fragment are excluded.

Clients compare effective Git fetch remotes locally. They do not send remote URLs to this API. New connections with remotes record a binding; later remote changes or changed server identity on synchronization require reconnection. Existing records without binding stay explicitly manual/unverified.

## No expiration 선택

프로필 → 클라이언트 연결 → 새 API key → 만료 설정에서 **No expiration (만료 없음)**을 선택한다. 기본 선택은 기간 지정 30일이며 기존에 발급한 key의 만료일은 변경하지 않는다. 무기한 key도 같은 목록에서 폐기할 수 있다. Migration 0059는 `expires_at`의 NOT NULL만 제거하며 기존 key·checksum과 날짜 key의 DB 상한을 보존한다.

무기한 key를 연결하는 클라이언트는 nullable expiry를 지원해야 한다. 공통 client-contract alpha.49 / client-core alpha.50 이상, GCR CLI alpha.40 이상, Commit Defender 2.13.1 이상에 포함된다. 이전 클라이언트는 기존 날짜 key를 계속 사용할 수 있지만 무기한 key의 identity를 해석하지 못한다. 전역 CLI를 자동 교체하지 않는다.

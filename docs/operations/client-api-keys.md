# Client API key와 지식 다운로드

이 문서는 P04/P06 source checkpoint의 구현 계약이다. PRISM-DEV의 API key 활성화, 웹 key 관리 화면, Commit Defender/CLI의 연결 UI·credential broker·실제 중앙 리뷰 완료를 뜻하지 않는다.

`CLIENT_API_KEYS_ENABLED`와 Helm `clientApiKeys.enabled`는 기본 false다. 활성화하려면 지식 발행·배포와 signing server ID, `local` 또는 `saml` 인증, HTTPS public URL이 필요하다. Runtime의 비운영 환경에서만 명시적인 loopback HTTP fixture를 허용하며 Helm 활성화는 HTTPS를 요구한다. 기존 migration 0001–0040을 수정하지 않고 0041에 `client_api_keys`를 추가한다.

## 발급과 폐기

로그인한 웹 사용자는 `POST /api/v1/me/client-credentials`에 `name`, `clientId`, `tenantId`, `repositoryIds`, `scopes`, `lifetimeDays`를 보낸다. `clientId`는 `commit-defender` 또는 `gcr-cli`, 현재 지원 scope는 `knowledge:read` 하나다. Repository는 한 tenant 안에서 명시적으로 1–100개를 선택하며 현재 DB 권한과 Cerbos 인가를 모두 확인한다. 기본 수명은 30일, 최대 90일이며 사용자당 유효한 키는 50개까지다. Owner를 body로 지정할 수 없다.

원문 `token`은 발급 응답에서만 반환한다. UUID 식별자 뒤에 256-bit 난수를 포함하는 opaque secret이며 서버에는 전체 token의 SHA-256 digest를 저장한다. 목록·감사 기록에는 원문이나 digest를 포함하지 않는다. 생성·폐기 요청은 웹 세션과 정확한 Origin을 요구한다. 쿠키를 client token으로 복사하거나 모델/GHES credential로 대체하지 않는다.

`GET /api/v1/me/client-credentials`는 본인 키의 이름·client·scope·repository·생성/만료/폐기 시각을 최대 100개 반환한다. `nextCursor`가 있으면 `?cursor=<id>`로 다음 페이지를 조회한다. `DELETE /api/v1/me/client-credentials/:keyId`는 본인 키만 폐기하며 반복 폐기는 같은 폐기 상태를 유지한다. 일반 웹 logout은 이미 발급한 API key를 폐기하지 않는다.

## 인증과 인가

`GET /api/v1/client-auth/config`는 실제 활성화된 방법만 게시한다. 현재 `api-key`만 구현했으며 PKCE·device·refresh flow는 게시하지 않는다. `GET /api/v1/client-auth/me`는 bearer principal의 user·tenant·실효 repository·scope·key 만료를 반환한다.

키는 `Authorization: Bearer <token>`과 `X-GCR-Server-ID`로 전달한다. Bearer 인증이 허용된 route는 client `me`, repository별 지식 `manifest`, `bundles`뿐이다. Authorization header가 있으면 웹 쿠키·proxy assertion·development 사용자로 인증을 대체하지 않는다. 키로 사용자 관리·메모리 승인·모델 실행 API를 호출할 수 없다. 기존 웹의 지식 조회는 기존 세션으로 계속 동작한다.

매 요청에서 발급 server·auth mode·user epoch, 키 만료/폐기, 현재 user·tenant·repository·membership·grant를 확인한다. Local 키는 비밀번호 변경 시각까지 정확히 비교한다. PostgreSQL의 microsecond를 JavaScript Date로 잘라 저장하지 않는다. SAML 키는 발급 session의 identity ID·security epoch를 고정하고 현재 identity 활성·검증 상태와 freshness를 확인한다. 개인 bundle owner는 bearer user로 결정하며 요청 body나 다른 웹 쿠키로 바뀌지 않는다. HTTP 304 전에도 동일하게 인가한다.

| 조건 | 결과 |
| --- | --- |
| 없는/틀린/만료된 키, 다른 server audience | 401 |
| 폐기·user epoch 변경·계정 비활성·비밀번호/identity epoch 변경·범위 이탈 | 403 |
| SAML security freshness 만료 | 503 `IDENTITY_UNAVAILABLE` |
| 지원하지 않는 client contract | 426 |

DB에서 확인한 발급 범위와 현재 권한의 교집합이 적용된다. 요청이 이미 시작된 뒤의 철회를 모든 in-flight 응답에 소급 취소한다고 주장하지 않는다. 진행 중 리뷰 context 폐기는 P06-C04에서 연결한다.

## Client HTTP transport

`KnowledgeHttpTransport`는 `TrustedCentralBinding`과 같은 `bindingId`의 `readToken()` credential port를 받는다. OS credential 조회·IPC·refresh 직렬화는 host/broker 책임이며 이 transport에 웹 쿠키나 전역 credential discovery가 없다. 각 요청에서 binding을 재확인하고 취소된 credential 조회가 늦게 끝나도 HTTP를 시작하지 않는다.

URL의 base path를 유지하고 GET만 사용하며 redirect를 따라가지 않는다. HTTPS는 인증서와 hostname 검증을 끌 수 없고 개발 CA는 공개 인증서를 명시적으로 주입한다. Manifest 응답은 64 KiB, bundle stream은 동기화 core의 서명된 크기와 2 MiB 제한을 따른다. Manifest 304·401·403·503 등의 상태를 cache core에 전달하며 서버의 오류 본문을 진단 메시지로 복사하지 않는다.

검증에는 격리된 실제 PostgreSQL, 실제 local 로그인과 key 발급 API, 로컬 HTTP listener, signed publication·암호화 cache, 별도 TLS listener와 임시 인증서를 사용한다. SAML key의 freshness/epoch 검증은 저장된 합성 identity fixture를 사용한다. 이 테스트는 실제 Keycloak 로그인→client 승인이나 macOS/Linux 설치 client의 검증을 대체하지 않는다. 테스트에서 외부 모델을 호출하지 않는다.

키 관리 UI, PKCE·device·refresh family, OS broker·CD/CLI 연결 화면, remote 매핑, 중앙 context resolver와 실제 리뷰 및 배포가 남아 있다. [검증 증거](../../.documents/execution/preventive-review/evidence/P04-client-api-keys.json)를 따른다.

## Repository identity for local binding

`GET /api/v1/client-repositories/:repoId` accepts a `knowledge:read` client key and returns the authorized server/tenant/repository/instance identity plus the GitHub web base URL, owner and repository name. It checks current key scope, tenant membership, repository grants and enabled state. Browser cookies alone do not authorize this route. The response is private/no-store, and URL userinfo, query and fragment are excluded.

Clients compare effective Git fetch remotes locally. They do not send remote URLs to this API. New connections with remotes record a binding; later remote changes or changed server identity on synchronization require reconnection. Existing records without binding stay explicitly manual/unverified.

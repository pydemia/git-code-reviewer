# Chat account registry와 GHES repository 관리 설계

## 1. 확정 요구사항

이 문서는 시스템 관리자와 일반 사용자의 책임, ChatGPT account 선택형 Chat, access token 기반 GHES repository 등록과 polling 관리를 정의한다.

- 시스템 관리자는 여러 ChatGPT account를 등록·검증·비활성화하고 account별 사용 범위를 지정한다.
- 일반 사용자는 자신에게 허용된 ChatGPT account, model, reasoning effort를 선택해 대화를 시작한다.
- Chat session은 생성 시 선택한 `accountId + modelId + reasoningEffort + analysisRevisionId`를 고정한다. 대화 중 설정을 바꾸면 기존 session을 변형하지 않고 새 session을 만든다.
- 시스템 관리자는 GHES connection과 access token을 등록하고 token으로 조회 가능한 repository만 review 대상으로 등록한다.
- 시스템 관리자는 repository별 automatic polling 사용 여부와 interval profile을 설정하고 즉시 poll을 요청할 수 있다.
- Webhook과 repository CI workflow는 요구하지 않는다.

`ChatGPT account`는 사용자가 browser에서 직접 로그인하는 개인 credential이 아니라 시스템 관리자가 서비스에 등록하고 사용 범위를 통제하는 server-side credential resource를 뜻한다. 사용자 identity와 ChatGPT account identity는 서로 다른 domain이다.

## 2. Role과 권한 경계

| Role | 허용 작업 |
|---|---|
| `administrator` | Chat account와 GHES connection credential 등록·회전·검증·비활성화, account assignment, repository와 polling policy, repository grant 관리 |
| `reviewer` | 자신이 속한 tenant와 repository grant 범위에서 PR 조회·refresh·Chat 사용, 허용된 Chat account/model/effort 선택 |

두 종류의 권한을 분리한다.

1. GHES access token은 서비스가 어떤 repository를 GHES API와 Git으로 읽을 수 있는지 정한다.
2. Application의 `tenant_memberships`와 `repository_grants`는 로그인한 사용자가 서비스 안에서 어떤 repository를 볼 수 있는지 정한다.

GHES token이 repository를 읽을 수 있다는 사실만으로 모든 application 사용자에게 그 repository가 공개되지 않는다. 반대로 application grant가 있어도 등록된 token이 GHES 읽기 권한을 잃으면 polling과 clone은 실패한다.

## 3. Chat account registry

### 3.1 Account resource

시스템 관리자가 등록하는 Chat account는 다음 metadata와 credential 상태를 가진다.

| 필드 | 의미 |
|---|---|
| `id` | 외부에 노출 가능한 opaque UUID |
| `displayName` | 사용자가 selector에서 보는 관리용 이름. 실제 email/token은 표시하지 않음 |
| `providerType` | `chatgpt-codex` 또는 승인된 `openai-api` adapter |
| `enabled` | 신규 session 선택 가능 여부 |
| `credentialCiphertext` | deployment encryption key로 암호화한 credential blob |
| `credentialVersion` | 회전 충돌 방지와 audit용 version |
| `expiresAt` | 확인 가능한 경우 access/refresh credential 만료 시각 |
| `health` | `ready|refresh-required|rate-limited|disabled|unavailable` |
| `lastValidatedAt` | 마지막 최소 연결 검증 시각 |
| `models` | 관리자가 허용한 model capability 목록 |
| `assignmentMode` | 전체 enabled user 또는 tenant/user/group 제한 |

Kubernetes Secret은 account 원문을 여러 개 보관하는 registry로 사용하지 않는다. Secret에는 DB credential을 암호화하는 master key만 두고, account credential과 refresh rotation 결과는 PostgreSQL의 암호화 row에 저장한다. Server replica는 account별 advisory lock 또는 optimistic version check로 동시에 같은 refresh token을 회전하지 않는다.

### 3.2 Model과 reasoning effort 정책

시스템 관리자는 account마다 사용 가능한 model을 등록하고 각 model에 다음 policy를 지정한다.

- 공개 label과 실제 provider model ID
- provider가 지원하는 reasoning effort 목록
- 기본 effort와 사용자가 선택할 수 있는 최대 effort
- 사용자별·account별 concurrency 및 기간별 요청 한도
- 비활성화 여부와 optional tenant/user/group assignment

지원 effort 값은 application 전체에 하나의 고정 enum으로 가정하지 않는다. Model capability에 저장된 값만 selector와 request validation에 사용한다. Provider에서 지원하지 않는 effort는 요청 전에 `MODEL_EFFORT_NOT_ALLOWED`로 거부한다.

일반 사용자는 persistent Chat 영역에서 다음 순서로 선택한다.

```text
Chat account -> Model -> Effort -> 새 대화 시작
```

기본 선택은 사용자 preference로 저장할 수 있지만 credential, account email과 token은 browser storage에 저장하지 않는다. 기본값이 더 이상 허용되지 않으면 Server가 첫 번째 허용 조합을 자동 실행하지 않고 재선택을 요구한다.

### 3.3 Session 고정 규칙

`chat_sessions`에는 다음 값을 저장한다.

- `user_id`
- `analysis_revision_id`
- `chat_account_id`
- `model_id`
- `reasoning_effort`
- `account_credential_version`
- `created_at`

Account, model 또는 effort를 바꾸면 같은 analysis revision에서도 새 session을 생성한다. 과거 message는 당시 선택과 usage metadata를 유지한다. Account가 이후 비활성화되거나 credential을 회전해도 완료된 대화는 읽을 수 있지만 새 message는 현재 account policy와 health를 다시 검사한다.

### 3.4 Account 등록 방식의 feasibility gate

OpenAI 공식 Codex 인증은 ChatGPT 로그인과 API key 로그인을 구분한다. 다만 Codex에서 생성한 ChatGPT credential을 임의의 다중 사용자 server가 token broker처럼 보관·재사용할 수 있는지는 공개 API contract만으로 확정할 수 없다. 따라서 `chatgpt-codex` account 등록은 다음 조건을 통과한 뒤 production 기능으로 연다.

- 조직의 ChatGPT workspace/account 공유 정책과 사용 약관 확인
- 승인된 device authorization 또는 credential import 절차 확인
- refresh token 회전, revoke, logout, account 식별 contract 확인
- account별 model/effort capability 확인
- source code 전송, retention, audit와 incident 대응 정책 승인

이 gate를 통과하지 못하면 같은 account registry UX를 유지하되 공식 OpenAI API project/service account 또는 사내 OpenAI-compatible gateway credential만 허용한다. 현재 `chatgpt.com/backend-api/codex` 직접 호출 구현은 production contract로 간주하지 않는다.

## 4. GHES access-token connection

### 4.1 Connection resource

동일 GHES instance에 여러 service identity/token을 등록할 수 있으므로 host와 credential을 하나의 전역 설정으로 합치지 않는다.

| Resource | 주요 필드 |
|---|---|
| `github_instances` | 이름, API base URL, Web base URL, CA profile, enabled |
| `github_credentials` | instance ID, label, auth type `access-token`, encrypted token, fingerprint, expiry, health |
| `repositories` | tenant ID, instance ID, credential ID, GHES numeric ID, owner/name, enabled |
| `poll_policies` | repository ID, automatic enabled, hot/active/idle interval, draft mode, request budget |
| `repository_grants` | repository ID, application subject/group, role |

Token은 GHES의 승인된 service/machine account에서 발급하고 대상 repository에 필요한 read 권한만 부여한다. GHES version이 fine-grained personal access token을 지원하고 조직 정책이 허용하면 repository를 명시하고 Metadata/Contents/Pull requests read 범위로 제한한다. Metadata는 repository 확인, Pull requests는 polling, Contents는 HTTPS Git fetch에 사용한다. Classic personal access token만 지원하면 `repo` scope가 넓다는 점을 security review와 rotation 주기에 반영한다. Admin, write와 workflow scope는 요구하지 않는다.

`credentialLabel`은 token 문자열이나 GHES username이 아니라 같은 instance 안에서 credential을 구분하는 application 관리용 이름이다. 같은 instance와 label로 다시 등록하면 암호화 token을 교체하고 credential version을 증가시키므로 token rotation에도 같은 label을 사용한다. Access token 입력에는 `Bearer` 접두어, 따옴표나 URL을 붙이지 않는다.

### 4.2 등록과 검증

시스템 관리자는 다음 순서로 connection과 repository를 등록한다.

1. GHES API/Web base URL, credential label, access token, 만료일과 optional CA profile을 입력한다.
2. Server는 credential을 암호화해 저장하고 별도 연결 테스트에서 `GET /user`를 호출해 token identity를 검증한다.
3. Repository 등록 시 Server가 `GET /repos/{owner}/{repo}`로 권한과 numeric ID를 검증한다.
4. 선택한 repository의 numeric ID와 기본 branch를 authoritative API에서 읽어 등록한다.
5. Tenant, application user/group grant와 polling policy를 지정한다.
6. `Poll now`로 open PR 조회를 실행하고 마지막 성공 시각과 오류를 확인한다.

GNB의 `/guide#ghes-credential`은 위 발급 절차와 입력 형식, classic PAT fallback, 401/403/404, Poll 성공 후 Git fetch 실패의 구분 방법을 시스템 관리자에게 제공한다. 연결 테스트 성공은 repository API와 Git fetch 권한까지 보장하지 않으므로 최초 repository는 등록, Poll now, snapshot 분석까지 검증한다.

Token은 `Authorization` header와 ephemeral Git credential helper에서만 사용한다. Browser response, clone URL, Git config, job payload, audit, log와 metric label에는 원문이나 ciphertext를 넣지 않는다. Job은 `credentialId`만 보관하고 실행 시점에 Server/Worker가 암호화 저장소에서 읽는다.

### 4.3 Polling trigger

Repository별 관리 항목은 다음과 같다.

- automatic polling enabled/disabled
- hot/active/idle/draft interval과 최소·최대 범위
- 다음 poll 시각과 마지막 성공 시각
- 현재 backoff, rate-limit reset과 최근 오류
- manual refresh 허용 여부
- 관리자 전용 `Poll now`

MVP는 임의 cron expression보다 bounded interval profile을 사용한다. Scheduler는 DB clock과 lease로 due repository를 claim하며 같은 repository poll을 중복 실행하지 않는다. Token의 401/403은 권한 또는 만료 상태로 표시하고 무한 retry하지 않는다. 429와 5xx는 다른 repository를 막지 않고 해당 connection/repository에 backoff를 적용한다.

## 5. API contract

### 5.1 사용자 Chat API

```text
GET    /api/v1/chat-accounts
GET    /api/v1/chat-accounts/{accountId}/models
POST   /api/v1/analyses/{analysisId}/chat-sessions
       body: { accountId, modelId, reasoningEffort, scope }
GET    /api/v1/chat-sessions/{sessionId}
POST   /api/v1/chat-sessions/{sessionId}/messages
GET    /api/v1/chat-sessions/{sessionId}/events
```

`GET /chat-accounts`는 현재 user에게 할당되고 enabled/ready인 account의 공개 label과 capability만 반환한다. Session 생성과 message 전송 시 membership, repository grant, account assignment, model/effort policy를 모두 다시 검사한다.

### 5.2 Chat account admin API

```text
GET    /api/v1/admin/chat-accounts
POST   /api/v1/admin/chat-accounts
PATCH  /api/v1/admin/chat-accounts/{accountId}
POST   /api/v1/admin/chat-accounts/{accountId}/credential
POST   /api/v1/admin/chat-accounts/{accountId}/test
PUT    /api/v1/admin/chat-accounts/{accountId}/assignments
GET    /api/v1/admin/chat-accounts/{accountId}/usage
```

Create/credential request의 secret 값은 write-only다. Response에는 credential 설정 여부, fingerprint 일부가 아닌 opaque version, expiry와 health만 반환한다.

### 5.3 GHES admin API

```text
GET    /api/v1/admin/github-connections
POST   /api/v1/admin/github-connections
PATCH  /api/v1/admin/github-connections/{connectionId}
POST   /api/v1/admin/github-connections/{connectionId}/credential
POST   /api/v1/admin/github-connections/{connectionId}/test
GET    /api/v1/admin/github-connections/{connectionId}/repositories

GET    /api/v1/admin/repositories
POST   /api/v1/admin/repositories
PATCH  /api/v1/admin/repositories/{repositoryId}
PUT    /api/v1/admin/repositories/{repositoryId}/poll-policy
POST   /api/v1/admin/repositories/{repositoryId}/poll-now
GET    /api/v1/admin/repositories/{repositoryId}/grants
PUT    /api/v1/admin/repositories/{repositoryId}/grants/{principalId}
DELETE /api/v1/admin/repositories/{repositoryId}/grants/{principalId}
```

## 6. Browser UX

### 6.1 일반 사용자

오른쪽 persistent Chat panel 상단에 `Account`, `Model`, `Effort` selector를 둔다. 대화를 시작한 뒤에는 세 값이 session metadata로 표시되고 selector 변경은 `새 대화 시작` 확인 뒤 새 session에만 적용한다. Account가 없거나 선택 가능한 model/effort가 없으면 composer를 비활성화하고 관리자에게 요청할 항목을 구체적으로 표시한다.

### 6.2 시스템 관리자

`/admin`에 다음 navigation을 제공한다.

- Tenants
- Users and memberships
- Chat accounts
- GHES connections
- Repositories and polling
- Repository grants
- Analysis provider
- Analysis prompts
- Retention, jobs and audit

Chat account 화면은 등록, credential 상태, model/effort allowlist, assignment, quota와 test를 제공한다. GHES 화면은 connection credential, repository discovery/등록, tenant/grant, poll profile, last poll과 `Poll now`를 한 흐름으로 제공한다.

## 7. 감사와 운영

다음 event를 원문 credential 없이 기록한다.

- Chat account 생성·검증·credential 회전·비활성화·assignment 변경
- 사용자의 Chat account/model/effort 선택과 session 생성
- GHES connection 생성·검증·token 회전·비활성화
- Repository 등록·grant·poll policy 변경과 manual poll
- Credential refresh 성공/실패, 401/403/429 상태 변화

Usage는 user, account, model, effort와 session의 opaque ID 기준으로 집계하되 source, prompt, response 원문을 metric label이나 audit metadata에 넣지 않는다.

## 8. 현재 구현과의 차이

현재 구현은 다음 이유로 이 요구사항을 충족하지 않는다.

- Chat account가 하나의 deployment Secret/PVC로 고정되어 registry가 없다.
- Model name은 deployment 설정 하나이며 reasoning effort는 `medium`으로 고정되어 있다.
- `chat_sessions`가 account/model/effort를 고정하지 않는다.
- Chat account assignment와 사용자 selector가 없다.
- GHES 인증은 GitHub App 전역 credential만 지원하고 admin-managed access token registry가 없다.
- Repository 등록은 API만 있고 admin UI가 없다.
- Repository grant를 생성·변경하는 API/UI가 없다.
- Poll interval patch 일부는 있으나 repository discovery, profile 편집과 `Poll now` admin workflow가 없다.

## 9. 검수 기준

1. 시스템 관리자가 Chat account 두 개를 등록하고 서로 다른 model/effort allowlist를 설정한다.
2. User A와 User B에 서로 다른 account assignment를 적용하면 selector 결과가 분리된다.
3. 사용자가 account/model/effort를 선택해 session을 만들면 세 값과 credential version이 session에 고정된다.
4. 대화 도중 selector를 바꾸면 기존 session의 message가 변하지 않고 새 session이 생성된다.
5. 허용되지 않은 account/model/effort를 ID 조작으로 요청하면 존재 여부를 감춘 오류를 반환한다.
6. Account를 비활성화하면 과거 대화는 읽을 수 있지만 신규 message는 거부된다.
7. 시스템 관리자가 GHES access token을 등록하면 원문이 API response, DB 평문, log와 job payload에 남지 않는다.
8. Token으로 읽을 수 없는 repository는 등록되지 않고 401과 403을 구분한 관리 상태를 제공한다.
9. Repository polling을 비활성화하면 automatic poll은 중단되지만 정책상 허용된 manual refresh는 동작한다.
10. 서로 다른 repository의 interval, backoff와 token rate-limit이 독립적으로 적용된다.
11. GHES token 권한과 application repository grant를 각각 제거했을 때 외부 조회와 사용자 조회가 의도한 경계에서 차단된다.

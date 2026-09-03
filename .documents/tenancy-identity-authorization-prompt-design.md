# Tenancy, Identity, Authorization and Analysis Prompt Design

## 1. 목적

Git Code Reviewer에 tenant 격리, 일반 사용자와 관리자 구분, 사용자 관리, RBAC+ABAC 인가, 전역 analysis provider와 tenant별 code analysis prompt 관리를 추가한다. 인증과 인가를 application code에 중복 구현하지 않고 다음 책임으로 분리한다.

| 영역 | 정본 | 책임 |
|---|---|---|
| Identity | Keycloak 또는 조직 표준 OIDC provider | 로그인, MFA/SSO/session, identity lifecycle, signed role/group claim |
| Application access | PostgreSQL | tenant, local user 상태, tenant membership, repository tenant, provider/prompt version |
| Authorization decision | Cerbos PDP | principal role/attribute와 resource attribute를 조합한 RBAC+ABAC 판단 |
| Enforcement | Git Code Reviewer Server | DB query scope 제한, Cerbos check, existence hiding, audit |

Keycloak 자체 authorization service에 application resource를 모두 등록하지 않는다. 그렇게 하면 repository와 analysis처럼 빠르게 생성되는 domain object가 identity system에 결합된다. Keycloak token은 identity와 coarse role만 전달하고, application의 최신 tenant/resource 속성은 Server가 Cerbos 요청에 제공한다.

## 2. 제품 결정

### 2.1 Keycloak 채택 범위

Self-hosted identity provider가 필요하면 Keycloak을 1순위로 사용한다. 표준 OIDC Authorization Code + PKCE, client role, group claim과 관리 기능이 있고 현재 Server의 generic OIDC 구현을 그대로 활용할 수 있다.

조직에 이미 Entra ID, Okta, PingFederate 같은 표준 OIDC provider가 운영 중이면 새 Keycloak을 추가하는 것보다 기존 provider를 재사용하는 편이 낫다. Application contract는 Keycloak 전용 adapter가 아니라 OIDC claim mapping으로 유지한다.

Keycloak은 application Helm chart에 bundled dependency로 설치하지 않는다. Identity database, realm backup, upgrade, TLS와 HA lifecycle은 review service보다 높은 운영 등급이 필요하므로 별도 platform service로 운영한다.

### 2.2 Cerbos 채택 범위

Cerbos는 RBAC와 tenant/repository 속성을 함께 평가하는 PDP로 사용한다. OPA도 가능하지만 이 제품에서는 resource/action/principal 형태가 분명해 Cerbos policy와 CheckResources API가 더 직접적이다. OpenFGA는 대규모 relationship 기반 권한에는 유리하지만 현재 요구인 두 role과 tenant membership에는 과도하다.

Production의 `AUTHORIZATION_MODE=cerbos`는 PDP timeout, malformed response 또는 unavailable 시 deny하는 fail-closed mode다. `local` mode는 동일한 최소 policy를 process 안에서 평가하며 local development와 recovery 진단에만 사용한다.

## 3. Tenant와 role model

### 3.1 Role

지원 role은 두 개다.

| Role | 의미 |
|---|---|
| `reviewer` | 자신이 member인 tenant 안에서 명시적으로 grant된 repository를 조회·refresh·Chat 사용 |
| `administrator` | tenant, membership, user 상태, repository, analysis provider와 prompt를 관리하고 모든 tenant resource 조회 |

OIDC token의 Keycloak client role `git-code-reviewer-admin`이 있으면 `administrator`, 없으면 `reviewer`다. 기존 `OIDC_ADMIN_GROUP` mapping은 호환 fallback으로 유지한다. Role은 로그인 때 signed claim에서 동기화하며 application admin UI에서 임의 승격하지 않는다.

### 3.2 Attribute

Cerbos principal:

```json
{
  "id": "OIDC_SUBJECT",
  "roles": ["reviewer"],
  "attr": {
    "tenantIds": ["TENANT_UUID"],
    "enabled": true,
    "groups": ["engineering"]
  }
}
```

Cerbos resource:

```json
{
  "kind": "repository",
  "id": "REPOSITORY_UUID",
  "attr": {
    "tenantId": "TENANT_UUID",
    "granted": true,
    "enabled": true
  }
}
```

`tenantId in principal.tenantIds`가 tenant ABAC 경계이며 `granted`가 기존 repository 단위 접근 제한을 유지한다. Administrator는 role policy로 전역 관리할 수 있지만 모든 변경은 audit event를 남긴다.

## 4. Data model

### 4.1 신규 table과 column

- `tenants`: immutable UUID, unique slug, display name, enabled 상태
- `tenant_memberships`: tenant/user pair와 membership 상태
- `users.enabled`: application access kill switch
- `repositories.tenant_id`: 모든 repository의 필수 tenant owner
- `analysis_prompt_versions`: tenant별 immutable instruction version, SHA-256 hash, active marker, creator/activator
- `analysis_provider_versions`: 전역 immutable provider version, 암호화된 credential, configuration hash, active marker
- `analysis_runs.prompt_version_id`: run 생성 시 고정된 prompt version
- `analysis_runs.prompt_hash`: built-in 또는 custom prompt identity
- `analysis_runs.provider_version_id`: run 생성 시 고정된 admin provider version. Deployment fallback이면 null
- `analysis_runs.provider_hash`: provider mode, endpoint, model, timeout과 credential identity를 포함한 hash

Migration은 `default` tenant를 만들고 기존 repository와 사용자를 그 tenant에 backfill한다. 신규 production 사용자는 첫 OIDC login으로 local identity가 만들어진 뒤 administrator가 membership을 부여한다. Development mode만 default tenant auto-join을 허용한다.

Prompt와 provider version은 삭제하거나 수정하지 않는다. Tenant마다 active prompt version은 최대 하나이고 전역 active provider version도 최대 하나다. Reset하면 각각 built-in prompt와 deployment provider 설정으로 돌아간다. Report에는 prompt 원문이나 provider credential이 아니라 version/profile/hash만 기록한다.

Provider API key는 `MODEL_CREDENTIAL_ENCRYPTION_KEY`의 32-byte key로 AES-256-GCM 암호화한다. 암호화 key는 PostgreSQL, ConfigMap, chart values와 browser에 저장하지 않고 Server와 Worker에만 Kubernetes Secret으로 주입한다. API는 credential 설정 여부만 반환하며 원문이나 ciphertext를 반환하지 않는다. 관리자 입력 endpoint는 `MODEL_PROVIDER_ALLOWED_ORIGINS`의 exact origin allowlist에 있어야 한다.

## 5. Authorization matrix

| Resource | Action | Reviewer | Administrator |
|---|---|---|---|
| tenant | `view` | 자신의 membership | 모두 |
| tenant | `create`, `update` | deny | allow |
| user | `view`, `update` | deny | allow |
| membership | `view`, `manage` | deny | allow |
| repository | `view`, `refresh` | same tenant + grant + enabled | allow |
| repository | `create`, `update` | deny | allow |
| pull_request | `view`, `refresh` | parent repository 조건 | allow |
| analysis | `view`, `chat` | parent repository 조건 | allow |
| analysis_prompt | `view`, `manage` | deny | allow |
| analysis_provider | `view`, `manage`, `test` | deny | allow |

List endpoint는 먼저 tenant/grant predicate를 SQL에 적용해 다른 tenant row를 읽지 않고, 반환 후보에 Cerbos batch check를 적용한다. 단일 resource endpoint는 tenant와 grant attribute를 조회한 뒤 Cerbos check를 수행한다. Deny는 기존 정책대로 `404 RESOURCE_NOT_FOUND`로 응답해 존재 여부를 숨긴다.

## 6. Admin API

### Tenant와 user

- `GET /api/v1/admin/tenants`
- `POST /api/v1/admin/tenants`
- `PATCH /api/v1/admin/tenants/:tenantId`
- `GET /api/v1/admin/users`
- `PATCH /api/v1/admin/users/:userId`
- `PUT /api/v1/admin/tenants/:tenantId/members/:userId`
- `DELETE /api/v1/admin/tenants/:tenantId/members/:userId`

User update는 local `enabled`만 변경한다. 이름, subject와 global role은 Keycloak signed claim에서 동기화된 read-only 정보다. Password, MFA와 Keycloak account lifecycle은 Keycloak Admin Console/API 책임으로 남긴다.

### Analysis prompt

- `GET /api/v1/admin/tenants/:tenantId/analysis-prompts`
- `POST /api/v1/admin/tenants/:tenantId/analysis-prompts`
- `POST /api/v1/admin/tenants/:tenantId/analysis-prompts/:promptId/activate`
- `POST /api/v1/admin/tenants/:tenantId/analysis-prompts/reset`

새 prompt는 1자 이상 12,000자 이하의 additional review instruction이다. Built-in untrusted-source guard와 JSON output contract는 교체할 수 없다. 생성/활성화/reset audit에는 tenant, version과 hash만 남기고 prompt 원문은 log에 남기지 않는다.

### Analysis provider

- `GET /api/v1/admin/analysis-provider`
- `POST /api/v1/admin/analysis-provider/versions`
- `POST /api/v1/admin/analysis-provider/versions/:providerId/activate`
- `POST /api/v1/admin/analysis-provider/reset`
- `POST /api/v1/admin/analysis-provider/test`

Provider는 모든 tenant analysis가 공유하는 전역 설정이다. `disabled` 또는 `openai-compatible` mode, endpoint, 명시적 model name과 timeout을 관리한다. 새 API key가 비어 있으면 현재 active admin version의 encrypted credential만 재사용할 수 있고, deployment fallback이나 credential이 없는 상태에서는 새 key가 필수다. Test는 source code나 prompt를 보내지 않는 최소 Chat Completions request이며 결과 본문은 browser나 log에 노출하지 않는다.

## 7. Prompt execution contract

Snapshot materialization이 analysis run을 만들 때 전역 active provider와 repository tenant의 active prompt를 선택하고 provider/prompt version ID와 hash를 고정한다. Admin provider가 없으면 deployment environment 설정을 사용한다. Worker 시작 뒤 active provider나 prompt가 바뀌어도 해당 run은 기존 version을 사용한다.

Model system message는 다음 순서로 합성한다.

1. immutable reviewer role과 repository content untrusted guard
2. tenant administrator additional instruction
3. immutable review scope, severity와 JSON output contract

Fixture/deterministic analysis에서는 custom prompt가 model output을 위조하지 않는다. Model이 disabled이면 prompt는 저장·활성화할 수 있지만 다음 model-enabled analysis 전까지 적용되지 않는 상태를 UI에 표시한다.

## 8. Browser UX

- Header에는 현재 사용자와 tenant selector를 표시한다.
- Administrator에게만 `/admin` navigation을 표시한다.
- Admin은 `Tenants`, `Users`, `Analysis provider`, `Analysis prompt` tab을 사용한다.
- Users에서 local enabled 상태와 tenant membership을 관리한다. Global role은 Keycloak 동기화 상태로 표시하고 편집하지 않는다.
- Analysis provider에서 effective source, mode, allowlisted endpoint, model name, timeout과 credential 설정 여부를 확인한다. API key input은 저장 뒤 즉시 비우고 다시 표시하지 않는다.
- Provider 저장과 활성화는 별도 command이며 최소 연결 test가 성공했다고 자동 저장하지 않는다.
- Analysis prompt에서 tenant를 선택하고 editor, active version/hash, version history, activate와 built-in reset을 사용한다.
- Prompt 저장은 `저장 및 활성화`라는 명시적 command이며 성공/실패 상태를 화면에 표시한다.

## 9. Deployment

- Keycloak은 외부 OIDC service로 연결하고 realm/client 설정 guide를 제공한다.
- Helm chart는 선택형 Cerbos Deployment/Service와 read-only policy ConfigMap을 제공한다.
- Server만 Cerbos HTTP endpoint에 연결한다. Worker는 authorization decision을 수행하지 않는다.
- Provider 관리자 기능을 켜면 동일한 model Secret의 encryption key를 Server와 Worker에 주입한다. Credential은 encrypted DB row 외에는 Server/Worker memory에만 복호화한다.
- Provider endpoint allowlist와 Kubernetes NetworkPolicy egress를 함께 제한한다. Application allowlist는 NetworkPolicy를 대체하지 않는다.
- Cerbos policy는 image가 아니라 chart version과 함께 배포하며 checksum annotation으로 policy 변경 시 rollout한다.
- `/health/dependencies`는 Cerbos 상태를 별도 표시한다.
- NetworkPolicy 사용 시 Server에서 Cerbos Service로의 egress만 허용한다.

## 10. Acceptance criteria

1. Reviewer는 membership이 없는 tenant와 grant가 없는 repository를 ID 직접 변경으로 조회할 수 없다.
2. Disabled user의 기존 session은 다음 request부터 거부된다.
3. Administrator만 tenant/user/membership/prompt API와 UI를 사용할 수 있다.
4. Cerbos unavailable 또는 invalid response 시 production request는 deny된다.
5. Prompt version 변경은 실행 중 analysis에 영향을 주지 않고 다음 run부터 적용된다.
6. Report version metadata로 사용한 prompt version/hash를 확인할 수 있으며 원문은 report, artifact, event와 log에 없다.
7. Keycloak logout/login 뒤 signed client role과 display name이 local cache에 동기화된다.
8. Helm default, external Cerbos, bundled Cerbos와 bundled PostgreSQL 조합이 schema/lint/render를 통과한다.
9. Administrator가 provider를 저장하면 API key 원문을 다시 읽을 수 없고 audit/log에도 남지 않는다.
10. Provider 변경 뒤 이미 queue된 run은 이전 provider version을, 다음 run은 새 version을 사용한다.
11. Allowlist 밖 endpoint와 잘못된 encryption key는 provider 저장/실행 전에 거부된다.

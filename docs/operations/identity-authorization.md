# Identity, authorization, and tenant administration

## Responsibility boundaries

| Component  | Source of truth                                                            |
| ---------- | -------------------------------------------------------------------------- |
| Keycloak   | 로그인, MFA/SSO, 사용자 identity, `git-code-reviewer-admin` client role    |
| PostgreSQL | 앱 접근 enabled 상태, tenant, membership, repository grant, prompt version |
| Cerbos     | principal/action/resource의 RBAC+ABAC decision                             |

조직이 이미 Entra ID, Okta, PingFederate 같은 OIDC provider를 운영하면 Keycloak을 새로 설치하지 않고 기존 provider를 사용하는 편이 낫다. 필요한 contract는 표준 Authorization Code + PKCE와 ID token의 role/group claim이다. Keycloak은 자체 DB, HA, backup, 보안 patch 주기가 application과 다르므로 Git Code Reviewer chart에 포함하지 않는다.

Cerbos는 이 서비스의 resource 중심 정책에 맞고 정책 테스트 도구를 제공하므로 기본 권장 PDP다. 조직이 이미 OPA/Gatekeeper 정책 운영 체계를 갖췄다면 같은 `AuthorizationService` 경계에 OPA adapter를 추가할 수 있다. 관계 기반 공유가 tenant membership보다 훨씬 복잡해질 때에만 OpenFGA 같은 ReBAC 저장소를 검토한다.

## Keycloak client

1. 운영 realm에 confidential OIDC client `git-code-reviewer`를 생성한다.
2. Standard flow와 PKCE `S256`을 사용하고 implicit/direct access grant는 끈다.
3. Valid redirect URI를 `https://git-code-reviewer.example.internal/auth/callback`으로 제한하고 Web origin도 서비스 origin 하나만 허용한다.
4. client role `git-code-reviewer-admin`을 만들고 관리자에게만 할당한다.
5. client의 **Full Scope Allowed**를 끄고 필요한 `openid profile email groups roles` scope만 허용한다.
6. client role이 ID token의 `resource_access.git-code-reviewer.roles`에 포함되는지 확인한다. 조직 정책상 realm role을 쓰면 `realm_access.roles`도 지원한다.
7. repository group grant를 사용할 때만 groups mapper를 추가해 문자열 배열 `groups` claim을 ID token에 넣는다.

앱은 `OIDC_ADMIN_ROLE` client/realm role 또는 `OIDC_ADMIN_GROUP` 중 하나가 일치하면 `administrator`, 아니면 `reviewer`로 동기화한다. 역할은 로그인할 때마다 identity provider 값으로 갱신되며 앱 관리 화면에서 바꾸지 않는다. 자세한 role scope와 protocol mapper 설정은 [Keycloak Server Administration Guide](https://www.keycloak.org/docs/latest/server_admin/)를 기준으로 한다.

OIDC 설정은 Kubernetes Secret에만 둔다.

```bash
kubectl -n git-code-reviewer create secret generic git-code-reviewer-auth \
  --from-literal=SESSION_SECRET="$(openssl rand -base64 48)" \
  --from-literal=OIDC_ISSUER='https://id.example.internal/realms/company' \
  --from-literal=OIDC_CLIENT_ID='git-code-reviewer' \
  --from-literal=OIDC_CLIENT_SECRET='...' \
  --from-literal=OIDC_REDIRECT_URI='https://git-code-reviewer.example.internal/auth/callback'
```

```yaml
auth:
  mode: oidc
  adminRole: git-code-reviewer-admin
  adminGroup: git-code-reviewer-admins
  defaultTenantSlug: default
  autoJoinDefaultTenant: false
```

`autoJoinDefaultTenant`는 pilot migration 때만 편리하다. 운영에서는 `false`로 두고 관리자가 membership을 명시적으로 할당한다.

## User and tenant lifecycle

첫 OIDC 로그인에서 사용자 레코드가 생성된다. 관리자는 `/admin`에서 다음 항목을 관리한다.

- **테넌트**: 생성, 표시 이름 변경, 활성/비활성 전환
- **사용자**: 앱 접근 enabled kill switch, tenant membership
- **분석 프롬프트**: tenant별 immutable version 생성, 이전 version 활성화, built-in prompt 복원

사용자를 비활성화하면 모든 앱 session이 즉시 삭제된다. 관리자는 자신의 현재 계정을 비활성화할 수 없다. Keycloak 계정, 암호, MFA와 role assignment는 Keycloak에서 관리한다. Tenant를 비활성화하면 해당 tenant의 repository는 polling과 사용자 조회에서 제외된다.

Reviewer는 enabled membership이 있는 tenant이면서 subject/group repository grant가 있는 repository만 볼 수 있다. Administrator는 모든 enabled tenant와 repository를 관리한다. 권한이 없는 단일 resource 요청은 존재 여부를 노출하지 않도록 404를 반환한다.

## Cerbos deployment

Bundled Cerbos를 사용하면 chart가 Cerbos 0.55.0 Deployment, Service, policy ConfigMap과 Server 전용 NetworkPolicy를 만든다.

```yaml
authorization:
  mode: cerbos
  cerbosUrl: ''
  timeoutMs: 2000

cerbos:
  enabled: true
  replicas: 2
```

기존 Cerbos PDP를 사용하면 `cerbos.enabled: false`, `authorization.cerbosUrl: http://cerbos.policy-system.svc:3592/`로 설정하고 NetworkPolicy egress를 추가한다. 두 설정을 동시에 켜면 Helm validation이 실패한다.

PDP timeout, 연결 실패, non-2xx 또는 해석할 수 없는 응답은 허용으로 fallback하지 않는다. 요청은 `503 AUTHORIZATION_UNAVAILABLE`로 실패하며 `/health/dependencies`의 authorization 상태는 `degraded`가 된다. 정책 API는 Cerbos [CheckResources](https://docs.cerbos.dev/cerbos/latest/api/index.html)를 사용한다.

배포 전 정책을 실제 Cerbos image로 컴파일하고 decision test를 실행한다.

```bash
docker run --rm \
  -v "$PWD/deploy/helm/git-code-reviewer/cerbos/policies:/policies:ro" \
  ghcr.io/cerbos/cerbos:0.55.0 \
  compile --strict-evaluation /policies
```

## Prompt version operations

관리자가 저장한 지침은 built-in source-as-untrusted guard와 JSON output contract 사이에 추가된다. Tenant 지침으로 고정 guard와 output schema를 교체할 수 없다. 프롬프트 원문은 관리자 API에만 반환하고 일반 report에는 version과 SHA-256 hash만 남긴다.

분석 작업이 생성될 때 active prompt version ID와 hash가 `analysis_runs`에 고정된다. 이후 active version이 바뀌어도 이미 queue에 들어간 분석의 지침은 변하지 않는다. 같은 지침을 다시 저장하면 중복 row를 만들지 않고 기존 version을 활성화한다.

Audit event에는 prompt 원문 대신 tenant ID, prompt version ID와 hash만 기록한다. 잘못된 새 지침은 `/admin?tab=prompt`에서 이전 version을 다시 활성화하거나 **기본값 복원**으로 즉시 rollback한다. 기존 report의 재현성을 위해 과거 version row는 삭제하지 않는다.

## Acceptance checks

1. Keycloak admin role 사용자에게만 `/admin` 링크가 보이고 API가 200인지 확인한다.
2. 일반 reviewer가 `/api/v1/admin/tenants`에서 404를 받는지 확인한다.
3. 두 tenant에 같은 reviewer를 배치하고 repository grant 유무에 따라 worklist가 분리되는지 확인한다.
4. 사용자 비활성화 직후 기존 session과 새 로그인이 모두 차단되는지 확인한다.
5. 프롬프트 v1으로 분석을 queue한 뒤 v2를 활성화하고, 첫 run은 v1 hash, 다음 run은 v2 hash인지 확인한다.
6. Cerbos Pod를 중지했을 때 보호 API가 503으로 fail closed되고 복구 후 정상화되는지 확인한다.
7. application log, audit metadata와 일반 report에 prompt 원문이나 OIDC token이 없는지 확인한다.

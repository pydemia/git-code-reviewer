# Local account 인증·사용자 관리 설계

## 1. 적용 범위

PRISM-DEV처럼 application과 browser를 `kubectl port-forward`로 연결하고 외부에서 접근 가능한 OIDC endpoint가 없는 환경은 `AUTH_MODE=local`을 사용한다. 사내 SSO, MFA와 중앙 계정 수명주기를 제공할 수 있는 운영 환경은 기존 `oidc` mode를 기본으로 유지한다.

Role은 다음 두 가지다.

| Role | 권한 |
| --- | --- |
| `administrator` | 사용자와 tenant, ChatGPT account, GHES connection, repository와 polling 정책을 관리한다. |
| `reviewer` | 자신에게 허용된 tenant와 repository를 조회하고 Review·Chat 기능을 사용한다. |

## 2. 계정과 credential

- `users`는 공통 application identity와 role, 활성 상태를 저장한다.
- `local_credentials`는 정규화된 사용자 이름과 scrypt password hash를 `users`에 1:1로 연결한다.
- 비밀번호는 12~128자로 제한하며 random 16-byte salt, scrypt `N=32768`, `r=8`, `p=1`, 64-byte derived key를 사용한다. 원문 비밀번호는 DB, API response, log와 audit metadata에 저장하지 않는다.
- 초기 시스템관리자와 선택적인 일반사용자는 Kubernetes auth Secret으로만 주입한다. Server는 해당 사용자 이름이 처음 나타날 때만 account와 credential을 생성하므로 Secret 변경이 관리자가 설정한 비밀번호를 덮어쓰지 않는다.
- 관리자는 `/admin?tab=users`에서 Local account를 생성하고 표시 이름, role, 활성 상태, tenant membership을 관리하거나 비밀번호를 재설정한다.
- 비밀번호 재설정, 사용자 비활성화 또는 role 변경 시 해당 사용자의 기존 server session을 폐기한다. 현재 시스템관리자는 자신의 role을 낮추거나 접근을 차단할 수 없다.

## 3. 로그인과 session

1. 인증되지 않은 API 요청은 HTTP 401을 반환하고 UI는 `/auth/login`으로 이동한다.
2. Local mode의 `/auth/login`은 application의 `/login` 화면으로 연결한다.
3. `POST /auth/local/login`은 사용자 이름을 정규화하고 저장된 scrypt hash를 비교한다. 존재하지 않는 사용자도 같은 scrypt 계산을 수행한다.
4. 같은 사용자 이름에서 15분 동안 5회 실패하면 15분간 로그인을 제한한다. 오류는 계정 존재 여부나 제한 상태를 구분하지 않는다.
5. 성공하면 256-bit random token을 발급하고 SHA-256 digest만 `user_sessions`에 8시간 보존한다. Cookie는 `HttpOnly`, `SameSite=Lax`를 사용하며 `PUBLIC_BASE_URL`이 HTTPS이면 `Secure`를 설정한다.
6. 로그아웃은 server session을 삭제하고 cookie를 제거한다.

모든 상태 변경 요청은 기존 same-origin 검사와 RBAC를 적용한다. 권한 없는 관리자 resource는 404로 숨긴다.

## 4. Kubernetes Secret contract

`secrets.auth`가 가리키는 Secret은 아래 key를 가진다.

| Key | 필수 | 설명 |
| --- | --- | --- |
| `SESSION_SECRET` | 필수 | 32자 이상의 cookie signing secret |
| `LOCAL_BOOTSTRAP_ADMIN_USERNAME` | 필수 | 최초 시스템관리자 사용자 이름 |
| `LOCAL_BOOTSTRAP_ADMIN_PASSWORD` | 필수 | 최초 시스템관리자 비밀번호 |
| `LOCAL_BOOTSTRAP_REVIEWER_USERNAME` | 선택 | 초기 일반사용자 사용자 이름 |
| `LOCAL_BOOTSTRAP_REVIEWER_PASSWORD` | 위 key 사용 시 필수 | 초기 일반사용자 비밀번호 |

실제 값은 values 파일이나 Git에 기록하지 않는다. 계정을 application에서 생성한 뒤에는 bootstrap Secret을 비밀번호 전달 수단으로 재사용하지 않는다.

## 5. API

```text
POST  /auth/local/login
POST  /auth/logout

GET   /api/v1/admin/users
POST  /api/v1/admin/users
PATCH /api/v1/admin/users/{userId}
PUT   /api/v1/admin/users/{userId}/password
PUT   /api/v1/admin/tenants/{tenantId}/members/{userId}
```

사용자 생성에는 `username`, `displayName`, `role`, 초기 `password`, 하나 이상의 `tenantIds`가 필요하다. 사용자 목록은 credential 자체 대신 `identityType=local|external`과 Local account의 `username`만 반환한다.

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
- 비밀번호는 8~128자로 제한하며 random 16-byte salt, scrypt `N=32768`, `r=8`, `p=1`, 64-byte derived key를 사용한다. 원문 비밀번호는 DB, API response, log와 audit metadata에 저장하지 않는다.
- 초기 시스템관리자와 선택적인 일반사용자는 Kubernetes auth Secret으로만 주입한다. Server는 해당 사용자 이름이 처음 나타날 때만 account와 credential을 생성하므로 Secret 변경이 관리자가 설정한 비밀번호를 덮어쓰지 않는다.
- 관리자는 `/admin?tab=users`에서 Local account를 생성하고 표시 이름, role, 활성 상태, tenant membership, repository grant를 관리하거나 비밀번호를 재설정한다.
- 사용자는 GNB의 `내 프로필`에서 자신의 계정 정보와 tenant membership을 확인한다. Local account는 표시 이름과 비밀번호를 직접 변경할 수 있다. 외부 인증 계정의 프로필과 비밀번호는 IdP에서 관리한다.
- 비밀번호 재설정, 사용자 비활성화 또는 role 변경 시 해당 사용자의 기존 server session을 폐기한다. 현재 시스템관리자는 자신의 role을 낮추거나 접근을 차단할 수 없다.
- 일반사용자 account를 만들거나 tenant membership을 설정하는 것만으로 repository가 공개되지는 않는다. 시스템관리자가 같은 tenant의 repository grant를 명시적으로 부여해야 일반사용자의 worklist에 나타난다.

## 3. 로그인과 session

1. 인증되지 않은 API 요청은 HTTP 401을 반환하고 UI는 `/auth/login`으로 이동한다.
2. Local mode의 `/auth/login`은 application의 `/login` 화면으로 연결한다.
3. `POST /auth/local/login`은 사용자 이름을 정규화하고 저장된 scrypt hash를 비교한다. 존재하지 않는 사용자도 같은 scrypt 계산을 수행한다.
4. 같은 사용자 이름에서 15분 동안 5회 실패하면 15분간 로그인을 제한한다. 오류는 계정 존재 여부나 제한 상태를 구분하지 않는다.
5. 성공하면 256-bit random token을 발급하고 SHA-256 digest만 `user_sessions`에 8시간 보존한다. Cookie는 `HttpOnly`, `SameSite=Lax`를 사용하며 `PUBLIC_BASE_URL`이 HTTPS이면 `Secure`를 설정한다.
6. 로그아웃은 server session을 삭제하고 cookie를 제거한다.

Local account의 비밀번호 변경은 현재 비밀번호를 다시 확인하고 로그인과 동일한 15분당 5회 실패 제한을 적용한다. 새 비밀번호가 현재 비밀번호와 같으면 거부한다. 변경에 성공하면 사용자의 모든 session을 폐기하고 다시 로그인하도록 안내한다. 프로필·비밀번호 변경 요청은 schema validation 실패, 외부 관리 계정, 현재 비밀번호 불일치, 변경 정책 위반을 포함해 성공·실패 audit event를 남긴다. 예상하지 못한 database 장애처럼 audit 저장 자체가 불가능한 오류는 server error log로 추적한다.

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

GET   /api/v1/profile
PATCH /api/v1/profile
PUT   /api/v1/profile/password

GET   /api/v1/admin/users
POST  /api/v1/admin/users
PATCH /api/v1/admin/users/{userId}
DELETE /api/v1/admin/users/{userId}
PUT   /api/v1/admin/users/{userId}/password
PUT   /api/v1/admin/tenants/{tenantId}/members/{userId}
PUT   /api/v1/admin/repositories/{repositoryId}/grants/{userId}
```

사용자 생성에는 `username`, `displayName`, `role`, 초기 `password`, 하나 이상의 `tenantIds`가 필요하다. 사용자 목록은 credential 자체 대신 `identityType=local|external`, Local account의 `username`, tenant membership과 repository grant만 반환한다. Grant API는 대상 사용자가 해당 repository의 tenant에 속하고 두 resource가 모두 활성 상태일 때만 권한을 부여한다.

프로필 API는 인증된 사용자 본인에게만 적용한다. `PATCH /api/v1/profile`은 Local account의 `displayName`만 변경하고, `PUT /api/v1/profile/password`는 `currentPassword`와 8~128자의 `newPassword`를 받는다. API response에는 password hash나 credential secret을 포함하지 않는다.

## 6. 사용자 삭제 (2026-09-08)

관리자 사용자 목록의 휴지통 버튼은 확인창을 연다. Local username 또는 외부 Subject를 직접 입력해야 삭제 요청을 전송한다. 본인 삭제 버튼은 비활성화하며 서버에서도 `409 SELF_DELETE_NOT_ALLOWED`로 거부한다. 취소에 초기 focus를 두고 Escape·취소·닫기를 제공한다. 요청 중에는 입력·닫기를 잠그고 중복 제출을 막는다. 실패 시 입력을 유지하고 오류에 focus를 옮기며 성공 후 목록에서 해당 행을 제거한다.

`DELETE /api/v1/admin/users/{userId}`는 strict body `{ "confirmIdentity": "sample-user" }`를 받는다. Administrator와 PDP `manage` 권한을 모두 요구하며 비로그인·일반사용자·policy 거부·없는 대상·이미 삭제한 대상은 404다. 확인값 불일치는 `409 USER_DELETE_CONFIRMATION_MISMATCH`다. 같은 Origin 검사는 기존 공통 경계를 따른다.

Migration `0019_user_deletion.sql`은 `users.deleted_at`과 삭제 상태의 접근 제한 CHECK를 추가한다. 삭제는 다음 변경과 `user.delete` audit을 하나의 transaction으로 처리한다.

- `deleted_at` 기록, `enabled=false`, 개인 Prompt와 group claim 제거
- 모든 `user_sessions` 폐기, Local password hash 제거 (`!deleted` 비인증 marker로 대체)
- tenant membership 비활성화와 해당 Subject의 직접 repository grant 제거. 공유 group grant는 유지

사용자 row·identity와 기존 개인 Chat은 보존한다. 개인 Chat은 다른 사용자에게 이전하지 않고 기존 retention에 따라 정리한다. 공동 PR report·operation·Provider·Prompt/Skill version의 작성자 참조와 audit 이력을 유지하므로 hard delete하지 않는다. 이는 개인정보 완전 삭제 API가 아니다. 기존 username·Subject는 재사용할 수 없고 UI/API 복원 기능은 제공하지 않는다. 일시 차단에는 기존 `enabled=false` 기능을 사용한다.

접근 변경 PATCH와 DELETE는 동일 advisory transaction lock을 사용하고 잠금 안에서 요청자의 현재 관리자 권한을 다시 확인한다. 관리자 두 명의 동시 상호 삭제·비활성화로 활성 관리자가 없어지는 상황을 막는다. 마지막 관리자 제거는 허용하지 않는다. 삭제된 대상의 접근 변경·비밀번호 재설정·멤버십 재부여도 거부한다. Audit 저장이 실패하면 삭제와 credential 정리까지 rollback한다.

Local bootstrap과 외부 identity upsert는 삭제된 identity를 되살리지 않는다. OIDC/proxy의 원본 IdP 계정은 변경하지 않으며 같은 Subject의 앱 접근만 계속 차단한다. Development mode도 사용자 객체를 영구 cache하지 않아 삭제 후 다음 요청부터 차단한다. 이미 시작된 모델 요청을 취소하거나 게시된 PR 댓글·기존 report를 재작성하지 않는다.

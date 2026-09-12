# Commit Defender의 리뷰 정책·메모리 동기화 설계

작성일: 2026-09-11  
상태: 구현 계획. 아래 client API·저장 구조·동기화 프로토콜은 아직 구현되지 않음.  
관련 문서: [플랫폼 기획](./preventive-review-platform-plan.md), [Commit Defender 재사용 검토](./commit-defender-integration-assessment.md), [로컬 VS Code 검증·CLI 게시 절차](./client-extension-release-plan.md)

## 실행 모드와 서버 설정

사용자가 선택하는 모드는 `standalone`과 `centralized` 두 가지다. 초기 기본값은 `standalone`이며 중앙 서버를 설치하거나 로그인하지 않아도 리뷰·메모리·Skill 관리가 가능해야 한다. 아래의 cached/fallback 표시는 실행 상태이며 세 번째 설정 모드를 만들지 않는다.

| 항목      | `standalone`                                                                | `centralized`                                                                |
| --------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 중앙 서버 | 불필요. 저장된 서버 주소가 있어도 background sync·feedback 전송을 하지 않음 | 사용자가 입력한 Git Code Reviewer URL에 연결                                 |
| 인증      | 선택한 모델 provider의 로컬 로그인/API 설정                                 | 중앙 로그인과 모델 provider 로그인을 분리                                    |
| 리뷰 지식 | Built-in Skill + 사용자가 활성화한 local Skill·memory                       | 유효한 중앙 정책·Skill·집단·본인 개인 메모리 + 충돌하지 않는 local 보완 자료 |
| 로컬 저장 | 본인 profile·repository별 memory, Skill, 리뷰·대화 이력                     | 독립형 저장소를 유지하면서 중앙 배포 snapshot을 별도로 저장                  |
| 모델 실행 | 기존 로컬 계정 CLI 또는 사용자가 지정한 API provider                        | 같은 로컬 executor를 기본으로 사용. 중앙 proxy는 별도 선택 사항              |
| 서버 장애 | 영향 없음                                                                   | 설정에 따라 유효 cache 사용, standalone fallback 또는 대기                   |

`Standalone`은 중앙 서버에 의존하지 않는다는 뜻이다. 선택한 모델이 외부 API·계정 CLI를 사용하면 그 제공자와의 연결은 여전히 필요하다. 모델을 실행할 수 없을 때는 지식 조회·편집·과거 결과 열람은 가능하지만 AI 리뷰를 완료했다고 표시하지 않는다.

Commit Defender 설정에 다음 항목을 추가한다. 기존 `commitDefender.aiProvider`·모델 설정은 독립형과 로컬 executor에서 재사용한다.

| 설정 이름                                        | 값·기본값                                       | 동작                                                               |
| ------------------------------------------------ | ----------------------------------------------- | ------------------------------------------------------------------ |
| `commitDefender.mode`                            | `standalone` / `centralized`; 기본 `standalone` | Repository별 실행 모드를 명시적으로 선택                           |
| `commitDefender.centralized.serverUrl`           | 기본 빈 문자열                                  | Git Code Reviewer의 base URL. Centralized 최초 연결 시 입력        |
| `commitDefender.centralized.offlineBehavior`     | `cache-then-standalone` 기본                    | 유효 cache 우선, 사용할 수 없으면 local 자료만으로 standalone 실행 |
| 같은 설정의 다른 값                              | `cache-only`, `standalone`, `pause`             | Cache만 허용 / 연결 실패 시 곧바로 standalone / 연결 복구까지 대기 |
| `commitDefender.centralized.modelExecutor`       | `local` 기본 / `centralized`                    | 정책 sync 위치와 모델 실행 위치를 독립적으로 선택                  |
| `commitDefender.centralized.syncIntervalSeconds` | `300` 제안                                      | Centralized 모드에서만 background sync. Sync 자체는 모델 미호출    |

설정 예시는 다음과 같으며 실제 서버 주소는 사용자가 입력한다. 이 문서의 URL을 제품에 기본 연결 대상으로 등록하지 않는다.

```json
{
  "commitDefender.mode": "centralized",
  "commitDefender.centralized.serverUrl": "https://review.example.com",
  "commitDefender.centralized.offlineBehavior": "cache-then-standalone",
  "commitDefender.centralized.modelExecutor": "local",
  "commitDefender.centralized.syncIntervalSeconds": 300
}
```

모드 선택·서버 주소 입력·`연결 테스트`·`로그인`·`지금 동기화`를 하나의 연결 설정 화면에 둔다. 연결 테스트는 API 호환성·서버 식별·인증 필요 여부를 확인하며 source 업로드나 모델 호출은 하지 않는다. 잘못된 주소, 인증 필요, 통신 장애, sync API 미지원 상태를 구분한다. 주소가 입력됐다는 이유만으로 standalone을 centralized로 바꾸지 않는다.

Server URL은 HTTPS를 기본으로 하며 loopback 개발 서버의 HTTP만 명시적으로 허용한다. Base path가 있는 배포도 지원하고 URL의 credential·query·fragment는 받지 않는다. 인증정보를 다른 origin으로 redirect하지 않는다. 공유 workspace 설정이 URL을 바꾸더라도 사용자가 새 연결 대상을 확인하기 전에는 token을 전송하지 않는다.

설정은 사용자 기본값과 확인된 repository별 override로 관리하고 secret은 포함하지 않는다. 다른 서버·tenant·계정으로 변경하면 기존 cache·token을 새 연결에 재사용하지 않는다. `serverUrl`과 별도로 확인된 server ID·신뢰 키·계정에 묶인 connection profile을 둔다. URL이 같더라도 서버 식별이 달라지면 재연결을 요구한다.

## 연결 실패 시 동작

기본 `cache-then-standalone` 흐름은 다음과 같다.

```text
configuredMode = centralized
  → 중앙 연결·sync 성공: 중앙 snapshot으로 리뷰
  → 연결 실패 + 사용 가능한 cache: 저장된 중앙 snapshot으로 리뷰
  → cache 없음·만료·사용 불가: local memory·Skill로 standalone 리뷰
  → 허용된 모델 executor 없음: AI 리뷰 unavailable, 로컬 자료 관리는 유지
```

유효 cache는 해당 서버·tenant·사용자·repository에 묶인 완전한 snapshot이며 서명·호환성·offline lease·인가 조건을 만족해야 한다. Cache가 없는 첫 실행, 만료된 cache, 잘못된 서명, 호환되지 않는 schema를 유효 cache처럼 사용하지 않는다. `cache-only`는 유효 cache가 없으면 대기하고, `standalone` fallback은 서버 실패 시 중앙 cache도 사용하지 않는다.

사용자가 선택한 `configuredMode`와 실제 리뷰의 `effectiveMode`, `knowledgeSource`, `fallbackReason`을 별도로 기록한다. 일시적인 fallback 때문에 저장된 모드나 서버 URL을 변경하지 않는다. UI는 `Centralized · online`, `Centralized · cached · 마지막 동기화 …`, `Standalone · fallback: 서버 연결 실패`를 구분하고 cache 만료 시각도 표시한다.

Fallback standalone은 built-in/local Skill·local memory만 사용한다. 만료·철회된 중앙 자료를 local 자료로 이름만 바꿔 계속 사용하지 않는다. 해당 결과는 중앙 정책을 충족했다는 증명으로 재사용할 수 없다. 중앙 검증이 필수인 작업에서도 독립형 참고 리뷰와 중앙 검증 미완료 상태를 구분한다.

기본 `modelExecutor=local`이면 서버 장애 중에도 같은 provider를 사용한다. 중앙 proxy를 선택한 경우 유효한 지식 cache만 있어도 모델을 실행할 수 있는 것은 아니다. 연결 설정에서 별도 local executor와 source 전송 범위를 미리 승인한 경우에만 그 경로로 전환한다. 승인하지 않은 다른 제공자로 source를 보내거나 중앙 credential을 로컬로 복사하지 않는다.

중앙 모델 job 제출 후 응답만 끊긴 경우에는 로컬 재실행을 즉시 시작하지 않는다. 기존 job의 상태를 확인하거나 취소를 확인해 중복 호출을 방지한다. 확인이 불가능하면 실행 상태를 미확정으로 표시하고 사용자 재시도 시 중복 실행 가능성을 알린다. Mode/서버 전환 시에도 시작한 리뷰의 context·인가 범위를 중간에 섞지 않는다.

Centralized로 설정된 동안은 backoff·jitter로 재연결하고 정상 sync 후 다음 리뷰부터 중앙 snapshot을 사용한다. 재연결만으로 모델을 호출하거나 과거 standalone 결과를 중앙 리뷰 결과로 승격하지 않는다. 사용자가 standalone으로 전환하면 새 중앙 요청·재시도·feedback 전송을 중단하며, 진행 중 원격 작업은 취소를 시도하고 남은 실행 상태를 별도로 표시한다.

## 동기화의 단위와 방향

Centralized 모드에서는 중앙 Git Code Reviewer가 배포 원본을 관리하고 Commit Defender의 공통 client core가 읽기 전용 snapshot을 받는다. 로컬에서 승인된 정책·집단 메모리를 직접 수정해 서버와 병합하는 양방향 파일 sync는 하지 않는다. 사용자가 직접 작성한 local 자료는 별도로 저장하고, 중앙 반영을 요청한 정정·예외·새 판단만 feedback 또는 메모리 후보로 제출해 중앙의 검토 절차를 거친다.

```text
GitHub 리뷰·사용자 feedback
        ↓ 후보 추출·검토·승인
중앙 정책 / 집단 메모리 / 개인 메모리
        ↓ 불변 bundle 발행
인증된 manifest → 필요한 bundle만 다운로드
        ↓ 검증·동시 활성화
로컬 cache → 관련 기준·메모리 선택 → 실제 코드 리뷰
                                      ↓ 사용자가 제출한 feedback
                                   중앙 후보 관리
```

Sync 자체는 모델을 호출하지 않는다. 승인된 데이터를 선택·직렬화하고 version/hash를 비교하는 서버·client 코드로 처리한다. 원문에서 메모리 후보를 추출하거나 실제 코드를 리뷰하는 모델 실행과 분리한다.

중앙에서 배포하는 review Skill의 전체 내용·version/hash는 `policyBundle`에 포함한다. 서버 연결 없이 cache로 리뷰할 때도 필요한 Skill 내용을 읽을 수 있어야 하며 이름과 hash만 저장하지 않는다. 로컬 사용자의 Skill과 중앙 Skill은 저장 위치·출처·수정 권한을 분리한다.

| 구성 요소                | 내려보낼 내용                                                                | 범위와 적용 방식                                                                                 |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `policyBundle`           | 리뷰 관점·report 형식·심각도 설정, 승인된 요구 사항·적용 조건·예외·조사 절차 | 해당 tenant·repository에 유효한 정책을 서버가 해석해 배포. 권한·실행 제한은 자연어 prompt와 분리 |
| `collectiveMemoryBundle` | 반복 결함, 설계 합의, 오탐·허용 예외, 미해결 질문과 근거                     | 해당 repository에 공개하도록 승인된 집단 메모리                                                  |
| `personalMemoryBundle`   | 본인의 repository별 과거 판단·선호·리뷰 이력에서 승인된 메모리               | 인증된 본인에게만 제공. 집단 기준을 덮어쓰지 않는 보완 자료                                      |

각 메모리는 `id`, `revision`, `contentHash`, `kind`, `summary`, `detail`, `recommendation`, 적용 경로·symbol·branch 조건, 유효 기간·대체 관계, source 참조를 갖는다. Source는 PR/댓글 식별자·허용된 URL·원문 hash·관련 commit을 연결한다. 현재 schema에 없는 적용 조건·기간·source projection은 확장한다.

GitHub 원문 전체나 모든 사용자의 개인 이력을 기본 복제하지 않는다. 배포용으로 승인된 판단과 필요한 짧은 근거를 전달하고, 상세 원문은 명시적인 조회 요청 시 중앙에서 다시 권한을 확인한다. 집단 메모리에도 개인 정보나 비공개 source 내용이 섞이지 않도록 배포 projection을 별도로 검토한다. `open-question`은 합의된 사실이나 정책 위반 조건으로 승격하지 않는다.

## 현재 코드에서 재사용할 것

- `reviewMemorySchema`의 개인·집단 scope, 상태, revision/hash, 적용 경로·symbol, source 정보: [계약](../packages/contracts/src/review-memory.ts#L33).
- 메모리 활성화·집계와 같은 `aggregationKey`의 개인 항목보다 집단 항목을 우선하는 처리: [선택 로직](../apps/runtime/src/services/review-memory.ts#L258).
- 활성 Skill bundle, version/hash 검증, 분석에 사용한 버전을 고정하는 처리: [정책 서비스](../apps/runtime/src/services/analysis-skills.ts#L21).

기존 Skill 활성 버전은 서비스 전역 조회이며 tenant·repository별 배포 정책을 이미 제공하는 것은 아니다. 기존 메모리 조회도 분석 run에 연결된 화면용 API다. Client 전용 인가·배포 projection·sync API를 새로 만든다.

현재 메모리 review route는 같은 row의 상태·내용을 갱신할 수 있다. 따라서 `id/revision`만 참조한 뒤 다운로드 시점의 row를 다시 읽으면 배포 내용이 바뀔 수 있다. **발행 시점의 실제 JSON bytes를 불변 artifact로 저장**하고 그 hash로 식별한다. 배포 이후 DB row가 바뀌어도 이미 발행한 artifact는 덮어쓰지 않는다. [현재 갱신 경로](../apps/runtime/src/routes/review-memory.ts#L548)

## 중앙 발행과 manifest

정책 활성화, 메모리 승인·수정·폐기, 원문 삭제·제외에 따른 재검토 결과가 같은 transaction의 outbox에 변경 이벤트를 기록하도록 확장한다. 발행 worker가 영향을 받는 범위만 다시 만든다. 모델 호출 없이 처리하며 같은 내용이면 artifact를 재사용한다.

발행 과정은 다음과 같다.

1. 일관된 DB snapshot에서 배포 가능한 정책·집단·본인 개인 자료를 선택한다. 원문이나 후보가 갱신됐다는 이유만으로 미승인 내용을 배포하지 않는다.
2. Scope별 직렬화 규칙을 고정해 JSON을 만들고 content hash·크기·schema를 기록한다. MVP는 크기 상한이 있는 완전한 bundle을 사용한다. 상한을 넘으면 일부를 조용히 누락하지 않고 새 발행을 실패 처리한다.
3. 모든 artifact 저장·검증이 끝난 뒤 현재 배포 pointer를 교체한다. Artifact가 준비되지 않은 release를 manifest에서 가리키지 않는다.
4. Client가 요청하면 현재 인가에 맞는 정책·집단·개인 component의 일관된 조합을 manifest로 반환한다. 개인 메모리가 없다는 사실도 서명된 빈 component로 표현하며 개인 component 다운로드 실패를 빈 메모리로 취급하지 않는다.

사용자별 manifest의 논리 구조는 다음과 같다. 필드명은 구현 시 contracts package에서 확정한다.

```text
ReviewKnowledgeManifest
  schemaVersion
  audience: serverId, tenantId, repositoryId, userId
  snapshotId, manifestHash
  components
    policy:    bundleId, releaseSequence, contentHash, sizeBytes
    collective: bundleId, releaseSequence, contentHash, sizeBytes
    personal:  bundleId, releaseSequence, contentHash, sizeBytes
  authorizationRevision, revocations
  issuedAt, offlineValidUntil
  compatibleClientVersions
  signingKeyId, signature
```

Component는 독립적으로 바뀌므로 개인 메모리만 바뀌면 개인 bundle만 다운로드한다. 활성화는 component별로 하지 않고 manifest가 지정한 조합 전체를 한 번에 교체한다. 각 component의 release 순서와 hash를 검증하며 승인된 rollback도 이전 artifact를 참조하는 더 높은 `releaseSequence`로 발행한다.

작은 repository는 전체 메모리를 동기화해 로컬 검색한다. 규모가 커지면 경로·업무 영역별 shard와 manifest index를 추가한다. 그다음 delta를 도입하며 pinned release pagination, 삭제 tombstone, cursor 만료 시 full resync를 포함한다. 페이지 누락이나 byte 상한 초과를 ‘동기화 완료’로 표시하지 않는다.

## Client 인증과 API

인증키·발급·보관·폐기는 [client 인증 설계](./client-authentication-design.md)를 따른다. Web UI는 자체 배포한 Keycloak의 SAML 로그인으로 신원을 확인하며, GCR은 앱 사용자·권한과 client 인가·token/API key 발급·폐기를 담당한다. Keycloak은 앱과 같은 PostgreSQL 자원에 별도 database·role로 연결한다. [배포안](./keycloak-saml-deployment-design.md)에 따라 사용자 관리 화면은 GCR에 두고 비밀번호·MFA 원본은 Keycloak에서 관리한다. `login`은 SAML 로그인 후 GCR에서 client 연결을 승인하고, `api-key`는 GCR이 발급한 만료·scope 제한 개인 키를 등록한다. 공용 key는 제공하지 않으며 원문 key는 VS Code settings나 repository에 저장하지 않는다.

중앙 로그인과 모델 provider 로그인은 별개다. 신규 `AUTH_MODE=saml`·기존 사용자 DB·웹 session 계약을 기반으로 GCR 내부에 PKCE code flow와 headless/remote CLI의 device flow를 추가한다. SAML assertion은 client sync API의 bearer token으로 사용하지 않는다. Credential을 제거한 remote를 tenant·repository ID에 명시적으로 연결하며 fork·여러 remote·같은 이름의 GHES repository를 임의로 하나로 합치지 않는다. 인증 방식은 `commitDefender.centralized.authMethod`로 선택하며 서버가 아직 구현하지 않은 방식은 비활성화한다. Standalone에는 중앙 인증·Keycloak을 요구하지 않는다.

기본 scope는 `rules:read`, `memories:read`이며 개인 메모리 owner는 request body가 아니라 인증된 사용자에서 정한다. 원문 조회는 `sources:read`, feedback은 `feedback:submit`, 결과 제출은 `reviews:submit`, 중앙 모델 호출은 `ai:invoke`로 분리한다. 모든 manifest·artifact·source 요청에서 credential의 현재 상태와 tenant membership·repository grant·요청 scope를 확인한다.

| 제안 API                                                          | 역할                                                             |
| ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `GET /api/v1/client-auth/config`                                  | GCR 자체 인증 방식·endpoint·public client ID·API audience 안내   |
| `GET /api/v1/client-auth/authorize`                               | GCR 계정 로그인·PKCE client 승인 시작                            |
| `POST /api/v1/client-auth/device`                                 | GCR의 headless device 연결 승인 요청                             |
| `POST /api/v1/client-auth/token`                                  | GCR의 code 교환·access/refresh token 발급·갱신                   |
| `POST /api/v1/client-repositories/resolve`                        | Git repository와 중앙 repository를 연결                          |
| `GET /api/v1/repositories/:id/review-knowledge/manifest`          | 인증된 사용자의 정책·집단·개인 bundle 조합. `If-None-Match` 지원 |
| `GET /api/v1/repositories/:id/review-knowledge/bundles/:bundleId` | Scope·현재 인가 확인 후 불변 artifact 제공                       |
| `GET /api/v1/repositories/:id/review-knowledge/sources/:sourceId` | 원문 또는 허용된 근거 projection을 명시적으로 조회               |
| `POST /api/v1/repositories/:id/review-knowledge/feedback`         | 선택한 판단에 대한 정정·예외·메모리 후보 제출                    |

기존 기획의 공용/개인 `rule-manifest` 분리 제안은 위 사용자별 조합 manifest로 구체화한다. Code 교환·기기 승인·token 갱신·폐기는 GCR 자체 인증 모듈에서 처리한다. 저장 artifact와 권한 경계는 계속 분리한다. UUID나 content hash를 아는 것만으로 다운로드할 수 없고, 개인 bundle에 공개 object URL을 발급하지 않는다. 사용자 응답을 공용 CDN cache에서 재사용하지 않도록 하며 로컬 cache도 계정별로 나눈다.

## 로컬 저장과 갱신 절차

공통 core의 `KnowledgeStore`를 Commit Defender·CLI·MCP·hook이 공유하도록 설계한다. 사용자 자료를 보관하는 `LocalKnowledgeStore`와 중앙 snapshot용 `CentralSnapshotStore`를 분리하고 `KnowledgeSyncService`는 centralized 모드에서만 동작한다. VS Code 프로세스에만 자료나 인증을 보관하지 않으며 extension을 닫거나 서버 연결이 없어도 저장된 데이터를 읽을 수 있어야 한다.

기본 저장 위치는 Git repository 바깥 OS application data 경로다. macOS에서는 `~/Library/Application Support/CommitDefender/`를 제안하며 Linux 등은 해당 OS의 application data 경로를 사용한다. 다음은 논리 구조이며 구현 파일명·암호화 형식은 storage contract에서 확정한다.

```text
CommitDefender/
  profiles/<local-profile-id>/
    local/
      skills/<skill-id>/SKILL.md
      repositories/<local-repo-key>/
        memories.store
        skills/<skill-id>/SKILL.md
        reviews.store
    central/<server-id>/<tenant-id>/<user-id>/<repository-id>/
      snapshots/<snapshot-id>/
      active-snapshot
```

Standalone은 로컬 profile과 안정적인 repository key만 필요하다. 중앙 user/repository ID는 필수값이 아니다. Git root·common directory·credential을 제거한 remote 등으로 repository를 식별하고 같은 basename의 서로 다른 repository, worktree, 복제된 checkout을 구분한다. Profile 전환 시 다른 사용자의 local 자료를 공유하지 않는다.

Local memory는 생성·편집·활성화·보관·삭제·내보내기를 지원하고 version/hash·근거·적용 범위·출처를 남긴다. 리뷰·chat 이력은 프로세스 종료 후에도 보존하되 보존 기간과 삭제 기능을 둔다. 이력에서 뽑은 메모리는 후보로 저장하고 사용자 확인 후 활성화한다. 모델의 모든 답변을 승인된 메모리로 자동 승격하지 않는다.

Local Skill도 생성·가져오기·편집·활성화·비활성화·내보내기를 지원한다. 사용자 공통과 repository별 범위를 구분하고 실제 Markdown 내용·metadata·hash를 저장한다. 기존 `.commit-defender/<name>/SKILL.md`는 사용자가 확인한 repository에서 명시적으로 등록할 수 있지만 system 지침·도구 권한으로 자동 승격하지 않는다. Sync 자료와 local Skill 모두 이번 제품에서는 실행 script가 아닌 리뷰 지침으로 취급한다.

Local 항목에는 중앙 offline lease를 적용하지 않는다. 사용자가 설정한 유효 기간·보관 상태를 따른다. 중앙 연결 해제·sync 실패·중앙 cache 삭제로 local memory·Skill을 지우지 않는다. 반대로 중앙 자료는 readonly로 관리하고 sync 갱신 시 사용자의 local 변경을 덮어쓰지 않는다. 중앙 자료를 local 항목으로 자동 복제하는 기능은 두지 않으며 export도 해당 자료의 공개 범위·권한을 확인한다.

Centralized에서는 유효한 중앙 정책·집단 메모리가 local 지침보다 우선한다. Local 자료는 적용 가능한 범위에서 보완 자료로 사용하고 충돌하면 숨기지 않고 설명한다. Standalone에서는 활성 built-in/local Skill과 local memory만으로 context를 구성한다. Local 자료를 중앙 집단 메모리로 표시하지 않는다.

- Managed cache는 사용자 전용 파일 권한과 저장 시 암호화를 적용하고 key·token은 OS credential store adapter로 관리한다. VS Code SecretStorage만 쓰면 독립 CLI와 자연스럽게 공유되는 것으로 가정하지 않는다.
- 개인 local memory·대화 이력도 저장 시 암호화하고 사용자 소유 Skill 파일은 사용자 전용 권한으로 저장한다. 저장소와 검색 index·credential 파일은 전체 repository 분석에서도 source 수집 대상에서 제외한다.
- 중앙 다운로드 JSON에는 Skill의 실제 내용까지 포함하고 검색 index를 함께 저장한다. 이를 repository의 `.commit-defender/*/SKILL.md`로 복사하지 않는다. 분석 시 선택된 내용만 제한된 review context로 구성한다.
- Server 신뢰 정보와 signing key는 최초 연결 시 확인한 조직 신뢰 설정에 고정한다. Bundle이 임의로 제공한 key를 그대로 신뢰하지 않는다. Key rotation·폐기를 지원한다.

```text
resolve authenticated repository scope
→ freshness·offline lease 확인
→ 조건부 manifest 조회
→ 변경된 artifact만 staging 디렉터리에 다운로드
→ audience·schema·서명·hash·크기·호환성 검증
→ 로컬 검색 index 구성
→ cross-process lock 아래 active snapshot pointer 원자적 교체
```

동시에 sync 요청이 오면 하나의 작업으로 합친다. 느리게 끝난 옛 다운로드가 새 pointer를 덮어쓰지 않도록 활성화 직전에 현재 generation·인가 상태를 다시 확인한다. 다운로드 실패·디스크 부족·잘못된 서명·알 수 없는 필수 schema에는 기존 유효 snapshot을 유지하고 실패 이유를 표시한다. 한 component만 새 버전인 조합은 사용하지 않는다.

ETag는 전송량을 줄이는 수단이고 인가나 유효 기간을 대신하지 않는다. 서버는 304 응답 전에도 권한을 확인한다. 서명된 offline lease를 새로 발행해야 하면 변경된 manifest를 200으로 반환한다. 304를 받았다는 이유로 기존 서명의 만료 시각을 client가 연장하지 않는다.

## 갱신 시점과 실제 리뷰

Centralized에서 MVP 제안값은 최초 연결·client 시작·수동 sync 시 확인, 사용 중 5분 간격+jitter, 리뷰 직전 마지막 확인이 5분 이상 됐으면 재확인이다. 네트워크 재연결·절전 복귀·계정 또는 remote 변경 때도 확인한다. Commit·Push에 더 엄격한 최신성 확인이 필요하면 repo 정책으로 별도 설정한다. Standalone에서는 이 중앙 sync 절차를 실행하지 않는다.

**Sync 시점과 LLM 리뷰 시점은 별개다.** Save·Stage·Commit·Push 중 사용자가 선택한 이벤트 또는 수동 요청이 리뷰를 시작한다. 정책·메모리 갱신만으로 모델을 호출하지 않는다. 기존 결과에 쓰인 항목이 바뀌면 stale로 표시하고 자동 실행 설정·예산이 허용하는 다음 시점 또는 수동 요청에서 다시 검토한다. 자동 실행을 모두 꺼 두면 sync만 수행한다.

한 리뷰는 시작할 때 실행 모드, 중앙 `knowledgeSnapshotId`가 있으면 해당 ID, policy/collective/personal hash, 활성 local Skill·memory hash, source snapshot을 고정한다. 실행 중 새 bundle이 와도 prompt·도구 결과에 섞지 않는다. 일반 갱신은 해당 실행을 고정 버전으로 마치되 영향받는 결과를 stale로 표시한다. 권한 철회나 critical revocation을 확인하면 관련 context의 추가 사용을 중단하고 진행 중 리뷰를 취소·무효화한다.

실제 review context는 다음 순서로 구성한다.

1. 정확한 base·index·working tree·push refs 중 해당 요청의 입력 snapshot을 정한다.
2. 적용 조건이 맞는 필수 정책을 먼저 선택하고 관련 경로·symbol·업무 영역의 메모리를 로컬 index에서 찾는다.
3. 같은 판단·적용 범위에서는 집단 메모리를 우선하고 개인 메모리는 부족한 정보를 보완한다. 이 충돌 해석은 모델 prompt의 요청에만 맡기지 않고 결정적인 client 로직과 중앙의 동일한 fixture로 검증한다.
4. 근거 원문·base·호출부가 더 필요하면 고정 snapshot과 접근 정책 안에서 추가 조회한다. 필수 정책·필수 근거가 context 예산에 들어가지 않으면 미완료로 남기고 누락을 기록한다.

현재 코드는 같은 `aggregationKey`의 집단 메모리 우선 처리를 관련도 계산 전에 수행한다. 연결형에서는 적용 범위·branch·예외까지 포함한 충돌 해석을 공통화하고, 관련 없는 집단 메모리가 개인 메모리를 가리는 사례도 검증한다. 개인 memory가 높은 검색 점수를 받았다는 이유로 집단 결정을 뒤집게 하지 않는다.

메모리는 판단 근거이지 현재 코드의 사실을 대신하지 않는다. 현재 코드가 과거 결함을 수정했거나 예외 조건이 달라졌으면 그 근거를 보고하고 메모리 재검토 후보를 만든다. 과거에 지적했다는 이유만으로 재발한 결함을 숨기거나 실행 권한 정책을 해제하지 않는다. 정책·메모리·원문에는 executable script와 임의 tool 정의를 허용하지 않는다.

결과에는 사용한 정책·메모리 ID/revision/hash와 근거를 남긴다. 결과 재사용 key에 실행 모드·중앙 scope·지식 snapshot·local 항목 hash를 포함해 처음에는 보수적으로 invalidation한다. Standalone 결과를 centralized 결과로 재사용하지 않는다. 이후 사용 항목과 새로운 관련 항목의 영향을 확인할 수 있을 때만 부분 재사용을 최적화한다. 개인 메모리의 내용과 식별 정보는 공용 PR 결과·공용 telemetry에 자동 포함하지 않는다.

## 오프라인·권한 철회·사용자 관리

일반 네트워크 장애는 최대 24시간의 서명된 offline 유효 기간 안에서 마지막 정상 snapshot을 사용할 수 있도록 제안한다. 민감한 repo는 기간을 줄이거나 offline 사용을 금지할 수 있다. 오래된 버전·마지막 확인 시각·offline 상태를 화면에 표시한다. 지식 cache가 있다고 모델도 오프라인에서 실행되는 것은 아니다.

401은 인증 갱신을 제한적으로 시도하고, 갱신 실패에는 중앙 context를 사용하는 새 리뷰를 중단해 재로그인을 요청한다. 명시적인 403·권한 철회에는 해당 중앙 범위의 사용을 즉시 중단하고 managed cache·검색 index를 정리한다. 이 상태를 단순 offline으로 처리해 중앙 자료 사용을 이어 가지 않는다. Standalone fallback이 설정돼 있으면 본인의 local 자료만으로 별도 리뷰할 수 있다. 단순 서버 장애를 권한 철회로 오인해 모두 삭제하지 않는다. Logout·계정 전환도 해당 사용자의 중앙 context·cache를 계속 공유하지 않는다.

만료됐거나 sync가 처음부터 성공하지 않은 경우 중앙 기준을 적용했다고 표시하지 않는다. `cache-then-standalone` 등 사용자가 확인한 fallback 설정에 따라 local 자료만으로 독립형 리뷰를 수행할 수 있지만 중앙 기준 충족 결과로 재사용하지 않는다. 이 설정은 독립형 실행에 대한 사전 선택이며 중앙 자료 접근 권한이나 다른 모델 제공자로의 전송 동의를 대신하지 않는다. 이미 offline client가 읽거나 복사한 데이터의 즉시 회수는 보장하지 않는다.

Commit Defender에는 실행 모드·서버 주소 입력, 연결 서버·repository·계정, 각 bundle 버전, 마지막 sync·만료 시각, 집단/개인/local 항목 수, 오류, `연결 테스트`·`지금 동기화`·`사용한 기준 보기`·`연결 해제`를 표시한다. Local Memory·Local Skills 관리 화면은 standalone에서도 사용할 수 있어야 한다. 중앙에서 받은 항목은 출처와 readonly 상태를 표시하고 local 편집 화면과 구분한다. 중앙에는 정책·메모리의 승인·퇴역·예외 처리와 client sync 상태를 제공한다. 사용자는 상세 판단에서 원문과 적용 이유를 확인하고 정정 요청을 보낼 수 있다.

Feedback은 원문 bundle을 직접 수정하는 patch가 아니다. 사용자가 고른 내용에 snapshot·memory/rule 참조와 idempotency key를 붙여 제출한다. 후보에서 개인 메모리 또는 승인된 집단 메모리로 반영된 뒤 다음 sync에서 내려온다. Standalone에서 만든 local 자료는 연결·복구 시 자동 업로드하지 않는다. 사용자가 중앙 제출을 요청한 항목만 대상 서버·계정에 묶어 보관하며, 연결 대상이 바뀌면 전송을 보류해 재확인한다. 로컬 diff·대화 전체의 자동 업로드는 기본 동작으로 넣지 않는다.

## 구현 순서와 검증

중앙 계약 개발에 앞서 독립형 core·설정을 구현한다. Mode resolver, 서버 URL 입력, local memory·Skill 영속 저장, 기존 executor를 연결하고 중앙 미설치·미로그인에서도 실제 리뷰·자료 관리가 되는지 검증한다. 재시작 후 복원과 standalone의 중앙 요청 수 0을 통과 조건으로 둔다.

| 단계              | 작업                                                                     | 통과 조건                                                                                          |
| ----------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 중앙 계약·인가    | 배포용 정책/메모리 schema, client auth, repo resolve, scope별 projection | 다른 tenant·repo·사용자 개인 메모리 접근 거부. 후보·퇴역 항목 제외                                 |
| 발행·sync core    | Outbox, 불변 artifact, 조합 manifest, 서명·lease, cache·lock             | 변경 없는 조건부 요청, 개인 bundle만 갱신, 폐기, rollback, 중간 실패·동시 실행에도 일관된 snapshot |
| CD 수동 리뷰 연결 | Sync 상태 UI, 고정 context, 집단 우선 resolver, local executor adapter   | 실제 source·base와 메모리를 사용한 리뷰. sync 단독 실행의 LLM 호출 수는 0                          |
| 자동 시점·운영    | Save·Stage·Commit·Push, stale·재시도·offline·feedback                    | Toggle off에서 자동 리뷰 미실행, 권한 철회 후 context 사용 중단, 결과에 사용 버전 기록             |

Fallback 검증에는 서버 정상·일반 장애·첫 sync 실패·cache 없음/만료/손상·401/403·모델 executor 부재를 포함한다. 중앙 cache와 local 자료 분리, 서버/계정 전환 시 token 비전송, 복구 후 다음 리뷰의 모드, 중앙 job 응답 유실 시 중복 실행 방지, standalone에서 만든 자료의 미승인 업로드 방지도 확인한다. 두 모드 모두 Save·Stage·Commit·Push의 사용자 선택과 공통 예산을 지킨다.

우선 full bundle·조건부 polling으로 완성한다. SSE 갱신 알림, shard/delta, 고급 검색은 크기·부하를 측정한 뒤 추가한다. Sync를 완성하려고 vector DB나 별도 상시 AI agent를 먼저 도입하지 않는다.

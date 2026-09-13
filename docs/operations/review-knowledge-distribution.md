# 서명된 리뷰 지식 배포

P05-C05/C06의 manifest·다운로드·메모리 배포 승인 API 구현이다. [Bundle 발행](review-knowledge-publication.md)의 migration 0039 다음에 0040을 적용한다. PRISM-DEV에는 [alpha.41·migration 40](review-knowledge-deployment-2026-09-14.md)으로 배포했다. 이전 내용을 높은 sequence로 재발행하는 명시적 rollback, 출처 상세 API와 client 동기화는 후속 범위다. 발행 상태와 메모리 승인 화면의 후속 로컬 구현은 [관리 화면](review-knowledge-management.md)에 기록했다.

## v2 전환 준비

현재 소스의 지식 client contract는 v2다. 운영 alpha.41은 아직 v1이며 위 배포 기록과 구분한다. v2는 메모리에 승인된 `aggregationKey`를 포함해 같은 판단의 집단·개인 메모리를 결정적으로 비교한다. Manifest envelope와 서명 domain은 v1을 유지한다. 서버는 v1/v3 요청에 426을 반환하고 v2 artifact 세 개가 모두 준비된 경우에만 v2 manifest를 발급한다.

추가 migration `0042_knowledge_precedence_contract.sql`은 기존 scope를 재발행 대상으로 등록하고, 구버전 worker가 v1 artifact로 새 요청을 완료 처리하지 못하게 한다. 기존 immutable release·artifact는 삭제하지 않는다. Grouping identity가 approval fingerprint에 추가되므로 기존 승인 projection은 재검토·재승인해야 한다. 원문이나 grouping이 변경된 메모리를 자동 승인하지 않는다. 적용 순서는 새 바이너리·migration·v2 worker의 발행·명시적 projection 승인 확인·client 전환이며, 이번 checkpoint에서는 PRISM-DEV migration이나 릴리스를 변경하지 않았다.

## Manifest와 신뢰

Ed25519 서명 대상은 `git-code-reviewer/knowledge-manifest/v1\n`과 canonical payload JSON을 이어 붙인 UTF-8 bytes다. SHA-256 `manifestHash`는 payload의 canonical bytes를 식별하고 ETag로 사용한다. Payload에는 server·tenant·repository·user ID, 세 component의 bundle ID·sequence·hash·크기, DB 권한 revision, 최소 허용 sequence, client contract 범위, 발급·갱신·offline 만료 시각과 signing key ID를 넣는다. Bundle 자체의 계약과 canonical encoding은 client-contract의 `central-knowledge`를 따른다.

`KnowledgeSigner`는 시작할 때 PKCS8 Ed25519 private key를 읽는다. DB에 server ID와 key ID별 공개키 hash를 고정하므로 기존 server ID를 바꾸거나 같은 key ID에 다른 키를 넣으면 시작하지 않는다. 키 교체는 새 ID와 공개키의 사전 배포가 필요하다. 서버 응답에 들어 있는 공개키를 자동으로 신뢰하는 경로는 제공하지 않는다. 폐기한 공개키 제거와 client 신뢰 저장소 배포는 운영자가 별도로 관리한다.

Client-core의 `verifyKnowledgeManifest`는 호출자가 전달한 신뢰 키와 정확한 audience, 서명, hash, contract, 시각, 권한 revision과 component sequence의 하한을 검사한다. 과거 유효한 manifest 재사용을 막으려면 client가 마지막으로 수락한 권한 revision·component sequence를 해당 audience별로 보관하고 검증기에 전달해야 한다. 이 checkpoint는 검증 함수까지 구현했으며 영구 cache·high-water mark 저장이나 Commit Defender의 중앙 접속을 완료한 것이 아니다.

온라인 갱신 주기는 5분이다. Offline lease는 0–86,400초이며 기본 24시간이다. 0이면 온라인 사용은 가능하고 offline 사용은 즉시 거부한다. Lease를 갱신할 때 새 manifest와 ETag를 발급한다. Offline으로 이미 내려받은 자료의 즉각적인 회수는 보장하지 않으며 만료 시각까지의 사용 경계를 적용한다. 메모리 만료, 기준의 재검토 시각, 예외의 시작·만료 조건은 bundle에 보존되고 소비자가 적용해야 한다.

## API

기본 경로는 `/api/v1/repositories/:repoId/review-knowledge`다. 모든 경로는 기존 로그인 session, 저장소 authorization 서비스와 현재 DB 권한을 사용한다. Cerbos 모드에서는 기존 authorization 판단도 거친다. DB 권한 revision은 DB의 grant·membership·역할·사용자·저장소 상태 변경을 추적하며 외부 Cerbos 정책 revision을 나타내지는 않는다. P04의 client PKCE/device/API key 경계는 이 구현에 포함되지 않는다. 웹 session cookie를 Commit Defender에 복사하는 방식으로 대체하지 않는다.

| 메서드·경로                             | 동작                                                                                                                              |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `GET /manifest?clientContractVersion=2` | 지원 contract와 권한, 세 component의 최신 발행 및 실제 파일 hash·크기를 확인한 뒤 서명된 조합을 반환한다.                         |
| `GET /bundles/:bundleId?snapshotId=:id` | 요청자 소유 snapshot에 들어 있는 bundle만 반환한다. 현재 권한 revision과 세 component의 release ID를 함께 재검증한다.             |
| `GET /status`                           | 공용 두 scope와 본인 personal scope의 발행 revision·bundle·오류 상태를 반환한다. 배포가 꺼져 있어도 인가 후 상태 조회는 가능하다. |
| `GET /memories?cursor=:id`              | 본인이 검토 가능한 활성 메모리를 최대 100개씩 반환한다.                                                                           |
| `GET /memories/:memoryId/projection`    | 현재 원문 fingerprint와 기존 배포 승인 내용을 반환한다. Raw 원문·anchor는 응답에 복사하지 않는다.                                 |
| `POST /memories/:memoryId/projection`   | `expectedFingerprint`와 명시적인 curated `content`를 받아 배포 projection·감사 이력·outbox를 같은 transaction에 저장한다.         |

공용 메모리 승인은 administrator 또는 위임 maintainer, 개인 메모리는 본인만 가능하다. 다른 사용자의 개인 메모리는 administrator도 조회·승인할 수 없다. 실제 원문 hash가 바뀌거나 활성·검토 상태가 달라지면 409로 다시 확인하도록 한다. Content 계약은 `centralMemoryContent`이며 알 수 없는 필드는 거부한다.

미로그인은 401, repository 인가 실패나 다른 사람의 snapshot은 404, DB에서 확인한 접근 권한 회수는 403으로 응답한다. 지원하지 않는 client contract는 426, 발행 대기·파일 누락/변조는 503이다. 권한 revision 또는 배포 조합이 달라지면 409로 manifest를 다시 받도록 한다. 최신 조합을 준비하지 못하면 일부 component만 섞어 반환하지 않는다.

`If-None-Match`도 권한과 준비 상태·파일 무결성 확인을 생략하지 않는다. 응답은 `Cache-Control: private, no-store`, `Vary: Cookie, Authorization`을 사용한다. Fresh한 동일 발행 조합은 저장한 manifest를 재사용해 304가 가능하다. 권한을 회수했다가 다시 부여해도 DB revision이 증가하므로 이전 snapshot을 다시 사용할 수 없다. 내용이 동일한 공용 component의 release는 재사용하고 개인 변경은 본인 component에 반영한다.

권한 revision을 공유 잠금으로 고정한 repeatable-read transaction에서 인가와 release 조합을 읽는다. Scope row 잠금을 추가하지 않아 source trigger의 scope→권한 잠금과 순환 대기하지 않는다. 파일 읽기는 기존 retention advisory lock을 공유한다. 동시 권한 변경에 따른 serialization 충돌은 409로 반환한다.

사용자 상태 갱신의 `INSERT ... ON CONFLICT DO NOTHING`처럼 아무 row도 바꾸지 않은 요청은 권한 revision·outbox를 갱신하지 않는다. Migration 0040은 관련 0039 statement trigger를 실제 변경 row에만 적용하도록 교체한다. 살아 있는 manifest는 불변이고 만료한 cache만 worker가 분당 최대 1,000개씩 정리한다. Repository·사용자 삭제의 FK cascade는 허용한다.

## 실행 설정

Worker에 `KNOWLEDGE_PUBLICATION_ENABLED=true`가 필요하다. 서버는 별도로 다음 값을 받는다.

| 환경 변수                         | 값                                                             |
| --------------------------------- | -------------------------------------------------------------- |
| `KNOWLEDGE_DISTRIBUTION_ENABLED`  | 기본 false. true일 때 publication과 서명 설정이 모두 필요하다. |
| `KNOWLEDGE_SERVER_ID`             | DB와 함께 유지할 UUID                                          |
| `KNOWLEDGE_SIGNING_KEY_ID`        | 키를 식별할 안전한 문자열, 최대 128자                          |
| `KNOWLEDGE_SIGNING_KEY_FILE`      | PKCS8 Ed25519 private key 파일 경로                            |
| `KNOWLEDGE_OFFLINE_LEASE_SECONDS` | 0–86,400, 기본 86,400                                          |

Helm `knowledgeDistribution`의 `enabled`, `serverId`, `signingKeyId`, `existingSecret`, `privateKeyKey`, `offlineLeaseSeconds`를 설정한다. Key Secret은 서버 container에만 read-only로 mount한다. Worker·migration·ChatGPT bootstrap init container는 private key를 받지 않는다. 키 파일은 Git에 저장하지 않는다. Key ID 또는 Secret 참조 변경은 Deployment 설정 변경으로 반영되며 기존 ID의 key 내용을 덮어쓰는 방식은 허용하지 않는다.

격리 PostgreSQL과 실제 filesystem에서 서명된 다운로드·개인 격리·조건부 요청·동시 권한 변경·무결성·만료 cache 삭제를 검증했다. 실제 개발 인증 hook과 local password session도 사용했으며 합성 사용자·메모리만 생성하고 외부 모델은 호출하지 않았다. 구체적인 실행 결과와 한계는 [검증 기록](../../.documents/execution/preventive-review/evidence/P05-knowledge-distribution.json)에 남긴다.

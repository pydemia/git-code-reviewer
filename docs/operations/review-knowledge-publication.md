# 리뷰 지식 bundle 발행

P05-C04의 로컬 구현이다. Migration 0039, 공통 bundle 계약, 메모리 배포 내용 승인, outbox와 worker 발행을 연결했다. 운영 PRISM-DEV에는 [alpha.41·migration 40](review-knowledge-deployment-2026-09-14.md)으로 발행·서명·API·관리 화면을 적용했다. 서명된 manifest·다운로드·메모리 승인 API의 후속 로컬 구현은 [배포 계약](review-knowledge-distribution.md)에 기록했다. 발행 관리 화면은 연결했으며 client 동기화는 남아 있다.

## 배포 자료

Bundle은 repository별 `policy`, `collective`, 사용자별 `personal`로 분리한다. `@gcr/client-contract`의 `centralKnowledgeBundle`이 서버와 client에서 사용할 순수 JSON 계약이다. schemaVersion은 1이고 완전한 bundle의 UTF-8 상한은 2 MiB다. 상한을 초과하면 일부를 잘라 발행하지 않는다. 계약에 없는 필드와 중복 항목 ID를 거부한다.

Policy에는 현재 유효한 Skill의 markdown·instructions 전체와 `active` 기준의 배포용 문서를 넣는다. 기준의 최신 평가, 고위험 기준의 독립된 지정 owner, 출처의 현재 공용 범위와 원문 snapshot을 다시 확인한다. 미승인 후보·미해결 질문·퇴역·출처가 바뀐 기준은 배포 대상이 아니다. 예외는 철회 여부와 현재 owner 권한을 확인하며 기간·범위를 포함한다. Client가 기간을 적용하도록 시작·만료 시각을 보존한다.

메모리 활성화와 배포 승인은 별개다. `approveKnowledgeMemory`는 호출자가 시작한 transaction에서 활성 메모리를 잠그고 명시적으로 검토한 summary·detail·recommendation·반증·적용 조건·만료 시각을 저장한다. 공용 메모리는 관리자·위임 maintainer, 개인 메모리는 접근 권한이 있는 본인만 승인한다. 관리자도 다른 사람의 개인 메모리를 대신 승인할 수 없다. 이 함수의 API 진입점은 [후속 배포 API](review-knowledge-distribution.md)에 연결했으며 [웹 화면](review-knowledge-management.md)도 연결했다.

승인은 메모리 내용과 현재 원문을 함께 hash한 fingerprint에 묶인다. 원문 내용이 바뀌거나 삭제·개인 전환·사용자 제외가 발생하면 기존 승인을 재사용하지 않는다. 집단 bundle에는 raw PR/Chat 본문, source_anchor, 기여자 신원과 다른 사용자의 개인 메모리를 직렬화하지 않는다. 승인된 메모리 ID/hash와 base/head SHA만 출처 참조로 제공하며 상세 원문 조회는 별도 인가 API가 필요하다.

항목의 `sourceContentHash`는 원래 기준/메모리 hash를 보존하고 `contentHash`는 배포 projection의 canonical JSON을 식별한다. 따라서 원문을 제거한 항목도 배포된 내용으로 hash를 다시 계산할 수 있으며 예외 변경도 새 항목 hash에 반영된다. Canonical JSON v1은 UTF-16 key 정렬과 JSON 문자열·숫자 encoding을 사용한다. Bundle ID·발행 시각·sequence는 내용에 넣지 않으므로 동일 내용의 bytes를 재사용할 수 있다.

## Outbox와 저장

기준·평가·승인·예외·메모리·배포 projection·원문·Skill·접근 권한 변경은 PostgreSQL trigger에서 해당 scope의 요청 revision과 outbox를 같은 transaction으로 기록한다. Source transaction이 rollback되면 요청도 남지 않는다. 최초에는 기존 repository의 policy·collective scope를 준비하고 개인 빈 component는 처음 필요해질 때 요청한다. 원문 변경은 재검토가 필요한 항목을 현재 projection에서 제외하고 그 ID와 사유를 기록한다.

Worker는 pending scope를 `SKIP LOCKED`로 하나만 가져가고 2분의 실행권과 임의 claim token을 사용한다. 하나의 repeatable-read snapshot으로 projection을 만든 뒤 현재 requested revision과 token을 다시 비교한다. 더 최신 요청이 있거나 실행권을 잃었다면 그 결과로 현재 pointer를 바꾸지 않는다. Worker가 중단되면 만료 후 다른 worker가 실행권을 얻을 수 있다.

파일은 `review-knowledge/<scope UUID>/<SHA-256>.json`에 불변 저장하고 크기·hash를 읽어 확인한다. 그 뒤 artifact registry, 불변 release, 현재 pointer와 처리한 outbox를 하나의 DB transaction으로 기록한다. 같은 내용이면 기존 artifact와 release를 재사용한다. 새 내용을 발행할 때 sequence가 증가한다. 명시적 rollback을 높은 sequence로 재발행하는 API는 P05-C05의 후속 범위다.

기존 retention의 advisory lock을 공유 모드로 사용해 파일 검증과 DB 등록 사이에 orphan 정리 작업이 파일을 제거하지 못하게 한다. 부분 저장이나 DB rollback으로 남은 파일은 준비된 release가 아니며 재시도에서 같은 hash 파일을 확인해 재사용한다. 저장 실패는 이전 pointer를 유지하고 `last_error`·재시도 시각을 남긴다. Repository/개인 scope 삭제 시 registry 참조를 제거하고 실제 orphan 파일은 기존 정리 유예 정책을 따른다.

## 실행과 검증 범위

Worker 실행 설정은 `KNOWLEDGE_PUBLICATION_ENABLED`, Helm 값은 `knowledgePublication.enabled`다. 기본값은 false다. 서명·다운로드 경계를 준비하기 전에 공개 endpoint를 활성화하지 않는다. 이 checkpoint에는 bundle 다운로드·client cache·서명 key 배포를 완료한 것으로 기록하지 않는다.

격리 PostgreSQL·실제 filesystem을 사용해 outbox rollback, Skill 본문, 미승인 항목 제외, 사용자별 분리, 부분 저장 실패, 동일 내용 재사용, 만료·stale claim, 퇴역·고위험 승인, 원문 변경·개인 전환·사용자 제외, retention과의 경합, repository 삭제, 실제 projection의 UTF-8 크기 초과를 검증했다. 실제 Pod 강제 종료나 서명 검증을 수행한 결과로 확대하지 않는다. [검증 증거](../../.documents/execution/preventive-review/evidence/P05-knowledge-publication.json)를 따른다.

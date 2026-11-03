# SAML DB 상태 저장 기반 배포

2026-09-13 08:28:45 KST에 PRISM-DEV에 application `0.8.0-alpha.34`, chart `0.10.32`, Helm revision **44**를 배포했다. P03-C02 source `b24ebe2`와 release pin `4137629`를 push한 뒤 적용했다.

이 release는 기존 사용자와 persistent SAML 신원의 명시적 연결, 일회성 로그인 transaction·message ID 소비, SessionIndex·security epoch·freshness·관리 operation/outbox를 위한 migration 0032와 DB API를 포함한다. 운영 인증은 기존 `local` mode다. 앱 SAML route·IdP provisioning·freshness 수집·운영 전환은 P03-C03–C08에서 이어서 구현한다.

## 검증한 artifact

- Source: `b24ebe2446ef34c1ea0e853a09d6da90631eec03`의 clean Git archive
- Build Node: `node:22-alpine@sha256:c610fcdfb1d5b4740dd70c284ed3cb16bb857e0f7166196e36a5501df7a3aa32`, Node 22.23.2
- Runtime: alpha.33 base, `/app` 정리 후 현재 output 복사
- Image index: `sha256:b3345ba4e4057ab0311bd0303a6c326c1d56ac4d2b784b578cfd01c48ec1c6a0`
- Linux/amd64 manifest: `sha256:3504b4356a1df5327008f4c9145c9e86d614c071b9489de52718cf4fd8cf068d`
- SBOM·provenance attestation manifest: `sha256:af744b7d3e288f207d0834c80533e12313f969c7f51e90c49d4613b8b8d2919b`
- OCI chart `registry-1.docker.io/pydemia/git-code-reviewer:0.10.32`: `sha256:f1f2f2443cfa23c0f702d7777714d1a38f26f650adfd5e8191254bd616c25546`
- Chart archive SHA-256: `472fe0c78796ebf63e838ba34da0fca17fd614bf8c2893bb481757b8c7dcf6bf`. Registry에서 다시 내려받은 archive와 바이트가 같다.

Node 22.23.2에서 새 SAML DB 테스트 33개를 포함한 전체 767개 테스트가 실패·skip 없이 통과했다. Build·runtime typecheck·새 파일 lint도 통과했다. 두 별도 Node process와 PostgreSQL backend에서 같은 AuthnRequest의 응답을 동시에 소비하거나 서로 다른 요청이 동일한 Response ID를 사용해도 하나만 저장됐다. 연결을 새로 만든 뒤에도 이전 응답은 거부됐다.

실제 image를 UID 1000·read-only·network-none으로 실행했다. Migration 32개와 compiled SAML module의 SHA-256이 테스트한 source/output과 일치한다. 구버전 package·web bundle·build CA secret·`.env` 부재, 실제 정적 파일 응답·hash/cache와 경로 우회 거부도 확인했다. Compiled SAML module hash는 `40accaab9872e616428f50d38c9620dc907c4dc27f39ef77ea2da3c61883095a`다.

## 운영 DB와 설정 보존

Migration 0032 checksum은 `29490f3ab13dadbf4cc4997e8ef04be3136b3b366e5d2614df27b4788573da74`이며 DB 적용 후 확인한 값과 같다. 기존 migration 31개의 checksum은 그대로다.

배포 전후 사용자 7명·account 7개·분석 142건·report 134건의 ID가 같다. 사용자 subject·role·group·상태, repository grant 2개, tenant membership 7개, memory 4개의 ID·owner도 유지했다. 기존 local session 1개의 ID hash·user·생성/만료 시각이 같고 추가한 SAML binding은 모두 null이다. 새 identity·SAML transaction·message ledger·admin operation·outbox 테이블은 모두 0행이며 운영 계정을 자동 연결하지 않았다.

Provider v8 `gpt-5.6-terra`, concurrency 4, timeout 300000과 configuration hash는 그대로다. Image 외 Helm user values hash는 배포 전·dry-run·배포 후 `9abc48b9861c0223aec5693151e5fa8b868ea84ab958909a3f5b127384f1ee14`로 같고 computed values hash도 전후 같다. Secret·corporate CA·HTTPRoute의 UID/resourceVersion과 DB RWO 10Gi·artifacts RWX 10Gi PVC의 UID·PV·capacity도 유지했다. App ConfigMap과 artifacts PVC의 version metadata는 새 release를 따른다.

## 배포 확인

Server `git-code-reviewer-server-6765f97776-6p67l` 1/1, Worker `git-code-reviewer-worker-659bb86f57-rl2zx` 2/2 Ready, restart 0이다. 두 process의 실제 image·version·compiled SAML module hash가 artifact와 일치한다. 확인한 초기 log의 warning/error/fatal은 0건이다.

Startup/live/ready/dependencies health는 모두 ok이고 `/api/v1/system`은 alpha.34·local mode다. 비로그인 `/api/v1/me`는 401이다. Helm 연결 test는 08:30:17 KST에 성공했다. 실제 gateway의 JS·CSS SHA-256도 image와 같다.

- `index-DrHUqW4X.js`: `d7b05ac7591912fa18d1819a393b7c3e2e815b92a3977e6c5ff3b600efd91cd8`
- `index-T_jmTDvd.css`: `e3dfa4e3389c0f71155cf8ba8cdf23de78c65ae0cc63f6c3006119a04d18e44e`

이전 alpha.33 Worker는 source-sandbox 종료 유예를 존중하며 강제 삭제하지 않았다. 임시 build context와 registry credential 파일, 테스트 전용 DB container는 제거했다. 원래 Docker/Helm 설정과 운영 credential은 바꾸지 않았다.

이번 검증을 위해 실제 사용자 신원 연결·계정 수정·모델 요청·재분석·PR 게시를 실행하지 않았다. 기존 session 보존은 DB 상태와 local auth 회귀로 검증했으며 실제 사용자 계정으로 다시 로그인한 결과를 의미하지 않는다. 테스트의 이미 검증된 SAML 신원 fixture는 C01의 실제 IdP/서명 검증과 구분한다. 앱의 통합 SAML callback·Safari/Chrome 검증과 운영 인증 전환은 아직 남아 있다. [배포 증거](../../.documents/execution/preventive-review/evidence/P03-C02-deployment.json)에 검사 결과를 기록했다.

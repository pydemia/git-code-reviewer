# Registry 삭제와 Review Chat 수정

## 삭제 정책

- 관리자만 비활성 ChatGPT account·Provider 버전을 삭제할 수 있다. 서버에서도 상태와 확인 이름을 검사하고 audit 기록과 같은 transaction에서 처리한다.
- Account: 목록에서 숨기는 `deleted_at` tombstone을 남긴다. FK와 표시 이름은 과거 분석·대화 참조를 위해 보존하되 credential ciphertext/IV/auth tag는 제거한다. Assignment와 model은 비활성화한다. 같은 이름을 다시 등록하면 새 ID를 사용한다.
- 활성 Provider, 대기·진행 중인 분석 또는 대화가 참조하는 account는 삭제할 수 없다. Credential 교체, 자동 refresh, 활성화 API로 삭제된 account를 되살릴 수 없다.
- Provider: 비활성 version을 목록에서 제거하고 재활성화를 차단한다. 이미 enqueue된 작업과 report가 참조하는 immutable 설정 및 암호화된 credential은 보존한다. 같은 설정을 다시 저장하면 별도 version을 생성한다. 원격 서비스의 token revoke는 이 기능의 범위가 아니다.
- 새 migration `0031_registry_deletion.sql`을 먼저 적용한다. 기존 계정·Provider·report를 일괄 삭제하거나 현재 활성 Provider를 변경하지 않는다.

## 질문별 모델 선택

`POST /api/v1/chat-sessions/:sessionId/runs`의 선택적 `selection`에는 `accountId`, `modelName`, `reasoningEffort`를 함께 전달한다. 생략한 구형 client는 session 설정을 사용한다. 서버와 Worker가 사용자 assignment 및 허용 model·effort를 검증하며 각 실행의 configuration에 값을 고정한다. 기존 실행 설정과 batch Provider 활성 상태는 바뀌지 않는다.

Interactive Chat은 같은 사용자·analysis revision의 최신 session을 모델과 무관하게 재사용한다. 모델 변경과 창 focus 복귀로 빈 session을 만들지 않는다. 생성 중에는 선택을 잠그며 각 답변에 실제 model·effort를 표시한다. 구형 비대화형 Chat은 기존 model별 session을 재사용한다.

Account catalog의 `analysisPresets`는 삭제되지 않은 ChatGPT Provider version 중 사용자가 접근 가능한 account/model/effort만 제공한다. Provider 등록 자체로 권한을 부여하지 않으며 credential·endpoint는 반환하지 않는다. OpenAI-compatible batch Provider는 tool-calling adapter와 별도 사용자 권한 정책이 없어 이번 선택 목록에서 제외한다.

## HTTP와 이력 메뉴

HTTP에서는 `crypto.randomUUID`가 없을 수 있으므로 `getRandomValues`로 RFC 4122 v4 UUID를 생성한다. 암호학적 난수 API가 없으면 명시적으로 실패하며 `Math.random`으로 대체하지 않는다. 같은 요청 재시도에는 같은 idempotency key를 사용하고 model·scope가 바뀐 질문에는 새 key를 만든다. 서버 접수 후 메시지 목록 갱신 실패를 질문 실패로 오인해 재전송하지 않는다. HTTPS 전환 권고는 그대로 유지한다. [MDN Crypto.randomUUID](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)

이력 메뉴는 ‘이전 대화와 코드 근거’로 명칭을 바꾸고 light theme, 빈 목록·loading·오류·재시도 상태를 제공한다. 이전 페이지를 읽다가 새 질문을 생성하면 최신 목록부터 다시 조회한다. 답변과 근거는 소유 사용자·repository 권한을 검사한 기존 API로만 조회한다.

## 검증

- 격리된 PostgreSQL 17: 75개 파일·460개 테스트 통과. 활성 항목 삭제 차단, 관리자 권한, 삭제와 audit rollback, 동시 삭제, 삭제 후 credential rotation·재활성화 차단, 동일 이름·설정 재등록, 사용자 권한별 preset 필터를 포함한다.
- 같은 session에서 model·effort를 바꿔 두 질문을 실행하고 과거 configuration과 대화가 유지되는 API 통합 테스트를 통과했다. 사용자가 다른 session의 실행에 접근하면 404다.
- lint·typecheck·production build·format·diff check 통과. Vite의 기존 Zod pure annotation 경고는 유지되며 build는 성공했다.
- Browser 합성 fixture 1440×1000, 390×844: `randomUUID` 부재 조건에서 UUID 생성, 두 질문 전송, Sol/medium → Luna/low 전달, Markdown, 이전 질문 선택·source L12–14 이동, alert/console 오류 0, 가로 overflow 없음, 입력창 아래 selector 접근을 확인했다. 외부 모델을 호출한 검증은 아니다.
- Impeccable 점검은 기존 light theme·typography를 유지하며 불필요한 question 강조 border와 dark select를 정리했다. 실제 운영 account·Provider 삭제, 재분석, PR 댓글 게시는 수행하지 않았다.

Browser 재현: `pnpm --filter @gcr/web exec vite --host 127.0.0.1 --port 4018` 후 `/tests/registry-chat.html`을 연다. 이 페이지는 외부 API를 호출하지 않는 합성 test harness다.

## PRISM-DEV 배포

2026-09-09 11:54:49 KST에 application `0.8.0-alpha.28`, chart `0.10.27`을 Helm revision **39**로 배포했다. Source `5d9a9204218583ecdaea16827f68eff97f673b99`, Backend `5039fbf`, release pin `56268be`는 모두 push했다. 배포 기록만 바꾸는 후속 commit은 image를 다시 만들지 않는다.

- Image: `docker.io/pydemia/git-code-reviewer:0.8.0-alpha.28`
- Image index: `sha256:9b01ad32833b727af4b4aa3c3110823ef55b9e00bab41bfc11bebc56f6a98db0`
- Linux/amd64 manifest: `sha256:700b389759f1c3fd09411621c07ee5689044ea87e74cebeddf84f47af95f26ef`
- SPDX SBOM·SLSA provenance attestation: `sha256:bf10feb4ffffa0de896dd1f76718b5b91c7dcb47cc740c76584566e3fff1587e`
- OCI chart: `oci://registry-1.docker.io/pydemia/git-code-reviewer:0.10.27`, digest `sha256:ec23059d14c068d4066c0edeb49b060eabd0792673e907a19f11e62e0a47beda`

Clean `git archive`를 build context로 사용했다. Runtime base는 alpha.27의 검증된 base를 재사용했다. Container를 UID 1000·read-only·network-none으로 검사했으며 migration 31개, build CA secret과 Browser 합성 harness의 실행 image 미포함을 확인했다.

`PRISM-DEV` context의 API `https://10.250.107.193:6443`, namespace/release `git-code-reviewer`에 `--reuse-values`와 image tag/digest override만 적용했다. Image 외 Helm values의 배포 전·dry-run·배포 후 SHA-256은 모두 `5f3eb1ed55f94d7ce9048eb9ef17e4b92400f3533ed9c8a5da1823ef66bb05c9`다.

### 배포 검증

- 새 Server `git-code-reviewer-server-5c48598f9-l4b9p` 1/1, Worker `git-code-reviewer-worker-59d6c59f9-q4hd5` 2/2 Ready이며 restart 0회다. 두 Deployment rollout을 확인했다.
- Helm 연결 test는 11:55:50 KST에 Succeeded로 끝났다. Health startup/live/ready/dependencies 모두 ok이며 system API는 alpha.28이다.
- `http://pr-review.prism.ai`의 gateway 경로로 받은 `/assets/index-BP5RTXd6.js` SHA-256 `56be5afe7fcd06cd1c5eeb9949d53c0239da2c1af98318b59dd65210288d5240`이 image와 일치한다. 새 Provider 선택·이력 UI 문구와 HTTP UUID fallback도 bundle에 포함됐다.
- Migration 31개가 적용됐으며 checksum 불일치는 없다. 실제 account·Provider tombstone은 0개다. 사용자 7명·ChatGPT account 7개·분석 70건·report 62건의 ID 집합 hash가 배포 전후 동일하다.
- 활성 Provider는 v8 `gpt-5.6-terra:medium`, concurrency 4, timeout 300000ms이며 configuration hash `2fdc6d40a3871aaeb3be7174891afee59582c1db4fea7428dddcdd4f064f0041`을 보존했다.
- Auth·credential registry·PostgreSQL Secret과 CA ConfigMap의 UID/resourceVersion은 그대로다. HTTPRoute UID와 hostname을 보존했고 Accepted/ResolvedRefs 모두 True다.
- `nfs-csi`의 PostgreSQL RWO 10Gi와 artifact RWX 10Gi PVC는 기존 UID·PV·용량·access mode를 유지한다. Artifact PVC의 release label에 따른 resourceVersion만 변경됐다.

Alpha.27 Worker `git-code-reviewer-worker-85b55879bd-54bcj`는 기존 source-sandbox의 3600초 종료 유예로 Terminating 상태다. 강제 삭제하지 않았다. 실제 로그인 Browser에서 운영 모델에 질문하는 검증, 운영 account·Provider 삭제, 추가 PR 재분석·댓글 게시는 수행하지 않았다. 모델 변경과 HTTP 오류는 합성 Browser 및 API 통합 테스트로 검증했고 배포 후에는 실행 version·정적 bundle·health·migration·운영 데이터 보존을 확인했다.

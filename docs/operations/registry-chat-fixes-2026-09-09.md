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

# GCR CLI

Node.js 22 이상의 headless client다. 설치본은 `@gcr/client-contract`, `@gcr/client-core`, `@gcr/client-executors`의 정확한 버전을 실행 파일 하나에 bundle한다. Runtime npm dependency가 없으며 서버·VS Code·sibling source checkout이 필요하지 않다.

```sh
pnpm pack:cli --verify
# manifest의 hash를 확인한 CLI tarball 하나를 설치한다.
npm install --offline --ignore-scripts --no-audit --no-fund /absolute/bundle/gcr-cli-<version>.tgz
./node_modules/.bin/gcr --help
```

모든 명령은 JSON을 stdout에 출력한다. 도움말만 일반 텍스트다. 진단 메시지는 stderr로 보낸다. `--json`은 JSON 출력을 명시하는 호환 옵션이다.

```sh
gcr status --cwd /path/to/repo
gcr context --cwd /path/to/repo --source index
gcr review --cwd /path/to/repo --source index --executor-path /path/to/codex
gcr result RUN_ID --cwd /path/to/repo
gcr history --cwd /path/to/repo
```

기본 source는 실제 Git index다. 저장된 working tree는 `--source working-tree`로 선택한다. `--base main`은 capture 시점 HEAD와 지정 ref의 merge-base를 고정한다. `--path`는 exact path이며 반복할 수 있다. Untracked 파일은 working-tree mode에서 `--include-untracked`로 명시해야 한다. `context`는 모델 호출 없이 snapshot·선택 지식의 hash와 제외 사유를 확인한다. 지식 본문은 `memory show` 또는 `skill show`로 조회한다.

`review` 호출은 지정한 계정 executor에 해당 profile의 활성 지식과 고정 source/base/관련 파일을 전달하도록 명시적으로 요청하는 동작이다. 전송 경로는 `--allow-path` glob으로 좁힐 수 있다. `--exclude`는 capture에서 제외하며 `--require-source source:caller.py`, `--require-source base:cache.py`, `--require-knowledge ID`로 필수 근거를 지정한다. Repository 파일과 Skill은 tool 권한을 바꾸거나 명령을 실행할 수 없다. 중앙 URL·token·cache를 읽지 않으며 standalone에서 GCR 중앙 요청을 만들지 않는다. 중앙 연결은 아래의 명시적 설정을 사용한다.

현재 실제 모델 adapter는 macOS의 지원 Codex CLI `0.153.4` 또는 `0.154.0`, `gpt-6-astra`, `xhigh` 조합이다. CLI 경로를 명시하거나 PATH의 `codex`를 사용한다. 특정 앱의 설치 경로를 추정하지 않는다. `status --check-executor --executor-path ...`는 구성과 tool 격리만 검사하며 로그인·quota를 확인하거나 계정 모델을 호출하지 않는다. Linux에서 로컬 저장소와 조회 명령은 사용할 수 있지만 현재 모델 adapter는 unavailable이다. 지원하지 않는 실행 환경에서 다른 모델/provider로 전환하지 않는다.

리뷰는 최대 200개의 선택 파일을 한 invocation으로 처리한다. 기본 제한은 120초, source/prompt 전송 1 MiB, tool call 100회다. `--timeout-ms`, `--source-bytes`, `--tool-calls`로 한도를 지정한다. 개별 read는 최대 200줄/24,000자다. 모델이 선택 파일과 base의 전체 범위를 읽고 실제 조회 ID를 응답에 포함해야 파일을 완료로 처리한다. 읽기 누락·필수 질문·반증 충돌·예산 초과는 incomplete다. 생성물·비공개 파일 등 정책상 제외는 보고서에 표시하며 검토한 것으로 세지 않는다. `source-confirmed`는 실제 읽은 source에 대한 모델의 조건·반증 검토이며 실행 재현을 뜻하지 않는다. 이 adapter는 테스트를 실행하지 않는다.

종료 코드는 다음과 같다.

| 코드 | 의미                                        |
| ---- | ------------------------------------------- |
| 0    | 명령 성공 또는 완료된 리뷰에 후속 조치 없음 |
| 1    | 완료된 리뷰에 finding 또는 선택 질문 있음   |
| 2    | 미완료·취소·모델 없음·잘못된 명령·저장 실패 |

`result`는 저장된 리뷰의 종료 코드를 그대로 반환하고 `history`는 각 항목에 종료 코드를 포함한다. 실행 정책에 입장한 리뷰는 failed/cancelled도 terminal report로 저장한다. Capture·context·executor 준비 실패는 아직 실행 identity가 없으므로 명령 오류로 반환하며 가짜 report를 만들지 않는다. 이력 저장을 확인할 수 없으면 stdout의 보고서를 유지하고 stderr에 `history-save-failed`, 종료 코드 2를 출력한다.

## Local Memory와 Skill

기본 scope는 현재 repository/worktree이고 `--scope profile`은 Git 밖에서도 사용한다. `--profile` 기본값은 `default`다. Extension과 동일한 profile·worktree·data directory를 사용하면 같은 암호화 자료를 읽는다. OS Keychain/Secret Service가 없거나 잠겨 있으면 실패하며 평문으로 저장하지 않는다. 기본 data directory는 core의 CommitDefender 경로이고 `--data-dir`로 명시할 수 있다.

`note.json`은 다음과 같이 작성한다. Skill도 같은 형식이며 `rationale`, `counterEvidence`는 Memory 전용이다.

```json
{
  "title": "부분 cache의 반환 계약",
  "body": "요청한 key를 모두 반환하는지 source와 caller를 함께 검토한다.",
  "rationale": "호출자가 반환 사전을 직접 indexing한다.",
  "appliesTo": { "paths": ["src/**"], "languages": ["python"], "symbols": [], "branches": [] }
}
```

```sh
gcr memory create --input note.json
gcr memory activate ID --revision 1
gcr memory list
gcr memory show ID
gcr memory edit ID --revision 2 --input changes.json
gcr memory deactivate ID --revision 3
gcr memory archive ID --revision 4
gcr memory export ID --output new-export.json
gcr memory import --input new-export.json
gcr memory delete ID --revision 5
```

`changes.json`에는 바꿀 필드만 넣는다. `expiresAt`은 UTC ISO timestamp이며 edit의 `null`은 기존 만료일을 제거한다. Create/import는 항상 candidate다. 활성화는 별도 명령이고 revision이 바뀌면 stale 편집·활성화·삭제를 거부한다. 모든 명령의 `memory`를 `skill`로 바꾸면 review-only Skill을 관리한다. 본문으로 실행 가능한 Skill을 등록할 수 없다.

`--input -`은 최대 2 MB의 UTF-8 JSON stdin을 받는다. 본문을 명령 인수나 repository 설정에 저장할 필요가 없다. Export는 사용자가 지정한 새 파일에만 평문 JSON을 0600으로 만들고 기존 파일을 덮어쓰지 않는다. Import는 원본 hash를 검증하고 새 ID·현재 scope·candidate 상태를 부여한다. 기본 리뷰 이력은 90일/1,000개이며 개인 지식의 활성화·삭제와 독립적이다.

## 중앙 연결과 리뷰

중앙 서버의 v2 지식 API와 `gcr-cli`용 `knowledge:read` API key가 필요하다. 현재 운영 alpha.41의 v1 API에는 연결할 수 없다. 서버 v2 배포·API key 기능 활성화는 별도 배포 단계다. SAML 웹 로그인 cookie나 모델 제공자의 credential을 API key로 사용하지 않는다.

서버 관리자에게 확인한 URL·server ID·tenant/repository ID와 별도로 받은 Ed25519 공개키로 JSON 설정 파일을 작성한다. 사용자 ID는 key의 `/client-auth/me` 응답으로 확인하며 응답의 repository scope·client ID·만료일과 서명된 manifest audience를 검증한다. 저장소 자동 검색이나 remote 이름 추정은 하지 않는다. 아래는 필드 형식이며 PEM에는 실제 공개키가 필요하다.

```json
{
  "serverUrl": "https://gcr.example.com/",
  "serverId": "server-id",
  "tenantId": "tenant-id",
  "repositoryId": "repository-id",
  "trustedKeys": [{ "id": "signing-key-id", "pem": "PUBLIC_KEY_PEM" }],
  "ca": null
}
```

`ca: null`은 시스템 TLS 신뢰 저장소를 사용한다. 사설 CA 환경은 CA PEM을 넣는다. HTTPS 인증서·hostname 검증과 서명 key pin 검증을 모두 수행하며 redirect·HTTP·인증서 검증 생략은 지원하지 않는다. 설정에는 token이나 private key를 넣지 않는다.

```sh
# key를 보안 입력 도구에서 stdin으로 전달한다. 아래 명령의 인수에는 key가 없다.
gcr central connect --mode centralized --input /private/config/connection.json --api-key-stdin --cwd /path/to/repo
# 반환된 연결 ID를 명시적으로 선택한다.
gcr central list --mode centralized --cwd /path/to/repo
gcr central status --mode centralized --connection CONNECTION_ID --cwd /path/to/repo
gcr central sync --mode centralized --connection CONNECTION_ID --cwd /path/to/repo
gcr context --mode centralized --connection CONNECTION_ID --cwd /path/to/repo
gcr review --mode centralized --connection CONNECTION_ID --cwd /path/to/repo --executor-path /path/to/supported/codex
gcr history --mode centralized --connection CONNECTION_ID --cwd /path/to/repo
gcr result RUN_ID --mode centralized --connection CONNECTION_ID --cwd /path/to/repo
gcr central disconnect --mode centralized --connection CONNECTION_ID --cwd /path/to/repo
```

Key 입력은 piped stdin만 받으며 terminal의 평문 입력이나 `--api-key` 인수, key 파일 옵션은 제공하지 않는다. macOS Keychain 또는 Linux Secret Service의 `com.commitdefender.central-auth.v1` namespace에 저장한다. 연결 설정에는 credential reference와 만료일만 넣고 별도 OS key로 암호화한다. 등록·조회·동기화는 모델을 호출하지 않는다. 같은 profile/worktree/audience의 key를 교체하려면 먼저 disconnect한 뒤 connect한다. 이전 연결 revision으로 실행하던 리뷰는 재연결 후에도 계속 사용할 수 없다.

신규 저장소의 초기 지식 발행이 진행 중이면 connect가 HTTP 503 응답에 한해 간격을 늘려 재시도한다. 최초 지식 동기화는 최대 60초이며 Ctrl+C로 취소할 수 있다. 서명된 세 component의 검증이 끝나야 연결이 활성화된다. 인증 거부, TLS 오류, 리다이렉트, 잘못된 응답은 재시도하지 않는다. 실패·취소·시간 초과 시 등록 중인 key를 정리하고 연결을 비활성화한다. 이후 수동 sync나 리뷰의 동기화에 이 초기 대기를 적용하지 않는다.

연결 ID만 알고 있어도 중앙 모드로 전환되지는 않는다. `--mode centralized`와 ID를 함께 지정해야 한다. 온라인 context/review는 현재 signed cache의 refresh 시각이 지났거나 cache가 없으면 동기화를 요청한다. `--offline`은 네트워크를 사용하지 않고 유효한 signed lease와 아직 만료되지 않은 key, 연결 상태를 검사한다. 정상 서버 장애 후에는 명시적으로 `--offline`을 선택할 수 있다. 401/403을 확인한 연결은 offline에서도 사용할 수 없다. 자동 fallback·주기 동기화·재접속 backoff는 아직 제공하지 않는다.

중앙 리뷰도 선택한 executor·source 전송 범위·예산을 적용한다. 결과는 `central-review-history/<binding ID>` 아래에 암호화하고 정확한 audience를 검증한다. Standalone 이력 조회에 중앙 결과를 섞지 않는다. 연결 해제는 local memory/Skill과 기존 리뷰 이력을 삭제하지 않으며, 중앙 이력 조회에는 해당 연결의 유효한 인증 상태가 필요하다. Key의 서버 측 폐기는 GCR 관리 화면/API에서 별도로 수행한다. 정리 실패는 반환한 `cacheCleanupPending`·`credentialCleanupPending`으로 확인한다.

CLI 연결과 macOS Keychain은 별도 프로세스로 검증했다. Linux Secret Service adapter의 명령 계약은 테스트했으나 실제 Linux 보안 저장소·중앙 모델 리뷰 검증을 완료한 것은 아니다. 기본 PATH의 Codex가 지원 버전과 다르면 executor를 unavailable로 처리한다. 특정 버전을 이유 없이 허용하거나 다른 계정/provider로 바꾸지 않는다.

## Foreground commit and push reviews

Use `gcr review --trigger commit` from an explicitly configured foreground adapter to review the actual hook index. `GIT_INDEX_FILE` is inherited; `--index-file /absolute/path` selects an explicit alternate index. The snapshot is captured before model execution, so a later working-tree edit does not change the review. The base is the pre-commit HEAD, including for an amend; this reports the amend's new changes rather than inferring a rewritten parent.

`gcr push-review` reads the complete pre-push stream from stdin and processes each ref. It preserves unsupported refs in the result and returns exit 2 if any review is incomplete or an input is unsupported. A deleted ref has no new source to review; it is reported as `ref-deleted`, not as all repository files being deleted. A new ref compares against an explicit empty tree, subject to the existing source limits. At most 64 refs / 256 KiB of input are accepted. Review timeout and source budgets apply separately to each ref.

For an explicit immutable comparison, use:

```sh
gcr review --source commit-tree --source-commit <full-new-oid> --base-commit <full-old-oid> --trigger push
```

Use `--base-commit empty` for a declared empty base and `--target-branch <branch>` to select branch-scoped knowledge. `--base <ref>` retains its existing merge-base semantics for index/working-tree reviews and cannot be combined with commit-tree capture.

These commands wait for the review and retain normal review exit codes (0 complete/no follow-up, 1 findings/questions, 2 incomplete/error). Do not install them directly as a pre-commit/pre-push hook unless you intend their waiting and exit behavior. The service commands below provide asynchronous enqueue; managed hook installation remains separate integration work.

The input format follows [Git's pre-push contract](https://git-scm.com/docs/githooks#_pre_push). `scripts/verify-hook-reviews.mjs` verifies a packaged CLI using temporary foreground advisory adapters, a partial commit and a local bare remote, with an explicitly supplied Codex executable. It does not install hooks into the user's repository.

## 독립 백그라운드 리뷰 서비스

```sh
gcr service start --profile default
gcr service allow --cwd /path/to/repo --trigger commit --trigger push \
  --executor-path /absolute/path/to/codex --model gpt-6-astra --reasoning-effort xhigh
gcr enqueue --cwd /path/to/repo --trigger commit
# 실제 pre-push hook의 stdin을 그대로 전달한다.
gcr enqueue-push --cwd /path/to/repo
gcr service status
gcr service job --id RECEIPT_ID
gcr result RUN_ID --cwd /path/to/repo
gcr service cancel --id RECEIPT_ID
gcr service revoke --cwd /path/to/repo
gcr service stop
```

`start`는 현재 Node와 설치된 CLI 진입점으로 별도 프로세스를 시작한다. 같은 profile·data directory의 서비스가 살아 있으면 기존 PID를 반환한다. `run`은 foreground 실행이며 Ctrl+C/SIGTERM으로 종료한다. 시작한 서비스는 CLI나 hook 종료 후에도 동작하지만 OS 로그인 자동 시작이나 종료 후 자동 재기동은 아직 제공하지 않는다. 시작 관측 시간이 초과되면 `status`로 기존 프로세스 상태를 확인한다.

신규 서비스는 어떤 저장소의 자동 리뷰도 허용하지 않는다. `allow`가 지정한 worktree의 trigger 목록과 실행 설정을 암호화해 저장한다. 다시 `allow`하면 목록 전체를 교체하며 실행 중인 이전 등록은 취소하고 대기 요청은 폐기한다. `revoke`는 허용 목록을 비운다. 저장소 설정 파일이나 enqueue 호출자는 모델·계정·전송 범위를 변경할 수 없다. 중앙 모드는 `allow --mode centralized --connection ID`로 명시하며 실행 시 현재 연결과 지식을 확인한다.

`enqueue`는 호출 시점 source/base와 관련 파일을 고정하고 암호화한 payload의 저장을 확인한 뒤 receipt를 반환한다. Commit의 임시 index가 이후 삭제돼도 고정 바이트로 실행한다. `enqueue-push`는 stdin의 모든 ref를 먼저 해석하고 ref별 receipt 또는 unsupported/삭제/변경 없음 상태를 남긴다. 접수의 `exit 0`과 `reviewCompletion: not-awaited`는 리뷰 완료를 뜻하지 않는다. 완료 상태와 `runId`는 `service job`에서 확인한다. 서비스 없음·등록되지 않은 trigger·저장 실패는 exit 2다. Git 진행을 보장하는 advisory hook은 이 종료 코드와 Git 정책을 별도로 처리해야 한다.

`--request-id UUID`는 응답 유실 시 같은 입력의 접수를 식별한다. 같은 UUID에 다른 입력을 보내면 거부한다. 서로 다른 receipt의 모델 실행은 기존 공통 요청 기록이 전체 source/context/executor identity로 중복을 판단한다. 프로세스 재시작 시 queued 요청은 복원하지만 이미 running이던 요청은 interrupted로 남기고 자동 재호출하지 않는다. `cancel`로 queued/interrupted payload를 정리할 수 있다. 실행 중 취소는 terminal 보고서를 만든 뒤 결과 상태를 기록한다.

IPC는 macOS/Linux의 사용자 전용 Unix socket(0600, 상위 디렉터리 0700)을 사용하며 TCP port를 열지 않는다. Windows는 지원하지 않는다. Payload는 최대 8 MiB이며 queued/running/interrupted 합계 64개까지 받는다. 모델 시간·source·tool 제한은 등록한 리뷰별 설정이다. 사용자 전체 호출/token 예산, headless 파일 감시, 중단 요청의 결과 대조 UI, receipt 보존 기간과 managed hook 설치는 남아 있다. Linux IPC 지원이 Linux 모델 executor 검증을 뜻하지는 않는다.

`scripts/verify-service-reviews.mjs`는 명시한 설치 artifact·현재 Codex 실행 파일로 임시 저장소의 commit/push를 검증한다. `GCR_SERVICE_CONSUMER`, `GCR_SERVICE_CODEX`, `GCR_SERVICE_EVIDENCE`에 절대 경로를 지정해야 하며 실제 모델을 호출한다. 사용자 저장소의 hook이나 전역 CLI는 변경하지 않는다.

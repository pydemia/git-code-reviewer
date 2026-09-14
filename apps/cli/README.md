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

## 중앙 모델 실행

개발 소스의 `remote-review`는 지식 모드와 별도로 중앙 모델 실행을 명시한다. `--mode standalone`은 로컬 지식을, `--mode centralized`는 선택한 중앙 기준을 사용한다. 두 경우 모두 명시한 `--connection`의 서버로 승인된 자료를 전송한다. 일반 `review`의 기존 executor 선택은 바꾸지 않는다. 현재 PRISM 배포본과 설치된 CLI에는 아직 이 경로를 전달하지 않았다.

먼저 서버에 할당된 계정 ID와 `knowledge:read`·`ai:invoke` 권한이 있는 연결을 준비한다. `remote-review models --connection CONNECTION_ID`로 현재 할당된 계정·모델·effort와 서버의 실행 활성화 여부를 조회한다. 목록 조회는 credential이나 모델 quota를 검사하지 않으며 실제 전송 시 인가를 다시 확인한다. 캐시 동기화 성공만으로 중앙 모델의 실행 가능 여부를 판단하지 않는다.

```sh
umask 077
gcr remote-review preview --cwd /path/to/repo --connection CONNECTION_ID \
  --mode standalone --account-id ACCOUNT_ID --model gpt-6-astra \
  --reasoning-effort xhigh --source index > /path/to/private/remote-preview.json
gcr remote-review submit --cwd /path/to/repo --connection CONNECTION_ID \
  --input /path/to/private/remote-preview.json --confirm-hash PAYLOAD_HASH
gcr remote-review status REQUEST_ID --cwd /path/to/repo --connection CONNECTION_ID
gcr remote-review result REQUEST_ID --cwd /path/to/repo --connection CONNECTION_ID
gcr remote-review cancel REQUEST_ID --cwd /path/to/repo --connection CONNECTION_ID
```

미리보기 JSON에는 실제 source/base/관련 파일과 선택한 지식 본문이 들어 있다. 저장 위치는 repository 밖의 개인 디렉터리를 사용한다. `payloadHash`를 확인해 제출하며 `REQUEST_ID`는 `payload.requestId`다. 이 파일은 사용자가 저장한 평문이므로 명령의 암호화된 복구 기록과 별개다. 신규 제출에서 승인 시각을 기록한다. 중앙 지식 미리보기와 제출에는 모두 `--mode centralized`를 사용한다.

기본 예산은 모델 호출 4회, 전체 120초, source tool 1 MiB·100회이며 각각 `--model-calls`, `--timeout-ms`, `--source-bytes`, `--tool-calls`로 미리보기에서 지정한다. 서버의 소스 보존은 3,600초, 결과 보존은 86,400초이며 `--source-retention-seconds`, `--result-retention-seconds`로 지정한다. 현재 모델 전송은 출력 token 상한을 지원하지 않는다. 미리보기에 한도 미지원 상태를 표시하고 임의의 token 제한을 약속하지 않는다.

제출 전에 요청 ID·승인 hash·결과 검증 메타데이터를 OS 키로 암호화해 기록한다. 같은 ID를 다시 `submit`하면 상태만 조회한다. 404·통신 오류·Ctrl-C는 서버에서 실행하지 않았다는 뜻이 아니다. 자동 새 요청이나 로컬 executor 전환은 없다. 상태가 확인되지 않은 요청을 재전송하려면 같은 파일·hash로 `retry`를 명시한다. 최초 승인 시각을 유지하며 이미 알려진 작업은 조회만 한다. 취소를 요청한 뒤에는 재전송하지 않는다. 취소 응답이 유실되면 `cancel`로 다시 확인한다.

`wait REQUEST_ID`는 최대 10분 동안 같은 요청의 상태를 조회한다. `--wait-timeout-ms`로 대기 한도를 줄일 수 있다. 일시적인 409·429·5xx 및 통신 오류는 재조회하지만 인가 오류·응답 불일치는 즉시 중단한다. 대기 종료는 서버 작업 취소를 뜻하지 않는다. 완료되면 결과를 받아 기존 report 종료 코드를 적용한다.

`list`는 복구 기록을 보여 준다. 복구 기록에는 소스·지식 본문과 report 본문을 저장하지 않으며 요청 ID 재사용을 막기 위한 메타데이터는 유지한다. `result`는 현재 서버 권한과 보존 기간 안에서 결과를 조회하고 승인한 source/context/model/account 설정 및 report hash를 대조한다. 서버의 read receipt를 로컬 읽기 근거로 변환하지 않는다. 현재는 로컬 `history`·`chat`에 중앙 report를 가져오는 기능을 제공하지 않는다.

제출·상태·취소 명령은 리뷰 결과를 확인하지 않았으므로 종료 코드 2를 반환한다. 결과 명령은 report의 완료·finding·미완료에 따라 기존 0/1/2 규칙을 적용한다. 미리보기와 목록 조회는 명령 성공 시 0이다.

## Host용 예방 리뷰 Skill

CLI tarball은 host용 `dist/skills/gcr-prevention/SKILL.md`와 명령 안내를 포함한다. Skill 설치가 필요하면 해당 `gcr-prevention` 디렉터리를 선택한 host의 Skill 경로로 복사한다. 패키지 설치는 host 설정·hook·watcher를 변경하거나 모델을 실행하지 않는다. 이 host Skill은 아래의 암호화된 로컬 리뷰 지식 `gcr skill`과 용도가 다르다.

## 저장된 리뷰 대화

`gcr chat read RUN_ID`는 원래 리뷰와 저장된 대화를 읽는다. `send`, `answer`, `resume`, `cancel`, `source`는 `--input JSON_FILE` 또는 `--input -`로 정확한 action JSON을 받는다.

| Action          | JSON                                                                            |
| --------------- | ------------------------------------------------------------------------------- |
| send            | `{"turnId":"turn-1","content":"이 finding의 발생 조건을 설명해 줘."}`           |
| answer          | `{"turnId":"turn-1","questionId":"반환된-question-id","content":"사용자 답변"}` |
| resume / cancel | `{"turnId":"turn-1"}`                                                           |
| source          | `{"turnId":"turn-1","citation":0}`                                              |

같은 `--cwd`, `--profile`, `--data-dir`와 원래 mode·connection을 지정한다. 모델을 실행하는 action에는 원래 executor/model 설정을 사용하며 경로를 제한한 리뷰는 같은 `--allow-path`를 전달한다. 저장된 context·executor·전송 범위·예산과 현재 설정이 다르면 새 대화를 시작하지 않고 거부한다. 소스는 원래 snapshot이며 이후 작업 파일의 수정은 반영하지 않는다. 수정 결과를 검토하려면 새 리뷰를 실행한다.

`awaiting_input`은 질문을 저장하고 모델을 종료한 상태다. 질문 ID와 실제 사용자 답변을 제출하면 같은 turn을 재개하며 두 모델 호출과 실행 시간 등 기존 turn 예산을 이어서 사용한다. 같은 turn ID/내용 또는 이미 처리한 동일 답변은 모델을 다시 호출하지 않는다. 중단 뒤 queued 상태는 `read`로 확인하고 `resume`으로 명시적으로 실행한다. 취소·완료된 turn은 resume하지 않는다.

`read`, `source`, `cancel`은 모델을 준비하지 않는다. Chat의 종료 코드 1은 queued/running/awaiting_input, 2는 실패·부분 완료·중단·취소를 뜻한다. 성공한 cancel 명령은 0을 반환한다. MCP에서는 `gcr_get_review_conversation`, `gcr_read_conversation_source`, `gcr_cancel_review_turn`을 제공하고 `--allow-review`가 있으면 `gcr_continue_review`의 send/answer/resume을 추가한다. MCP의 실행 계정은 startup 설정에 고정되며 tool 인수로 바꿀 수 없다.

## Local Memory와 리뷰 지식 Skill

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

IPC는 macOS/Linux의 사용자 전용 Unix socket(0600, 상위 디렉터리 0700)을 사용하며 TCP port를 열지 않는다. Windows는 지원하지 않는다. Payload는 최대 8 MiB이며 queued/running/interrupted 합계 64개까지 받는다. 모델 시간·source·tool 제한은 등록한 리뷰별 설정이다. `service allow --reviews-per-hour 6`은 profile/worktree의 공통 실행 기록을 기준으로 시간당 시작 횟수를 제한한다(기본 6, 범위 1–100). 기존 수동 리뷰 시작도 집계하며 같은 결과를 재사용할 때는 새 시작을 차감하지 않는다. 한도에 걸린 receipt는 `notBefore`를 기록한 queued 상태로 남고 해당 시각 이후 다시 준비한다. 사용자 전체 호출/token 예산과 receipt 보존 기간은 남아 있다. Linux IPC 지원이 Linux 모델 executor 검증을 뜻하지는 않는다.

`scripts/verify-service-reviews.mjs`는 명시한 설치 artifact·현재 Codex 실행 파일로 임시 저장소의 commit/push를 검증한다. `GCR_SERVICE_CONSUMER`, `GCR_SERVICE_CODEX`, `GCR_SERVICE_EVIDENCE`에 절대 경로를 지정해야 하며 실제 모델을 호출한다. 사용자 저장소의 hook이나 전역 CLI는 변경하지 않는다.

## VS Code와 독립적인 파일 감시

```sh
gcr service start
# allow는 기존 grant 전체를 교체한다. 유지할 commit/push도 함께 지정한다.
gcr service allow --cwd /path/to/repo --trigger stage --trigger save \
  --executor-path /absolute/path/to/codex
gcr watch start --cwd /path/to/repo --trigger stage
# 모든 외부 파일 쓰기를 Save 입력으로 허용하는 경우에만 실행한다.
gcr watch start --cwd /path/to/repo --trigger stage --trigger save --external-changes
gcr watch status --cwd /path/to/repo
gcr watch stop --cwd /path/to/repo
```

감시는 기본으로 꺼져 있다. `start`가 반환하면 CLI를 닫아도 서비스가 감시를 계속한다. 첫 시작은 현재 변경을 기준점으로 저장하므로 이미 수정하거나 stage한 코드를 소급 실행하지 않는다. 같은 설정으로 다시 시작하면 대기 중인 변경을 보존한다. 설정을 바꾸면 새 기준점을 만든다. `service allow/revoke`로 등록 revision이 바뀌면 감시가 꺼지며 `watch start`로 다시 허용해야 한다.

Stage는 실제 index, Save는 디스크의 working tree를 관찰한다. 각 조회가 끝난 뒤 2초 후 다시 조회하고 변경은 3초 debounce 후 공통 서비스 큐로 보낸다. Save 접수 간격은 기본 10분이며 `--minimum-save-interval-ms`로 10000–3600000ms 사이에서 지정한다. 큐에서 실행을 시작한 시각도 이 간격에 반영한다. 여러 파일의 연속 변경은 합치고, whole-file unstage·원본 복원·내용이 같은 재저장·제외된 파일은 새 리뷰 입력을 만들지 않는다. 부분 hunk만 unstage한 경우의 추가 구분은 남아 있다.

파일 시스템은 수동 Save, Auto Save, 다른 프로그램의 쓰기를 구분하지 못한다. CLI에서 직접 켜는 Save 감시는 `--external-changes`를 명시해야 하며 Auto Save로 기록된 바이트도 포함할 수 있다. 확장과 연결할 때는 `editor-save-events-v1` 서비스 기능을 사용한다. Editor 세션이 등록된 동안에는 파일 재조회만으로 새 Save를 허용하지 않고 확장이 전달한 저장 이유와 현재 파일 hash를 확인한다. 제외한 Auto Save와 같은 바이트를 외부 변경으로 다시 보내도 허용하지 않는다.

마지막 editor 세션이 정상 해제되면 그 시점의 관측값을 기준으로 외부 감시를 이어간다. 이미 허용한 Save 요청은 확장 종료 후에도 서비스에서 실행한다. 비정상 종료 시 마지막 미분류 변경은 소급 실행하지 않고 `unclassifiedFiles`에 남긴다. 현재 파일을 수동 리뷰하거나 이후 명시적인 새 저장 이벤트로 처리해야 한다. 등록 전·서비스 연결 실패 중에는 저장 이유를 전달할 수 없으므로 이 기능을 전체 editor 생명주기 검증으로 간주하지 않는다. 상태의 `editorSessions`와 `editorTransition`으로 연결·정상 해제·프로세스 종료를 구분한다.

관측값·debounce 대기·제출 intent를 암호화해 저장한다. 서비스가 재시작되면 누락된 변경을 다시 조회하고 이미 제출한 intent는 같은 receipt로 확인한다. 실행 중이던 요청은 `interrupted`로 남겨 결과를 복구하도록 하며 같은 관측 입력으로 모델을 자동 재호출하지 않는다. `watch stop`은 해당 감시가 만든 대기/실행 요청만 취소한다. 일반 enqueue·hook 요청과 서비스 grant는 유지한다.

Save 조회는 제외 정책을 적용한 후보 512개, 텍스트 파일당 2 MiB, 파일 순회 20초 한도로 제한한다. 심볼릭 링크와 ignored 파일은 읽지 않으며 binary·파일당 크기 제한을 초과한 파일은 관측에서 제외한다. 후보 수·순회 한도를 넘거나 조회가 실패하면 `watch status`에 `watch-observation-unavailable`을 남기고 재조회한다. 상태에는 대기 파일 수와 receipt를 표시하며 고정 source payload는 포함하지 않는다. OS 로그인 시 서비스 자동 시작과 Linux 실제 executor 검증은 아직 남아 있다.

`scripts/verify-headless-watch.mjs`는 설치한 CLI로 서비스를 시작한 뒤 명령이 종료된 상태에서 실제 파일을 변경한다. `GCR_WATCH_ALLOW_MODEL=1`, `GCR_WATCH_CONSUMER`, `GCR_WATCH_CODEX`, `GCR_WATCH_EVIDENCE`를 명시해야 하며 임시 저장소에 실제 계정 리뷰를 한 건 수행한다. 실행 중인 receipt의 관측 시간이 길어져도 같은 작업을 계속 확인한다. 완료를 확인한 후 서비스와 테스트용 OS key를 정리하며 실행 여부가 불명확하면 fixture를 보존한다.

## 중단 작업의 완료 결과 복구

```sh
gcr requests --cwd /path/to/repo --profile work
gcr requests reconcile --key REQUEST_HASH --generation 1 --cwd /path/to/repo --profile work
gcr service reconcile --id RECEIPT_ID --profile work
```

원래 data directory와 profile을 지정하며 중앙 요청은 같은 `--mode centralized --connection ID`를 사용한다. 서비스의 `review-reconciliation-v1` 기능은 CLI alpha.23부터 제공한다. 기존 서비스가 실행 중이면 먼저 status에서 버전 기능과 활성 작업을 확인한다.

복구는 실행 세대별 완료 receipt의 보고서 ID/hash와 실제 암호화 이력을 대조한다. 현재 작업 파일을 캡처하거나 모델을 준비·재호출하지 않는다. 살아 있는 lease, 저장 보고서나 receipt의 부재는 unresolved/interrupted로 유지한다. 다른 generation의 결과·변조된 보고서·철회된 중앙 권한은 거부한다. CLI `requests reconcile`은 확인한 원본 보고서와 request를 반환하며 성공은 exit 0, 미해결·오류는 exit 2다. 서비스 명령은 receipt가 finished로 확인된 경우에만 exit 0이다. 보고서 자체의 partial/failed 상태는 그대로 유지한다.

서비스에서 이력·완료 기록 저장이 확인되지 않으면 `completionUnconfirmed: true`와 interrupted 상태를 남긴다. `runId`가 존재해도 완료 receipt로 취급하지 않는다. 복구에 성공하면 원래 결과를 연결하고 source payload를 삭제한다. 구버전에서 완료 receipt 없이 중단된 작업과 모델 종료를 확인할 근거가 없는 작업은 재호출로 복구하지 않는다.

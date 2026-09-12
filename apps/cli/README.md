# GCR standalone CLI

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

`review` 호출은 지정한 계정 executor에 해당 profile의 활성 지식과 고정 source/base/관련 파일을 전달하도록 명시적으로 요청하는 동작이다. 전송 경로는 `--allow-path` glob으로 좁힐 수 있다. `--exclude`는 capture에서 제외하며 `--require-source source:caller.py`, `--require-source base:cache.py`, `--require-knowledge ID`로 필수 근거를 지정한다. Repository 파일과 Skill은 tool 권한을 바꾸거나 명령을 실행할 수 없다. 중앙 URL·token·cache를 읽지 않으며 standalone에서 GCR 중앙 요청을 만들지 않는다. `--mode centralized`는 현재 unavailable이다.

현재 실제 모델 adapter는 macOS의 지원 Codex CLI `0.153.4`, `gpt-6-astra`, `xhigh` 조합이다. CLI 경로를 명시하거나 PATH의 `codex`를 사용한다. 특정 앱의 설치 경로를 추정하지 않는다. `status --check-executor --executor-path ...`는 구성과 tool 격리만 검사하며 로그인·quota를 확인하거나 계정 모델을 호출하지 않는다. Linux에서 로컬 저장소와 조회 명령은 사용할 수 있지만 현재 모델 adapter는 unavailable이다. 지원하지 않는 실행 환경에서 다른 모델/provider로 전환하지 않는다.

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

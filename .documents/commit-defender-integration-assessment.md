# Commit Defender를 로컬 리뷰 client로 활용할 수 있는가

검토일: 2026-09-11  
상태: 코드 검토에 따른 권고안. 후속 요구의 standalone/centralized 지원을 설계에 반영했으며 구현·배포하지 않음.  
관련 기획: [사전 예방형 리뷰 플랫폼](./preventive-review-platform-plan.md)

연결 방식의 상세: [리뷰 정책·메모리 sync 설계](./client-review-knowledge-sync-design.md)  
개발·게시의 필수 절차: [로컬 VS Code 검증과 CLI 게시](./client-extension-release-plan.md)

## 판단

**별도의 VS Code 확장을 처음부터 만들기보다 Commit Defender를 로컬 리뷰 화면과 실행 진입점으로 활용하는 쪽을 권한다.** 중앙 Git Code Reviewer와 연결할 공통 client core는 추가로 필요하다. 선택지는 ‘client를 개발할 것인가’보다는 ‘이미 있는 VS Code 제품을 확장할 것인가’에 가깝다.

재사용할 가치는 inline unit-comment-block, summary 화면, Git stage 감지, VS Code 없이 실행되는 pre-commit 진입점에 있다. GitHub 최신 코드에는 계정 인증을 사용하는 Codex·Claude Code·Gemini·Antigravity CLI adapter도 있다. 반면 중앙 메모리 동기화, 정확한 로컬 snapshot, trigger 간 중복 방지, 지속되는 대화형 리뷰는 아직 연결해야 한다.

권고 구조는 `Git Code Reviewer 중앙 서버 + 공통 local review core + Commit Defender VS Code adapter + CLI/MCP adapter`다. 새 VS Code client를 병행 개발하거나, 서버 연결을 AI provider의 URL 하나 바꾸는 작업으로 축소하는 방식은 권하지 않는다.

## 검토한 버전과 검증 범위

| 대상                             | 확인한 상태                                                                                                             |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| 로컬 `~/git/commit-defender`     | `main`, `14203044e4e0cf2ba5d44fcf521425a4113f7840`, VS Code package `2.0.3`                                             |
| GitHub `pydemia/commit-defender` | `main`, `47dabfea718729b0ccc685ae173857476040d6ea`, VS Code package `2.3.0`                                             |
| 현재 Git Code Reviewer           | `a85d52a`; 사전 예방형 client는 별도 기획 문서에 있는 구현 예정 범위                                                    |
| 로컬 2.0.3 검증                  | `npm run typecheck` 통과                                                                                                |
| 원격 2.3.0 검증                  | 임시 디렉터리에 해당 revision을 추출해 `npm run build`, `npm test` 통과. Provider 테스트 7개                            |
| 검증 환경                        | Node `v25.9.0`, 기존 로컬 extension의 `node_modules` 사용. clean install 및 VS Code Extension Host 검증은 수행하지 않음 |

로컬과 원격의 차이는 문서만이 아니다. 원격에는 계정 provider, 로그인·모델 선택 UI, JSON schema, provider 테스트가 추가돼 있다. 검토 기준은 원격 2.3.0이며 로컬 2.0.3만 보고 계정 연결이 없다고 판단하면 안 된다. 원격의 GHES 브라우저 확장·서버 설계 문서는 실행 코드와 구분했다. [원격 revision](https://github.com/pydemia/commit-defender/tree/47dabfea718729b0ccc685ae173857476040d6ea), [package](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/package.json)

Provider 테스트는 가짜 CLI로 인자·출력·취소·timeout을 확인한다. 실제 계정 로그인, 모델 응답 품질, Marketplace 배포 버전까지 검증한 것은 아니다. 설치된 Codex CLI `0.144.4`의 help에서 adapter가 사용하는 옵션은 확인했다. 실제 LLM 요청, hook 설치, 기존 checkout의 pull·변경은 수행하지 않았다.

## 기존 기능과 추가 개발 범위

| 요구                        | Commit Defender 2.3.0의 구현                                                                                                         | 판단                                                                                                                                      |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 코드 옆 unit-comment-block  | CommentThread, CodeLens, Problems, 파일별 findings tree                                                                              | 재사용. Problems 표시는 리뷰 결과를 보여주는 수단이며 linter 구현을 뜻하지 않음                                                           |
| summary와 개별 finding 분리 | `review.summary`, `file_comments`, `per_file_summaries`, summary webview                                                             | 재사용하되 GCR의 coverage·근거·미완료 상태를 보존하도록 확장                                                                              |
| 여러 언어의 코드 리뷰       | TypeScript 구현이며 입력은 알려진 binary 등을 제외한 텍스트. 언어별 AST가 필수는 아님                                                | Python 구형 실행 경로를 되살릴 필요 없음. 혼합 언어의 호출·계약 분석은 별도 검증 필요                                                     |
| Stage 자동 분석             | `.git/index` watcher, 2초 debounce, `runOnStage` 설정                                                                                | 기반은 있으나 정확한 Git 경로·snapshot·설정 변경 반영은 보완 필요                                                                         |
| Commit 전 분석              | bundled Node CLI를 호출하는 pre-commit hook; VS Code 종료 상태에서도 실행 가능                                                       | headless 진입점 재사용. hook 설치·판정·공통 scheduler는 변경 필요                                                                         |
| Save / Push 선택            | 해당 자동 trigger 구현 없음                                                                                                          | Save listener와 pre-push adapter 추가                                                                                                     |
| 계정 기반 실행              | Codex·Claude Code·Gemini·Antigravity CLI 실행 및 로그인 진입점                                                                       | 재사용 가치가 큼. 중앙 계정 인증과 로컬 CLI 계정 인증은 별개                                                                              |
| diff 외 기존 코드 조회      | 기본 입력은 staged diff 또는 파일별 전체 내용. Codex는 repository cwd에서 read-only 실행. Claude Code는 `--tools ''`로 도구 비활성화 | provider마다 조회 능력이 다름. 공통의 정확한 base/index/관련 코드 조회가 이미 완성됐다고 볼 수 없음                                       |
| interactive review chat     | comment thread는 `canReply = false`; 현재 결과 조회·재분석 중심                                                                      | 질문·추가 조회·사용자 응답·재개 기능 추가                                                                                                 |
| 누적 메모리                 | `HistoryProvider`의 프로세스 내 최근 20개 결과. 로컬 `SKILL.md` prompt 주입                                                          | 개인·집단 메모리, GitHub 이력 관리, sync 기능으로 대체할 수 없음                                                                          |
| 실행량 제어                 | diff/파일 80,000자 제한, timeout·cancel. API provider의 출력 token 설정                                                              | 공통 cache·예산·동시 실행 제어 추가. CLI 한 번이 내부 모델 호출 한 번을 의미하지 않으며 CLI adapter에는 동일한 token 상한이 강제되지 않음 |

코드 근거: [리뷰 파이프라인](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/ai/reviewer.ts#L34), [CLI provider](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/ai/providers.ts#L105), [댓글 표시](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/comments.ts#L14), [이력](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/historyProvider.ts#L31), [Stage watcher](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/extension.ts#L1270).

## 그대로 연결하기 전에 수정할 부분

### 민감 파일이 repository 분석 대상에 들어갈 수 있다

`collectFiles()`는 디렉터리를 직접 순회하고 사용자 `excludePatterns`만 적용한다. `.gitignore`를 읽지 않으며 `.commit-defender` 디렉터리는 순회 허용 대상이다. API key 모드의 hook 설정은 `.commit-defender/hook.json`에 평문으로 기록된다. 생성 mode `0600`과 `.gitignore` 추가는 구현돼 있지만, 같은 사용자 권한의 분석기가 파일을 읽는 것을 막지 못한다.

가짜 `.env`, `.commit-defender/hook.json`, 이를 제외하는 `.gitignore`를 둔 임시 repository에서 두 파일 모두 `collectFiles(..., [])` 결과에 포함되는 것을 재현했다. 이는 source 수집 경로의 노출 가능성이며 실제 사용자 비밀이 전송됐다는 확인은 아니다. 사용자 credential 파일은 열지 않았고 네트워크로 전송하지 않았다.

연결 전에는 수집 정책에서 credential·환경 설정·내부 cache를 기본 제외하고, Git ignore·사용자 제외·중앙 source 정책을 함께 적용해야 한다. 계정 token은 OS credential storage에 두고 repository에는 비밀이 없는 연결 설정만 둔다. CLI가 스스로 코드를 읽는 경우에도 prompt에 파일을 넣지 않는 것만으로 충분하지 않으므로 읽을 수 있는 context와 경로를 제한해야 한다. [파일 수집](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/gitHelper.ts#L69), [hook 설정 저장](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/hook/install.ts#L65)

### Stage 결과와 working tree가 섞인다

모델 입력은 staged diff지만 finding을 숨기는 `applyMarkers()`는 working tree 파일을 읽는다. 임시 repository에서 stage 후 working tree에만 `# TODO`를 넣으면, staged diff에는 marker가 없어도 해당 줄 finding이 제거되는 것을 재현했다.

Save는 저장된 working tree, Stage·Commit은 해당 index, Push는 전송할 ref를 기준으로 별도 snapshot을 고정해야 한다. Suppression·근거·관련 코드 조회도 같은 snapshot을 사용해야 한다. `TODO`나 타입 검사 무시 표시를 AI 리뷰 전체의 자동 면제 사유로 삼는 현재 정책도 폐기하거나 명시적인 리뷰 예외 정책으로 바꿔야 한다. 삭제 파일은 현재 staged 목록과 diff에서 제외되므로 삭제에 따른 호출부·계약 파손을 검토하는 범위도 보완한다. [marker 처리](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/skipMarkers.ts#L40), [staged 목록](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/gitHelper.ts#L111), [diff 추출](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/diff.ts#L34)

### 실패와 통과, 심각도와 차단을 분리해야 한다

파일별 분석은 provider가 실패하면 오류 summary를 쌓지만 최종 집계에서 `is_error: false`를 설정한다. 실제 provider를 호출하지 않는 오류 fixture에서 모든 대상의 provider dispatch가 실패해도 최종 `is_error=false`, `exit_code=0`이 되는 것을 재현했다. Extension은 summary 문자열에서 오류를 다시 감지하는 보완 처리가 있지만 report 자체의 상태는 일관되지 않다.

현재 hook은 P3 또는 모델의 `blocking=true`이면 차단하고 모델 오류는 통과시킨다. 연결형 모드는 `queued/running/partial/failed/cancelled/completed/stale` 같은 실행 상태와 `advisory/block` 정책을 분리해야 한다. 기본 advisory, 실패는 미완료로 표시한다. 오래된 report를 화면에 남길 때도 현재 변경이 리뷰됐다는 인상을 주지 않아야 한다. [파일별 집계](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/ai/reviewer.ts#L89), [hook 판정](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/exitResolver.ts#L14)

### Hook·scheduler·신뢰 경계를 보강해야 한다

- Hook 설치가 `<repo>/.git/hooks`에 고정돼 있어 worktree의 `.git` 파일과 `core.hooksPath`를 고려하지 않는다. 기존 hook은 사용자 확인 후 backup·교체하는 방식이지 연쇄 실행하는 방식이 아니다. 기존 hook을 보존하는 adapter로 변경한다.
- Watcher는 첫 workspace의 `.git/index`를 감시한다. `runOnStage`는 watcher 초기화 때만 확인하고 설정 변경 시 watcher를 재구성하지 않는다. 연결형 toggle은 즉시 반영하고 multi-root·worktree·하위 폴더 열기를 검증한다.
- Stage와 pre-commit은 각각 provider를 호출한다. 공통 결과 cache나 cross-process lock이 없으며 extension의 분석 진입점도 기존 실행을 기다리거나 취소한 후 시작하도록 직렬화돼 있지 않다. 새 공통 scheduler에서 중복 실행과 오래된 결과의 덮어쓰기를 방지한다.
- 로컬 `SKILL.md`가 system prompt에 바로 들어간다. 중앙 승인 기준과 repository의 참고 자료를 같은 신뢰 수준으로 합치지 않는다. 모델 출력 Markdown의 `isTrusted=true`도 제한하고 finding의 경로·라인을 검증한다.
- CLI 실행에는 `shell:false`, 출력 크기 제한, timeout·cancel이 있어 재사용할 수 있다. 다만 프로세스 종료와 하위 도구 종료, 내부 모델 호출량, source 접근 범위는 executor별 검증이 추가로 필요하다.

근거: [hook 설치](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/hook/install.ts#L111), [분석 진입점](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/extension.ts#L333), [CLI 프로세스](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/ai/providers.ts#L310), [Skill 주입](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/vscode-extension/src/ai/prompt.ts#L179)

## Git Code Reviewer와 맞는 부분

GCR은 이미 Commit Defender의 보고서 개념을 채택했다. `reviewAnalysisSchema`에는 `commit-defender-total-summary-v1`, `unit-comment-block`, 파일별 summary, Skill version/hash, coverage가 있다. 따라서 화면 개념을 다시 설계할 필요는 적지만 두 JSON을 그대로 교환할 수 있는 것은 아니다. GCR의 finding/segment ID, base·head 위치, 미완료 상태와 근거를 legacy `file/line/comment`로 축소하면 정보가 사라진다. 공통 report 계약을 유지하고 CD 화면용 projection을 둔다. [GCR 분석 계약](../packages/contracts/src/review-analysis.ts#L95)

GCR의 chat agent에는 관련 코드 조회, Git/file 도구, `ask_user`, 사용자 응답 후 재개, 근거 참조와 개인·집단 메모리 우선순위가 있다. 이 동작 계약과 테스트를 재사용한다. 현재 서버 도구는 서버가 준비한 `manifest.json` 및 `head/base/mergeBase` view를 전제로 한다. 사용자의 미커밋 working tree와 임시 index를 그대로 처리하는 범용 client SDK는 아니다. [Chat 지침](../apps/runtime/src/services/chat-agent.ts#L147), [source 도구](../packages/git-engine/src/local-tools.ts#L34), [근거 계약](../packages/contracts/src/chat-run.ts#L21)

GCR package는 현재 private workspace package이고 root Node 요건은 22 이상, CD hook bundle target은 Node 18이다. 런타임 호환성을 확인하지 않은 채 상대 경로로 서버 코드를 import하지 않는다. 순수 계약·안전한 source 처리·scheduler를 분리해 버전을 고정한 package 또는 배포 artifact로 전달한다. 서버 route/DB 코드를 extension에 복사하지 않는다.

## 권고하는 연결 구조

```text
GitHub / GHES 리뷰 이력
        ↓
Git Code Reviewer 중앙 서버
  승인된 집단·개인 메모리 / 리뷰 기준 버전 / 접근 권한
        ↕ 인증된 sync API, 동의한 결과·feedback
공통 local review core
  정확한 snapshot / 관련 코드·base 조회 / sync cache
  scheduler / 실행 예산 / 결과·대화 상태 / report 계약
        ├─ Commit Defender: 설정, Save·Stage 이벤트, review 화면·chat
        ├─ CLI / Git hooks: 수동·Commit 전·Push 전 요청
        └─ MCP / Skill: 다른 개발 도구의 리뷰 요청
        ↓
선택된 executor 한 개
  로컬 계정 CLI 또는 승인된 중앙 모델 proxy
```

### 인증과 실행은 분리한다

로컬 계정 CLI를 쓰는 경우 GCR은 승인된 메모리·기준을 전달하고 CD가 기존 로컬 로그인으로 분석한다. 현재 기획의 ‘실제로 호출 가능한 executor’ 요건을 충족할 출발점이 이미 있는 셈이다. 로컬 source를 중앙에 올리지 않는 운영도 가능하도록 설계하되 source는 선택된 모델 제공자에게 전달될 수 있음을 표시한다.

중앙에 설정된 ChatGPT 계정을 쓰려면 별도의 인증된 모델 proxy 및 로컬 리뷰 job/context API가 필요하다. 중앙 credential을 내려받아 로컬 CLI에 넣지 않는다. 기존 PR 세션 API에 미커밋 코드를 끼워 넣어 PR snapshot으로 가장하지도 않는다. 사용자별 repository 접근 권한, source 전송 동의, retention, 개인 메모리 격리를 확인한다.

API-key·로컬 CLI·중앙 proxy의 실행 경로를 명시적으로 선택한다. 서버 연결 실패는 유효 cache 또는 standalone으로 처리하되, 모델 경로까지 바꾸려면 사용자가 사전에 승인한 executor와 source 전송 범위가 필요하다. 한 리뷰를 기존 CD와 연결형 core가 동시에 실행하지 않도록 실행 책임을 하나로 둔다. 중앙 모델의 admission 제어가 로컬 계정 CLI 내부 호출까지 통제한다고 표시하지 않는다.

### Client core와 VS Code 제품을 분리한다

`ReviewBackend` 같은 추상화를 두어 CD의 직접 `new Reviewer(cfg)` 호출을 독립형 backend와 GCR 연결형 backend로 분리하는 방안을 제안한다. 연결형 backend는 공통 core에 요청하고 결과를 표시한다. 중앙 계약·인증·sync는 GCR에서, VS Code UI와 배포는 CD에서 관리하는 구성이 변경 책임을 명확하게 한다.

모드는 `standalone`/`centralized`로 명시하고 기본은 `standalone`이다. Centralized의 서버 URL은 사용자가 입력한다. 독립형에서도 local memory·Skill을 영속 저장·관리하며 중앙 cache와 분리한다. 기본 연결 실패 정책은 유효 cache 우선, 없으면 local 자료만으로 standalone 실행이다. 상세 설정·전환·권한 조건은 sync 설계에 정의한다.

Core는 VS Code API에 의존하지 않는다. 다른 editor나 agent 사용자는 별도 GCR VS Code 확장 없이 같은 CLI/MCP를 쓸 수 있어야 한다. 설치된 extension의 절대 경로에만 hook 실행 파일이 종속되지 않도록 headless 배포 경로도 제공한다.

기존 독립형 사용자의 provider·hook 설정은 임의로 바꾸지 않는다. 연결형 최초 설정에서는 Save·Stage·Commit·Push를 각각 선택하며 기본은 모두 off, 판정은 advisory다. CD의 기존 `runOnStage=true`, P3 차단을 연결형 기본값으로 그대로 승계하지 않는다.

## 새 client와 연결형 비교

| 기준                  | 새 VS Code client                                          | CD 연결형                                           |
| --------------------- | ---------------------------------------------------------- | --------------------------------------------------- |
| 초기 제품 작업        | 설정, inline 표시, summary, history, 설치·배포를 새로 개발 | 기존 화면·명령·CLI 실행 adapter 활용                |
| 중앙 연결·정확한 리뷰 | 공통 core·API 개발 필요                                    | 동일하게 필요. 기존 prompt 주입만으로 해결되지 않음 |
| 보안·Git 경계         | 새 구현과 테스트 필요                                      | 확인된 기존 위험을 먼저 수정하고 회귀 테스트 추가   |
| 기존 사용자           | 제품 설치·설정 이동 필요                                   | 명시적인 connected mode 도입으로 이전 부담 축소     |
| IDE 외 사용           | headless core를 분리하면 가능                              | 동일. CD extension에 core를 가두지 않는 것이 조건   |
| 장기 유지보수         | 비슷한 리뷰 제품 두 개의 UI·provider 수정이 중복될 수 있음 | CD와 GCR의 배포 버전·호환 계약 관리 필요            |

현재 요구는 기존 CD의 UI·계정 CLI와 맞닿아 있으므로 연결형의 중복 개발이 적다. CD를 별도 독립 제품으로 고정해 수정할 수 없거나, VS Code 외 IDE가 첫 출시의 중심이거나, 요구되는 격리·배포 방식 때문에 CD UI까지 대폭 교체해야 한다면 새 client를 재검토한다. 개발 기간이나 재사용률 수치는 추정하지 않았다.

## 구현 순서와 통과 조건

1. **기준 버전·안전성 확정**: 원격 2.3.0을 기준으로 기존 미커밋 작업을 보존해 개발 환경을 맞춘다. 민감 파일 제외, 동일 snapshot의 suppression, failed/partial 상태, 안전한 Markdown·경로 처리와 회귀 테스트를 먼저 반영한다. 이번 검토에서는 로컬 checkout을 갱신하지 않았다.
2. **수동 연결 리뷰**: GCR client 인증·기준 sync와 CD connected backend를 연결한다. 우선 검증된 로컬 계정 executor 하나로 실제 base·관련 코드·집단 우선 메모리를 읽고 summary와 finding을 표시한다. 인증되지 않은 repo·다른 사용자의 개인 메모리 접근을 거부한다. 중앙 계정 모드는 proxy 준비 후 별도 지원한다.
3. **네 시점과 공통 실행 관리**: Save·Stage·Commit·Push의 독립 toggle, 정확한 대상, queue·dedup·budget·취소·stale 표시를 구현한다. Partial stage, 초기 commit, amend, alternate index, 삭제·rename, worktree, 기존 hook, 다중 push ref를 fixture로 확인한다. Hook이 비동기 예약만 하면 ‘Commit/Push 전 리뷰 완료’로 표시하지 않는다.
4. **대화와 도구 확장**: finding 단위 추가 질문, 관련 코드 재조회, 사용자 응답 후 재개와 근거를 CD 화면에 연결한다. 같은 core를 CLI/MCP에 노출하고 명시적인 feedback만 중앙 메모리 후보로 보낸다. Python 외 언어와 혼합 언어 계약 변경도 실제 리뷰로 검증한다.

이 순서는 기존 플랫폼 기획의 중앙 계약·sync 단계와 로컬 client 단계를 CD 재사용 관점에서 나눈 것이다. Linter 기능은 다시 추가하지 않는다. 각 단계는 모의 응답뿐 아니라 허용된 실행 경로의 실제 분석 결과로 검증하되 비용·권한·지원하지 않는 검증 범위를 함께 기록한다.

각 extension 릴리스에는 build·자동 테스트뿐 아니라 작업자가 로컬 VS Code의 Development Host와 최종 VSIX 설치 환경을 직접 실행하는 검증을 요구한다. 통과한 VSIX의 hash를 고정한 뒤 CLI로 publisher 인증·권한을 확인하고 그 파일을 publish한다. 개발 호스트 검증만으로 게시하거나 웹 관리 화면의 수동 업로드로 대체하지 않는다. 게시 후 Marketplace 설치까지 확인하는 [릴리스 절차](./client-extension-release-plan.md)를 따른다.

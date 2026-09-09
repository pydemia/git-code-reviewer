# Git Code Reviewer 기능 목록

현재 구현된 기능을 화면 메뉴별로 정리한 문서입니다. 먼저 제품의 사용 흐름을 확인하려면 [Introduction](introduction.md)을 읽으세요. 설정 절차는 [사용 가이드](/guide)에서 확인할 수 있습니다.

## Pull requests · PR 목록

**메뉴 위치:** 홈 → Pull requests

- Tenant를 선택하면 접근 권한이 있는 repository의 open PR을 표시합니다.
- PR 제목, 작성자, repository, 분석 상태, 코드 품질 등급과 P2 이상 의견 수를 확인합니다.
- PR을 선택하면 해당 분석의 Review workspace를 엽니다. 분석 결과가 아직 없으면 PR 단위 화면으로 이동합니다.
- 목록의 동기화는 PR 목록을 다시 조회합니다. 새로운 분석 요청은 Review workspace의 새로고침에서 실행합니다.

관리자가 등록한 repository는 설정된 주기에 따라 polling합니다. 아직 수집되지 않은 PR이나 허용되지 않은 repository는 목록에 표시되지 않습니다.

## Review workspace · 분석과 결과

**메뉴 위치:** Pull requests → PR 선택

| 기능           | 화면에서 하는 일                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 분석 진행 상태 | 코드 준비, 분석 대기, 파일 검토, 파일·전체 요약, 결과 저장 단계를 확인합니다.                                             |
| 결과 상태      | 분석 완료와 미완료·미수행·실패·데모 표시, 검토하지 못한 범위를 구분합니다.                                                |
| 새로고침       | 같은 commit도 새 분석 revision으로 검토합니다. 이전 보고서는 이력으로 남습니다.                                           |
| 분석 기준 고정 | 분석에 사용한 commit, Provider, Prompt, Skill과 메모리 버전을 분석 단위로 유지합니다.                                     |
| 공용·개인 분석 | Polling은 집단 메모리를 참고하고 수동 요청은 요청자 개인 메모리도 참고합니다. 개인화 분석은 요청자와 관리자가 조회합니다. |
| 패널 조절      | 파일 탐색 영역을 접고 Chat 너비와 하단 도구 높이를 조절합니다. 조절한 크기는 브라우저에 저장합니다.                       |

관리자가 실제 AI Provider를 연결해야 AI 리뷰가 실행됩니다. 데모 결과나 코드 위치 확인만으로 실제 AI 검토·문제 재현이 완료됐다고 판단하지 않습니다.

## Code · Summary · Comments

**메뉴 위치:** Review workspace → 메인 Code·Summary 탭, 하단 Comments 탭

| 메뉴           | 제공 기능                                                                       |
| -------------- | ------------------------------------------------------------------------------- |
| Files          | 폴더·파일 tree, 추가·삭제 line 수, 키보드 탐색과 파일 선택                      |
| Code           | 변경 diff, inline comment, 선택한 finding의 코드 위치 강조                      |
| Summary        | PR 전체 요약, 파일별 Overall Summary, 분석한 파일 목록과 파일별 검토 상태       |
| Comments       | unit-comment-block에 해당하는 finding의 문제, 영향, 권장 조치, 근거와 확인 상태 |
| 관련 코드 이동 | 파일 요약·의견 block 또는 코드 링크에서 동일 분석 revision의 파일·line으로 이동 |
| 코드 품질 등급 | 보고서의 품질 평가와 P2 이상 확인 항목을 표시                                   |

의견 수준은 P0 Praise, P1 Info, P2 Warning, P3 Critical입니다. P0는 좋은 변경, P1은 참고할 개선, P2는 merge 전 확인할 위험, P3는 치명적 문제를 뜻합니다. Summary의 종합 판단과 개별 finding은 별도로 읽습니다.

AI 검토를 완료했고 지적 사항이 없는 파일은 `검토한 변경 범위에서 문제가 발견되지 않았습니다.`로 간단히 표시합니다. 일부 검토·미검토·분석 제한과 검토 의견이 있는 파일의 설명은 유지합니다. 기존 report에도 표시 규칙을 적용하며 저장된 원문과 Raw JSON은 바꾸지 않습니다.

파일 전체에 대한 의견은 파일 수준으로 표시합니다. 확보한 diff 밖의 line에 대한 의견을 다른 line에 임의로 붙이지 않습니다.

자세한 조작은 [Review와 Chat 가이드](/guide#review-flow)와 [코드 이동 가이드](/guide#code-navigation)를 참고하세요.

## Git graph · Impact · Tests

**메뉴 위치:** Review workspace → 하단 도구 탭

| 메뉴      | 제공 기능                                            | 확인할 범위                                                      |
| --------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| Git graph | merge-base, 관측한 base tip, PR commit과 head를 표시 | 현재 분석 snapshot의 commit 관계                                 |
| Impact    | 보고서가 제시한 영향 영역, 위험, 설명과 근거를 표시  | 확보한 코드 구조와 보고서의 분석 범위                            |
| Tests     | 추가된 테스트 파일, 테스트 케이스와 기대 조건을 표시 | 추가된 테스트 코드의 정적 해석; 테스트 실행 결과는 제공하지 않음 |

분석에 해당 자료가 없으면 빈 상태나 제한 사유를 표시합니다.

## Chat · 후속 질문

**메뉴 위치:** Review workspace → 오른쪽 Chat

- 허용된 ChatGPT account·model·effort를 선택해 질문합니다.
- PR 전체 요약, 파일별 요약과 findings를 함께 참고합니다. 선택한 finding이나 파일은 질문 범위를 정하는 참고 정보이며 전체 PR 질문도 할 수 있습니다.
- 분석에 고정된 메모리와 현재 사용자의 관련 개인 메모리, 개인 Prompt를 답변에 참고합니다.
- 대화 이력을 유지하고 답변을 Markdown 목록·코드·표로 표시합니다.
- 답변에서 사용한 관련 코드 링크를 최대 24개 표시합니다. 클릭하면 해당 분석의 파일과 이전·변경 코드 위치로 이동합니다.
- Enter로 전송하고 Shift+Enter로 줄을 바꿉니다.

예를 들어 “여러 파일의 findings를 종합하면 merge 전에 무엇을 확인해야 하나요?” 또는 “이 권장 조치와 기존 보고서의 영향 범위는 어떻게 연결되나요?”처럼 질문할 수 있습니다.

Interactive Chat이 활성화된 환경에서는 등록된 GitHub 연결로 로컬 Git 저장소와 base·merge-base·head 파일 트리를 준비합니다. AI가 변경되지 않은 구현·호출부·테스트도 검색하고 필요한 파일과 Git 이력을 반복 조회합니다. 판단에 필요한 요구사항이 불명확하면 선택지 또는 자유 입력으로 질문하며 응답 후 분석을 이어 갑니다.

조회 과정, 실제 응답 스트리밍, 중단과 계정 한도 대기를 표시합니다. 실행 상태는 서버에 저장되어 재접속해도 이어서 확인할 수 있습니다. 실행 중 추가 지시는 다음 모델 단계에 반영합니다. `조회한 코드 근거`를 누르면 메인 `코드 근거` 탭에서 고정 SHA와 line 범위를 확인합니다. 이 목록은 실제로 읽은 범위이며 파일 전체 검토나 모든 항목의 최종 인용을 뜻하지 않습니다.

기본 한도는 대화 실행당 모델 요청 8회·도구 조회 24회·추가 근거 128 KiB입니다. 자동 분석과 Chat은 같은 upstream 계정의 동시 요청 1개, 분당 60회·직렬화 입력 1 MiB 제한을 공유합니다. 제공자가 더 낮은 한도를 적용할 수 있으며 429 응답의 대기 시간 동안 재요청을 보류합니다. 토큰 잔량을 정확히 예측하거나 실패를 없앤다는 보장은 아닙니다.

`이전 분석과 코드 근거`에서는 과거 질문을 선택해 답변·확인 질문·사용자 응답을 다시 읽고 당시 SHA의 파일을 메인 탭에서 열 수 있습니다. 현재 진행 중인 대화는 별도로 유지됩니다. 오래된 대화는 출처와 생략 범위를 표시한 발췌로 전달하며 AI가 필요한 원문과 코드 근거를 다시 조회합니다. 발췌가 개인·집단 메모리에 자동 등록되지는 않습니다.

관련 코드 탐색은 JS/TS 구문 AST와 Python lexical 분석으로 정의·호출·테스트 후보를 구분합니다. 동적 호출이나 타입별 method 해석까지 검증한 결과는 아니며 조회하지 못한 범위를 함께 표시합니다. 자동 분석은 저장된 단계별 모델 결과를 Worker 재시작 후 재사용합니다. 이미 전송한 요청은 계정 예산에서 차감된 상태를 유지합니다.

## Memory · 개인 메모리

**메뉴 위치:** Review workspace → Memory → 내 Memory / 현재 Review와 Chat

- AI finding, 완료된 자신의 Chat 메시지와 GitHub PR 대화를 개인 메모리 후보로 저장합니다.
- 수동 분석의 일부 P2·P3 finding은 자동으로 개인 후보가 됩니다. 후보는 사용자가 적용해야 분석에 참고합니다.
- 후보를 적용하거나 제외하고 활성 메모리를 폐기할 수 있습니다.
- 현재 분석에 고정된 개인 메모리 수와 관리할 후보·활성 항목을 확인합니다.
- 개인 메모리는 현재 사용자와 repository의 범위에서 조회합니다.

활성화한 메모리를 새 분석에 적용하려면 workspace에서 새로고침합니다. 이미 완료된 보고서는 변경되지 않습니다. Chat의 새 답변에는 현재 관련 개인 메모리를 추가로 참고할 수 있습니다.

## Memory · GitHub PR 대화

**메뉴 위치:** Review workspace → Memory → PR 대화

| 수집 원천      | 보존하는 내용                                        |
| -------------- | ---------------------------------------------------- |
| PR 일반 댓글   | 본문, 작성자, 원본 URL과 GitHub 작성·수정 시각       |
| Review 본문    | 제출된 review의 본문, 작성자, 원본 URL과 commit 정보 |
| Inline comment | 본문, 제공된 파일·line·side·commit 정보와 답글 관계  |

Repository polling이 open PR을 갱신할 때 대화를 함께 수집합니다. 빈 본문은 제외하고 bot 메시지도 원천 데이터로 보존합니다. 원문을 수집했다고 메모리가 자동 활성화되지는 않습니다.

화면에서 작성자, 본문, 제공된 코드 위치와 GitHub 원문 링크를 확인한 뒤 `Memory 후보`를 누릅니다. 저장한 원천에는 `후보로 저장됨`을 표시합니다. 저장 전에는 `무시`와 `다시 표시`로 본인의 관리 상태를 바꿀 수 있으며 다른 사용자의 상태에는 영향을 주지 않습니다.

GitHub 댓글이 수정되면 수집된 최신 본문을 갱신하고 이전 본문도 버전으로 보존합니다. 후보는 저장 당시의 원문 버전을 계속 참조합니다. 전체 과거 closed PR을 일괄 수집하거나 답글을 대화형 thread tree로 표시하는 기능은 현재 제공하지 않습니다.

## Repository Memory · 집단 메모리

**메뉴 위치:** Review workspace → Memory → Repository Memory / 관리 → Repository Memory

같은 repository와 검토 주제에서 서로 다른 사용자 두 명 이상이 승인한 개인 메모리를 집계해 공용 후보를 만듭니다. 관리자는 repository별 후보의 내용, 기여 수, 충돌 수와 revision을 확인하고 활성화·기각·폐기합니다.

현재 코드와 보고서의 근거가 먼저이며 메모리 중에는 집단 메모리를 개인 메모리보다 우선합니다. 같은 주제에서 집단 메모리와 충돌하는 개인 판단은 집단 판단을 뒤집는 근거로 쓰지 않습니다. 메모리만으로 새로운 finding을 만들지 않고 현재 분석의 근거와 함께 해석합니다.

Workspace의 Repository Memory에는 현재 분석에 고정된 항목이 표시됩니다. 새 공용 판단은 새로운 분석에 반영되며 기존 보고서와 당시 사용한 메모리는 유지됩니다. GitHub 작성자의 수가 아니라 메모리를 승인한 애플리케이션 사용자의 수로 기여를 집계합니다.

실제 저장·승인 순서는 [Memory 사용 가이드](/guide#review-memory)에서 확인하세요.

## 내 프로필 · 개인 설정

**메뉴 위치:** 상단 → 내 프로필

- 계정의 표시 이름, 사용자 이름 또는 subject, role, 인증 방식과 tenant membership을 확인합니다.
- 개인 Prompt로 답변 길이·설명 방식·관심 영역을 최대 4,000자까지 설정합니다. 다음 Chat 질문부터 적용합니다.
- Local account는 표시 이름과 비밀번호를 변경할 수 있습니다. 비밀번호 변경 후에는 다시 로그인합니다.

개인 Prompt는 답변의 선호 설정이고 Memory는 과거 검토 판단입니다. 두 설정은 따로 관리합니다. 같은 ChatGPT account를 공유해도 개인 Prompt는 다른 사용자의 질문이나 공용 PR 분석에 적용되지 않습니다.

## 관리 · 테넌트와 분석 설정

**메뉴 위치:** 관리자 계정 → 상단 관리

| 관리 메뉴         | 제공 기능                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| 테넌트            | Tenant와 사용자 membership 관리                                                                        |
| 사용자            | 사용자 접근 상태, role과 권한 관리, Local account 관리와 사용자 삭제                                   |
| GHES 연결         | GitHub 연결·PAT, repository 등록, polling과 PR 결과 게시 설정                                          |
| 분석 모델         | 등록된 Account·Model·Effort 선택, 파일 병렬 수 1~4개 설정(새 설정 기본값 4), 연결 테스트와 버전 활성화 |
| 분석 프롬프트     | Tenant별 추가 지침과 Severity Level을 버전으로 저장·활성화                                             |
| 분석 Skills       | 검토 관점과 unit-comment-block·overall-summary·total-summary 형식 관리                                 |
| ChatGPT accounts  | Account 등록, 사용자 할당과 허용 model·effort 관리                                                     |
| Repository Memory | 집단 메모리 후보 검토와 활성화·기각·폐기                                                               |

기본 Skill 관점은 correctness, security, maintenance, optimization, review-history, setting입니다. Severity Level은 lean, generous, moderate, rigorous, severe 중 선택하며 기본값은 moderate입니다. 변경한 분석 설정은 새 분석에 적용합니다.

설정 절차는 [사용 가이드의 모델 설정](/guide#analysis-provider), [분석 Skills](/guide#analysis-skills), [repository 등록](/guide#register-repository)을 참고하세요.

## GitHub 게시 · 실행과 운영

Repository의 결과 게시 설정을 활성화하면 공용 분석 결과를 GitHub PR timeline의 관리형 요약 댓글로 생성·갱신합니다. 게시 상태, 원본 링크와 오류를 관리 화면에서 확인할 수 있습니다. 개인화 분석은 공용 PR 댓글로 게시하지 않습니다.

PR 댓글에는 전체 요약과 comment가 있는 파일의 요약·comment-block만 표시하며 전체 파일 목록은 생략합니다. 목록·강조·inline code를 유지하고 긴 AI Comments는 접어서 표시합니다. 검토 수·분석 제한·전체 report 링크는 남기며 앱과 Markdown export에서는 전체 파일을 확인할 수 있습니다.

개발·검증용 Docker Compose와 VS Code의 Server·Worker·Web 실행 설정을 제공합니다. Kubernetes에서는 같은 애플리케이션 image로 Server, Worker, migration과 retention 작업을 구분해 실행합니다. PostgreSQL과 분석 artifact를 함께 운영하며 인증·인가, 상태 점검, 백업·복구 절차는 저장소의 운영 문서에 정리되어 있습니다.

## 지원 범위와 구현 계획

현재 제공 범위는 PR snapshot 분석, 보고서·코드 탐색, 로컬 Git 기반 Interactive Chat, 개인·집단 메모리와 PR 대화 수집·관리입니다. Interactive Chat은 운영자가 기능 flag와 격리된 source sandbox를 함께 활성화해야 합니다. 비활성 환경에서는 기존 보고서 기반 Chat을 유지합니다.

코드 수정, 임의 shell 명령, dependency 설치와 테스트 실행은 제공하지 않습니다. 현재 화면의 Tests와 Chat의 테스트 조회는 정적 해석입니다. 심층 symbol graph 탐색, 공유 Git mirror, 장기 대화 압축과 과거 모든 대화의 근거 탭 복원은 후속 범위입니다.

# Review workspace와 등록 account 기반 분석

2026-09-07 구현. 기존 gray/teal Workspace, 오른쪽 전용 Review Chat, panel resize와 FNB 도구를 유지한다.

## 확인한 원인

Worker의 분석 단계가 repository와 무관하게 전역 `GITHUB_MODE=fixture`를 사용했다. 실제 PAT repository에서 확보한 diff에도 데모 token rotation report가 붙었다. Fixture report 생성기에는 `session.ts`가 없으면 첫 파일을 사용하는 fallback도 있었다.

Fixture는 `GITHUB_MODE=fixture`, `installationId=fixture`, credential 없음의 세 조건을 모두 만족하는 명시적 데모 repository에만 적용한다. Materialization과 분석 단계가 같은 판정을 사용한다. 데모 report도 지정된 `src/auth/session.ts`가 없으면 rotation comment를 만들지 않는다. 과거 report는 수정하지 않고 Workspace에 데모 분석임을 표시한다.

기존 Findings 선택은 파일 선택만 갱신하고 line 이동을 하지 않았다. 선택한 파일에 finding이 없어도 첫 finding을 Evidence에 표시하는 fallback을 제거했다.

## 분석 Provider

관리자 `/admin?tab=provider`에 `chatgpt-account` mode를 추가했다. 관리자는 기존 registry의 account, enabled model, 허용 effort, Timeout을 선택하고 연결 테스트 후 새 버전을 활성화한다. Review Chat의 사용자 선택과 자동 분석 설정은 서로 독립적이다.

`analysis_provider_versions`에는 account ID, model ID, effort, Timeout과 configuration hash만 저장한다. Account 인증 정보를 복사하지 않는다. 분석 작업 생성 시 Provider와 tenant prompt의 version/hash를 고정한다. Worker는 실행 시 현재 registry에서 인증 정보를 읽으며 registry의 refresh 경로를 재사용한다. 모델 선택은 버전에 고정되지만 인증 정보와 권한은 최신 상태를 따른다.

자동 분석은 repository의 tenant grant 또는 `all/*` grant만 허용한다. 관리자 개인의 user/group grant를 Worker가 대신 사용하지 않는다. Save·activate·연결 테스트에서는 all 또는 활성 tenant assignment가 있는지 확인한다. 실제 review 호출 직전에는 정확한 repository tenant, account/model 활성 상태, 허용 effort를 다시 확인한다. 다른 tenant, 비활성 account, 허용되지 않은 effort는 모델을 호출하지 않는다. 연결 테스트는 코드와 tenant prompt 없이 `Reply with OK.`만 보낸다.

새 migration `0013_analysis_chat_account.sql`은 기존 disabled/OpenAI-compatible version을 보존하면서 mode 제약을 확장한다. Registry-only 배포는 기존 `CREDENTIAL_ENCRYPTION_KEY`를 사용한다. OpenAI-compatible mode를 선택할 때는 여전히 별도 Provider 암호화 key와 exact-origin allowlist가 필요하다. PRISM-DEV values의 `model.analysis.admin.enabled=true`는 다음 배포 시 관리자 편집을 허용한다. 실제 account 선택은 배포 파일에 넣지 않는다.

## Report 내용과 출처

모든 모델 adapter가 같은 JSON parser와 한국어 review prompt를 사용한다. 전체 요약에는 실제 동작 변화와 위험, 파일 요약에는 변경 내용과 검토 결론을 요구한다. Comment에는 문제 발생 조건과 수정 방법을 구체적으로 적고 전문 용어·코드 식별자는 영어를 유지한다. 코드 실행 결과나 테스트 통과 여부를 추정하여 채우지 않는다. Tenant 지침과 repository 내용은 고정된 untrusted-source guard를 바꾸지 못한다.

- P0 Praise: 근거가 있는 좋은 변경
- P1 Info: 선택적 개선
- P2 Warning: merge 전 확인할 위험
- P3 Critical: 직접 근거가 있는 치명적 문제

`per_file_summaries`를 모델 응답에서 보존한다. 선택적 `title`, `impact`, `recommendation`을 수용하되 없는 설명은 일반론으로 만들어 채우지 않는다. `line=0`은 파일 전체 comment로 유지하고 가짜 line 1을 만들지 않는다. Diff에 없는 line은 위치 확인 제한으로 표시한다. `verified`는 file/line 존재 검사이며 의미적 정확성이나 재현을 증명하지 않는다.

Report의 `versions.review`는 `model`, `fixture`, `unavailable`, `failed`를 구분한다. 모델 미설정·실패는 partial report와 제한 사항으로 남기고 Workspace의 품질 grade 대신 수행 상태를 표시한다. 기존 report는 `versions.model`로 fixture/disabled를 판별한다. Coverage는 확보한 코드 범위다.

## 탐색과 코드 표시

Files는 directory-first tree로 렌더링한다. 선택한 파일의 상위 폴더는 펼치고 나머지는 접는다. 모두 접기·모두 펼치기, 방향키, Home/End, Enter를 지원한다. 파일명은 한 줄로 표시하고 전체 path는 tooltip으로 제공한다. 각 파일·폴더 오른쪽에는 초록색 additions와 빨간색 deletions를 분리한다. 폴더는 하위 합계이며 미확인 수치가 있으면 0 대신 `—`를 표시한다.

파일 요약·finding·praise·Outline 선택 시 같은 snapshot의 해당 파일과 코드 위치로 이동한다. Finding은 관련 line을 강조하고 바로 아래에 전체 설명을 펼친다. 같은 항목을 다시 눌러도 해당 위치로 이동한다. 파일 전체 comment와 diff 밖 line은 별도 안내를 표시하며 임의의 다른 line으로 연결하지 않는다. 파일 선택은 첫 변경 line으로 이동한다.

Split은 같은 row에 base/head를 정렬한다. Unified도 삭제 line과 base/head line 번호를 유지한다. 여러 hunk, 신설·삭제 파일, unequal additions/deletions, 마지막 개행을 처리한다. Code와 모델 설명은 React text로 출력하여 raw HTML을 실행하지 않는다.

## 같은 commit 재분석

진행 중 작업은 기존 PR/base/head 기준으로 중복 제거한다. 완료 후 수동 새로고침의 materialization job 키에는 새 operation ID를 포함한다. 동일 SHA라도 새 immutable snapshot·analysis ID를 만들 수 있다. 완료한 뒤 Workspace는 과거 URL의 report를 다시 읽지 않고 최신 analysis로 이동한다. 과거 deep link와 artifact는 변경하지 않는다.

## 운영 적용 순서

Migration 0013을 포함한 Server/Worker를 함께 배포한다. 관리자는 기존 account에 분석 대상 tenant 권한을 확인하고 분석 Provider에서 account·model·effort를 저장한다. 데모 report가 생성된 실제 PR은 새로고침으로 다시 분석한다. PR 게시가 켜져 있으면 새 분석의 게시 경로도 함께 실행된다. 과거 report 파일을 수동으로 덮어쓰지 않는다.

검증은 전용 local PostgreSQL과 synthetic credential·모델 응답을 사용한다. 실제 GHES나 ChatGPT account로 분석을 실행한 것과 구분해서 기록한다.

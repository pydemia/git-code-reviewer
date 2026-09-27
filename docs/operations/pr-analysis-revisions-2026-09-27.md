# PR 분석 revision과 최신 상태 확인 — 2026-09-27

## 확인한 원인

`analysis_runs.revision`은 snapshot 안에서 재분석하는 순서였다. 새 push가
새 snapshot을 만들면 기본값 1로 다시 시작했다. PR #1084에는 서로 다른
head `ff2ef1b74e24`, `bcb97e497381`, `ef58f1174afc`의 공동 분석이 이미
저장돼 있었으나 화면은 모두 Revision 1로 표시했다. revision 버튼에는
선택 동작도 없었다.

목록의 분석 링크는 `/reviews/<analysisId>`에 고정됐고 완료 화면은 새
분석 이력을 조회하지 않았다. 12:01 UTC의 새 head 분석은 자동으로
시작됐지만 이전 결과를 열어 둔 화면에서는 이를 확인할 수 없었다.
점검 중 다음 head `2ec999686595`의 공동 분석도 자동으로 대기열에 들어왔다.
이 작업에서 운영 분석을 추가 요청하거나 모델을 직접 호출하지 않았다.

종료된 PR의 상태는 등록된 두 GitHub repository의 실제 Open 목록과
DB 목록을 읽기 전용으로 대조했다. backend Open #1084·#1059,
helm Open #242·#245·#217이 일치했고 상태 불일치는 없었다. 기본 Open
화면에도 이 5건만 표시됐다. Closed/Merged 1,271건은 Closed·All 이력에
남겨야 한다. 당시 화면과 API에는 주기적인 목록 갱신이 없었다.

## 변경

- migration `0060_pull_analysis_revisions.sql`이 PR별 `pull_revision`과
  영구 counter를 추가한다. 기존 보관 중인 분석에 생성 순서대로 번호를
  부여하고 원래 `revision`, 분석 ID, snapshot, 보고서·artifact는 유지한다.
  이미 retention으로 삭제된 과거 실행까지 복원하는 번호는 아니다.
- 새 push, 같은 snapshot의 명시적 재분석·재개가 새 분석 실행을 만들면
  번호가 증가한다. 중복 `analysis_key`의 충돌 처리나 worker 재시도는
  번호를 증가시키지 않는다. 분석이 실패해도 실행 이력은 남는다.
- PR와 공동/개인 소유자 범위마다 counter를 분리한다. 다른 사용자의
  개인 분석은 공동 번호를 변경하지 않고 목록에도 노출되지 않는다.
  기존 관리자 직접 조회 정책은 변경하지 않는다. retention으로 분석을
  삭제해도 counter를 줄이거나 번호를 재사용하지 않는다.
- 이력·상태 API에 선택 필드 `pullRevision`, `revisionScope`를 추가한다.
  이력은 생성 시각·ID 순으로 cursor pagination을 제공한다. 기존 20건
  제한 때문에 과거 분석 URL이 열리지 않던 문제도 해소한다.
- 기존 native select와 리뷰 toolbar를 재사용해 revision·head SHA·분석
  상태를 선택지로 표시한다. 개인 분석에는 `개인 Revision`을 표시한다.
  과거 결과에서 최신 결과로 이동하는 링크를 제공한다. 보고서와 대화
  문맥은 사용자가 선택한 분석에 유지하고 새 결과로 임의 전환하지 않는다.
- PR 목록 링크는 PR 주소로 이동해 그 시점의 최신 분석을 연다. 목록과
  분석 이력은 보이는 탭에서 30초마다, 탭 복귀 시 읽기 전용으로 갱신한다.
  요청은 겹치지 않고 페이지 이탈 시 취소한다. 갱신 실패는 표시하며
  목록의 직전 결과를 보존한다. API 갱신 자체는 GitHub polling이나
  분석을 새로 요청하지 않는다. repository polling 간격도 그대로다.
- 기존 분석 요청 아이콘은 `최신 코드로 분석 요청`으로 명명해 목록의
  읽기 전용 새로고침과 구분한다. Chat의 head 표시는 현재 PR head 대신
  선택한 분석 head를 사용한다.

Reference는 운영 GCR의 기존 Worklist, ReviewWorkspace toolbar와 모델
선택 native select다. `reference-led-frontend`, `frontend-development`
지침에 따라 기존 URL·상태·권한 계약과 컴포넌트를 재사용했다.

## 검증

실제 disposable PostgreSQL을 사용한 migration/API·PR 상태 회귀와
frontend API·select·취소·visible polling 검사 25건, 기존 worker·분석·
DB 장애 복구·게시 경로 회귀 20건, 총 45건이 통과했다. 분석 fixture는
합성 입력이며 추가 운영 LLM 호출의 증거로 취급하지 않는다.

전체 build와 workspace typecheck, 변경 파일 ESLint, `git diff --check`가
통과했다. 전체 ESLint는 기존 `codex-isolation.ts`의 `no-unsafe-finally`
1건과 두 기존 검증 script의 unused variable 4건 때문에 실패했다.
해당 파일은 이번 작업에서 변경하지 않았다.

코드 source: `3e4e35be68259486838a967ccdf95b2b85a84b01`.
배포 pin commit: `b5f456a`.

## 배포와 운영 확인

21:34:35 KST에 PRISM-DEV Helm revision **93**, chart **0.10.80**,
app **0.8.0-alpha.84**를 배포했다. 기존 Helm values를 재사용하고
`image.tag`, `image.digest`만 바꿨다. Image는 source commit의 clean
archive에서 빌드하고 직전 승인 runtime base의 Git·tini만 재사용했다.
PRISM-DEV node architecture에 맞춘 `linux/amd64` artifact이며 이번
release에 새 arm64 image는 포함하지 않는다. SBOM·provenance를 포함한다.

- Image index: `sha256:39a27baa0cd99cd69491f1f3f2a982937513d3bd80d0597535ba7d8eb88300ec`
- Linux amd64 manifest: `sha256:674e8656a6b6780fadce8f67fb17d42efa7efcbe174f48c43848b137d442a2ac`
- OCI chart: `sha256:3486b4b43f477cc8ea70622e535957a633f70538332458d32bb8d1313704aaf8`
- 다운로드한 chart 파일 SHA256: `132e0693673456ab7568ac61b410773fa19f57841f77915e5ba9073df52f0eda`

게시 후 실제로 내려받은 image를 network none·read-only·non-root로
검사했다. migration checksum·runtime module·정적 asset과 캐시·경로
접근 경계가 통과했고, 이전 bundle·dependency·build CA·`.env`가
포함되지 않은 것을 확인했다. Registry에서 내려받은 chart도 게시한
파일과 byte 단위로 일치했다. Helm lint·server dry-run을 통과했고
서버·worker rollout과 Helm connection test가 성공했다. Server·worker는
각각 Ready 1/1, 기존 identity는 이미지 변경 없이 Ready 2/2다.

운영 DB에서 migration checksum과 app role의 counter 읽기·쓰기 권한을
확인했다. 보관 중인 기존 분석 312건의 ID·snapshot ID·analysis key·원래
revision·생성 시각은 모두 같고, 기존 artifact 13,092건의 ID·checksum·
locator·version도 같다. 운영 중인 기존 분석이 artifact 29건을 추가했다.
사용자·로컬 password credential·모델 목록·계정 assignment·분석 provider·
prompt·repository grant 설정의 비교 hash가 같다. Secret·ConfigMap·PVC
21건의 UID와 data/spec도 같다. 대형 PR 호출 한도 512회, worker 동시성
2, repository polling·계정·데이터·사용자 설정을 보존했다.

로그인된 실제 브라우저에서 다음을 확인했다.

- PR 목록의 Open은 당시 새로 수집된 #1087을 포함한 6건이며 모든 표시
  항목이 Open이었다. Closed 1,271건은 기본 목록에서 제외됐다.
- #1084 PR 주소는 최신 공동 Revision 4(`2ec99968`)를 열었다. 공동
  Revision 1~4와 현재 사용자의 개인 Revision 1이 모두 선택지에 표시됐다.
- Revision 1을 선택하면 기존 분석 URL과 해당 결과가 열리고, 최신
  Revision 4 링크를 선택하면 새 결과로 돌아갔다. Chat도 R4와 해당
  snapshot head에 고정돼 표시됐다.
- 모든 기존 결과의 `partial` 표시는 `일부 검토`로 유지됐다. 이 작업은
  해당 분석의 coverage를 확대하거나 정상 완료로 바꾸지 않았다.

데스크톱 DOM·접근 가능한 이름·선택 상태·메뉴 너비·page overflow를
검증했다. Screenshot capture는 브라우저 도구 timeout으로 확보하지
못했고 모바일 viewport·실제 키보드 조작은 별도로 검증하지 않았다.
합성 polling/취소 검사와 운영 화면 조회를 구분한다. 추가 운영 모델
시험 호출·수동 분석 요청·GitHub 댓글 게시 요청은 0회다. 배포가 기존
자동 분석·게시 동작을 중단하지는 않았다.

집계 증거는 [pr-analysis-revisions-2026-09-27.json](evidence/pr-analysis-revisions-2026-09-27.json)에
저장한다. 시험용 Helm Pod는 삭제했다. 원문 비교 자료·빌드 CA·임시
archive는 제한된 권한의 임시 디렉터리에 두고 작업 종료 시 제거한다.

## 사용

PR 목록의 Open에서 진행 중인 PR을 열고 우측 상단의 `분석 revision
선택` 메뉴로 결과를 이동한다. SHA와 상태가 함께 표시되므로 같은 코드의
재분석과 새 push 분석을 구분할 수 있다. 과거 결과를 열어 둔 동안 새
분석이 생기면 `최신 Revision … 보기` 링크를 선택한다. 이력 조회와
revision 선택은 모델 호출을 요청하지 않는다.

새 push 감지는 기존 repository polling을 따른다. 종료·병합 이력은
Closed·All에서 열 수 있고 Open에서는 제외한다. 배포 전에 열린 브라우저는
기존 bundle을 유지하므로 사용자가 페이지를 새로 열거나 reload해야 한다.

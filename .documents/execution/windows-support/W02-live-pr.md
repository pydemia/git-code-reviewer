# W02 추가 검증: 실제 GitHub 테스트 PR과 로컬 GCR

상태: 완료. 2026-09-16 사용자가 접근할 수 없는 #917/#915 대신 로컬
GCR과 pydemia/commit-defender의 새 PR로 검증하도록 변경했고 검증용
리뷰 댓글·답글 게시도 허용했다. PR #3의 실제 원문 수집부터 활성 지침,
Windows pulling, 실제 모델의 세 판단과 저장 결과 재조회까지 확인했다.
기존 PRISM #917/#915 원자료를 검증한 것으로 표시하지 않는다.

## 호출 전에 기록한 대상과 기대 결과

- PR: https://github.com/pydemia/commit-defender/pull/3
- draft 상태를 유지하며 merge하지 않았다.
- 검증 시 base: codex/windows-native-support,
  df7fc59ea64d17e85829327004f66807ef9e7504
- 고정 head: codex/w02-github-history-test,
  2aca9bbc54e811f0d7d8d0c966148d85fff1636a
- 변경 경로: vscode-extension/test/fixtures/w02-history/의 7개 파일.
  G04 fixture를 재사용했으며 사용자 제품 코드에 결함을 넣지 않았다.

기존 재구성 자료의 최초 3회와 구분해 추가 한도 3회, 각 최대 240초를
[호출 전 계획](evidence/W02-live-pr-call-plan.json)에 기록했다.
기존 기본 Codex 계정의 gpt-5.6-luna/high를 사용했고 모델 대체는 없었다.
무관 사례의 응답 검증 실패 후 추가 1회·240초를 별도 기록해 재검증했다.

| 사례 | 고정 source/base 조건 | 기대 결과 |
| --- | --- | --- |
| defect | 정상 model validator를 호출되지 않는 별도 함수로 이동 | 두 model_validate 경로의 reference_id 누락·null 허용을 지적하고 과거 지침을 적용 |
| fixed | model validator 복원 | 지침 충족을 설명하고 해결된 결함을 반복 지적하지 않음 |
| unrelated | 정상 요청 검증을 유지하고 저장된 archived 상태를 service에서 거부 | DB 상태 검증을 요청 값 지침에서 제외하는 이유를 설명 |

schema.py, service.py, api.py, repository.py, pyproject.toml과 경계값 테스트를
고정했다. 누락·명시적 null·양수 reference_id, 두 service/API 호출부,
repository의 저장 상태 동작을 포함한다. 각 실행 근거에 모델 호출 전에
기록한 Git base/tree SHA와 파일별 source/base SHA256이 있다.
pytest는 실행하지 않았다. 테스트 source를 읽은 것을 실행으로 집계하지 않는다.

## 실제 원문·본문 버전·활성 지침 대조

Windows Node에서 GCR의 실제 인증·credential 발급·history collection·
guidance publication·reader 라우트를 기동했다. 기존 Git credential은
메모리에서만 사용했다. GitHub collector는 실제 API에 읽기 요청을 보냈다.
댓글·답글 게시는 사용자가 승인한 별도 GitHub 연결 도구로 수행했다.
수집·지침 활성화는 로컬 관리자의 명시적 조작이며 자동 수집을 등록하지 않았다.

초판 댓글을 실제 수집한 뒤 같은 댓글을 수정하고 답글을 게시해 다시
수집했다. GCR 응답의 원문·답글·관계·본문 hash를 별도로 다시 조회한
GitHub 응답과 대조했다. 재구성한 history나 합성 reader 응답을 쓰지 않았다.

| 항목 | 실제 응답의 값 |
| --- | --- |
| 원문 GitHub ID | 4022589067 |
| GCR source ID | d04489d1-9a82-49ad-ae11-52e605d4ee0e |
| 원문 URL | https://github.com/pydemia/commit-defender/pull/3#discussion_r4022589067 |
| 현재 본문 SHA256 | 4bff080a8b3250f0ec7a084c9cd94c84a38fad33afe57af3f87102713c6b7084 |
| 관찰 hash | 37c2918dd85844a3b5e52018816baae9ca576bc43721abcb2162bd4ee68d6c0e |
| 답글 GitHub ID / GCR ID | 4022595630 / 49768448-b77c-40d6-9cfe-114a178ebc83 |
| 답글 URL | https://github.com/pydemia/commit-defender/pull/3#discussion_r4022595630 |
| 답글 본문 SHA256 | 94870a7a0fb5c2037b04faeebe5a32684c77269f58a43844a59349ac101f15af |
| 활성 guidance ID | 4b0f4c10-f4ca-4d1c-b064-e8c673256169 |
| guidance revision / state | 1 / active |
| guidance canonical content SHA256 | 0fd783fcb03543546e29181d1405f92851e550a5a17650864dd5dd2765d23a5f |

본문 버전은 아래 두 건이다. 최신 guidance의 sourceContentHash는 현재
본문 hash와 일치했다. body-version ID와 각 관찰 시각도 실행 근거에 남겼다.

- 2026-09-16T04:49:47.000Z: 4bff080a8b3250f0ec7a084c9cd94c84a38fad33afe57af3f87102713c6b7084
- 2026-09-16T04:48:44.000Z: 683e732c2e8bfa05f89b130b3e7195eefd9e3bfd05a09ceec26d8e44ba88bb3a

온라인 응답과 암호화 cache의 재조회가 일치했다. manifest 온라인 수명은
정확히 300초, signed offline lease는 3600초였다. 각 리뷰는 유효 lease와
source·observation·guidance revision을 고정한 뒤 시작했다. 세 사례의
policy/collective/personal bundle ID·release·hash도 동일하다. 유효기간을
늘리거나 만료 cache를 재사용하지 않았다.

## 실제 Windows Extension Host 결과

| 사례 | Host 측 리뷰 시간 | 결함 수 | 실제 모델 응답의 판단 |
| --- | ---: | ---: | --- |
| defect | 114.638초 | 1 | P2 1건. 미호출 validator와 두 model_validate 호출 경로를 확인하고 과거 지침을 적용 |
| fixed | 108.556초 | 0 | 지침 충족을 설명하고 해결된 결함을 반복 지적하지 않음 |
| unrelated | 179.013초 | 0 | DB 상태 검사를 요청 값 지침의 대상에서 제외한 이유를 설명 |

위 세 건은 completed이며 timeout·partial은 0건이다. 무관 사례의 첫
시도는 99.700초에 invalid-output (unknown-read-id)로 실패했다. 모델이
이번 실행에서 발급되지 않은 readId를 응답에 넣어 기존 검증기가 거부했다.
원문 stream을 보관하지 않아 정확히 어느 ID/필드인지까지는 확인할 수 없다.
CLI 종료 코드 0과 reviewCompletionConfirmed=true가 있어도 report.status가
failed이므로 완료로 인정하지 않았다.

제품·harness 변경은 없었다. 기존 거부 동작의 회귀 1건 통과·28건 선택 제외를
확인하고 [추가 호출 계획](evidence/W02-live-pr-retry-plan.json)에 원인,
수정 없음의 이유, 고정 문맥, 무관 사례 1회·240초를 먼저 기록했다.
동일한 검증 규칙과 문맥으로 수행한 두 번째 시도를 위 결과에 포함했다.
[실패 근거](evidence/W02-live-pr-unrelated-failed-attempt1.json)는 보존했다.

새 실제 모델 호출은 총 4회, 완료 3회·실패 1회다. 앞선 재구성 자료의
실제 3회와 합치면 W02 전체 계정 리뷰는 7회다. 합성 검사와 loopback
probe는 이 수에 넣지 않는다. 자동 재시도는 하지 않았다.

모델이 직접 작성한 summary·file summary·finding을 읽고 기대 결과와
대조했다. defect는 현재 source가 답글의 수정 주장을 충족하지 않는다고
설명했다. fixed는 복원된 validator가 두 진입점에서 지침을 충족한다고
판단했다. unrelated는 summary에서 이미 충족됐다고 표현했으며 excluded라는
상태어를 쓰지 않았다. file summary의 DB 상태/service 책임 설명을
새 검사에 요청 값 지침을 적용하지 않는 사유로 평가했다. 구체적인 판단과 인용은
[판단 수용 근거](evidence/W02-live-pr-acceptance.json)에 보존했다.
contextMetadataMatched 및 core가 붙인 reasoning 출처는 문맥 전달 근거로
구분했으며 모델의 실제 판단을 대신하는 증거로 쓰지 않았다.

각 결과를 암호화 저장한 뒤 원래 report와 다시 읽은 report의 일치를
검사했다. 설치 확장의 showHistoryEntry 명령으로 저장 결과를 열었고
source panel의 출처·버전 정보도 확인했다. 개별 근거:
[defect](evidence/W02-live-pr-defect.json),
[fixed](evidence/W02-live-pr-fixed.json),
[unrelated](evidence/W02-live-pr-unrelated.json).

## 통신과 검증 범위

CD → GCR 요청은 총 56회, 전부 GET이며
request body는 0 byte였다. 서버 소유 ID와 cursor/revision을 사용했다.
각 모델 실행 구간의 중앙 요청은 0회였다. source/diff/질문/결과/개인 memory를
GCR에 업로드하지 않았다. 로컬 관리자 API의 credential 발급·collection·
지침 활성화 요청은 CD reader 통신과 구분한다.

provider 경계에서는 실패 시도를 포함해 account-review 4회와 loopback
catalog probe 8회를 별도로 관찰했다. model/high 선택, shell=false,
240초 이하 native timeout과
종료 코드 0을 기록했다. credential·prompt·stdin·응답 stream을 로그에
기록하지 않았다. provider의 네트워크 payload를 packet capture한 것은 아니다.

[서버 근거](evidence/W02-live-pr-server.json)는 실제 GitHub collection과
GCR reader 실행이다. 이전 [합성 HTTPS/오류 검사](evidence/W02-synthetic-host.json),
[로컬 제품 reader 권한·철회·만료 검사](evidence/W02-product-reader.json),
[회귀 검사](evidence/W02-regression.json)와 분리한다. 자료 없음·장애·403·
철회·만료의 실패 처리를 유지했다. 사용자 운영 credential은 철회하지 않았다.

임시 PostgreSQL은 고정 image의 Linux Docker container다. Windows 네이티브
검증 대상은 GCR API, 보안 저장소, 설치된 CD worker와 Extension Host이며
DB container나 WSL 실행을 Windows 검증으로 집계하지 않았다.
검증 Host는 Windows ARM64 / VS Code 1.137.0 / Node 24.18.1이다.
GCR API와 외부 실행기는 Windows ARM64 Node 24.16.0에서 실행했다.
macOS/Linux native 실행과 Windows x64는 이번에 검증하지 않았다.

## source·artifact·설치 적용 상태

- GCR 제품 source: c05dd04ce7227f070baf90d52416cc1d678f48c7
- CD 제품 source: 777d11511869225da39d2ecd5a57b4dfcfb71df7
- GCR 실행 source: a423a77d9123cb345057c9ac9eed27ed04407256
- CD harness source: 4ec39113d085bdaa2ff3d073a01abbe57bcd419e
- client 0.1.0-alpha.48 / native helper 1.0.2 / private service 0.1.0-alpha.37
- VSIX: commit-defender-2.12.3-win32-arm64.vsix
- VSIX SHA256: 107049cf0742eb1d2ae6e865f6d0ef88ab2d58d7fefad853413c3205bc0bd191
- 설치·검증 worker SHA256: 3afc229fdcd4bceb89e94aba4a4802b2e8a4131fa58fc5080413d6dbc2c3e6b2

[artifact 연결](evidence/W02-artifact-linkage.json)에 공통 package 3종,
helper, private service, VSIX와 설치된 파일의 전체 hash를 연결했다.
이번 추가 검증은 test harness·문서만 바꾸었으므로 제품을 재빌드하거나
재설치하지 않았다. 실행 후 제품·검증 코드는 바뀌지 않았다.
문서 전달 SHA는 [최종 원격 대조](evidence/W02-live-pr-delivery.json)에 기록한다.

2.12.3의 로컬 설치와 실제 검증 Host의 worker hash는 확인했다. 이미 열린
사용자 Host의 적용 버전은 미확인이다. 사용자 VS Code를 강제 재로드하지
않았으며 전역 계정·모델·자동 실행 설정과 Codex CLI를 변경하지 않았다.

## 재현과 사용

GCR에서 아래 명령으로 검증 전용 서버를 실행한다. Git OpenSSL 경로는
현재 process PATH에 있어야 한다. 서버는 새 DB·key·reader를 사용하며
기존 사용자 DB를 선택하지 않는다. 실행 상한은 40분이다.

~~~powershell
node apps/runtime/node_modules/tsx/dist/cli.mjs apps/runtime/test/windows-github-reader-server.ts
~~~

서버 stdin의 제어 명령은 collect, activate, status, stop이다.
activate의 sourceGithubId는 실제 조회값을 사용한다. 기존 댓글에 버전이
두 개 있다는 이력은 이번 로컬 DB의 관찰 기록이다. 새 DB로 다시 기동하면
GitHub는 현재 본문만 돌려주므로 본문 두 버전 검증을 그대로 재현할 수 없다.
추가 게시·수정과 실제 모델 호출은 별도 승인·한도 없이 반복하지 않는다.
source 0건을 기대하는 사전 preflight는 현재 PR에 다시 실행하지 않는다.

CD 검증 실행기는 test/run-w02-native-host.mjs이며 W02_LIVE_CONNECTION에
서버가 만든 공개 connection.json, W02_CASE에 사례 이름을 지정한다.
W02_EXTENSION/W02_CODEX/W02_VSCODE에는 위 검증 artifact와 기존 CLI/Host
실행 경로를 지정하고 W02_EVIDENCE에는 덮어쓰지 않을 새 증거 경로를 준다.
W02_RECORDS는 GCR의 .documents/execution/review-memory-pull/evidence다.
reader key는 argv·환경변수·JSON에 넣지 않고 Windows 보안 저장소의 참조로
읽는다. 상세 호출 전 조건과 파일 고정 방식은 계획·개별 근거를 따른다.

일반 사용자는 확장을 다시 활성화한 뒤 Commit Defender: Central Review
Connection에서 신뢰할 수 있는 연결 JSON과 signing-key fingerprint를
확인하고 password 입력으로 reader key를 저장한다. Connection status,
Synchronize knowledge, Browse PR review history로 연결과 자료를 확인한다.
Analyze Staged Files 또는 Analyze Current File로 수동 리뷰하고 History에서
저장 결과와 출처를 다시 연다. signed offline knowledge는 유효 lease에서만
사용한다. 시험 서버는 종료했으므로 시험 connection은 운영 연결로 재사용하지 않는다.

## 정리와 완료 판정

실패 시도를 포함한 네 임시 Host/profile/cache/key와 모델 후손 process를
정리했다. 서버 종료 시
검증용 reader만 철회하고 OS credential, 임시 DB container·volume, session과
TLS/서명 key를 정리했다. 기존 사용자 데이터·운영 계정·container는 보존했다.
설정·CLI hash와 auth 파일 hard link 수는
[최종 보존 검사](evidence/W02-live-pr-preservation.json)에 기록했다.

중단된 합성 검사의 gcr-central-cache-MSFkld 삭제는 자동 승인 검토에서
두 차례 차단됐다. 사용자가 직접 삭제했다고 알려준 뒤 해당 정확한 경로가
없음을 확인했다. 우회 삭제는 수행하지 않았다.

W02-C01~C04를 사용자가 승인한 PR #3 대체 범위에서 충족했다.
[완료 감사](evidence/W02-completion-audit.json)에 기존 blocked 이력과
변경된 범위의 실제 근거를 함께 남긴다. 원래 PRISM #917/#915 검증은
수행하지 않았고 그 원문을 복원했다고 주장하지 않는다. W03/W04, 자동
service/hook 이식, 새로운 중앙 업로드, 서버 모델 대행, P11, 신규 provider,
PRISM-DEV 배포·운영 설정 변경과 Marketplace 게시는 시작하지 않았다.

# PRISM-DEV 분석 모델·병렬 처리 배포

2026-09-09 11:09:36 KST에 application `0.8.0-alpha.27`, chart `0.10.26`을 Helm revision **38**로 배포했다. Account·Model·Effort 선택과 파일 병렬 수 1~4개 설정을 제공한다. 새 설정의 기본값은 사용자가 지정한 4개다. 구현은 [병렬 분석 문서](parallel-analysis.md)를 참고한다.

## 현재 적용값과 남은 작업

운영 활성 Provider는 v4 `gpt-5.6-luna / medium`이며 **병렬 수는 아직 1개**다. 작업 도중 다른 Admin 조작으로 account 세 개와 Provider v2~v4가 추가됐다. 배포 직전 최신 선택을 다시 읽어 보존했으며 기존 sol 설정으로 되돌리지 않았다. Migration은 기존 version의 동작과 hash를 유지하기 위해 concurrency 1을 부여한다.

4개 활성화는 완료하지 못했다. 로그인된 Browser의 제어 연결이 `Debugger unattached` 및 Computer Use 권한 대기 상태였고, 배포 초기 관리자 credential을 사용한 정식 Local login은 HTTP 401로 거부됐다. 첫 API 요청의 Origin 누락 403은 요청 header를 바로잡았으며 이후 credential 실패는 반복 시도하지 않았다. 비밀번호 초기화·session 위조·DB Provider 직접 변경은 수행하지 않았다.

현재 로그인한 관리자가 **설정 → 분석 모델 → 파일 병렬 처리 수 `4개 · 병렬 처리` → 새 버전 저장 및 활성화**를 실행해야 한다. Account·Model·Effort는 원하는 현재 선택을 유지하면 된다. 이때 새로 생성되는 분석부터 4개 설정을 고정하며 이전 분석·report는 유지한다. 활성 Provider를 재조회해 concurrency 4를 확인하는 것이 남은 완료 조건이다.

## Release

| 항목 | 값 |
| --- | --- |
| Backend commit | `4c19a77` |
| UI·가이드·검증 source commit | `2bfadea9f7ce8bdc14eefdae2f2864cbcf665ae4` |
| Release pin commit | `b1adbaf` |
| Image index | `sha256:3c7863811cd6a21d050436a8c140619448843f2ef5022fc49d102f8181f93216` |
| Linux/amd64 manifest | `sha256:3831094dc67f45b39ec58ea0c017b0a04bb7a001754e5f5ae54385743056f5eb` |
| OCI chart | `sha256:23a11a85963bc4ab1f49d62b276607cd56903018b782cf9b8d914b61e73738aa` |

모든 기능·release commit을 push한 뒤 배포했다. Image는 source commit의 `git archive`를 사용했으며 SPDX SBOM·SLSA provenance v1을 함께 게시했다. Network-none·read-only Container에서 UID 1000, migration 30개, 병렬 함수와 현재 bundle을 확인했다. Build CA는 secret mount이며 실행 image에 해당 secret 파일은 없다.

기존 Helm values에 image tag·digest만 덮어써 `--atomic --wait`로 upgrade했다. Helm lint·server-side dry-run·upgrade 및 11:10:24–26 KST Helm connection test가 성공했다. 새 Server `git-code-reviewer-server-5746bb5565-qxflr`는 1/1, Worker `git-code-reviewer-worker-85b55879bd-54bcj`는 2/2 Ready이며 restart는 0회다. 이전 alpha.26 Worker는 Worker container 종료 후 source-sandbox의 기존 종료 유예로 1/2 Terminating이며 강제 삭제하지 않았다.

## 검증

- 전체 446 tests / 73 files, skip 없음. TypeScript·ESLint·production build 통과. 최종 실행 환경과 초기 timeout·시간 의존 테스트 수정은 [구현 검증](parallel-analysis.md#구현-검증)에 기록했다.
- 실제 HTTPRoute의 live·ready·startup·dependencies가 HTTP 200·ok다. `/api/v1/system`은 alpha.27·Local auth를 반환한다. 비로그인 Admin Provider API는 기존 정책대로 404다.
- DB migration 30개 checksum이 image의 SQL과 전부 일치한다. 기존 Provider v1~v4의 model·effort·hash를 유지하고 concurrency는 모두 1이다.
- Local 합성 Browser의 Desktop·Mobile에서 저장·재조회·모델별 Effort·이전 version 재활성화를 확인했다. Impeccable 독립 검토는 `ship`이며 기존 Admin 디자인을 유지했다. 운영 Browser의 새 화면 조작·저장 검증은 권한 문제로 미완료다.

현재 HTTPRoute에서 제공하는 asset과 image의 hash가 일치한다.

| Asset | SHA-256 |
| --- | --- |
| `/assets/index-Ckmsukmc.js` | `18088e4eeb1c93dfcfbb27ceecd0954287c5b551c4dec73d6a3c3d44bd23a04b` |
| `/assets/index-DRMrbQKi.css` | `cc3f6c80306c7684336bb057cca296a65d6d74f413e2f23db63f580f83c3132d` |

## 실제 모델 동시 요청

11:11:57–59 KST에 현재 등록 account의 `gpt-5.6-luna / medium`으로 `Reply with OK.` 요청 네 개를 실행했다. 운영 Provider를 변경하지 않고 진단 실행에만 concurrency 4, 누적 모델 예산 4회를 지정했다. 등록 account의 원래 credential·refresh·admission 경로를 사용했으며 PR source·개인 Prompt·Memory를 전송하지 않았다.

진단 run key는 `diagnostic:parallel:184c151f-327a-4d5d-a9ab-64094a9493f1`이다. Batch ledger 네 개가 모두 completed이고 동시 활성 peak는 4개, 응답 네 개 모두 비어 있지 않았다. 전체 소요 시간은 1,808ms다. 짧은 연결 요청의 결과이며 실제 PR 분석 속도나 4배 개선을 뜻하지 않는다. 이 검증으로 운영 Provider의 활성화가 완료된 것도 아니다.

새 analysis run·report·GitHub 댓글/게시 job은 만들지 않았다. 실제 PR 전체 분석의 속도 비교는 4개 설정 활성화 후 별도의 사용자 승인된 재분석 또는 새 PR에서 수행한다.

## 보존·정리

배포 직전/후 사용자 7명, Chat account 7개, analysis 67개, report 59개의 ID 집합이 일치한다. Report row 전체 SHA-256은 양쪽 모두 `c994bfe2f96c7ed7753a6cbaf72cb1abcbf3935e349e932bccbbd0b34be609d7`다. 최초 작업 중 실행되던 분석 한 건은 배포 전에 정상 완료됐다. 배포 직전과 모델 진단 후 조회에서 실행·대기 job은 0건이다.

11:15 후속 점검에서는 별도 운영 workflow가 analysis `be6d82c4-ed00-43bd-bca0-45d57abe91f9` 한 건을 11:12:51–11:15:10에 완료하고 기존 publication 정책에 따라 게시했다. 총 analysis는 68개, report는 60개로 늘었다. 배포 전 report 59개만 다시 계산한 hash는 여전히 동일하다. 이 workflow는 네 번의 연결 진단과 별개이며 검증 스크립트가 생성한 PR 재분석·게시가 아니다.

Image 외 Helm values hash는 `5f3eb1ed55f94d7ce9048eb9ef17e4b92400f3533ed9c8a5da1823ef66bb05c9`로 동일하다. Auth·credential registry·PostgreSQL Secret, corporate CA, HTTPRoute의 UID·resourceVersion을 유지했다. 두 PVC의 UID·PV·nfs-csi·10Gi·access mode를 보존했다. Artifact PVC의 resourceVersion은 Helm metadata 갱신으로 바뀌었으며 삭제·재생성하지 않았다.

검증용 Local server·Browser와 전용 PostgreSQL Container/합성 DB는 정리했다. 사용자 소유의 다른 Container·repository 파일·운영 데이터를 삭제하지 않았다. 운영 Browser 검증용 탭은 제어 권한 문제로 닫지 못했다.

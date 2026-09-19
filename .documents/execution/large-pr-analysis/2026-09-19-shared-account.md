# 공유 계정 사용량과 #1024 미완료 원인 보정

## 확인한 원인

#1024 analysis `841560c1-98a2-417c-84f7-21a2d4330e93`는 실제 공급자의 HTTP 429 `usage_limit_reached`로 중단됐다. 공급자가 알려준 재개 시각은 **2026-09-19 19:32:02 KST**다. 512회 소프트웨어 상한도, 실제 경과 시간 3시간도 소진하지 않았다. 요청 102회는 HTTP 완료 93회·실패 8회·중단 1회이며 검증된 작업은 92개다.

1,045파일 중 336개를 검토했고 707개는 미완료, 2개는 정책상 제외다. 일반 묶음 88개는 완료됐지만 경계 작업 321개 중 317개가 남았다. 한 파일은 담당 일반·경계 작업이 모두 검증되어야 완료된다. 파일 목록 누락으로 생긴 미완료가 아니다. 이미 채택된 의견 140개와 원래 보고서를 보존한다.

저장된 `MODEL_TIME_BUDGET_EXHAUSTED`는 당시 cooldown이 실행 deadline보다 늦다는 코드 분기에서 발생했다. 실제 사용량 제한 원인을 시간 예산 오류로 뭉뚱그린 결함이다. 이전 report/task를 다시 쓰지 않고 별도 HTTP ledger 근거를 읽어 원인과 재개 시각을 표시한다.

성공 요청 93회의 시작부터 종료까지 1,326초, 응답 중앙값 35.14초, 95백분위 53.35초였다. 1분 이동 구간의 최고 요청 수는 8회, 입력 합계는 704,380 bytes였다. 이 값은 GCR ledger 관측치이며 계정 전체 사용량이나 token 과금량이 아니다.

## 적용 기준

| 구분 | 새 기준 |
| --- | --- |
| 대형 분석 실행별 최대 호출 | **128회**; 재시작 시 누적 유지 |
| 실행별 시간 예산 | 3시간 유지 |
| 동일 계정의 분석 동시 요청 | 최대 2개, 등록 provider 상한이 더 작으면 그 값 적용 |
| 대화 동시 요청 | 별도 1개 유지 |
| 분석 admission | 모든 lane의 최근 1분 예약을 합산해 30회·512KiB 이내에서만 승인 |
| 대화 포함 계정 admission | 기존 60회·1MiB/분 유지 |
| 공급자 usage limit | 계정 공통 cooldown 보존, 해당 분석을 partial로 저장하고 명시적 재개 대기 |
| 일시적인 rate limit/5xx | 기존 backoff·내구성 대기·완료 작업 재사용 유지 |

분석이 분당 예산 절반을 다 써도 대화용 요청·입력량 여유가 남도록 한다. 여러 분석이나 같은 계정의 다른 모델을 합산하고 실패 예약도 소비량에 포함한다. 512KiB를 넘는 단일 분석 요청은 불가능한 입장을 계속 기다리지 않고 입력 예산 오류로 종료한다. 기존 묶음 입력은 이 값보다 작다.

이 수치는 **GCR 내부 보호 정책**이다. ChatGPT 계정의 5시간·주간 token 잔여량 중 50%를 보장한다는 뜻이 아니다. 외부 Codex 앱·CLI가 같은 계정으로 보내는 요청과 실제 잔여 사용량은 현재 GCR ledger에 보이지 않는다. 외부 앱과 한도 충돌이 절대 없다고 보장하지 않는다. 공급자의 reset/Retry-After를 줄이거나 다른 계정으로 우회하지 않는다.

128/256은 실행 총량이며 응답 속도나 동시성을 바꾸지 않는다. 현재 장애가 102회에서 발생했으므로 256 증액은 원인 해결이 아니다. 기본값은 128로 되돌린다. 향후 계정 여유를 별도로 확인했고 128~256회 범위의 남은 작업을 한 실행에서 처리할 필요가 있을 때만 Helm `model.analysis.groupMaxModelCalls=256`을 선택할 수 있다. 이때도 공유 계정의 동시성·분당 제한은 그대로다. 317개 남은 작업은 재사용 가능한 입력이 유지되고 추가 실패가 없더라도 128회 단위로 최소 3번의 후속 실행이 필요하다. 재개를 자동으로 반복해 무제한 예산을 만들지 않는다.

## 수정 내용

- `usage_limit_reached`를 `MODEL_USAGE_LIMIT_REACHED`로 구분하고 남은 작업의 `retry_at`에 재개 시각을 남긴다. 완료 묶음을 보존하며 뒤따르는 source 준비·요약 호출을 중단한다.
- 제한이 진행 중인 보고서의 재개 버튼을 비활성화하고 API도 429와 재개 시각을 반환한다. 권한·현재 PR head·개인 분석 소유권·중복 재개 방지는 유지한다. UI의 제한 상태는 30초 간격으로 갱신한다.
- partial + P3 보고서는 `일부 검토 · BLOCKED`로 표시한다. 기존 P3 판정과 보고서 원문은 바꾸지 않는다.
- 오래된 보고서 화면의 시간은 DB의 시작/종료 시각으로 계산한다. 마지막 Worker 시도만 잰 39초 대신 실제 대기·복구를 포함한 55분 28초를 보여 준다. 새 보고서도 실행 전체 시간을 기록한다. 기존 artifact JSON은 보존한다.
- `read_file`이 `path_not_present_in_revision`을 정상 응답한 경우 source 장애로 취급하지 않는다. #1024의 추가 파일은 1,005개이며 base 부재는 정상이다. 기존 원본 artifact 478개가 저장되어 있다. 실제 읽기·검증 실패 경고는 유지한다. 저장된 과거의 일반적인 경고를 소급 삭제하지 않는다.
- 기존 상태 영역과 command button을 재사용했다. `reference-led-frontend` 및 agent-skills `origin/feat/frontend-ui-workflow-20260917:skills/frontend-development/SKILL.md`를 적용했으며 화면 구조나 디자인을 새로 만들지 않았다.

## 검증

- 격리 PostgreSQL + 합성 transport 50건: 계정별 원자적 슬롯/분당 예산, 여러 실행 경합, 대화용 여유, lease·cooldown, 기존 누적 128회 예산, 실제 quota와 deadline 구분, 완료 묶음 재사용.
- 후속 runtime/account/config 회귀 47건: 새 제한 metadata와 재개 차단·해제, 기존 report 보존, 원래 권한 경계, 전체 경과 시간의 API 표시 포함. 앞 검사와 중복되므로 합산하지 않는다.
- source context/Git read 회귀 18건: 정상적인 revision 파일 부재와 실제 오류 구분, pinned base/head·경로 제한·격리 경계.
- Chrome UI 5건과 report 표시 1건: 1360px/420px, 키보드·reader 권한·실패 표시·quota 사유·재개 비활성화, partial/P3 표시. 최초 report assertion은 변경된 표시와 맞지 않아 실패했고 기대값을 보정한 뒤 해당 검사를 다시 통과했다.
- packages/runtime/web build 및 runtime/web typecheck 통과. 변경 파일 ESLint 통과. 전체 lint는 변경하지 않은 `packages/client-executors/src/codex-isolation.ts`의 `no-unsafe-finally` 1건과 `scripts/verify-codex-catalog.mjs`, `scripts/verify-windows-codex.mjs`의 미사용 변수 4건으로 실패했다. 기존 Rollup annotation/bundle 크기 경고도 유지된다.
- 첫 SQL migration 검사는 PL/pgSQL CASE 비교식의 괄호 누락으로 실패했다. 수정 후 위 격리 DB 검사에서 migration과 예약 함수를 검증했다. 이 실패를 통과로 계산하지 않았다.
- 이번 수정 검증의 실제 모델 호출은 **0회**다. 기존 실제 429 증거와 이번 합성 오류 주입을 구분한다.

## 배포 확인

- 제품 수정: `1f68392`; image source: `bca9f1540c835b6ce4b0b1a9201ba4e46b9aa086`.
- Chart 이미지 pin: `d06742d`; PRISM-DEV 값: `dd3d541`.
- App `0.8.0-alpha.74`, chart `0.10.71`.
- Image digest: `sha256:91968505ae113c99248621c8ae1ec8239932751c51ea060150d03ef8d8cbdd0f`.
- Chart OCI digest: `sha256:f6443de24143b887e0f016093e42bcd96cb253845ce14e3d91eaeb278bf10112`.

처음 만든 chart 0.10.70은 기존 기본 values의 오래된 image digest가 남아 있음을 확인해 배포하지 않았다. digest를 alpha.74로 고정한 0.10.71을 새로 발행했다. alpha.74 제품 이미지는 한 번만 빌드했고 두 번째 chart 준비에는 재빌드하지 않았다.

Helm revision **83**, server·worker·source-sandbox가 alpha.74 digest로 Ready이며 새 container restart는 0이다. 구 worker는 정상 종료 중이며 강제 삭제하지 않았다. PostgreSQL은 기존 1Gi limit과 TLSv1.3를 유지하고 restart 0이다. chart package SHA256은 `2ca31b6b52bdeb80096dd427e6e3b4fa884c94b7d2f2431203b7d8bd3bfda5d0`이다.

- 기존 57개 migration 행/checksum은 동일하고 0058만 추가됐다. 기존 데이터·설정 12개 테이블의 전체 행 hash가 배포 전후 같다. 새 #1024 보고서도 비교에 포함했다.
- Helm user values는 image tag/digest와 `model.analysis.groupMaxModelCalls=128` 외 모두 같다. 계정·provider·모델·DB 자원·인증·HTTP/HTTPS 설정을 유지했다.
- 실제 HTTP·HTTPS 로그인, alpha.74 version, 128회 추가 예산, 원래 #1024 보고서 26/1,045·finding 25개·표시 파일 16개, logout 뒤 401을 확인했다.
- 새 #1024의 실제 Chrome 화면은 `일부 검토 · BLOCKED`, 92/409 묶음, 336/1,045 파일, 32%, finding 140개, 55분 28초를 표시한다. `MODEL_USAGE_LIMIT_REACHED`와 오늘 19:32 재개 시각을 API에서 읽고 재개 버튼이 비활성화됐음을 확인했다. page error는 없다.
- 운영 smoke의 최초 시도는 이전 기대값 512가 남아 128 비교에서 실패했다. 기대값을 새 정책에 맞춘 뒤 HTTP/HTTPS·보고서 검사를 통과했다. 모든 시도의 세션은 finally에서 로그아웃했다.
- 운영 화면 검사는 API 읽기만 허용하고 자동 chat-session POST를 차단했다. screenshot의 chat 403은 이 시험 차단 응답이며 로그인이나 운영 chat 장애 증거가 아니다. 실제 모델과 외부 PR 댓글 호출은 없었다.

요청 ledger는 여전히 완료 93·실패 8·중단 1로 동일하고 진행 중 분석은 0개다. **707개 파일의 남은 검토가 완료된 것은 아니다.** 공급자 재개 시각 이후 권한이 있는 사용자가 같은 화면의 `남은 검토 재개`를 눌러야 다음 제한된 실행을 시작한다. 계정·현재 PR head·고정 문맥의 유효성을 다시 확인하며 원래 완료 결과는 유지한다.

안전한 집계 근거는 [검증 JSON](2026-09-19-shared-account-evidence.json)에 기록했다. 원본 코드가 보이는 screenshot과 원문 artifact는 Git에 추가하지 않았다.

Helm 연결 시험은 Succeeded이며 시험 pod를 제거했다. 임시 registry 설정·Helm values 디렉터리와 위치 포인터를 삭제했고 브라우저와 로그인 세션을 정리했다. 전역 Docker credential 설정은 바꾸지 않았다.

# Interactive Review Chat 검증 기록

이 기록은 실제 운영 검증과 fixture 기반 회귀 테스트를 구분한다. 최종 릴리스 정보는 [PRISM-DEV 배포 기록](../deploy/environments/prism-dev/README.md)에 있다.

## 구현 범위

| Phase | 반영 내용 | 남긴 범위 |
| --- | --- | --- |
| P0 | run·question·source 계약, additive migration, session별 활성 run과 idempotency, fenced lease, feature flag | workspace 자체의 별도 DB lease는 없음 |
| P1 | 등록 origin의 exact SHA fetch, base·merge-base·head 파일 트리, 7개 읽기 도구, SHA/blob/line 근거, macOS·Linux sandbox, 자동 분석 추가 context | 기존 snapshot diff materializer 유지, 문자열 기반 관련 코드 검색, fetch 중 hard disk quota·공용 mirror 없음 |
| P2 | 등록 ChatGPT account, 실제 tool/delta/usage 파싱, 계정 공통 admission, 영속 호출 예산, 429 cooldown·refresh lock·취소 | token 대신 요청 수·input byte 제한, 장기 대화 압축 없음 |
| P3 | 비동기 run API·Worker, checkpoint, 사용자 질문과 응답 후 재개, 추가 지시·중단·권한 재검사, 집단 우선 메모리 | shell·코드 수정·테스트 실행 권한 없음 |
| P4 | 실제 streaming·도구 timeline·질문 카드·상태 표시, SSE replay와 polling, 최신 run 복구, 메인 코드 근거 탭 | 과거 모든 run의 source 탭 복원, 잠긴 Mac의 실제 desktop/mobile 조작 검증은 미완료 |
| P5 | Compose·VS Code·Helm, 391개 회귀 테스트, native 운영 sandbox 검증, 실제 등록 계정 완료, revision 33 전체 활성화 | 로그인 browser/desktop/mobile 조작·캡처 검증은 미완료 |

## 자동 검증

2026-09-09 00:05 KST 실행에서 UTF-8 local PostgreSQL을 포함한 **63개 파일·391개 테스트**가 skip 없이 통과했다. `--maxWorkers=2 --hookTimeout=60000`을 사용했다. 최초 기본 병렬 실행의 DB migration advisory lock 경합에 따른 hook timeout과 실제 기능 실패를 구분했다. 전체 TypeScript 검사와 ESLint도 통과했다.

회귀에는 divergent base/head/merge-base와 branch 이동 후 revision 고정, 새 파일의 base 부재, 경로·옵션 주입과 symlink 차단, source blob 일치, corporate CA와 public root의 공존, 중복 run·질문 응답·fence·취소·권한 경계, provider stream과 shared admission이 포함된다. 새 admission 테스트는 배치 실행 중 대기한 Chat이 다음 배치보다 먼저 계정 slot을 얻는지 검증한다. UI 테스트는 React 렌더링이며 실제 브라우저 상호작용을 대신하지 않는다.

Apple Silicon에서 amd64 Docker image의 seccomp 적용은 exit 125로 거부됐다. 격리를 끄지 않았고 해당 환경에서 sandbox 성공으로 처리하지 않았다. macOS native sandbox-exec의 실제 source 조회는 통과했다. PRISM-DEV Kernel 5.4의 별도 무비밀 probe에서는 UID 65534, 환경 비밀 제거, 쓰기·경로 이탈·process·네트워크 차단과 실제 local Git blob 조회를 확인했다.

## 운영 canary에서 발견하고 수정한 문제

- 실제 provider는 `response.output_item.done` 뒤 `response.completed.output=[]`를 보냈다. 빈 배열로 이미 받은 tool call을 덮어쓰던 parser를 수정하고 regression을 추가했다.
- alpha.18은 추가 corporate CA를 Git의 전체 trust bundle처럼 전달해 public GitHub TLS 검증이 실패했다. public roots와 corporate CA를 합치도록 공통 Git helper를 수정했다. TLS 검증을 끄거나 CA Secret을 교체하지 않았다.
- alpha.19의 실제 복합 분석은 새 파일을 base에서 조회했을 때 예외가 발생해 최종 `partial`이 됐다. alpha.20부터 정상적인 파일 부재는 `exists:false`로 반환하며 접근·권한·clone 실패와 구분한다.
- alpha.20에서 배치가 model slot을 연속 점유해 Chat이 장시간 `waiting_capacity`에 머물렀다. alpha.21에 Worker의 Chat용 slot과 15초 갱신형 계정 우선권을 추가했다. 요청·byte 한도와 제공자 cooldown은 완화하지 않았다.
- alpha.21의 마지막 종합 답변은 기존 Chat의 60초 timeout에 정확히 걸렸다. alpha.22는 고급 Chat에 별도의 180초 제한을 적용하고 run 시작 시 고정한다. 최대 설정은 300초이며 기존 Chat의 60초 제한은 유지한다. timeout을 구체적인 오류로 표시하고 중단된 실제 요청도 run 호출 횟수에 반영하는 회귀를 추가했다.

alpha.18에서 기존 snapshot job `43a0fef6-c495-4f8d-bff0-069fd797c158`도 TLS 오류로 3회 실패했다. alpha.19 수정 후 이 job에만 한 번의 재시도를 허용했다. 과거 attempt와 오류를 보존했고 네 번째 attempt는 completed, snapshot은 materialized가 됐다. 후속 원래 분석 operation의 완료까지 검증한 것은 아니다. 다른 실패 record를 성공으로 덮어쓰거나 일괄 재시도하지 않았다.

23:53 KST 무렵 alpha.20 Worker의 기존 900초 종료 유예가 끝났다. Legacy analysis job `34ce0ab7-e574-4ce8-93b1-a0a912a89570`이 attempt 3/3에서 만료된 lease로 남아 정확한 이전 executor·lease·상태를 확인한 뒤 한 번의 재시도를 허용했다. 세 번째 attempt는 interrupted로 남기고 audit을 기록했다. model ledger와 128회 예산은 초기화하지 않았다. 다른 배치 job은 기존 정책으로 새 Worker에 재할당됐다. alpha.22부터 PRISM-DEV의 새 Worker는 3600초 종료 유예를 사용한다. Legacy 배치의 최대 attempt 만료 복구는 아직 운영자 절차이며 Chat의 fenced run 복구와 구분한다.

00:27 KST에는 alpha.21 Worker도 종료됐다. 그 Worker에서 계속 실행되던 `661d6a9c-cb72-4cd3-aeca-33115afd3c32` 역시 attempt 3/3·만료 lease를 확인해 동일하게 한 번만 복구하고 audit을 남겼다. 두 배치의 마지막 상태는 첫 번째 running(4/4), 두 번째 queued(3/4)다. 최종 분석 완료를 확인한 것은 아니며 남은 128회 예산 안에서 처리한다. 기존 분석이 Worker 교체 전에 사용한 호출을 환급하거나 성공 record로 바꾸지 않았다. 최대 attempt에서의 자동 회수와 배치 단위별 모델 결과 checkpoint는 후속 운영 개선 항목이다.

## 실제 AI 검증 방법과 중간 결과

운영 Server image의 실제 Fastify route를 in-process injection으로 호출하고 기존 canary 관리자 principal의 현재 권한을 사용했다. 인증 없는 network listener나 우회 로그인 token은 만들지 않았다. 운영 DB에 명확한 검증 접두사의 개인 session과 audit을 남기고 실제 배포 Worker·등록 `gpt-5.6-sol:medium`·등록 GitHub repository를 사용했다. 이는 로그인 브라우저/HTTP 인증 E2E가 아닌 **handler·Worker 통합 smoke**다.

검증 대상은 고정된 analysis `43958a91-50d0-4a82-a9e0-19384afeee58`다. PositionV2Tmp 외래키 변경과 block 생성 오류 처리의 관계를 base/head 코드·기존 report로 분석하도록 요청했다. 원본 report·공용 메모리·GitHub PR 댓글은 검증 목적으로 변경하지 않았다.

- alpha.18 run `76878a4a-bd17-43c9-bdd3-8ac24df85d01`: 실제 모델·질문 응답은 수행했으나 Git TLS 실패로 근거 0건, 최종 partial. 성공 사례로 집계하지 않는다.
- alpha.19 run `210256b0-3da6-45ae-bf1e-37089fa4bff2`: 모델 요청 8회, source 도구 6회, 실제 근거 3건, 사용자 질문·응답·재개와 2,171자 답변을 확인했다. 실제 text delta event 98건과 citation을 저장했다. base 신규 파일 부재 오류 때문에 partial이며 완료 사례로 집계하지 않는다.
- alpha.20 run `d62a2d91-f8fc-4717-b926-e7d5043f42c9`: 모델 1회·도구 1회·근거 1건 이후 account 대기가 길어져 수정 배포 전에 해당 진단 run만 중단 요청했다. 과거 상태를 완료로 바꾸지 않았다.
- alpha.21 run `cc3a27f9-1fe9-4245-9ebc-c5f7ac48dbff`: 실제 근거 4건, 도구 6회, 질문·응답·재개와 source API 재조회를 확인했다. 구버전 Worker drain 동안 관찰 harness의 12분 대기가 끝나 동일 run에 재접속했고 예산을 새로 만들지 않았다. 마지막 여덟 번째 요청이 60.000097초에 중단돼 3,370자의 부분 출력과 citation을 보존했다. 최종 상태는 partial이며 성공으로 집계하지 않는다. 당시 화면 counter는 완료 요청 7회였고 ledger는 중단 포함 8회였다. alpha.22에서 이 차이도 수정했다.

검증용 session은 개인 history에 남으며 `[배포 검증용 실제 AI 리뷰]`로 식별한다. 실제 source 본문·사용자 답변·credential은 이 문서와 일반 진단 로그에 복사하지 않는다.

## alpha.22 최종 실제 AI 결과

2026-09-09 00:11:56–00:21:22 KST, run `cf19fcf0-c4cf-4c0f-b2a6-24cab6000e55`, session `18d463e7-c6d6-4099-b213-afdd52743ee0`를 검증했다. 최종 상태는 **completed**, 오류는 null이다. `gpt-5.6-sol:medium`의 실제 요청 8회가 모두 완료됐고 각 요청의 usage가 ledger에 저장됐다. Source 도구 6회, 사용자 질문·응답 후 재개, 2,249자 답변과 citation, 실제 delta event 96건을 확인했다.

근거는 position/models.py의 base/head 1–65행과 block/service.py의 head 160–230행, 총 3건이다. Base SHA는 `aebc554766ea11e022caa557773d3b5651aa59af`, head는 `9f7a7d14396be6da6bb01d874fb9cfe2c850140d`다. 각 근거의 blob과 본문 SHA-256이 일치하며 source API 재조회도 성공했다. Base에 없는 신규 파일은 정상적인 부재 결과로 처리했다.

배치 동시 실행·계정 대기·attempt별 workspace 재생성을 포함한 경과 시간은 약 9분 25초다. 개별 모델 요청은 약 3.07–34.67초였으며 전체 Chat의 응답 시간 보장을 검증한 것은 아니다. 두 Worker의 자동 분석과 Chat이 함께 실행되는 동안 확인 가능한 완료 ledger 구간의 계정 요청 중첩은 0건이었다. 미완료·중단 요청까지 사용량이 모두 확정됐다는 뜻은 아니다.

00:23:01 KST Helm revision 33에서 allowlist를 비우고 Server만 재시작했다. 새 Server의 agent enabled, 빈 allowlist, model admission enabled와 180000ms 설정을 확인했다. 기존 사용자·repository·등록 account 권한을 우회하지 않는다. 이 backend 검증과 SSR 회귀를 근거로 활성화했으며 최초 P5 계획의 실제 desktop/mobile 화면 검증은 아직 충족하지 못했다.

Health 4종은 HTTP 200·ok, system version은 alpha.22, 비로그인 Chat config는 401이었다. Helm test는 00:23:30 KST에 성공했다. Migration 26개의 DB checksum이 배포 image와 일치했다. 기존 3개 application Secret과 corporate CA의 UID·resourceVersion, 두 PVC의 UID·PV를 보존했다. Image·새 Chat/admission 설정·Worker concurrency/grace를 제외한 Helm values SHA-256은 배포 전후 `e5d4970dbbd8ea776f0cb381384f5bbd221d1c1b08d133dda1c9c10ccc8f4ba8`로 같다.

배포 image와 실제 HTTPRoute가 제공한 asset hash도 일치했다. JS `index-D2HxFsd6.js`는 `97d7f579e060df1bc1c30d1fe7c5fe65b134b78f4b12dd044b5a5674cc6a068a`, CSS `index-DkDPMocU.css`는 `a38d1265666dc7745f476b98773785a51b3a6017c0f81298788a2109436c9acc`다. Native alpha.22 probe도 실제 Git read와 모든 격리 검사를 통과했고 임시 Pod는 삭제했다.

## 화면 검증 제한

CUA의 Mac 잠금 해제가 실패했다. 수동 잠금 해제를 요청했으나 작업 중 응답이 없어 실제 운영 화면의 desktop/mobile 조작과 캡처는 수행하지 못했다. SSR 테스트, 실제 delta event, 배포 asset 비교는 별개의 검증이며 화면 캡처가 있다고 주장하지 않는다.

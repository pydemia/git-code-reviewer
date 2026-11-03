# 원래 요구 범위에 대한 개발 점검

점검일: 2026-09-15, 운영 조회 14:06–14:07 KST
대상: GCR `f8d2048` / 배포 `0.8.0-alpha.60`, Commit Defender `8bb3916` / 설치 `2.10.0`
방법: 설계·실제 코드·배포 기록 대조, PRISM-DEV 읽기 전용 조회, 관련 회귀 테스트. 구현·설정·배포는 변경하지 않았다. 미커밋 P11 runner 작업도 그대로 보존했다.

## 판정

요구에 맞는 기반은 구현돼 있지만, 원래 의도를 충족하는 기능이 잘 완성되고 있다고 평가하기는 어렵다. 과거 리뷰의 로컬 재사용보다 범용 실행기·승인 체계·인증·자동화·CI 근거·운영 지표로 개발 범위가 넓어졌다. 그 사이 실제 운영의 과거 코멘트 메모리와 배포 기준은 채워지지 않았다.

이번 점검의 기준은 다음 두 가지다.

- GCR의 기존 PR 리뷰 동작을 유지하면서 과거 review comment를 메모리로 저장한다.
- Commit Defender는 로컬에 설정한 모델·계정으로 리뷰하고 GCR의 review comment 히스토리, Skill, 검증로직을 pulling한다. 로컬 내용은 중앙으로 제출하지 않는다.

| 요구 | 실제 구현·운영 상태 | 판정 |
| --- | --- | --- |
| 기존 GCR 리뷰 유지 | 기존 PR 수집·분석·보고서·게시 경로는 남아 있다. 다만 공용 지식 검증 실패 시 모델 실행을 생략하는 새 조건이 추가됐다. 현재 worker도 Ready가 아니다. | 유지 여부 재검증 필요 |
| 과거 코멘트 저장 | PR 대화 원문 235건, 본문 버전 282건, 관측 이력 232건을 저장하고 중앙 웹에서 조회한다. | 구현·운영 데이터 확인 |
| 과거 코멘트 메모리화 | 후보 생성·승인·발행 코드는 있다. 운영 메모리는 finding 출처의 개인 후보 4건뿐이며, 코멘트 출처 메모리·활성 메모리·배포 승인 메모리는 없다. | 실제 활용 미완료 |
| CD의 로컬 리뷰 | 중앙 지식을 받아 로컬 executor로 실행한다. 그러나 새 리뷰 경로는 macOS의 Codex 0.153.4/0.154.0, `gpt-6-astra / xhigh`로 제한됐다. | 위치는 적합, 지원 범위 축소 |
| 코멘트 히스토리 pulling | 내려받는 것은 승인된 메모리 projection과 기준이다. PR 코멘트 원문·답글·상태 변경 이력은 bundle에 포함되지 않는다. | 원문 히스토리 pulling은 미구현 |
| Skill·검증로직 pulling | Skill 본문, 적용 범위, 검토 절차, 반증 조건을 다운로드·선택·리뷰 입력에 적용한다. 실행 가능한 검증 코드의 배포 계약은 없다. | 지침 전달은 구현, 실행 코드 전달은 미구현 |
| 단방향 전파 | 클라이언트 업로드와 중앙 실행 명령을 제거했고 SDK 제출은 네트워크 전송 없이 거부한다. 서버도 client bearer 쓰기를 차단한다. | 현재 경로는 적합, 과거 코드 잔존 |

## 원래 의도와 차이가 큰 부분

### 1. 히스토리를 저장하는 기능과 로컬로 전달하는 기능이 분리돼 있다

중앙은 `github_pr_messages`, `github_pr_message_versions`, `github_pr_message_observations`에 원문과 변경 이력을 보관한다. 웹 session으로 현재 대화와 개별 원천 이력을 조회하는 API도 있다.

그러나 client bundle에는 원문 히스토리가 없다. 메모리는 summary/detail/recommendation과 적용 조건, 기준은 requirement/reviewSteps/counterEvidence를 담는다. 출처 참조도 주로 kind·ID·hash이며 원래 PR의 전체 논의를 읽는 클라이언트 경로로 연결되지 않는다. CD의 다운로드 내용 화면 역시 이 가공된 snapshot을 표시한다.

따라서 “히스토리 pulling”이 원문·스레드·판단 근거까지 로컬에서 읽는다는 뜻이라면 현재 설계부터 보완해야 한다. 요약된 판단의 재사용만 뜻하더라도 실제 운영에는 발행된 메모리가 없어 아직 목적을 달성하지 못했다. 이 두 의미를 구분하지 않고 동기화 완료로 보고하면 안 된다.

근거: [다운로드 계약](../../packages/client-contract/src/central-knowledge.ts), [발행 projection](../../apps/runtime/src/services/knowledge-projection.ts), [원문·이력 API](../../apps/runtime/src/routes/review-memory.ts), [CD 다운로드 화면](../../../commit-defender-preventive-review/vscode-extension/src/centralKnowledgeView.ts).

### 2. 과거 이력의 확보와 메모리화보다 관리 절차가 앞섰다

운영 DB에는 PR 1,189건이 있지만 코멘트가 저장된 PR은 open 5건, closed 65건이다. 나머지 PR에 실제 코멘트가 있는지는 GitHub와 대조하지 않았으므로 이 숫자를 누락률로 해석할 수 없다. 다만 현재 구현은 새로 발견한 과거 closed PR의 대화를 전부 회수하지 않으며 기간·저장소를 지정하는 backfill은 미완료다.

분석 finding의 자동 메모리 후보 생성은 요청 사용자(owner)가 있을 때 P2/P3 finding을 개인 후보로 만든다. 모든 중앙 PR 리뷰 코멘트를 자동으로 메모리화하는 흐름은 아니다. GitHub 코멘트의 후보 등록과 모델 기반 기준 후보 생성은 별도 사용자 작업이다.

메모리의 활성화와 다운로드용 projection 승인이 분리돼 있다. 집단 메모리에는 개인 기여 집계와 별도 승인도 있다. 근거 검토와 잘못된 지적의 무분별한 재사용 방지는 필요하지만, 개인/집단 승격·별도 배포 승인·기준 평가·예외 승인까지 모두 기본 흐름에 넣은 현재 구조는 사용자가 요구한 수집→저장→pull보다 훨씬 크다.

운영 조회 결과는 `review_memories=4`(모두 personal/candidate/finding), `review_knowledge_memory_projections=0`, `review_rules=0`이다. 지식 release 8건이 있다는 사실을 과거 리뷰 메모리 전달 실적으로 계산해서는 안 된다.

근거: [메모리 생성·집계](../../apps/runtime/src/services/review-memory.ts), [대화 재수집](../../apps/runtime/src/services/conversation-sync.ts), [별도 배포 승인 구조](../../packages/db/migrations/0039_review_knowledge_publication.sql), [과거 PR 수집의 현재 한계](../../docs/operations/pr-review-provenance.md).

### 3. 기존 CD 리뷰를 확장하는 과정에서 기존 provider 지원을 축소했다

`createReviewBackend()`는 수동 리뷰를 새 공통 worker로 넘긴다. 기존 provider adapter는 로그인·commit message 생성용으로 남아 있고 새 리뷰 경로에서는 Codex 외 provider를 `unsupported-provider`로 거절한다. 모델은 `gpt-6-astra`, reasoning은 `xhigh`만 허용한다.

중앙 서버에 모델 실행을 맡기지는 않는다. 하지만 사용자가 기존에 선택한 로컬 provider로 계속 리뷰하면서 중앙 자료를 보완 입력으로 받는 구조와는 다르다. “기존 설정을 보존했다”와 “기존 설정으로 리뷰가 계속 동작한다”를 구분해야 한다. 이 제한은 제품 코드에 있으며 현재 개발 대화의 모델 설정과도 별개다.

근거: [CD backend](../../../commit-defender-preventive-review/vscode-extension/src/reviewBackend.ts), [실행 조건](../../../commit-defender-preventive-review/vscode-extension/src/standaloneReview.ts), [제품 설정](../../../commit-defender-preventive-review/vscode-extension/package.json).

### 4. 기존 GCR 분석도 새 발행 기능에 의존하게 됐다

공용 기준과 Skill을 로컬·중앙에서 일치시키는 기능은 유용할 수 있다. 그러나 지금은 지식 발행이 켜진 상태에서 고정한 공용 bundle이나 같은 Git SHA의 원문을 확인하지 못하면 `model = undefined`로 만들고 분석을 partial로 남긴다. 단순 메모리 보강을 넘어 기존 분석의 실행 조건을 바꾼 것이다.

운영은 `KNOWLEDGE_PUBLICATION_ENABLED=true`다. 활성 저장소 두 곳에는 policy/collective 발행본이 있으므로 현재 장애를 bundle 부재 때문이라고 단정할 수는 없다. 다만 이후 발행·검증 실패가 기본 PR 리뷰까지 막을 수 있는 결합은 코드상 확인된다. 기존 동작 유지가 우선이라면 메모리 보강 실패와 기본 분석 실패를 구분하는 제품 정책을 다시 정해야 한다.

근거: [분석 worker](../../apps/runtime/src/jobs/worker.ts), [중앙 공용 기준 계약](../../docs/operations/central-shared-criteria.md).

### 5. “검증로직”을 지침과 실행기로 구분하지 않고 확장했다

현재 pulling 계약의 검증로직은 Skill 지침·검토 절차·반증 조건이다. 이 내용을 로컬 모델에 전달하는 경로는 있다. 중앙의 실행 가능한 검증 코드를 버전별로 받아 로컬에서 실행하는 기능은 이 계약에 포함되지 않는다.

미커밋 P11은 로컬 사용자가 승인한 Docker profile로 고정 source를 검사하는 별도 runner다. 중앙 검증 코드 pulling 구현 자체가 아니며 CD 선택 UI도 아직 없다. 실제 Docker 격리 실행 검증은 로컬 Docker 저장소 I/O 오류로 완료하지 못했다는 기존 작업 기록이 있다. 이번 점검은 해당 장애를 재시험하거나 runner를 완성하지 않았다.

P13 trusted CI도 중앙이 서명된 CI 결과를 확인하는 별도 기능이다. 현재 운영 정책은 빈 배열이므로 실제 CI 생산자와 연동돼 있지 않다. 이를 CD의 검증로직 pulling 완료로 계산할 수 없다.

근거: [다운로드 계약](../../packages/client-contract/src/central-knowledge.ts), [현재 미커밋 runner](../../packages/client-core/src/check-runner-docker.ts), [CI 기능과 미설정 상태](../../docs/operations/trusted-ci-evidence.md).

## 유지·정리·보류할 범위

| 구분 | 판단 |
| --- | --- |
| 유지할 기반 | 기존 GCR PR 분석·보고서·게시, 코멘트 원문·출처·버전 저장, CD 로컬 리뷰, 중앙 읽기 전용 API, repository별 접근 권한, 버전 확인·캐시, Skill 적용, 기본 입력·오류 처리 테스트 |
| 원래 요구에 맞춰 우선 보완 | 대상 과거 PR 이력 확보, 코멘트→재사용 메모리 연결, 로컬 히스토리 조회 범위, 기존 provider로 중앙 자료를 사용하는 리뷰, 실제 과거 사례를 이용한 전체 흐름 검증 |
| 단순화 검토 | 개인/집단 메모리 승격과 별도 projection 승인, 기준 평가·정정·예외·역할 위임의 다단계 관리. 원천 보존과 지식 활성화는 구분하되 모든 관리 기능을 첫 사용의 필수 조건으로 두지 않음 |
| 별도 요청 전 보류 권고 | 범용 CLI/MCP 제품 확대, 별도 리뷰 채팅·watcher·자동 trigger 확장, Docker runner·critic, trusted CI, 재발/성과/비용 지표. 기존에 구현된 부분을 이번 점검만으로 삭제하지 않음 |
| 방향에서 제외 | 로컬 source/result/feedback 업로드, 중앙 모델 대행 실행. P08 일부와 P10은 철회됐지만 호환 메서드·제출 관리 route/service·DB 구조가 남아 있어 추후 정리 대상을 식별해야 함 |
| 이미 별도로 요청받은 인프라 | Keycloak의 PRISM-DEV 배포, Helm, DB TLS는 사용자 후속 요청이 있었으므로 임의 개발로 분류하지 않음. 다만 전체 SAML·PKCE/device/refresh·identity 복구 체계를 히스토리 pulling의 선행 완료 조건으로 둘 필요는 없음. 현재 웹 인증은 local이고 client 읽기용 key 경로가 있음 |

범위 판단의 기준은 기능이 유용한가만이 아니라 원래 목적을 완성하는 데 지금 필요한가다. 기존 구현의 일괄 삭제·롤백보다 기본 리뷰 동작과 실제 메모리 전달을 먼저 확인하는 편이 적절하다.

## 운영 장애는 범위 문제와 별도로 확인됨

PRISM-DEV 조회 시 server는 1/1, Keycloak은 2/2 Ready였지만 worker pod는 source-sandbox만 Ready이고 worker container는 Ready=false였다. readiness는 503으로 실패하고 있다.

`analysis.run` 한 건이 running 상태이며 마지막 heartbeat는 11:34:49 KST, lease 만료는 11:35:19 KST였다. 14:07 KST 조회 시에도 만료된 실행권을 가진 채 남아 있었다. 같은 시간대에 worker 재시작 기록과 PostgreSQL의 이전 OOMKilled 기록도 확인했지만 인과관계는 아직 규명하지 않았다. 단순 표시 문제로 간주해서는 안 되며 새 분석·복구 처리의 정상 동작을 우선 확인해야 한다.

이번 요청은 점검이므로 재시작·재배포·job 상태 수정은 하지 않았다. 장애 수리 전에는 “현재 GCR의 기존 동작이 정상 유지되고 있다”고 보고할 수 없다.

## 원래 요구의 완료를 판단할 검증 흐름

실제 과거 PR 하나를 대상으로 아래 흐름이 연결돼야 한다. 별도의 플랫폼 기능 개수나 테스트 총수를 완료 기준으로 사용하지 않는다.

1. 해당 PR의 코멘트와 답글, 출처, 수정 이력을 중앙에서 확보한다. 수집하지 못한 범위를 표시한다.
2. 코멘트로부터 로컬 리뷰에 재사용할 판단을 저장한다. 원문과 해석·활성 상태를 구분하고 원래 출처를 찾을 수 있게 한다.
3. CD가 해당 히스토리와 Skill·검증 지침을 읽기 전용으로 내려받고 사용자가 내용을 확인한다. 원문까지 내려받을지 승인된 요약만 받을지를 계약에 명시한다.
4. 기존에 설정한 로컬 provider로 관련 변경을 리뷰한다. 적용된 과거 코멘트·Skill·버전을 추적하고 중앙 데이터 전송이 없음을 확인한다. 실행 검증이 요구된다면 그 부분을 별도 계약으로 검증한다.
5. 같은 기간 기존 GCR PR 분석·보고서·게시 흐름도 정상 동작함을 확인한다. 중앙 메모리 기능의 실패가 기본 리뷰에 미치는 영향도 시험한다.

## 검증 근거와 한계

이번 회귀 테스트는 GCR 4개 suite 68건, CD 3개 suite 31건으로 총 99건이 통과했다. 대상은 중앙 HTTP 전송·전송 차단, 중앙 지식의 로컬 리뷰 적용, 메모리 선택, 중앙 공용 기준 선택, CD 다운로드 화면과 backend다. 합성 HTTP/모델 응답을 사용했으며 실제 GitHub 쓰기나 유료 모델 호출은 하지 않았다.

과거 P06에는 합성 서명 자료와 실제 로컬 계정 모델을 연결한 검증 기록이 있다. 그 기록과 이번 테스트를 실제 운영 코멘트의 수집→메모리화→CD 적용을 완료했다는 증거로 확대하지 않는다.

운영 데이터는 읽기 전용 transaction으로 집계했고 원문·계정·토큰은 출력하지 않았다. 전체 과거 GitHub 이력의 완전성, 현재 모델 리뷰 품질, 기존 GCR의 모든 기능에 대한 회귀를 이번 점검에서 검증한 것은 아니다. 설치된 CD 버전은 확인했지만 이미 열린 VS Code Extension Host가 그 버전을 로드했는지는 별도다.

[조회·테스트 증거](original-scope-review-evidence-2026-09-15.json)

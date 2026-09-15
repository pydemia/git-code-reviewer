# GCR와 Commit Defender 아키텍처

이 문서는 현재 구현의 역할, 저장 위치와 통신 경계를 설명합니다. 설치·설정 순서는 [설치·연결 가이드](getting-started.md), 메뉴별 계약은 [기능 목록](features.md)을 따릅니다. `.documents` 아래의 이전 설계·실행 기록은 변경 배경과 검증 근거이며 현재 사용 절차와 구분합니다.

## 실행 구성

| 구성요소              | 실행 위치                 | 책임                                                                                        |
| --------------------- | ------------------------- | ------------------------------------------------------------------------------------------- |
| GCR Web / Server      | 서버                      | 로그인·인가, PR 목록·보고서·이력 UI, REST/SSE, polling, 중앙 Review Chat                    |
| GCR Worker            | 서버                      | 격리된 Git snapshot, PR 분석, 보고서와 checkpoint, 만료 job 실행권 복구                     |
| PostgreSQL            | 서버의 DB                 | 사용자·권한·작업·보고서 metadata·PR 메시지/본문 버전/관측·지침·발행 상태                    |
| Artifact store        | Server/Worker 공유 저장소 | snapshot과 분석 artifact. 배포에 따라 PVC 사용                                              |
| Identity / 정책       | 선택한 인증 구성          | local 또는 SAML 등 웹 인증, tenant/repository 접근. Keycloak·Cerbos는 배포 구성에 따라 사용 |
| CD Extension Host     | 개발자 VS Code            | 계정 선택·연결 UI, 분석 요청·취소, 원문·결과 화면                                           |
| CD worker / 공통 core | 개발자 컴퓨터             | Git 소스 고정, 로컬 자료 선택, provider 호출, 응답·출처 검증과 암호화 이력                  |
| CD background service | 개발자 컴퓨터             | 명시적으로 켠 자동 trigger의 queue·소스 보관·복구. 전역 CLI를 교체하지 않는 bundled service |

GCR는 Web asset과 runtime을 같은 image로 전달하고 Server, Worker, migration Job, retention Job을 서로 다른 command로 실행합니다. CD는 `@gcr/client-contract`, `client-core`, `client-executors`를 정확한 버전의 artifact로 포함합니다. 이름에 GCR가 있어도 이 공통 package가 중앙 모델 실행을 뜻하지는 않습니다.

## 두 리뷰 흐름

중앙 PR 리뷰는 GitHub에서 GCR로 수집한 PR을 대상으로 합니다.

```text
GitHub PR → GCR polling → job / 고정 Git snapshot
                         → 중앙에 설정한 provider → 보고서
                         → 설정한 경우에만 GitHub 게시
```

CD 리뷰는 개발자의 로컬 변경을 대상으로 합니다.

```text
GCR 원문·Skill·활성 지침 ── 읽기 API / 서명 bundle ──→ CD cache
로컬 Git 변경 + 로컬 Memory/Skill + 선택한 중앙 자료 → 고정 리뷰 문맥
                                                       ↓
                                              선택한 로컬 provider adapter
                                                       ↓
                                          로컬 결과·이력·출처 표시
```

여기서 provider adapter가 로컬에서 실행된다는 말과 모델 서비스의 위치는 다릅니다. 사용자가 Codex 계정이나 외부 API를 선택했다면 승인한 소스와 문맥은 해당 provider로 전송됩니다. GCR 서버로 로컬 source/result/chat을 업로드하거나 GCR가 그 모델 호출을 대행하는 흐름은 없습니다.

## 원문과 지침의 수명

원문은 PR의 review, inline comment, 일반 comment와 답글입니다. 현재 본문, 저장된 이전 본문, 수집 당시 thread/출처 관측을 구분합니다. 현재 GitHub 응답에 나타나지 않는 항목은 `not-returned`로 보존할 수 있으며 이것만으로 삭제 이유를 확정하지 않습니다. 수집 이전에 사라진 본문을 복원했다고 표시하지 않습니다.

파생 지침은 원문 ID·URL·본문 hash·관측 hash에 연결됩니다. 관리자는 요약, 검토 지침, 적용 조건과 반증을 검토해 초안을 활성화·발행합니다. 원문 읽기에 이 승인을 요구하지 않습니다. 기존 개인 메모리 후보·집단 메모리 승격과 원문 연결 지침의 활성화는 별도 경로입니다.

CD는 내려받은 자료에서 파일·언어·심볼·브랜치에 맞는 지침을 선택합니다. 자연어 계약 조건은 현재 소스와 함께 모델이 판단합니다. 선택된 지침의 원문·답글은 제한된 수만 가져오며 source/guidance/thread 버전이 서로 맞지 않으면 해당 보강 자료를 제외합니다. 원문 누락이 기본 리뷰를 제거하지는 않지만 권한 철회는 중앙 자료 사용을 중단시킵니다.

## 인증과 데이터 경계

| 인증 자료                        | 사용 목적                                        | 다른 용도로 사용하지 않는 대상  |
| -------------------------------- | ------------------------------------------------ | ------------------------------- |
| GCR 웹 로그인 session            | 웹 화면과 현재 사용자 권한                       | CD 모델 계정                    |
| GitHub PAT / 연결 credential     | 중앙 GitHub 수집·허용된 게시                     | CD reader key                   |
| GCR reader API key               | 특정 client·tenant·repository의 `knowledge:read` | 원문 수집, 지침 쓰기, 모델 대행 |
| 공개 연결 JSON                   | 서버 주소·audience·서명 공개키·웹 CA 확인        | 비밀 key 저장                   |
| CD model credential / CLI 로그인 | 선택 provider 호출                               | GCR 서버 인증                   |

CD의 연결·cache·이력은 profile, repository/worktree와 중앙 server/tenant/user에 묶입니다. Git remote는 서버가 제공한 repository identity와 로컬에서 비교하며 로컬 remote URL을 조회 검색어로 업로드하지 않습니다. 현재 권한, 서명·hash, key/lease 만료를 확인하고 다른 사용자나 저장소의 자료를 재사용하지 않습니다.

CD의 개인 Memory, 리뷰 결과와 대화는 로컬 암호화 저장소에 남습니다. OS credential store를 사용할 수 없으면 plaintext 저장으로 전환하지 않습니다. 사용자가 직접 내보내기를 선택한 파일은 별도의 plaintext 산출물입니다. 로컬 코드의 모든 소스를 보고서 DB에 저장하는 구조도 아닙니다. navigation에 필요한 고정 source의 보존 범위는 별도 cache/자동 service snapshot 정책을 따릅니다.

## 버전 고정과 장애 처리

리뷰는 Git source/base, 선택 모델·설정, Skill·지침·원문 버전을 고정합니다. 실행 중 새 발행물이 생겨도 현재 문맥의 본문을 바꾸지 않습니다. 결과는 당시 버전의 판단이며 자료 변경·무효화와 `superseded`, 취소, 미완료 상태를 구분합니다.

현재 GCR online manifest는 5분 freshness 경계를 갖고 signed offline lease는 별도로 검증합니다. 새 manifest를 받거나 offline 모드를 선택하는 것이 이미 만료·철회된 자료를 허용하지는 않습니다. 연결을 끊으면 진행 중 중앙 자료 사용도 중단합니다. offline client가 동기화 없이 서버의 새 철회를 즉시 알 수 있는 것은 아니며 signed lease와 이미 관측한 철회가 경계를 정합니다.

GCR의 job lease·checkpoint는 worker 중단 뒤 회수·정합한 종결과 중복 방지를 담당합니다. 선택적인 메모리 보강 실패와 기본 분석 실패를 구분합니다. CD도 자료 없음·통신 장애·권한 실패·모델 실패를 구분하며 실패한 리뷰를 지적 0건의 성공 결과로 바꾸지 않습니다.

## 결과의 증거 수준

- context entry의 ID/revision/hash는 해당 자료가 고정 문맥에 포함됐다는 증거입니다.
- 모델 요약·rationale의 출처와 적용/반증 설명은 현재 코드 판단과 함께 검토합니다. 출처를 인용했다는 이유만으로 판단의 정확성을 보장하지 않습니다.
- source-read는 읽어 반환한 코드 범위이고 anchor 검증은 위치 일치입니다. 둘 다 테스트 실행 증거는 아닙니다.
- 일반 수동/자동 CD 리뷰는 advisory입니다. 기존 legacy hook의 commit 차단은 별도 실행 경로입니다.

내려받은 검증 지침은 실행 권한을 부여하지 않습니다. 임의 runner·원격 shell·dependency 설치·테스트 실행을 이 문서의 리뷰 흐름에 포함하지 않습니다.

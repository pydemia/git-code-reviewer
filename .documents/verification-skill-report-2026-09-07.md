# Skill 기반 report 검증 기록

검증일은 2026-09-07이며 대상은 `feat/browser-review-service`의 `9930f90`까지의 구현과 이후 build/doc 변경이다. PRISM-DEV의 DB, account, repository, workload는 변경하지 않았다.

## 자동 검증

- `GCR_TEST_DATABASE_URL=<전용 임시 PostgreSQL> pnpm test`: 33 files, 189 tests 통과. Worker 4개, Skill 관리 5개, account 5개, repository lifecycle 6개의 실제 PostgreSQL integration을 포함한다. Migration 0001–0015를 적용했다.
- `pnpm lint`, `pnpm typecheck`, `git diff --check`: 통과.
- Production build: 통과. Zod의 PURE annotation 경고는 build 실패가 아니다.
- `helm lint deploy/helm/git-code-reviewer -f deploy/environments/prism-dev/values.yaml`: 1 chart 통과. Icon 권고만 남는다.
- C-1 단계에서 Cerbos compile/test 35개 통과. 이후 해당 policy는 변경하지 않았다.

## R1–R10 대조

| 기준 | 구현과 검증 근거 |
| --- | --- |
| R1 | `report-forms.test.ts`, `report-format.test.ts`: 상태·최고 priority·grade·실제 완료 파일 수·comment 수 집계. Browser에서 BLOCKED/P3, mode/duration 확인. |
| R2 | `skill-review.test.ts`: accepted unit만 파일 요약에 전달. `report-forms.test.ts`: 파일당 summary 한 개와 unit 연결 검증. Browser 파일별 Overall Summary 확인. |
| R3 | `review-windows.test.ts`, `skill-review.test.ts`: file/side/range/활성 perspective 검사와 overlap 중복 제거. Browser에서 mergeBase line 1 이동, inline 설명, Chat scope 연동 확인. |
| R4 | `report-format.test.ts`, `skill-review.integration.test.ts`: API view/JSON의 analysis 유지, Markdown/PR 동일 계층, 원본 artifact의 hash·analysis ID 확인과 정확한 mergeBase permalink. |
| R5 | `skills.test.ts`: 9개 Built-in, strict parser, bundle hash와 custom perspective. `skill-review.test.ts`: stage별 Skill 사용. |
| R6 | `analysis-skills.integration.test.ts`: 권한, concurrent save, immutable version, 중복 bundle, 복원과 audit. Browser에서 편집·저장·초안 불러오기·이전 version 활성화 확인. |
| R7 | `skill-review.integration.test.ts`: enqueue 이후 active version을 바꾸어도 원래 bundle 사용, custom category 저장, 재실행 idempotency. DB trigger로 run snapshot 수정 차단. |
| R8 | `review-windows.test.ts`, `skill-review.test.ts`: multi-file/hunk, overlap, input/call budget, 오류·truncation·생략. 완료되지 않은 파일을 검토 완료나 PASS로 세지 않음. |
| R9 | `analysis-account.integration.test.ts`, adapter/legacy 회귀: 동일 account/model/effort로 세 stage 호출. Files tree/layout/diff test와 browser에서 기존 패널·오른쪽 Chat·deep link 보존 확인. |
| R10 | `/guide`의 분석 Skills와 report 사용법, 요건/기능/UI 설계, 구현계획, README와 handoff 갱신. 한국어 설명, 영어 전문용어 유지. |

## 실제 local runtime과 browser

별도 임시 PostgreSQL, 실제 Server와 Worker process, loopback HTTP 모의 모델을 사용했다. Worker가 snapshot materialization과 durable job, SQL/artifact 저장을 수행했다. PR report 두 개가 completed로 저장됐으며 각 report는 unit 3회·파일 summary 2회·전체 summary 1회, 합계 12 model calls를 사용했다. Review Chat 1 call도 응답을 확인했다. 화면의 account/model과 report 본문은 검증용 데이터임을 표시했다.

Desktop 1440×1000, mobile 390×844에서 확인했다. Mobile은 기존 세로 적층 Workspace이고 full-page capture 높이는 viewport보다 길다. Console error와 수평 overflow는 관찰되지 않았다. 기본 Files/Findings navigation, diff와 오른쪽 Chat, FNB를 유지했다.

Impeccable의 두 차례 자체 검토 후 독립 reviewer를 사용했다. 최초 disposition은 fix였으며 아래 두 항목을 한 batch로 고쳤다. Verdict pass는 두 수정 항목에 한정해 resolved와 ship으로 판정했다. 이전 Workspace reviewer 판정을 이번 report 검토에 재사용하지 않았다.

| 수정 | 확인 |
| --- | --- |
| Mobile Skill 버튼 글자 숨김 | Skills 안에서 공통 command button의 font-size 12px·padding·자동 폭 복원. 저장 버튼은 전체 폭 유지. |
| 좁은 LNB에서 고정 navigation이 이동 대상 제목을 가림 | 실제 navigation 높이 + 12px로 scroll offset 계산. Desktop 측정에서 navigation 하단과 AI Comments 제목 사이 12px 확보. |

최종 screenshot은 `.impeccable/review/`의 `skills-desktop.png`, `skills-mobile.png`, `structured-report-desktop.png`, `structured-report-mobile.png`, `structured-comments-desktop.png`, `structured-comments-mobile.png`다. Detector의 기존 Provider/Prompt history active border 경고 2건은 이번 변경으로 생긴 문제가 아니어서 유지했다.

Finish documenter가 현재 CSS와 컴포넌트에서 root `DESIGN.md`, `.impeccable/design.json`을 추출했다. 기존 palette/control과 responsive 수치만 기록했으며 새 디자인 세계나 UI 동작을 추가하지 않았다. Markdown/JSON format과 token reference 검사를 통과했다.

## Packaging과 제한

사내 TLS inspection 환경의 Alpine 다운로드는 일반 build에서 CA 신뢰 오류가 발생했다. Dockerfile에 선택형 `build_ca` BuildKit secret을 추가했다. Node는 `NODE_EXTRA_CA_CERTS`, Alpine package 설치는 `SSL_CERT_FILE`로 신뢰하며 TLS 검증을 끄지 않는다. CA는 Git과 최종 image에 복사하지 않는다. Runtime outbound CA 설정과는 별개다.

최종 코드로 `git-code-reviewer:skills-verification` local image build를 통과했다. Build 인수는 `VERSION=skill-review-test`, `REVISION=9930f90`이며 manifest list digest는 `sha256:a28a8e86312c7b2f5afd492fa6a23acb102f98642d52b88f4c4a2db10cd1bc55`다. Registry에는 push하지 않았다.

`docker run --rm --read-only --network none --entrypoint node` smoke에서 UID 1000으로 9개 Built-in Skill을 읽고 bundle hash `ec6cbf2a77e803d416e56f6e736704f10b88109d6fcc8ca2cc468ce2e8b45de4`와 migration 15개를 확인했다. 최종 image에 `/run/secrets/build_ca`는 없으며 배포용 HTML에도 direction contract comment가 남아 있다.

검증용 Browser session, Server·Worker·모의 모델을 종료했고 전용 PostgreSQL container의 임시 DB와 이번 작업의 임시 source clone·모의 artifact·CA 파일을 정리했다. Synthetic 데이터는 폐기했으며 source와 screenshot, 검증 기록은 Git에 남겼다. Local 검증 image는 재사용할 수 있도록 보존했다.

모델의 의미적 분석 정확도와 실제 조직 account의 quota·접근 정책은 이 검증으로 보장하지 않는다. 실제 private source는 외부에 보내지 않았고 GitHub 게시 API는 모의 응답으로 검사했다. 다음 배포 시 승인된 account와 repository에서 재분석 및 관리 댓글 갱신을 확인해야 한다. BLOCKED는 report 판정이며 branch protection이나 merge 차단 설정을 자동으로 바꾸지 않는다.

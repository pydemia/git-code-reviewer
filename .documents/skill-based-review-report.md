# Skill 기반 분석과 Commit Defender report

## 기준과 범위

참조 정본은 `pydemia/commit-defender`의 main revision `47dabfea718729b0ccc685ae173857476040d6ea`이다. 2026-09-07에 원격 main을 조회하고 아래 문서와 Node.js source를 확인했다.

- [Code Analysis Forms](https://github.com/pydemia/commit-defender/blob/47dabfea718729b0ccc685ae173857476040d6ea/.commit-defender/vscode-extension.md#code-analysis-forms)
- [영역별 Skill](https://github.com/pydemia/commit-defender/tree/47dabfea718729b0ccc685ae173857476040d6ea/.commit-defender)
- `vscode-extension/src/{skills.ts,types.ts,ai/prompt.ts,ai/reviewer.ts}`

기존 package는 VS Code, local Git과 CLI Provider에 결합되어 있다. Node.js 의존성으로 연결하지 않고 report의 데이터 관계와 Skill 조립 방식을 참고하여 현재 Server/Worker용으로 구현한다. 외부 source를 실행하거나 대상 repository의 Skill을 system instruction으로 자동 신뢰하지 않는다. 기본 Skill 문구와 구현은 제품의 immutable snapshot·tenant·outbound 정책에 맞게 작성한다.

## 완료 기준

| ID | 요구사항 | 검증 근거 |
| --- | --- | --- |
| R1 | 전체 report에 제목, PASS/BLOCKED 또는 분석 미완료 상태, 대표 priority, grade, 분석 파일 수·comment 수·model mode·duration을 표시한다. | contract/집계 test, browser |
| R2 | Overall Summary는 분석 파일당 하나이며 파일 경로, 해당 unit의 최고 priority, unit들을 종합한 한국어 설명을 제공한다. | model orchestration/집계 test, browser |
| R3 | AI Comments는 파일로 묶인 unit-comment-block이다. 각 unit은 하나의 code segment, priority, point-of-view/Skill, 설명과 정확한 위치를 갖고 클릭하면 diff의 해당 line과 inline comment로 이동한다. | segment/anchor test, browser interaction |
| R4 | Analyzed File List와 Raw JSON, Markdown export를 제공한다. PR timeline 게시에도 같은 report 계층을 사용한다. | API/export/publication test, browser |
| R5 | correctness, security, maintenance, optimization, review-history, setting과 분석 형식 unit-comment-block, overall-summary, total-summary를 각각 SKILL.md로 관리한다. 새 perspective 추가가 enum 수정 없이 반영된다. | parser/catalog/prompt test |
| R6 | Skill은 name/version/kind/analysis-unit/enabled와 분석 지침을 가진다. 기본 source와 관리자 편집·version 생성·재활성화·기본값 복원이 가능하다. | admin API/DB integration, browser |
| R7 | 작업 생성 시 Skill bundle과 hash를 고정한다. 관리자 변경 또는 배포 후에도 queued 분석은 원래 Skill을 사용한다. report에 적용 Skill provenance를 남긴다. | Worker lifecycle integration |
| R8 | 파일별 diff를 line 번호가 있는 bounded segment로 나누고 경계 context를 겹친다. 모델은 segment 단위 comment를 생성하며 파일별·전체 집계가 이 결과를 사용한다. 실패·생략·잘린 출력은 PASS나 검토 완료로 표시하지 않는다. | multi-file/multi-hunk/budget/failure test |
| R9 | 기존 immutable report와 deep link, Files tree, resizing, 오른쪽 Chat과 FNB를 보존한다. 등록 account/model/effort 분석 경로와 OpenAI-compatible 경로 모두 동일한 Skill/report contract를 사용한다. | compatibility regression, browser, adapter test |
| R10 | 한국어 설명과 영어 전문용어를 유지하고 가이드·설계·handoff에 관리와 적용 절차를 기록한다. | 문서와 실제 UI 대조 |

## 데이터와 신뢰 경계

`code-segment → unit-comment-block → 파일별 overall-summary → total-summary`를 정본 관계로 사용한다. Segment는 한 파일의 한쪽 revision에 속하며 실제 diff line과 context 범위를 가진다. 하나의 unit에서 무관한 파일이나 segment를 함께 지적하지 않는다. 파일 수준의 설명은 line을 만들어내지 않고 file-level로 표시한다. Window overlap에서 같은 지적은 중복 제거한다.

P0 Praise, P1 Info, P2 Warning, P3 Critical을 유지한다. 대표 priority는 unit들의 최고 값이며 P3가 있으면 BLOCKED다. 같은 파일에 문제 지적이 있으면 P0 Praise로 안전을 혼동시키지 않는다. 위치 확인은 분석 주장의 참·거짓 검증을 뜻하지 않는다. 실제 commit/merge를 막는 hook, Check Run, branch protection 변경은 이 report 기능의 동작이 아니다. 외부 PR 게시 여부는 기존 repository toggle을 따른다.

Built-in Skill은 application package에 포함한다. 관리자 version은 전역 bundle이며 기존 tenant prompt와 별도로 관리한다. Worker는 queued 분석에 저장된 bundle만 사용한다. Tenant prompt와 Skill은 source-as-untrusted guard, 인증/인가, output schema를 변경할 수 없다. 대상 PR이 추가한 SKILL.md, TODO, type-ignore 같은 source 문자열만으로 보안 검사를 끄거나 시스템 지침을 바꾸지 않는다. 이는 local pre-commit 도구와 중앙의 untrusted PR 검토 서비스가 다른 신뢰 경계를 갖기 때문이다.

## Commit phase

- 완료한 선행 기능: `4ca28e3` — Files tree, line navigation, 등록 account 기반 batch 분석.
- Phase A: 위 요구사항과 구현 경계를 기록한다.
- Phase B: Skill catalog/parser, segment·unit/report contract, 집계 및 회귀 test를 구현한다.
- Phase C: 관리자 Skill version API/DB/UI와 Worker의 고정된 Skill 기반 모델 orchestration을 연결한다.
- Phase D: Overall Summary·AI Comments·Analyzed File List, inline navigation, JSON/Markdown/PR 게시와 가이드를 연결한다.
- Phase E: 전용 DB integration, 실제 local Server/Worker와 모의 모델, desktop/mobile browser, lint/typecheck/build/Helm을 검증하고 handoff와 최종 검증 근거를 남긴다.

각 phase는 검증 후 commit·push한다. 클러스터 배포는 현재 요청에 포함되지 않는다.

## 진행 기록

- Phase A: `9e5ded5`로 요구사항을 기록하고 원격 branch에 push했다.
- Phase B: 9개 기본 SKILL.md, 제한된 frontmatter parser, bundle hash 검증, stage별 prompt 조립, base/head별 bounded window와 overlap, unit/segment/파일 요약의 일대일·일대다 contract 및 집계 함수를 추가했다. 기존 v1 report에는 optional `analysis` 확장으로 추가한다. 새 metadata는 아직 Worker/UI에 연결하지 않았다.
- Phase B 검증: review-contract/analysis-engine의 24 tests와 두 package build, 전체 lint를 통과했다. Dockerfile에 기본 Skill directory COPY를 추가했다. 실제 image build와 Worker/browser 검증은 Phase E에 남아 있다.
- Phase C-1: migration 0014, 관리자 `/api/v1/admin/analysis-skills` 조회·version 저장·activate·reset API와 `analysis_skill` Cerbos policy를 구현했다. Version 본문/hash/생성정보 변경과 삭제는 DB trigger로 막고 활성 상태만 변경한다. Concurrent save는 advisory lock으로 직렬화한다. 분석 run의 bundle/hash snapshot column과 검증 함수를 준비했으며 Worker INSERT/실행 경로는 아직 연결하지 않았다.
- Phase C-1 검증: 전용 PostgreSQL에서 migration 0001–0014와 Skill integration 5개를 포함한 전체 169 tests(30 files)가 통과했다. Concurrent save, 같은 bundle 재사용, 기본값 복원, 이전 bundle 검증, 본문 불변성, reviewer 차단과 audit에 지침 원문을 남기지 않음을 검사했다. Cerbos compile/test 35개, 전체 lint/typecheck, PRISM-DEV Helm lint도 통과했다.
- 다음 작업: Phase C-2 Worker Skill snapshot 고정과 모델 orchestration, C-3 관리자 Skill 편집 UI, Phase D report 화면/export/게시, Phase E 통합 검증. R1–R10 전체 완료를 아직 주장하지 않는다.

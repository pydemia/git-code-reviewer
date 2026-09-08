# 분석 Skill 번역과 Severity Level

2026-09-08 구현. 이번 변경은 아직 PRISM-DEV에 배포하지 않았다.

## 원문과 번역 범위

Commit Defender [revision 14203044](https://github.com/pydemia/commit-defender/tree/14203044e4e0cf2ba5d44fcf521425a4113f7840/.commit-defender)의 Correctness·Maintenance·Optimization·Review History·Security·Setting을 번역했다. Correctness·Maintenance는 사용자가 첨부한 원문과 대조했다. 각 점검 항목과 Tone을 유지하고 전문용어는 영어로 남겼다. 원문 번역과 git-code-reviewer의 근거·priority·Secret 비노출 기준을 별도 절로 구분했다.

`packages/analysis-engine/skills/*/SKILL.md`의 perspective version은 2다. Report form 3개의 내용과 version은 바꾸지 않는다. 원문 출처와 Apache-2.0 license는 같은 디렉터리의 `THIRD_PARTY_NOTICES.md`, `LICENSE.commit-defender`에 보관한다.

활성 custom bundle은 배포로 덮어쓰지 않는다. 관리자는 분석 Skills 화면에서 ‘Built-in을 초안으로 불러오기’ 후 기존 지침과 비교·편집하고 새 version을 저장·활성화한다. Built-in 사용 환경의 새 작업에는 배포된 version 2가 적용된다. Queue에 고정된 bundle과 과거 report는 재작성하지 않는다.

## 수준별 동작

분석 프롬프트의 Severity Level은 **tenant별 검토 범위**다. 분석 Provider의 account·model·reasoning effort와 독립적이며 호출 예산을 바꾸지 않는다.

| Level | 한국어 설명 | 허용 comment |
| --- | --- | --- |
| lean | 기능 중단·보안 취약점·데이터 손실 등 치명적인 문제만 보고한다. | P3 |
| generous | 실제 위험이 분명한 오류와 중요한 경고를 중심으로 검토한다. | P2·P3 |
| moderate (기본값) | 의미 있는 문제와 개선점을 균형 있게 검토한다. | P2·P3, P1은 파일당 최대 2개 |
| rigorous | 작은 개선점과 best practice 위반까지 폭넓게 검토한다. | P1·P2·P3 |
| severe | 근거 있는 모든 개선점을 엄격히 검토하고 잘된 변경에 대한 의견도 허용한다. | P0·P1·P2·P3 |

P0는 Praise, P1은 선택적 제안(기존 UI의 Info), P2는 Warning, P3는 Critical이다. Severe에서도 comment를 채우기 위한 Praise를 만들지 않고 동일 파일의 문제 지적과 모순되는 Praise는 제거한다. Level이 높다는 이유로 priority를 올리거나 낮은 수준을 선택했다는 이유로 확인된 P3를 낮추지 않는다. Secret leak·exploit은 근거를 갖춰 P3로 보고한다. Level은 지적할 범위를 바꾸며 검사 범위 밖의 안전성을 보장하지 않는다.

Commit Defender의 [Prompt](https://github.com/pydemia/commit-defender/blob/14203044e4e0cf2ba5d44fcf521425a4113f7840/vscode-extension/src/ai/prompt.ts)와 [실제 필터](https://github.com/pydemia/commit-defender/blob/14203044e4e0cf2ba5d44fcf521425a4113f7840/vscode-extension/src/ai/reviewer.ts)를 기준으로 이식했다. 원본 package.json의 설명과 실행 코드가 다른 부분은 그대로 복사하지 않았다. 특히 rigorous는 P0를 제외하며 severe라고 모든 항목을 P2로 승격하지 않는다. 대상 코드의 TODO·skip 지시를 신뢰하는 동작도 이식하지 않았다.

## 저장과 실행

`POST /api/v1/admin/tenants/:tenantId/analysis-prompts`의 body:

```json
{ "instructions": "", "severityLevel": "moderate" }
```

추가 지침은 비울 수 있다. Severity Level을 생략한 이전 API client는 moderate로 저장한다. 지원하지 않는 값은 400이며 기존 활성 version을 바꾸지 않는다. 조회 응답의 `active`와 `items[]`에는 `severityLevel`이 포함된다. 관리자 및 tenant 권한 검사는 기존대로 유지한다.

Migration `0017_analysis_severity.sql`은 다음을 적용한다.

- `analysis_prompt_versions.severity_level`: NOT NULL, 기본 moderate, 5개 값만 허용한다. Version의 지침·level·hash·작성 정보를 수정하거나 삭제하지 못하는 trigger를 추가한다. 활성 여부와 활성화 기록은 변경할 수 있다.
- 새 version의 hash: 정규화한 instructions와 severityLevel을 `analysis-prompt-v2` 형식의 JSON으로 함께 SHA-256 계산한다. 같은 조합을 다시 저장하면 기존 version을 재활성화한다. 기존 version hash는 재계산하지 않는다.
- `analysis_runs.severity_level`: nullable. 새 작업은 snapshot materialization 시 활성 Prompt의 level 또는 기본 moderate를 고정한다. Prompt ID·hash·level은 실행 후까지 변경할 수 없다. Analysis key v6과 policy hash v3에 level을 포함한다.
- Migration 이전 작업의 NULL은 의도적인 legacy 표시다. 당시의 동작을 유지하며 현재 활성 level을 나중에 대입하지 않는다. 빈 지침을 저장했더라도 Prompt version 참조는 유지한다.

Worker는 unit-comment-block·overall-summary·total-summary의 모든 모델 호출에 선택한 수준을 전달한다. Window 결과의 category·line·priority를 검증하고 중복을 제거한 뒤 파일 단위로 수준 필터를 적용한다. Moderate의 P1 한도는 window별로 초기화하지 않는다. 필터를 통과한 동일 unit 집합으로 파일 요약과 전체 요약을 만든다. 의도적으로 제외한 낮은 priority는 분석 실패나 coverage 누락으로 집계하지 않는다.

Report의 `versions.severity`와 `versions.prompt`가 적용 수준·Prompt version을 기록한다. Null level의 구형 report에는 severity를 새로 만들어 넣지 않는다. 모델의 최종 판단 품질까지 보장하는 설정은 아니며 기존 근거 검증과 분석 제한 안내는 유지한다.

## 화면과 복원

분석 프롬프트에서 tenant를 선택하면 5개 radio 항목과 각 한국어 설명·priority 범위를 함께 표시한다. Tenant 데이터를 불러오는 중에는 입력·저장·활성화를 막고 이전 요청의 늦은 응답을 무시한다. 선택 항목은 native radio와 fieldset/legend로 키보드 조작을 지원한다.

‘새 버전 저장 및 활성화’는 지침과 수준을 함께 저장한다. Version history는 수준·설명·지침을 보여주며 이전 version 활성화 시 둘 다 복원한다. ‘기본값 복원’은 추가 지침 없음·moderate로 돌아간다. 기존 PR에 적용하려면 새 분석을 생성해야 한다.

## Commit phase

- Phase 1: 6개 Skill 원문 번역, 출처·license, checklist 회귀 테스트. Commit `2ff10b5`.
- Phase 2: shared contract, migration, API, immutable queue pinning, 모델 지침·필터와 단위/DB integration 검증. Commit `1c89187`.
- Phase 3: 관리자 UI, 사용 가이드, 설계·handoff, desktop/mobile 확인 후 commit·push. 클러스터 배포와 live 모델·GHES 검증은 별도 요청 범위다.

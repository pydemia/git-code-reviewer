# 분석 모델·파일 병렬 처리 UI 기록

2026-09-09. 기존 Administration의 분석 모델 화면에 파일 병렬 처리 설정과 Model·Effort 설명을 확장한 결과를 기록한다. 전역 디자인 규칙을 추가하지 않으며 `PRODUCT.md`, 루트 `DESIGN.md`와 `.impeccable/design.json`은 유지한다.

근거는 `apps/web/index.html`의 방향 계약, `apps/web/src/AdminPage.tsx`의 `ProviderPanel`·초기 draft, `analysis-provider-ui.ts`, `styles.css`의 Provider 관련 규칙, `GuidePage.tsx`의 `analysis-provider` 절이다. 아래 캡처를 직접 확인했다.

| 캡처 | 크기 | 확인한 화면 |
| --- | --- | --- |
| [parallel-model-desktop.png](parallel-model-desktop.png) | 1440×1000 | 현재 설정, 편집 필드, 도움말, 저장 action과 버전 이력 |
| [parallel-model-mobile.png](parallel-model-mobile.png) | 390×844 | 가로 Admin navigation, 현재 설정, 한 열로 쌓인 선택 필드 |
| [parallel-model-mobile-actions.png](parallel-model-mobile-actions.png) | 390×844 | 병렬 수와 Timeout, 도움말, 저장·테스트·Deployment action과 버전 이력 |

## Overview

관리자가 새 PR 분석에 사용할 Account·Model·Reasoning effort와 파일 병렬 처리 수를 한 화면에서 지정한다. 상단 상태 영역은 현재 적용 중인 설정을 표시하고 그 아래 editor는 새로 저장할 값을 다룬다. 저장 범위 설명은 editor 첫 문단에 두며 이미 생성된 분석과 Report가 유지된다는 조건을 함께 표시한다.

기존 회색/teal Admin shell, 조밀한 form, Lucide icon과 버전 이력을 사용한다. Worklist·Workspace·Review Chat·diff·FNB의 구성은 이번 확장의 설계 범위에 포함하지 않는다.

## Colors

회색 canvas와 상태 영역, 흰 editor·native control, 기존 border로 화면을 구획한다. Teal은 현재 navigation, 선택 상태와 주요 저장 action에 사용한다. 새 palette나 전역 color token은 추가하지 않는다. 버전의 `Active` 표기와 기존 왼쪽 강조선은 그대로 사용한다.

## Typography

기존 Noto Sans KR 계열과 코드용 monospace, heading·label·metadata의 위계를 유지한다. Provider의 문단 도움말은 13px/1.8, 최대 78ch이며 필드 바로 아래 보조 설명은 11px/1.6이다. 한글 설명 안의 Account·Model·Effort·Timeout·Summary 등 기존 개발 용어를 유지한다. 이 화면의 보조 설명 크기를 다른 화면의 전역 본문 기준으로 확대하지 않는다.

## Layout

Desktop은 기존 왼쪽 Admin navigation과 본문 구조를 유지한다. 본문은 제목 → 현재 설정 → 적용 범위 설명 → Provider mode → 입력 필드 → 등록·요청 제한 도움말 → action → 버전 이력 순서다. 입력은 두 열이며 Account와 Effort가 넓은 왼쪽 열, Model과 파일 병렬 처리 수가 오른쪽 열에 배치된다. Timeout은 다음 행으로 이어진다.

820px 이하에서 Admin navigation은 가로 scroll로 전환하고 Provider 상태 영역은 두 열로 줄인다. 540px 이하에서는 상태와 입력을 한 열로 쌓으며 mode control은 본문 너비를 사용한다. 390px 캡처에서 label·select·설명은 해당 필드와 함께 읽히고 긴 도움말은 줄바꿈된다. 저장 action과 이력은 화면 아래로 이어지므로 별도의 actions 캡처로 확인했다.

Desktop action은 왼쪽의 `Deployment 설정`과 오른쪽의 `연결 테스트`·`새 버전 저장 및 활성화`로 나뉜다. 모바일에서는 전체 너비 버튼을 사용하고 시각적 순서는 저장 → 연결 테스트 → Deployment 설정이다. CSS의 `column-reverse`에 따른 순서이며 DOM 순서는 Desktop과 같다. 버전 이력은 모바일에서 metadata와 시각·활성화 action을 세로로 나눈다.

## Elevation & Depth

상태 영역과 editor는 배경색과 테두리로 구분하며 새 panel shadow를 추가하지 않는다. Mode의 선택 버튼에 있는 작은 기존 shadow는 유지한다. 공통 keyboard focus의 2px outline과 2px offset을 그대로 사용한다.

## Components

### 선택 필드와 도움말

- 활성화된 account 중 분석에 필요한 tenant 또는 all 권한이 있는 account만 표시한다. Account를 선택하면 첫 활성 Model과 그 기본 Effort를 채우고 Model을 바꾸면 해당 Model의 기본 Effort로 갱신한다. Effort 목록은 Model의 허용값을 사용한다.
- Effort 바로 아래에는 선택값에 맞는 설명을 표시한다. low·medium·high·xhigh는 `analysis-provider-ui.ts`의 공통 문구를 사용하며 그 밖의 값은 Model이 허용하는 Effort를 선택하라는 안내를 표시한다. 속도·검토 깊이의 관계는 안내 문구이며 측정 결과가 아니다.
- 파일 병렬 처리 수는 native select의 1–4개 고정 선택지다. 1개에는 `순차 처리`, 나머지에는 `병렬 처리`를 표시한다. 사용자 선택에 따른 새 draft 기본값은 4개이며 Deployment 설정에서 새 draft를 만들 때도 4개로 제안한다. 기존 Admin 설정을 읽을 때는 저장된 값을 유지한다. 현재 적용값을 나타내는 상단 상태와 새 draft 기본값은 구분한다.
- 필드 도움말은 한 PR의 파일을 동시에 검토하되 파일 안의 코드 구간은 순서대로 검토하고 PR 전체 Summary는 마지막에 생성한다고 설명한다. Account 단위 분석 요청 최대 4개와 별도 Review Chat 1개 제한, Retry-After 대기는 아래 문단에서 안내한다. 병렬 수와 소요 시간이 비례한다는 주장은 하지 않는다.
- 선택지가 없을 때는 `ChatGPT accounts에서 Model·Effort 등록` 링크를 제공한다. 가이드의 자동 분석 절은 등록 권한, 설정 순서, 기본값, 파일 내부 순차 처리, 저장 후 적용 범위와 버전 고정을 설명한다.

### 상태와 접근성

Mode는 native button의 `aria-pressed`로 선택 상태를 표시한다. Account·Model 등 필드는 `label`로 연결되며 Effort와 파일 병렬 처리 수는 `aria-describedby`로 바로 아래 도움말을 참조한다. Mode·입력·action은 권한과 busy 상태에 따라 비활성화된다. Model·Effort가 아직 선택 가능하지 않은 경우에도 해당 select가 비활성화된다.

저장은 허용 Model·Effort 또는 유효한 OpenAI 호환 입력, 1,000–600,000ms Timeout, 정수 1–4개 병렬 수가 충족되어야 활성화된다. 비활성 mode에서는 연결 테스트를 비활성화한다. 분석용 account가 없으면 `role="status"` 안내를 표시하고 Admin 작업 메시지도 기존 `role="status"` 영역을 사용한다. 이는 소스에서 확인한 동작이며 별도의 screen reader·keyboard 실사용 테스트 결과를 뜻하지 않는다.

### 저장과 이력

주요 action의 이름은 `새 버전 저장 및 활성화`로 결과를 명시한다. 이력에는 버전, Provider mode, Model, 병렬 수, Account·Effort, configuration hash와 시각을 표시한다. 활성 버전은 `Active` 텍스트로 구분하고 비활성 버전에는 활성화 버튼을 제공한다.

새 설정은 이후 생성되는 분석에 적용된다. 기존 분석의 Account·Model·Effort와 병렬 수는 해당 버전에 고정하며 실행 중인 분석과 기존 Report를 변경하지 않는다는 설명을 유지한다. Review Chat의 모델 선택은 자동 분석 설정과 별도다.

## Do's and Don'ts

- 현재 적용값, 편집 중인 값과 새 draft 기본값을 구분한다. 기본값 4개를 기존 저장 버전의 일괄 변경으로 해석하지 않는다.
- Desktop과 모바일 상단 캡처의 `synthetic-deep`·high·2개, 이력의 `synthetic-fast`·low·4개는 저장·재활성화 상호작용을 확인한 합성 검증 데이터다. 모바일 actions 캡처는 이전 4개 버전이 활성화된 다른 상태다. 이를 운영 기본 Model·Effort로 문서화하지 않는다. 배포 직전에 다시 조회한 운영 Account·Model·Effort를 보존한다.
- Timeout·분석 예산을 줄여 검토 범위를 생략하거나 고정 배수의 속도 향상을 약속하지 않는다. 이 기록은 성능 측정이나 backend 동시성 검증 결과를 추가하지 않는다.
- 루트 디자인 문서와 sidecar를 재생성하지 않는다. 기존 버전 이력의 왼쪽 강조선, 모바일 action의 10px 글자와 이 화면의 일회성 수치는 새로운 전역 디자인 규칙으로 정하지 않는다.

[최종 검토 기록](parallel-model-finish-review.md)의 판정은 `ship`이며 이번 변경 범위에서 필수 수정 사항은 없었다. 이 문서 작성에서는 제공된 소스와 캡처를 확인했으며 저장·재조회·이전 버전 활성화 테스트를 다시 실행하지 않았다.

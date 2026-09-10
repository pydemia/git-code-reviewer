---
name: Worklist PR 상태 필터
description: 기존 Worklist에 추가한 GitHub PR 상태와 필터의 구현 기록
---

# Worklist PR 상태 표시 기록

## Overview

2026-09-09 구현 기준입니다. `apps/web/src/App.tsx`, `PullRequestFilters.tsx`, `styles.css`와 `apps/web/index.html`의 방향 계약을 근거로 작성했습니다. 기존 `PRODUCT.md`와 `DESIGN.md`의 회색/teal, Noto Sans KR, Lucide, 조밀한 panel 구성을 그대로 확장했습니다. 새 시각 체계나 공통 토큰은 추가하지 않았으며 이 기록은 루트 `DESIGN.md`와 `.impeccable/design.json`을 대체하지 않습니다.

## Colors

기존 canvas·surface·border로 바탕과 목록을 구획합니다. Open과 Merged는 accent, Closed는 muted를 사용하며 상태명과 서로 다른 아이콘을 함께 표시합니다. 검토 평가는 별도 열에 유지합니다. 선택한 필터는 흰 바탕과 테두리, 선택하지 않은 필터는 필터 바의 회색 바탕으로 구분합니다. 목록 조회 실패는 danger, repository 동기화 실패 안내는 warning을 사용합니다.

## Typography

기존 Noto Sans KR Variable 스택을 유지합니다. 페이지 제목은 (27px), PR 제목은 (13px, 700), 상태·metadata·검토 평가는 (11px), 필터와 안내문은 (12px)입니다. (540px) 이하에서 페이지 제목은 (23px)로 줄어듭니다. PR 제목과 metadata는 한 줄 말줄임을 적용합니다.

## Layout

Global header 아래 중앙 Worklist를 최대 (1120px)로 배치합니다. 제목·새로고침 → Closed/Merged 및 polling 안내 → 조건부 동기화 안내 → Open·Closed·All 필터와 건수 → PR 목록 순서입니다. Desktop 목록은 PR 제목·metadata, PR 상태, 검토 평가, 업데이트의 네 열이며 뒤 세 열은 각각 (120px·128px·90px)입니다.

(820px) 이하에서는 열 제목과 업데이트 시각을 숨기고 두 열로 재배치합니다. 왼쪽은 제목·metadata 아래에 PR 상태, 오른쪽은 두 행에 걸친 검토 평가입니다. (540px) 이하에서는 좌우 여백을 각각 (10px), PR 행 최소 높이를 (78px), 행 간격을 (8px)로 조정합니다. 필터의 텍스트와 건수는 모바일에서도 유지하며 새로고침은 아이콘으로 표시합니다.

## Elevation & Depth

기존 배경색 차이와 얇은 경계선을 사용합니다. 필터 바와 목록에 새로운 그림자는 없습니다. 버튼과 링크의 키보드 focus는 기존 outline (2px)과 offset (2px)을 따릅니다.

## Shapes

필터 버튼은 기존 control radius (5px), 건수는 작은 둥근 배지로 표시합니다. 목록은 행 구분선을 유지하며 개별 PR을 별도 카드로 분리하지 않습니다.

## Components

필터는 `PR 상태 필터`라는 이름의 그룹이며 선택한 버튼을 `aria-pressed`로 전달합니다. 기본 선택은 Open이고 URL의 `state` 값으로 선택을 복원합니다. Closed는 Merged를 포함하며 버튼의 `aria-describedby`가 해당 안내문을 연결합니다.

| 상태             | 구현된 표시                                                                                              |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| 선택             | Open·Closed·All 중 하나에 흰 바탕과 테두리, 각 버튼에 조회 건수                                          |
| 로딩             | 건수는 `–`, 목록은 `aria-busy`, 회전하는 RefreshCw와 “PR을 불러오는 중입니다.” 표시. 새로고침은 비활성화 |
| 빈 목록          | 선택에 따라 “Open PR이 없습니다.”, “Closed 또는 Merged PR이 없습니다.”, “수집된 PR이 없습니다.” 표시     |
| 목록 조회 실패   | CircleAlert와 “PR 목록을 불러오지 못했습니다.” 표시                                                      |
| 동기화 실패      | 실패한 repository 수와 마지막 수집 상태임을 안내하는 `status` 문구                                       |
| 최초 동기화 대기 | 대기 중인 repository 수를 별도 `status` 문구로 표시                                                      |

PR 상태에는 Lucide `GitPullRequest`(Open·Open · Draft), `GitPullRequestClosed`(Closed), `GitMerge`(Merged)를 (14px)로 사용합니다. 분석 결과가 없는 Closed/Merged 행에는 “GitHub에서 보기”와 `ExternalLink`(11px)를 표시하고 원문을 새 탭으로 엽니다. 분석 결과가 있으면 저장된 검토 화면으로 이동합니다. 상태·외부 링크 아이콘은 텍스트를 보조하며 `aria-hidden`입니다.

시각 확인 자료는 [desktop](pr-state-desktop.png), [mobile](pr-state-mobile.png), [넓은 화면](pr-state-user-2501.png)입니다. 기존 앱을 캡처한 검토 자료이며 화면에 표시된 합성 검증 데이터는 실제 GitHub 동기화 성공의 증거로 취급하지 않습니다. 로딩·빈 목록·오류 설명은 소스의 렌더링 분기에 근거했습니다. 제품에 새 이미지 자산을 추가하지 않았습니다.

## Do's and Don'ts

- PR 상태와 검토 평가는 별도 정보로 유지하며 Merged만으로 검토 성공을 표시하지 않습니다.
- 상태는 색상과 함께 텍스트·Lucide 아이콘으로 구분합니다.
- 이번 화면의 열 너비와 모바일 재배치를 전역 디자인 토큰이나 다른 화면의 강제 규칙으로 확대하지 않습니다.
- 외부 링크의 문자 glyph는 Lucide `ExternalLink`로 교체되어 향후 패턴으로 기록하지 않습니다.

---
name: Git Code Reviewer
description: 사내 PR 검토와 분석 설정을 위한 기존 웹 UI의 시각적 기준
colors:
  accent: '#176b5d'
  accent-soft: '#e3f2ee'
  accent-hover: '#125c50'
  selected-text: '#155e52'
  canvas: '#f4f6f8'
  surface: '#ffffff'
  surface-subtle: '#f7f8fa'
  border: '#d9dee5'
  border-strong: '#c7cdd6'
  text: '#20252d'
  muted: '#69717d'
  header: '#1f252c'
  header-text: '#f7f9fb'
  code: '#161a20'
  focus: '#268b7a'
  danger: '#b42318'
  warning: '#b54708'
  report-failed-text: '#9c241b'
  report-failed-bg: '#fce9e7'
  report-incomplete-text: '#8a3c09'
  report-incomplete-bg: '#fff0d9'
typography:
  body:
    fontFamily: 'Noto Sans KR Variable, Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif'
    letterSpacing: '0'
  headline:
    fontSize: '27px'
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontSize: '14px'
    fontWeight: 700
  label:
    fontSize: '12px'
    fontWeight: 650
  report-body:
    fontSize: '12px'
    lineHeight: 1.65
  skill-code:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'
    fontSize: '12px'
    lineHeight: 1.7
rounded:
  inline: '3px'
  compact: '4px'
  control: '5px'
  dialog: '6px'
  registry: '7px'
  panel: '8px'
spacing:
  inline: '8px'
  row: '12px'
  panel: '16px'
  form: '18px'
  section: '24px'
components:
  button-primary:
    backgroundColor: '{colors.accent}'
    textColor: '{colors.surface}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0 11px'
  button-primary-hover:
    backgroundColor: '{colors.accent-hover}'
    textColor: '{colors.surface}'
  button-secondary:
    backgroundColor: '{colors.surface}'
    textColor: '#333b45'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0 11px'
  input:
    backgroundColor: '{colors.surface}'
    textColor: '#27313a'
    rounded: '{rounded.control}'
    padding: '0 9px'
    height: '34px'
  navigation-active:
    backgroundColor: '{colors.accent-soft}'
    textColor: '{colors.selected-text}'
    typography: '{typography.label}'
    rounded: '{rounded.control}'
    padding: '0 10px'
  report-state-pass:
    backgroundColor: '{colors.accent-soft}'
    textColor: '{colors.selected-text}'
    rounded: '{rounded.inline}'
    padding: '3px 7px'
  registry-card:
    backgroundColor: '{colors.surface}'
    rounded: '{rounded.registry}'
    padding: '12px 14px'
  report-comment:
    backgroundColor: '{colors.surface-subtle}'
    textColor: '{colors.text}'
    rounded: '{rounded.compact}'
    padding: '12px'
  skill-editor:
    backgroundColor: '#fbfcfd'
    textColor: '#27313b'
    typography: '{typography.skill-code}'
    rounded: '{rounded.compact}'
    padding: '12px'
---

# Design System: Git Code Reviewer

## Overview

회색 바탕과 흰색 panel 위에 teal action·선택 상태를 표시한다. 짙은 global header와 code surface가 작업 영역의 경계를 만들며 한글 설명, English 개발 용어와 코드가 함께 읽히도록 Noto Sans KR와 monospace를 구분한다. 반복 작업에 맞춘 조밀한 control과 분할 panel을 유지한다.

2026-09-07 구현에서 추출했다. 값의 근거는 `apps/web/src/styles.css`, `main.tsx`, `workspace-layout.ts`이며 컴포넌트 동작은 `AdminPage.tsx`, `App.tsx`, `AnalysisSkillsPanel.tsx`, `ReviewReportPanel.tsx`를 따른다. `PRODUCT.md`와 `apps/web/index.html`의 기존 회색/teal 앱 확장 방향을 적용했다. 과거 설계 문서와 수치가 다르면 현재 소스를 우선한다. Frontmatter의 radius·spacing 이름은 구현값을 문서화한 이름이며 별도 CSS 변수가 아니다.

## Colors

Primary는 `accent`와 `accent-soft`다. 주요 저장 action과 경로 link에는 accent, 현재 navigation과 선택한 comment에는 accent-soft를 사용한다. Primary hover는 accent-hover, keyboard focus와 활성 comment의 테두리는 focus를 사용한다.

Neutral은 canvas, surface, surface-subtle로 바탕·내용·보조 영역을 나눈다. Border와 border-strong은 panel 구획과 입력 control의 경계를 구분한다. Text는 본문, muted는 metadata와 도움말에 사용하며 header/header-text와 code는 어두운 shell·diff 영역을 담당한다.

Danger와 warning은 기존 severity·위험 표시의 의미색이다. Report의 BLOCKED/FAILED와 INCOMPLETE는 각각 별도 text/background 쌍을 사용한다. PASS에는 선택 상태와 같은 teal 계열을 쓰되 상태 label과 분석 제한 설명을 함께 표시한다.

## Typography

Body stack의 첫 서체인 Noto Sans KR Variable은 `main.tsx`에서 실제로 불러온다. Inter와 OS 서체는 fallback이다. 본문 전체를 하나의 크기로 통일하지 않고 worklist·admin·report의 각 역할에 정의된 크기를 유지한다.

일반 페이지 heading은 headline, Report/Skills section heading은 title을 따른다. Skills page heading은 (25px), Report heading은 (17px)이다. Command button과 Admin navigation은 label을 사용한다. Report 본문은 report-body, 긴 설명은 추가 line-height (1.75)를 적용하고 metadata는 (11px)로 구분한다. SKILL.md 편집기는 skill-code를 사용한다. Lucide icon은 action·navigation의 의미를 보조하며 아이콘만 있는 버튼에는 accessible name이 있다.

## Layout

Desktop review workspace는 global header (44px), PR context (42px), 나머지 높이를 사용하는 panel grid다. 초기 LNB·Chat 너비와 FNB 높이는 각각 (244px·316px·176px)이며 사용자가 separator로 조정한다. LNB는 Files·Outline·Impact 탐색에 집중하고 메인은 Code·Summary·Comments를 탭으로 전환한다. Admin은 navigation (210px)과 본문으로 나누고 본문은 최대 (1180px), worklist는 최대 (1120px)다.

좁은 화면에서는 실제 CSS breakpoint를 따른다. (1100px) 이하에서 context metadata를 줄이고 (820px) 이하에서 workspace를 LNB → diff → FNB → Chat 순서로 쌓는다. 같은 breakpoint에서 Admin navigation은 가로 scroll로 전환한다. Skills workbench는 (760px) 이하에서 목록을 select로 바꾸고 editor를 한 열로 표시한다. (540px) 이하에서도 Skills action은 텍스트 label을 유지하며 저장 버튼은 본문 너비를 사용한다.

간격은 control 내부와 행, panel padding을 구분한다. Report section과 Skills editor는 panel spacing, comment는 row spacing을 사용한다. Summary는 전체 상태·Overall Summary·Analyzed File List·provenance를 표시하고 Comments는 Commit Defender의 unit-comment-block을 파일별로 표시한다. 파일 경로와 긴 Report 설명은 줄바꿈하고 metadata·action 묶음은 공간에 따라 wrap한다.

## Elevation & Depth

Workspace·Admin panel은 배경색 차이와 선으로 구획한다. 로그인 카드와 modal에는 각각의 box-shadow가 있으며 이를 전체 panel의 기본 shadow로 확대하지 않는다. 정확한 shadow와 resize handle·switch의 transition (120ms ease)은 `.impeccable/design.json`에 기록한다. Button·link·input·select·textarea의 keyboard focus는 outline (2px)과 offset (2px)으로 표시한다.

## Shapes

Status와 inline code는 inline radius, comment·Skills editor는 compact radius, 버튼·일반 입력·navigation은 control radius를 사용한다. Registry card와 form은 각각 registry·panel radius를 사용한다. Workspace panel과 Skills workbench는 직선 테두리로 연결하고 dialog에는 dialog radius를 적용한다. 모든 surface를 같은 둥근 카드로 바꾸지 않는다.

## Components

### Buttons

Command button은 최소 높이 (32px), icon/text 간격 (7px)의 공통 control이다. Primary는 저장·적용 action에 쓰며 Secondary는 흰 바탕과 border-strong으로 구분한다. Hover는 배경과 테두리 색이 바뀐다. Skills의 busy/disabled 버튼은 opacity (0.55)와 `not-allowed` cursor를 적용한다. 일반 command의 disabled 상태는 opacity (0.62)와 `progress` cursor다.

### Inputs / Fields

일반 입력은 label 아래에 배치하며 field 높이와 padding은 input token을 따른다. Disabled 입력은 회색 글자와 바탕을 사용한다. SKILL.md 편집기는 textarea로 구현하며 세로 resize, teal caret, 긴 행의 편집을 지원한다. 최소 높이는 desktop (430px), Skills 모바일 전환 이후 (360px)다. 저장 결과는 `status`, 오류는 `alert`로 알린다.

### Navigation

Admin navigation은 icon과 label을 나란히 표시하고 active 항목은 teal tint와 테두리로 구분한다. Skills 목록도 같은 선택색을 쓰며 현재 항목을 `aria-current`로 표시한다. Workspace의 Files·Outline·Impact는 LNB에, Code·Summary·Comments는 메인 toolbar에, Evidence·Git graph·Impact·Tests는 하단 tool tab에 둔다.

### Cards / Containers

Registry card는 metadata와 action을 한 행에 배치하고 작은 화면에서 한 열로 바꾼다. Report는 section 사이의 divider와 파일 묶음의 간격을 사용한다. Version history는 행 구분선, version·시각·hash와 우측 action으로 구성한다.

### Report States / Comments

Report 상태 badge와 priority는 별도 항목으로 표시한다. Overall Summary → AI Comments → Analyzed File List 순서는 Report 컴포넌트에 적용된다. Sticky section navigation의 높이를 측정해 이동한 heading이 가려지지 않게 한다.

Comment button은 category·line range·문제·영향·수정 제안을 펼쳐 읽을 수 있는 형태다. Hover는 옅은 녹색, selected는 accent-soft와 focus 테두리를 사용하며 선택 여부는 `aria-pressed`로 전달한다. 경로와 comment 선택은 같은 analysis revision의 diff로 이동한다. Comment가 없거나 검토하지 못한 파일도 파일 목록에서 확인할 수 있다.

## Do's and Don'ts

- Do: 기존 색상 token과 control을 재사용하고 상태·선택·action의 역할을 유지한다.
- Do: 한글 안내와 원래 English 개발 용어를 함께 유지한다.
- Do: Report 설명과 파일 경로는 줄바꿈하고 Skills 모바일 action의 label을 표시한다.
- Don't: Report의 실패·미수행·데모 상태에 성공 grade를 표시하지 않는다.
- Don't: 기존 Admin·Workspace 확장에 별도 서체·palette·panel 형태를 도입하지 않는다.

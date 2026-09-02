# Review Workspace — UI 구현 설계

## 1. 문서 위치와 적용 범위

이 문서는 `.documents/blueprint.md`의 UI Blueprint를 실제 web application으로 구현할 때의 layout, navigation, state와 기능 경계를 정의한다. `.documents/visuals/review-workspace.html`은 정보 밀도와 시각 방향을 확인하기 위한 interaction prototype이며, production 기능 목록이나 panel 배치를 제한하지 않는다.

기준 화면은 code reviewer가 finding과 근거를 확인하면서 agent와 동시에 대화하는 desktop workspace다. 특정 panel을 열기 위해 Chat이나 현재 선택 문맥을 닫게 만들지 않는다.

이 문서에서 **LNB**는 사용자가 말한 왼쪽 SNB, **Chat dock**은 오른쪽 SNB, **FNB tool dock**은 하단 navigation/tool 영역을 뜻한다.

### 1.1 UI locale과 용어 정책

- 기본 locale은 `ko-KR`이며 document root는 `<html lang="ko">`로 렌더링한다. 사용자 설정이 없을 때 browser locale 때문에 영어로 바뀌지 않는다.
- 버튼, 상태, 오류, 빈 화면, loading, 도움말, finding 제목·설명과 Chat 응답은 한글 문장으로 작성한다.
- 개발 문맥에서 고유한 의미를 가진 `PR`, `diff`, `snapshot`, `finding`, `commit`, `merge-base`, `HEAD`, `Git graph`, `Worker`, `runtime`, `container`, `queue`, `Chat`, `API`, `SSE`는 영어 표기를 유지한다. 억지로 번역해 다른 개념처럼 보이게 하지 않는다.
- code identifier, file path, branch, SHA, environment key와 API field는 원문을 유지하고 설명 조사와 서술어만 한글 문장에 자연스럽게 연결한다.
- domain enum은 API contract의 영어 값을 유지하고 UI message catalog에서 한글 표시값으로 변환한다. 사용자에게 보이는 문구를 component와 server error에 직접 hard-code하지 않는다.
- 날짜, 상대 시간, 숫자는 `Intl.DateTimeFormat`, `Intl.RelativeTimeFormat`, `Intl.NumberFormat`에 `ko-KR`을 지정한다. 접근성 label과 live-region 문구도 같은 message catalog를 사용한다.

## 2. Workspace topology

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ Header: repository · PR · snapshot · run/stale/refresh · coverage          │
├───────────────┬──────────────────────────────────────────┬──────────────────┤
│ LNB           │ Main workspace                           │ Chat dock        │
│               │                                          │ always mounted   │
│ Files         │ Split / unified diff                     │ scope            │
│ Findings      │ File / symbol / commit view              │ conversation     │
│ Outline       │ Tool maximized view                      │ evidence links   │
│ Impact        │                                          │ composer         │
├───────────────┴──────────────────────────────────────────┴──────────────────┤
│ FNB tool dock: Evidence · Git graph · History · Ownership · Impact · Tests │
└─────────────────────────────────────────────────────────────────────────────┘
```

- **LNB:** 탐색과 결과 정리를 담당한다. Findings는 Chat과 분리해 LNB에서 계속 볼 수 있다.
- **Main workspace:** diff와 선택 artifact를 읽고 비교하는 영역이다. 너비를 가장 먼저 확보한다.
- **Chat dock:** 오른쪽 전용 panel이며 Findings와 상호 배타적인 tab으로 만들지 않는다.
- **FNB tool dock:** evidence와 graph 계열 도구를 필요할 때 펼치는 하단 dock이다. 기본 상태에서 화면 절반을 차지하지 않는다.

## 3. Panel sizing과 resize contract

| 영역 | 기본값 | 사용자 조절 범위 | 접힘 상태 | 제약 |
|---|---:|---:|---:|---|
| LNB | 280px | 220–420px | 56px rail | Main workspace를 560px 미만으로 줄이지 않는다. |
| Chat dock | 380px | 320–560px | desktop에서는 접지 않음 | streaming 중에도 composer와 현재 scope를 유지한다. |
| FNB tool dock | 132px | 48px–45vh | 48px tab rail | 45vh는 사용자가 직접 확장한 경우에만 허용한다. |
| Main workspace | remaining | 최소 560px | 없음 | 다른 panel보다 우선해 읽기 너비를 확보한다. |

구현 규칙은 다음과 같다.

- LNB/Main, Main/Chat, Main/FNB 경계에 `role="separator"`인 resize handle을 둔다.
- pointer drag와 keyboard 조절을 모두 지원한다. focus된 separator에서 화살표는 8px, `Shift+화살표`는 32px 단위로 조절한다.
- separator는 `aria-orientation`, `aria-valuemin`, `aria-valuemax`, `aria-valuenow`를 갱신한다. double click은 해당 panel의 기본 크기로 되돌린다.
- CSS grid와 `--lnb-width`, `--chat-width`, `--fnb-height` custom property를 사용한다. drag 중에는 본문 selection을 막되 pointer capture가 끝나면 즉시 복원한다.
- layout preference는 초기에는 `localStorage`의 `gcr:workspace-layout:v1:<userId>:<repositoryId>`에 저장한다. layout 값에는 source code나 conversation 내용을 넣지 않는다. 조직 간 이동이 필요한 시점에는 user preference API로 승격한다.
- viewport가 작아져 저장된 크기를 적용할 수 없으면 clamp한 값을 사용한다. viewport가 다시 커져도 사용자가 저장한 원래 값은 보존한다.

## 4. Responsive behavior

| viewport | layout |
|---|---|
| 1280px 이상 | LNB, Main, Chat을 같은 행에 표시하고 FNB를 하단에 둔다. 세 panel boundary를 모두 resize할 수 있다. |
| 960–1279px | LNB는 기본 56px rail로 시작하고 필요할 때 240px까지 펼친다. Chat은 오른쪽에서 최소 320px을 유지한다. FNB 기본 높이는 96px이다. |
| 720–959px | LNB는 overlay sheet로 연다. Chat은 viewport 하단의 240px persistent dock으로 옮기고 FNB의 48px tool rail을 그 위에 둔다. Main은 나머지 높이를 사용한다. |
| 720px 미만 | Chat의 scope, 최신 응답 상태와 composer를 viewport 하단에 계속 표시하고 conversation은 위로 확장한다. Findings sheet를 열어도 Chat draft와 response stream은 사라지지 않는다. |

`Findings`와 `Chat`을 하나의 tab group에 넣지 않는다. 좁은 화면에서는 동시에 옆에 놓지 못하더라도 Chat의 scope와 composer가 viewport에서 사라지지 않게 하고, Findings를 열었다는 이유로 Chat을 unmount하지 않는다.

## 5. LNB information architecture

LNB 상단에는 workspace mode를 전환하는 navigation을 둔다. mode별 list는 독립 scroll position과 filter를 보존한다.

### Files

- module/package directory grouping
- add/delete/rename, changed line 수, 최고 priority, 분석 생략 상태
- changed-only와 all-context 전환
- virtualized tree, keyboard tree navigation, 현재 diff file 표시

### Findings

- priority, confidence, open/resolved/suppressed, file/module, specialist별 grouping과 filter
- finding 선택 시 Main의 정확한 line range, FNB의 evidence/history, Chat scope를 같은 transaction으로 갱신
- finding fingerprint를 사용한 resolved/reintroduced 상태
- 전체 finding 수와 현재 filter로 보이는 수를 구분

### Outline

- 현재 file의 function/class/symbol outline
- changed symbol, caller/callee, related test 진입점
- parser가 지원하지 않는 file은 line-based outline 또는 명시적인 unsupported state 표시

### Impact

- dependency, caller, affected module, related test 요약
- certainty가 다른 edge를 구분하고 추론 edge에는 근거와 analyzer를 표시
- 큰 graph는 LNB에서 요약만 보여주고 FNB 또는 Main의 maximized tool view에서 탐색

## 6. Main workspace

Main은 다음 surface를 동일한 snapshot selection model 위에서 전환한다.

- virtualized split/unified diff와 old/new line coordinate
- commit별 diff와 전체 PR diff
- file viewer, symbol range, binary/generated/omitted state
- finding/comment anchor와 related symbol marker
- FNB tool의 maximize 결과: Git graph, history, ownership, dependency/impact graph

현재 선택은 URL에 `snapshot`, `file`, `commit`, `side`, `line`, `finding`, `tool`을 직렬화해 같은 권한을 가진 사용자가 deep link로 재현할 수 있게 한다. panel 크기와 개인 filter는 URL에 넣지 않는다.

## 7. Persistent Chat dock

Chat dock은 화면 오른쪽의 전용 영역이며 Review Workspace가 mount된 동안 유지한다.

- header에 질문 scope를 `PR / file / hunk / symbol / finding / commit`으로 표시하고 사용자가 범위를 좁히거나 해제할 수 있게 한다.
- conversation, cited evidence, tool progress, partial/failed answer state와 composer를 한 panel에 둔다.
- LNB finding 선택 시 기본 scope를 해당 finding과 snapshot으로 갱신하되 작성 중인 draft는 삭제하지 않는다.
- 답변의 evidence chip을 선택하면 Main과 FNB가 해당 file/line/commit으로 이동한다. Chat scroll과 draft는 유지한다.
- head가 바뀌면 기존 conversation을 stale snapshot으로 표시하고 새 snapshot으로 질문을 이어갈지 확인한다. 기존 답변을 새 head의 근거처럼 재사용하지 않는다.
- desktop에서는 Chat을 숨기는 collapse control을 제공하지 않는다. focus mode가 필요하면 사용자가 Chat 너비를 최소값으로 줄인다.

## 8. FNB tool dock

FNB는 기본 132px의 compact dock이다. tab rail과 한 줄 또는 작은 preview를 우선 표시하며, 사용자가 drag하거나 maximize를 선택했을 때만 큰 영역을 사용한다.

### Evidence trail

- 선택 finding의 `finding → line → symbol → commit → analyzer artifact` 경로를 compact breadcrumb/timeline으로 표시
- 기본 상태에서는 한 줄 요약과 직접 근거만 보이고, 상세 metadata는 expand 또는 inspector로 연다.

### Git graph

- base, merge-base, head와 PR에 직접 연결된 commit lane을 최초 범위로 표시
- branch, merge, tag, author, date, CI/review 상태 filter
- pan/zoom, keyboard 이동, commit 선택, current snapshot 강조
- commit 선택 시 Main을 commit diff로 바꾸고 LNB Findings와 Chat scope를 같은 commit 기준으로 갱신
- `Load more history`로 depth/cursor를 확장하고, 전체 repository graph를 처음부터 DOM에 만들지 않는다.
- compact dock에서는 PR 중심 mini graph를, maximize하면 Main에서 full graph를 표시한다.

### History와 Ownership

- file → symbol → line 순으로 history를 확장
- rename/move 추적, blame, CODEOWNERS, 실제 review history를 서로 다른 source로 표시
- ownership은 단일 점수로 합치지 않고 근거별 origin과 snapshot/ref를 유지

### Impact와 Related tests

- import/reference, caller/callee, affected module과 test candidate를 탐색
- edge certainty와 analyzer source 표시
- 관련 test가 없거나 analyzer가 실패한 상태를 빈 graph로 오해하지 않게 구분

### Analyzer artifacts

- parser omission, coverage, raw diff/stat, policy decision과 verifier 결과
- raw model response는 기본 UI에서 제외하고 권한과 retention 정책을 만족하는 운영 도구에서만 접근

## 9. Client state와 동기화

```ts
type WorkspaceSelection = {
  snapshotId: string;
  file?: string;
  commitOid?: string;
  side?: "base" | "head";
  line?: number;
  symbolId?: string;
  findingId?: string;
  tool?: "evidence" | "git-graph" | "history" | "ownership" | "impact" | "tests";
};

type WorkspaceLayout = {
  lnbWidth: number;
  chatWidth: number;
  fnbHeight: number;
  lnbMode: "files" | "findings" | "outline" | "impact";
  fnbTool: WorkspaceSelection["tool"];
};
```

- selection 변경은 단일 store transaction으로 처리해 diff, LNB, FNB와 Chat scope가 서로 다른 snapshot을 가리키는 중간 상태를 만들지 않는다.
- server query key에는 항상 `snapshotId`를 포함한다. 새 head를 감지하면 기존 query를 삭제하지 않고 stale로 격리한다.
- Chat stream, graph pagination과 diff chunk loading은 독립적으로 취소할 수 있어야 한다.

## 10. Frontend source boundary

```text
apps/web/src/features/review-workspace/
├── shell/             # grid, responsive layout, resize handles, preferences
├── lnb/
│   ├── files/
│   ├── findings/
│   ├── outline/
│   └── impact/
├── main/              # diff, file, commit and maximized tool surfaces
├── chat/              # persistent conversation, scope, evidence links, composer
├── fnb/
│   ├── evidence/
│   ├── git-graph/
│   ├── history/
│   ├── ownership/
│   ├── impact/
│   └── tests/
├── state/             # snapshot selection, URL sync, layout preference
└── contracts/         # workspace view models and API adapters
```

layout shell은 tool별 data loading을 알지 않는다. 각 tool은 snapshot-scoped query와 selection command만 공유한다. Git graph나 impact graph를 추가해도 Chat과 diff component를 다시 구성하지 않는 경계로 유지한다.

## 11. Delivery scope

### Reviewable MVP

- resizable LNB/Main/Chat/FNB shell과 responsive fallback
- Files, Findings, Outline
- split/unified diff, finding deep link
- persistent snapshot-scoped Chat
- compact Evidence trail, PR 중심 Git graph, file/symbol history
- layout preference와 keyboard-accessible separator

### Change impact phase

- Impact mode, caller/dependency graph, related test explorer
- ownership source view, rename/moved symbol history
- full Git graph filter와 history pagination
- resolved/reintroduced finding 추적

### Enterprise phase

- cross-PR comparison, organization policy/audit surface
- shared layout preference, feature entitlement, tenant-specific tool availability
- very large repository graph의 server-side slice/cache와 운영 관측

## 12. Acceptance criteria

- 1440px viewport의 초기 FNB 높이는 132px이며 사용자가 확장하지 않은 상태에서 160px을 넘지 않는다.
- Findings와 Chat은 desktop에서 동시에 보이고, 한쪽을 사용해도 다른 쪽의 selection, scroll, draft가 유지된다.
- 세 resize handle은 pointer와 keyboard로 조절할 수 있고 reload 후 같은 repository에서 복원된다.
- viewport 축소 시 panel이 Main 최소 너비를 침범하지 않고 정의된 compact/stacked layout으로 전환된다.
- Git graph tab은 prototype 표시 여부와 관계없이 Reviewable MVP에서 접근할 수 있으며 base/merge-base/head가 식별된다.
- finding, evidence chip, graph commit 중 하나를 선택하면 Main, LNB, FNB, Chat이 같은 `snapshotId`와 selection을 가리킨다.
- graph, diff와 list는 큰 PR에서도 전체 node를 한 번에 DOM에 만들지 않으며 loading/partial/omitted 상태를 구분한다.
- 사용자 locale 설정이 없는 첫 진입에서 `ko-KR`이 적용되고 버튼·상태·오류·접근성 label은 한글로 표시된다. 기술용어, code identifier, path, branch와 SHA는 원문을 유지한다.

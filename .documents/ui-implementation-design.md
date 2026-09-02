# Review Workspace - UI 구현 설계

## 1. 적용 범위

이 문서는 사내 HTTPS web application의 사용자 흐름과 review workspace를 정의한다. 기준 visual artifact는 다음과 같다.

- `visuals/review-workspace.html`
- `visuals/review-workspace-preview.png`

HTML/PNG의 Header, LNB, Main diff, right Chat, FNB 구조와 정보 밀도는 유지한다. UI는 VS Code webview, browser extension, local Git 또는 host bridge를 전제로 하지 않으며 일반 browser에서 Server REST/SSE만 사용한다.

기본 locale은 `ko-KR`이다. `PR`, `diff`, `snapshot`, `finding`, `commit`, `merge-base`, `Git graph`, `Chat`, `SSE`처럼 개발 문맥이 명확한 용어는 English를 유지한다.

## 2. Route와 화면

```text
/                         -> 허용된 PR worklist
/repositories/:repoId     -> repository별 PR worklist
/repositories/:repoId/pulls/:number
                          -> 최신 analysis로 이동하는 canonical route
/reviews/:analysisId      -> revision에 고정된 review workspace
/settings                 -> 사용자 preference
/admin/repositories       -> 관리자 전용 repository 등록/상태
```

로그인 전에는 OIDC redirect에 필요한 최소 화면만 표시한다. 로그인 후 첫 화면은 marketing page가 아니라 worklist다.

`/reviews/:analysisId`는 browser navigation route다. REST resource는 `/api/v1/analyses/{analysisId}`처럼 `/api/v1` 아래에 두며 UI route와 API route를 혼용하지 않는다.

### 2.1 PR worklist

worklist는 반복 업무를 위한 compact table/list다.

| 열 | 내용 |
|---|---|
| PR | number, title, author, draft |
| Repository | owner/name |
| Change | files/additions/deletions |
| Analysis | latest state, partial/stale, elapsed time |
| Findings | grade와 P3/P2/P1 count |
| Updated | GHES update와 마지막 poll 시각 |

repository, author, review state, priority, draft, updated time filter를 제공한다. 행을 선택하면 최신 immutable analysis route로 이동한다. 분석이 없으면 PR 상세 shell을 먼저 열고 refresh 상태를 표시한다.

## 3. Workspace topology

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Global: product · repository switcher · user                              │
│ PR: identity · refs · analysis · coverage · merge simulation · refresh    │
├───────────────┬────────────────────────────────────────┬───────────────────┤
│ LNB           │ Main workspace                         │ Chat dock         │
│ Files         │ split / unified diff                   │ snapshot scope    │
│ Findings      │ file / symbol / commit                 │ conversation      │
│ Outline       │ maximized tool                         │ evidence links    │
│ Impact        │                                        │ composer          │
├───────────────┴────────────────────────────────────────┴───────────────────┤
│ FNB: Evidence · Git graph · Impact · Tests                                │
└────────────────────────────────────────────────────────────────────────────┘
```

- **Header:** PR identity와 전체 상태를 빠르게 확인하고 refresh/revision 전환을 수행한다.
- **LNB:** 파일, finding과 code structure를 탐색한다.
- **Main:** 읽기 너비를 우선하는 diff/code 도구 영역이다.
- **Chat dock:** Review Workspace가 mount된 동안 유지되는 오른쪽 대화 영역이다.
- **FNB:** evidence와 graph 도구를 compact하게 유지하는 하단 dock이다.

## 4. Layout contract

| 영역 | 기본값 | 조절 범위 | compact 상태 |
|---|---:|---:|---:|
| Global header | 54px | 고정 | 없음 |
| PR context header | 72px | 고정 | 두 줄 wrap 허용 |
| LNB | 280px | 220-420px | 1020-1279px에서 220px |
| Main | remaining | 최소 560px | 폭 880px 미만이면 unified |
| Chat | 380px | 320-560px | desktop에서 접지 않음 |
| FNB | 132px | 48px-45vh | 48px tab rail |

separator는 pointer와 keyboard로 조절 가능하며 `role="separator"`, 방향, 현재 값과 min/max를 제공한다. drag 중 text selection을 막되 mouse release/cancel 후 반드시 복원한다.

layout preference key:

```text
gcr:workspace-layout:v2:<user-id>
```

값은 user 기본 layout과 최근 사용 repository override 최대 10개를 가진 하나의 versioned JSON document다. 오래된 override는 last-used 순서로 제거한다. 저장 대상은 panel size, selected tab, theme, locale뿐이다. source, diff, finding, report, Chat 내용과 credential은 localStorage/IndexedDB/service worker cache에 저장하지 않는다.

### 4.1 Responsive

| viewport | 동작 |
|---|---|
| 1280px 이상 | LNB/Main/Chat을 같은 행에 표시하고 FNB를 하단에 둔다. |
| 1020-1279px | LNB를 220px compact width로 시작하고 Chat은 최소 320px을 유지한다. |
| 720-1019px | LNB는 overlay, Chat은 하단 persistent dock, FNB는 그 위 rail이 된다. |
| 720px 미만 | scope/composer를 하단에 유지하고 conversation과 Findings는 sheet로 확장한다. |

좁은 화면에서도 Findings를 열었다는 이유로 Chat을 unmount하거나 draft/stream을 잃지 않는다. panel이 Main 최소 너비를 침범하기 전에 compact layout으로 전환한다.

## 5. Header

Header는 두 행으로 고정한다.

1. Global header: product identity, repository switcher, 사용자 menu
2. PR context header: PR number/title, base/head와 short SHA, analysis revision selector, report state, grade/P3-P1 count, coverage, merge simulation state, refresh와 overflow menu

Report state는 `대기|진행 중|완료|부분 완료|실패|대체됨|취소됨` badge로 표시한다. `stale`은 별도 파생 badge이며 현재 PR의 base/head와 report의 base/head가 다를 때 표시한다. Merge simulation은 `확인 중|병합 가능|충돌|미확인|실패`처럼 별도 영역에 표시하고 report 완료 상태와 합치지 않는다.

Refresh는 즉시 새 report가 생기는 것처럼 보이지 않는다. 클릭 후 poll 시작, snapshot 동일, 새 snapshot 발견, run 진행 상태를 순서대로 표시한다. 동일 snapshot이면 기존 report 재사용 이유를 알린다.

새 revision이 생기면 현재 화면을 자동 교체하지 않고 `새 분석 결과가 있습니다` banner와 전환 command를 표시한다. 이전 revision을 보는 동안 Header에 stale를 유지한다.

## 6. LNB

### 6.1 Files

- directory tree와 flat changed-file mode
- modified/added/deleted/renamed/binary/generated 상태
- additions/deletions, finding count와 review progress
- path/status/finding filter
- file 선택 시 Main diff 이동, 현재 snapshot 유지

### 6.2 Findings

- 상단 report summary에 Commit Defender식 grade, `hasCriticalFindings`, 전체 요약, 분석 file 수/시간과 coverage를 표시
- per-file summary는 file, grade, worst priority와 요약을 compact row로 제공
- P3/P2/P1/P0, confidence, category, file과 상태 filter
- priority, file, confidence, category 정렬
- Analyzer/model source와 rule, 제목, problem, impact, recommendation, file:line, evidence count와 verification 상태
- 선택 시 Main anchor, FNB evidence와 Chat scope를 한 transaction으로 갱신
- 직접 근거가 누락된 finding은 일반 finding처럼 표시하지 않고 limitation으로 분리
- P0 positive observation은 조치 finding count와 분리하고 `좋았던 점` section에 표시
- toolbar에서 report link 복사, Markdown 복사, JSON 다운로드를 제공

### 6.3 Outline

- 현재 file의 symbol hierarchy
- changed, directly referenced, unchanged context 구분
- symbol 선택 시 base/head side와 line range를 함께 이동

### 6.4 Impact

- `Structure | Dependencies` segmented control
- Structure는 parent container와 child member를, Dependencies는 uses와 used-by를 별도 group으로 표시
- direct caller/importer/consumer와 related test, relation kind와 PR 전후 added/removed 상태 요약
- direct 관계를 먼저 표시하고 hop 수, relation kind, change와 confidence filter 제공
- 큰 graph는 FNB 또는 Main maximized view로 전환

각 mode는 독립 scroll, filter와 selection을 보존한다.

## 7. Main workspace

### 7.1 Diff

- split/unified segmented control
- canonical split diff의 왼쪽은 `mergeBase`, 오른쪽은 `head`이며 branch tip을 뜻하는 `BASE` label로 오해시키지 않는다.
- whitespace, context line, collapse unchanged 설정
- old/new line number, hunk header, comment/finding marker
- rename/binary/omitted/too-large 전용 상태
- file/hunk virtualization과 다음 chunk loading

Finding anchor는 `fileId + side + line + hunk fingerprint`를 사용한다. `side`는 `mergeBase|head`다. line mapping이 불가능하면 가장 가까운 hunk로 이동하고 정확한 line을 찾지 못했다는 상태를 표시한다.

Main의 실제 가용 폭이 880px 미만이면 기본 split mode를 unified로 자동 전환하고 toolbar에 이유를 표시한다. 사용자가 split을 명시적으로 고정한 경우 column 최소 너비를 유지한 horizontal scroll을 제공하며 행이나 code text를 찌그러뜨리지 않는다.

### 7.2 Tool view

Git graph, Impact와 Tests를 maximize하면 Main을 사용한다. 닫을 때 이전 file/diff scroll과 selection을 복원한다. tool은 동일 snapshot query만 사용하며 별도 revision을 암묵적으로 읽지 않는다. History, Ownership과 Relationships는 FNB top-level tab으로 제공하지 않는다.

Impact maximize view는 안정된 세 column 또는 동등한 방향 graph를 사용한다. 바깥 column label은 Structure mode에서 `Parent | Selected object | Children`, Dependency mode에서 `Uses | Selected object | Used by`로 바뀌며 두 체계의 label을 동시에 섞지 않는다. Node에는 kind, qualified name, changed 상태와 직접 relation 수를, edge에는 calls/imports/extends/tests 같은 relation과 confidence를 표시한다. Cycle은 끊어서 숨기지 않고 cycle marker로 표시하며 truncated branch에는 `더 보기`와 limitation을 둔다.

Node를 선택하면 definition과 incoming/outgoing reference가 갱신되고, edge를 선택하면 FNB Evidence에 해당 relation을 증명하는 file/line을 표시한다. Changed node/edge는 mergeBase/head 상태를 비교할 수 있으며, 변경되지 않은 downstream object는 finding이 아니라 impact로 표시한다.

### 7.3 URL selection

```text
/reviews/:analysisId?file=<id>&side=head&line=42&finding=<id>&tool=history
/reviews/:analysisId?finding=<id>&evidence=<evidence-id>
/reviews/:analysisId?symbol=<object-id>&relation=<relation-id>&tool=impact
/reviews/:analysisId?commit=<oid>&tool=graph
```

URL에는 analysis identity와 공유 가능한 selection만 둔다. panel size, 개인 filter, Chat session, source text는 넣지 않는다. history navigation은 selection 단위로 동작하고 browser reload 후 같은 위치를 복원한다.

### 7.4 바로가기와 외부 GHES link

Report, finding, evidence, file/line, symbol, relation과 commit header에 link 또는 link-copy command를 제공한다.

- 내부 deep link는 현재 `analysisId`를 항상 포함하고 같은 tab에서 정확한 selection을 연다.
- Copy Link는 configured public origin의 absolute URL을 clipboard에 기록한다.
- `Open in GHES`는 exact commit SHA의 blob/line permalink를 새 tab에서 연다.
- GHES route가 지원되지 않거나 file/line이 없으면 내부 evidence view를 유지하고 file-level link로 낮춘 이유를 표시한다.
- Link icon button은 tooltip과 accessible name을 가지며 작은 finding row에서는 hover뿐 아니라 keyboard focus에도 노출한다.
- Markdown/JSON export의 finding과 evidence도 UI와 같은 typed link target을 사용한다.

Internal opaque ID나 external URL 자체는 권한을 부여하지 않는다. 로그인 return path는 relative route만 허용하고, 모든 deep link 진입에서 analysis/repository grant를 다시 검사한다.

## 8. Persistent Chat

- 상단에 analysis revision, selected finding/file/symbol scope를 표시한다.
- scope chip은 제거/추가할 수 있지만 다른 revision의 evidence는 섞을 수 없다.
- finding 선택 시 기본 scope를 바꾸되 작성 중 draft는 유지한다.
- citation을 선택하면 Main/FNB가 이동하고 Chat scroll/draft는 유지한다.
- streaming 중 stop, 재연결, 실패 후 retry와 완성 message 재조회 command를 제공한다.
- 새 analysis 전환은 기존 conversation을 바꾸지 않고 새 session을 시작한다.
- Server가 반환하는 model availability가 false이면 이전 합성 답변을 conversation처럼 표시하지 않고 composer를 비활성화한다.
- 비활성 model에 대한 전송은 message persist 전에 `CHAT_MODEL_DISABLED`로 종료한다. GHES fixture 여부와 interactive model 사용 여부는 독립적이다.

assistant response의 citation은 keyboard focus가 가능한 button이다. tooltip에는 file, line/symbol, artifact type을 표시하며 source 전체를 hover card에 복제하지 않는다.

## 9. FNB

기본 높이 132px의 compact dock이며 tab rail과 작은 preview를 우선한다.

| Tab | compact view | expanded/maximized view |
|---|---|---|
| Evidence | selected claim과 locator | claim-evidence chain, omission |
| Git graph | nearby commit lanes | branch/merge graph, commit diff |
| Impact | direct dependency와 selected edge summary | parent/children 또는 uses/used-by graph, evidence와 coverage |
| Tests | 추가된 test file/case 요약과 assertion 수 | case 설명, evidence, gap와 confidence |

Git graph는 snapshot commit artifact, merge-base와 관측된 base/head ref만 표시하고 존재하지 않는 commit을 합성하지 않는다. Tests는 added diff에서 지원되는 test declaration과 assertion을 추출한다. Snapshot에 test patch 본문이 없으면 case를 추측하지 않고 file additions와 limitation을 표시한다.

commit을 선택하면 Main은 commit diff로 바뀌고 LNB/Chat에 commit scope를 반영한다. canonical PR diff로 돌아가는 command를 항상 제공한다.

## 10. Client state

```ts
type ReviewSelection = {
  analysisId: string;
  snapshotId: string;
  fileId?: string;
  side?: "mergeBase" | "head";
  line?: number;
  symbolId?: string;
  evidenceId?: string;
  relationId?: string;
  relationView?: "structure" | "dependency";
  relationDirection?: "parents" | "children" | "uses" | "usedBy";
  findingId?: string;
  commitId?: string;
  tool?: "evidence" | "graph" | "impact" | "tests";
};
```

selection 변경은 한 store transaction으로 처리한다. server query key는 반드시 `analysisId` 또는 `snapshotId`를 포함한다. Chat stream, graph page와 diff chunk request는 서로 독립적으로 cancel 가능해야 한다.

server state cache와 local UI state를 구분한다.

- server state: worklist, report, diff, finding, graph, Chat message
- URL state: 현재 analysis와 공유 가능한 selection
- local preference: layout, theme, locale, 개인 filter
- transient state: hover, open menu, resize, unsent Chat draft

## 11. Loading, empty와 error state

| 상황 | 표시 |
|---|---|
| 최초 poll 전 | 등록은 됐지만 아직 조회되지 않았음을 표시 |
| requested | `대기`, queue 상태와 대기 시간 |
| preparing/analyzing/persisting | `진행 중`, 현재 stage, elapsed time과 마지막 event |
| completed | `완료`, coverage와 완료 시각 |
| partial | 사용 가능한 결과와 누락된 analyzer/범위를 함께 표시 |
| stale | 현재 base/head와 report base/head를 비교하고 새 revision action 제공 |
| failed | 실패 stage, retry 가능 여부, request ID와 마지막 성공 report link |
| superseded | `대체됨`, 최신 run link |
| cancelled | `취소됨`, 취소 주체와 시각 |
| SSE disconnected | 기존 화면 유지, reconnect 상태와 REST refresh |
| dependency degraded | 기존 화면을 유지하고 영향 기능에 GHES/model/artifact/DB 상태와 retry 가능 여부 표시 |
| 권한 없음/없음 | resource 존재를 구분하지 않는 공통 화면 |
| large file omitted | omission 이유와 raw source를 자동 요청하지 않는 상태 |

Skeleton은 최종 layout과 같은 고정 크기를 사용해 panel이 이동하지 않게 한다. 오류 때문에 Chat, selection과 읽던 diff를 전체 unmount하지 않는다.

## 12. 접근성과 성능

- icon button은 accessible name과 tooltip을 가진다.
- tab, tree, list, dialog, separator에 적절한 ARIA pattern을 적용한다.
- keyboard만으로 LNB/Main/Chat/FNB와 citation을 이동할 수 있다.
- focus ring을 숨기지 않고 modal/sheet focus trap과 return focus를 구현한다.
- 색상만으로 priority, diff와 state를 구분하지 않는다.
- motion preference를 존중하고 streaming/layout animation을 최소화한다.
- diff row, file tree, finding list와 graph를 virtualize한다.
- monospace font fallback과 line height를 고정해 horizontal alignment를 유지한다.

## 13. Frontend 경계

```text
src/
  app/          # route, auth boundary, query client
  worklist/     # repository/PR table and filters
  workspace/    # resizable shell and header
  files/        # tree and diff
  findings/     # finding list/detail
  tools/        # evidence/graph/impact/tests
  chat/         # session, stream, composer, citations
  state/        # selection, URL sync, preferences
  api/          # generated types and REST/SSE clients
  i18n/         # ko-KR messages
```

workspace shell은 개별 tool의 data loading을 알지 않는다. tool은 snapshot-scoped query와 selection command만 공유한다.

## 14. UI 완료 조건

- 1440px과 1280px에서 visual artifact의 topology와 정보 밀도를 유지하고 1440px 초기값은 split diff다.
- 1440px 초기 FNB는 132px이며 사용자가 확장하지 않으면 160px을 넘지 않는다.
- desktop에서 Findings와 Chat을 동시에 사용할 수 있다.
- 720px 미만에서도 Chat draft/stream과 현재 analysis scope가 유지된다.
- reload/deep link 후 같은 analysis와 selection을 복원한다.
- finding/citation/commit 선택 시 모든 panel이 같은 snapshot을 가리킨다.
- 복사한 report/finding/evidence/object URL이 로그인 후 같은 revision과 selection을 복원한다.
- Object graph가 structure parent/children과 dependency uses/used-by를 구분하고 edge evidence를 연다.
- GHES source action은 branch가 아니라 exact SHA permalink를 만들며 arbitrary origin을 열지 않는다.
- Main 폭 880px 경계에서 자동 unified 전환 또는 pinned split scroll이 layout shift 없이 동작한다.
- Playwright screenshot에서 text overlap, horizontal page overflow와 blank panel이 없다.
- browser storage 검사에서 source, report, finding과 Chat content가 없다.

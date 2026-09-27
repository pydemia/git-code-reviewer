/* global window, document, location, URLSearchParams, history, matchMedia */
const paletteStudy = window.gcrPaletteStudy;
/* Static design fixture. No API, model, storage or application mutations. */
const designs = [
  {
    id: 'U1',
    name: 'Primer · 코드 리뷰 스레드',
    short: 'GitHub의 파일·코드·코멘트 연결',
    note: '파일 탐색 → 코드 근거 → 리뷰 본문. 익숙한 PR 스레드 구조를 유지하고 심각도는 헤더에서만 표시합니다.',
    reference: 'https://primer.style/product/components/timeline/',
  },
  {
    id: 'U2',
    name: 'Material UI · 리뷰 워크벤치',
    short: '탐색 rail + List + 낮은 elevation의 Paper',
    note: '목적지 탐색과 리뷰 목록을 분리합니다. 내용은 하나의 평평한 Paper에 두고 설정·입력 control까지 확장하기 쉬운 구조입니다.',
    reference: 'https://mui.com/material-ui/react-drawer/',
  },
  {
    id: 'U3',
    name: 'Carbon · 검토 테이블',
    short: '심각도·위치·판단을 비교하는 행과 펼친 근거',
    note: '리뷰 의견을 먼저 표에서 훑고 선택한 행 아래에 원문과 코드 근거를 펼칩니다. 대형 PR에서 비교·분류하는 작업에 맞춥니다.',
    reference: 'https://carbondesignsystem.com/components/data-table/usage/',
  },
  {
    id: 'U4',
    name: 'Ant Design · 목록 / 상세',
    short: '의견 목록은 왼쪽, 읽는 원문은 오른쪽',
    note: '선택한 의견을 상세 영역에 집중해 보여줍니다. 리뷰 관측·이력에서도 목록 위치를 유지한 채 원문을 바꾸는 흐름입니다.',
    reference: 'https://ant.design/components/list/',
  },
  {
    id: 'U5',
    name: 'Editorial · 근거 문서',
    short: '박스 없는 본문 + 목차 + 출처 여백',
    note: '긴 설명과 수정 문맥을 읽는 데 집중합니다. 본문은 문서처럼 열고 코드 인용과 수정 제안에만 경계를 둡니다.',
    reference: 'https://ui.shadcn.com/docs/typeset',
  },
  {
    id: 'U1+U2',
    name: '선택안 · 리뷰 스레드 + 워크벤치',
    short: 'U1 코멘트 + U2 파일 탐색 + 기존 code diff',
    note: '선택하신 통합 방향입니다. 실제 GCR diff·리뷰 renderer를 재사용합니다. Split/Unified, 행 번호, 인라인 의견, 파일 선택, 의견→코드 이동을 직접 확인할 수 있습니다. patch와 의견은 합성 자료입니다.',
    reference: 'hybrid-decision.md',
  },
];

const params = new URLSearchParams(location.search);
let selectedPalette =
  paletteStudy.palettes.find((p) => p.id === params.get('palette')) || paletteStudy.palettes[0];
let selectedDesign =
  designs.find((d) => d.id === (params.get('capture') || params.get('ui'))) || designs[0];
let contentState = ['normal', 'long', 'empty', 'error', 'loading'].includes(params.get('state'))
  ? params.get('state')
  : 'normal';
const capture = designs.some((d) => d.id === params.get('capture'));
const sheet = ['colors', 'uis'].includes(params.get('sheet')) ? params.get('sheet') : null;
if (capture) document.body.classList.add('capture');
if (sheet) document.body.classList.add('sheet-mode');

const path = 'agentstore/mainapp/domains/agents/tools/data/filter_pool_by_block.py';
const title = 'optional <code>extracted_entities</code>를 함수 전체에서 안전하게 정규화하세요';
const warningIcon =
  '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M10 2 18 17H2Z"/><path d="M10 7v4m0 2v1"/></svg>';
const severity = `<span class="severity">${warningIcon} P2 Warning</span>`;
const tokenStyle = (p) =>
  Object.entries(p.tokens)
    .map(([key, value]) => `--${key}:${value}`)
    .join(';');

const appbar = () =>
  '<header class="appbar"><strong>Git Code Reviewer</strong><nav aria-label="제품 화면 예시"><span class="current">Pull requests</span><span>리뷰 관측</span><span>리뷰 이력</span></nav><span class="demo-marker">DESIGN PREVIEW</span></header>';
const context = () =>
  `<section class="context"><p class="breadcrumb">agentstore / PR 리뷰 / 코드 라인 코멘트</p><div class="context-top"><h2>변경 코드 리뷰 <span>리뷰 의견 ${contentState === 'empty' ? '0' : '1'}건</span></h2></div><p class="context-meta">제공된 화면의 관측 · commit <code>cb04f928</code> · 변경 코드 L70 · 시안 데이터</p><div class="tabs" aria-label="화면 구획 예시"><span class="active">리뷰 의견 <b class="count">${contentState === 'empty' ? '0' : '1'}</b></span><span>코드 근거</span><span>원문·출처</span></div></section>`;
const fileRail = (editorial = false) =>
  `<aside class="file-rail" aria-label="${editorial ? '문서 목차' : '관련 파일'}"><p class="rail-title">${editorial ? '이 의견의 구성' : '리뷰 의견이 있는 파일'}</p>${editorial ? '<a href="#finding-title" class="file-entry selected">01 문제와 조건</a><a href="#code-evidence" class="file-entry">02 코드 근거</a><a href="#suggestion" class="file-entry">03 수정 제안</a><a href="#source" class="file-entry">04 원문·출처</a>' : '<span class="file-entry selected">filter_pool_by_block.py<small>△ P2 Warning · L70</small></span><p class="rail-description">agentstore / agents / tools / data</p><p class="rail-title rail-heading">표시 기준</p><p class="rail-description">리뷰 의견이 있는 파일만 표시합니다.</p>'}</aside>`;
const provenance = () =>
  '<aside class="context-rail" aria-label="관측 출처"><p class="rail-title">원문과 관측 문맥</p><dl><dt>기준 코드</dt><dd><code>cb04f928</code></dd><dt>위치</dt><dd>변경 코드 · L70</dd><dt>검토 관점</dt><dd>correctness</dd><dt>적용 조건</dt><dd>호출부가 optional 인자를 생략할 때</dd><dt>반증할 문맥</dt><dd>모든 접근 전 정규화 여부</dd></dl><p class="rail-description">첨부 화면의 과거 관측을 재배치했습니다. 현재 코드의 결함 판정은 아닙니다.</p></aside>';
const evidence = () =>
  `<figure class="code-evidence" id="code-evidence"><figcaption><a href="#finding-title">${path}</a><span>L68–72 · cb04f928</span></figcaption><div class="code-scroll" tabindex="0" aria-label="코드 근거, 가로 스크롤"><div class="code-line"><span class="line-no">68</span><code>    candidates: <span class="kw">dict</span>[<span class="kw">str</span>, <span class="kw">dict</span>],</code></div><div class="code-line"><span class="line-no">69</span><code>    intent: <span class="kw">str</span>,</code></div><div class="code-line referenced"><span class="line-no">70</span><code>    extracted_entities: <span class="kw">dict</span> | <span class="kw">None</span> = <span class="kw">None</span>,</code></div><div class="code-line"><span class="line-no">71</span><code>) -&gt; <span class="kw">dict</span>:</code></div><div class="code-line"><span class="line-no">72</span><code>    """예정된 payload 계약:</code></div></div></figure>`;
const body = () =>
  `<div class="comment-body"><p><code>extracted_entities</code>를 optional로 변경했지만, multi-candidate recommendation 경로에서는 이후 <code>extracted_entities.get("ignored_candidates", [])</code>를 직접 호출합니다. 따라서 이 함수를 기본값으로 호출하고 <code>intent</code>가 해당 경로이면 <code>NoneType</code>의 <code>get</code> 호출로 실패합니다.</p><p>함수 진입 시 <code>extracted_entities = extracted_entities or {}</code>로 정규화하거나, 모든 사용 지점에서 <code>None</code>을 처리해야 합니다.</p><h4>영향</h4><p>직접 호출자 또는 테스트가 <code>extracted_entities</code>를 생략한 채 multi-candidate recommendation을 요청하면 블록 필터 단계가 <code>AttributeError</code>로 중단됩니다.</p>${contentState === 'long' ? '<h4>적용 조건·반증 문맥 — 표시 검증용</h4><p>과거 관측은 현재 호출부와 계약에 대조합니다. 수정 이후 모든 접근 전에 정규화된다면 같은 지적을 반복하지 않습니다.</p><div class="markdown-scroll" tabindex="0" aria-label="검증 문맥 표, 가로 스크롤"><table><thead><tr><th scope="col">호출 조건</th><th scope="col">확인할 근거</th><th scope="col">판단</th></tr></thead><tbody><tr><td>인자 생략</td><td>기본값과 정규화 위치</td><td>접근 전 None 처리 필요</td></tr><tr><td>수정된 호출부</td><td>정규화가 모든 분기를 지배</td><td>과거 지적을 반복하지 않음</td></tr></tbody></table></div><pre class="long-code"><code>extracted_entities.get("a_very_long_key_used_only_for_horizontal_overflow_verification", [])</code></pre>' : ''}<section class="suggestion" id="suggestion" aria-label="수정 제안"><h4>수정 제안</h4><p>함수 시작 부분에서 빈 dict로 정규화한 뒤 이후의 <code>.get()</code> 호출이 동일한 안전한 객체를 사용하도록 하세요.</p><pre><code>extracted_entities = extracted_entities or {}</code></pre></section></div>`;
const source = () =>
  `<details class="source-detail" id="source"><summary>원문·출처 확인</summary><p>출처: 사용자가 제공한 코드 라인 코멘트 화면<br />파일: <code>${path}</code><br />관측 위치: commit <code>cb04f928</code>, 변경 코드 L70<br />실제 PR 번호·작성 시각·답글·수정 이력은 이 이미지에 없어 시안에서 만들지 않았습니다.</p></details>`;
const finding = (editorial = false) => {
  const head = `<header class="finding-head">${severity}<span>correctness</span><span>변경 코드 · L70</span></header>`;
  const heading = `<h3 id="finding-title">${title}</h3>`;
  if (['empty', 'error', 'loading'].includes(contentState)) {
    const states = {
      empty: [
        '표시할 리뷰 의견이 없습니다.',
        '해당 조건의 리뷰 의견은 0건입니다. 분석 완료 여부는 별도 상태로 유지합니다.',
      ],
      error: [
        '원문을 불러오지 못했습니다.',
        '조회 실패와 의견 없음은 구분합니다. 출처가 없는 내용으로 대체하지 않습니다.',
      ],
      loading: [
        '리뷰 원문을 불러오는 중입니다.',
        '현재 선택한 revision의 원문을 조회하고 있습니다.',
      ],
    };
    return `<article class="finding"><div class="state-message ${contentState}" role="${contentState === 'error' ? 'alert' : 'status'}"><strong>${states[contentState][0]}</strong><p>${states[contentState][1]}</p></div></article>`;
  }
  return `<article class="finding" aria-label="코드 라인 리뷰 의견">${head}<div class="finding-content">${editorial ? heading + evidence() : evidence() + heading}${body()}<footer class="finding-foot"><a href="#code-evidence">코드로 이동 ↗</a><a href="#source">원문·출처 ↓</a><span>GitHub 링크 위치 · 시안</span></footer>${source()}</div></article>`;
};
const contentColumn = (editorial = false) =>
  `<div class="content-column"><div class="content-label"><span>filter_pool_by_block.py</span><span>리뷰 의견 1건</span></div>${finding(editorial)}</div>`;
const inbox = () =>
  `<aside class="review-inbox" aria-label="리뷰 의견 목록"><div class="inbox-tools"><span>의견 목록</span><span>1 / 1</span></div><div class="inbox-item" aria-current="true">${severity}<strong>optional 인자의 정규화 누락</strong><small>filter_pool_by_block.py<br />L70 · correctness · cb04f928</small></div><div class="inbox-section"><p class="rail-title">현재 선택한 의견</p>원문과 코드의 revision을 함께 유지합니다. 목록 위치를 유지한 채 상세를 읽습니다.</div></aside>`;
const carbon = () =>
  `<section class="carbon-table" aria-label="리뷰 검토 테이블"><div class="table-caption"><span>리뷰 의견 · 1건</span><span>코드 근거가 있는 의견</span></div><table class="triage-table"><thead><tr><th scope="col"><span aria-label="펼침 상태">⌄</span></th><th scope="col">심각도</th><th scope="col">검토 의견</th><th scope="col" class="optional">위치</th><th scope="col" class="optional">관점</th></tr></thead><tbody><tr class="finding-row"><td>⌄</td><td>${severity}</td><td>optional 인자의 정규화 누락</td><td class="optional"><code>filter_pool_by_block.py:70</code></td><td class="optional">correctness</td></tr><tr class="expand-row"><td colspan="5"><div class="carbon-evidence">${finding()}${provenance()}</div></td></tr></tbody></table></section>`;

function renderStage() {
  let layout;
  if (selectedDesign.id === 'U1+U2')
    layout = `<iframe class="hybrid-frame" title="U1 + U2 통합 시안 · 기존 GCR code diff" src="hybrid-build/review-hybrid.html?palette=${selectedPalette.id}&state=${contentState}"></iframe>`;
  else if (contentState === 'empty')
    layout = `${appbar()}${context()}<div class="empty-content">${finding()}</div>`;
  else if (selectedDesign.id === 'U2')
    layout = `${appbar()}<div class="material-shell"><aside class="destination-rail" aria-label="목적지 rail 예시"><div class="selected"><b>⌘</b>PR 리뷰</div><div><b>◷</b>관측</div><div><b>≡</b>이력</div></aside><div>${context()}<div class="review-layout">${fileRail()}${contentColumn()}</div></div></div>`;
  else if (selectedDesign.id === 'U3') layout = `${appbar()}${context()}${carbon()}`;
  else if (selectedDesign.id === 'U4')
    layout = `${appbar()}${context()}<div class="review-layout">${inbox()}${contentColumn()}</div>`;
  else
    layout = `${appbar()}${context()}<div class="review-layout">${fileRail(selectedDesign.id === 'U5')}${contentColumn(selectedDesign.id === 'U5')}${provenance()}</div>`;
  document.querySelector('#stage').innerHTML =
    `<div class="workspace ui-${selectedDesign.id}" style="${tokenStyle(selectedPalette)}">${layout}</div>`;
  document.querySelector('#selection-title').textContent =
    `${selectedPalette.id} ${selectedPalette.name} / ${selectedDesign.id} ${selectedDesign.name}`;
  document.querySelector('#selection-note').textContent = selectedDesign.note;
  document.querySelector('#screen-link').href =
    selectedDesign.id === 'U1+U2'
      ? `hybrid-build/review-hybrid.html?palette=${selectedPalette.id}&state=${contentState}`
      : `?capture=${selectedDesign.id}&palette=${selectedPalette.id}&state=${contentState}`;
  document.querySelector('#selection-status').textContent =
    `현재 조합: ${selectedPalette.id} + ${selectedDesign.id} · 주색 #176B5D 고정 · 색 띠 없음 · 수정 제안 별도 박스`;
  updateTableSpan();
}

function updateTableSpan() {
  const cell = document.querySelector('.expand-row > td');
  if (cell) cell.colSpan = matchMedia('(max-width: 760px)').matches ? 3 : 5;
}
matchMedia('(max-width: 760px)').addEventListener('change', updateTableSpan);

function saveSelection() {
  const next = new URLSearchParams(location.search);
  next.set('palette', selectedPalette.id);
  next.set(capture ? 'capture' : 'ui', selectedDesign.id);
  next.set('state', contentState);
  history.replaceState(null, '', `${location.pathname}?${next}`);
  renderStage();
}

for (const p of paletteStudy.palettes) {
  const label = document.createElement('label');
  label.className = 'choice-row';
  label.innerHTML = `<input type="radio" name="palette" value="${p.id}" ${p.id === selectedPalette.id ? 'checked' : ''} /><span class="choice-info"><span class="choice-name"><span class="choice-id">${p.id}</span>${p.name}</span><span class="choice-subtitle">${p.note}</span></span><span class="mini-swatches" aria-hidden="true">${[p.tokens.accent, p.tokens.canvas, p.tokens.muted, p.source_palette.swatches[1], p.source_palette.swatches[4]].map((c) => `<i style="background:${c}"></i>`).join('')}</span>`;
  label.querySelector('input').addEventListener('change', () => {
    selectedPalette = p;
    saveSelection();
  });
  document.querySelector('#palette-options').append(label);
}
for (const d of designs) {
  const label = document.createElement('label');
  label.className = 'choice-row';
  label.innerHTML = `<input type="radio" name="ui" value="${d.id}" ${d.id === selectedDesign.id ? 'checked' : ''} /><span class="choice-info"><span class="choice-name"><span class="choice-id">${d.id}</span>${d.name}</span><span class="choice-subtitle">${d.short}</span></span>`;
  label.querySelector('input').addEventListener('change', () => {
    selectedDesign = d;
    saveSelection();
  });
  document.querySelector('#ui-options').append(label);
}
document.querySelector('#content-state').value = contentState;
document.querySelector('#content-state').addEventListener('change', (event) => {
  contentState = event.target.value;
  saveSelection();
});
renderStage();

if (sheet === 'colors') {
  const el = document.querySelector('#color-sheet');
  el.hidden = false;
  el.innerHTML = `<p class="eyebrow">COLOR STUDY / FIVE PALETTES</p><h1>같은 청록, 다섯 가지 주변 색</h1><p>등록된 원본의 6색을 순서대로 표시했습니다. 오른쪽은 #176B5D를 고정한 UI 파생안입니다.<br />원본 색을 본문 색으로 바로 쓰지 않고 대비를 확인한 역할별 token으로 연결합니다.</p><div class="sheet-fixed-colors"><span><i style="background:#176B5D"></i>GCR 주색 #176B5D</span><span><i style="background:#B54708"></i>P2 Warning #B54708</span><span><i style="background:#B42318"></i>P3 Critical #B42318</span></div>${paletteStudy.palettes.map((p) => `<article class="palette-sheet-row"><div><h2>${p.id} ${p.name}</h2><p>${p.note}</p><p><a href="?palette=${p.id}&ui=U1">이 색상으로 화면 보기 ↗</a></p></div><div class="palette-chips" aria-label="${p.source_palette.name} 원본 색상">${p.source_palette.swatches.map((c) => `<div class="palette-chip"><i style="background:${c}"></i><code>${c}</code></div>`).join('')}</div><div class="palette-sample" style="${tokenStyle(p)}"><div class="sample-inner">${severity}<h3>코드 근거가 있는 리뷰 의견</h3><p>파일·행·관측 문맥을 짧은 metadata로 표시합니다.</p><div class="sample-suggestion">수정 제안 · <code>extracted_entities or {}</code></div></div></div></article>`).join('')}`;
} else if (sheet === 'uis') {
  const el = document.querySelector('#ui-sheet');
  el.hidden = false;
  el.innerHTML = `<p class="eyebrow">LAYOUT STUDY / FIVE DIRECTIONS</p><h1>리뷰를 읽고 조사하는 다섯 가지 구조</h1><p>모든 화면을 C1 색상과 동일한 원문으로 비교했습니다. 아래 시안은 디자인 방향을 보여주며 각 라이브러리의 실제 도입은 선택 후 결정합니다.</p><p><a href="?palette=C5&ui=U1%2BU2">선택한 C5 + U1/U2 통합 시안 보기 ↗</a></p><div class="ui-gallery">${designs
    .filter((d) => d.id !== 'U1+U2')
    .map(
      (d) =>
        `<article><h2>${d.id} ${d.name}</h2><p>${d.short}</p><a href="?capture=${d.id}&palette=C1"><img src="images/${d.id}.png" alt="${d.id} ${d.name} 전체 화면 시안" /></a><a href="?ui=${d.id}&palette=C1">색상을 바꿔 비교 ↗</a> · <a href="${d.reference}" target="_blank" rel="noopener">공식 reference ↗</a></article>`,
    )
    .join('')}</div>`;
}

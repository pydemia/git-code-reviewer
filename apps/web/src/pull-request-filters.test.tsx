import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { PullRequestFilters, PullRequestState } from './PullRequestFilters.tsx';

it('exposes mutually exclusive Open/Closed/All controls and repository-wide counts', () => {
  const html = renderToStaticMarkup(
    <PullRequestFilters
      value="closed"
      counts={{ open: 2, closed: 5, all: 7 }}
      onChange={() => {}}
    />,
  );
  expect(html).toContain('role="group"');
  expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  expect(html).toContain('aria-pressed="true" aria-describedby="closed-filter-help">Closed');
  expect(html).toContain('Open<span>2</span>');
  expect(html).toContain('All<span>7</span>');
});

it('does not claim zero results while counts are loading', () => {
  const html = renderToStaticMarkup(
    <PullRequestFilters value="open" counts={null} onChange={() => {}} />,
  );
  expect(html.match(/<span>–<\/span>/g)).toHaveLength(3);
});

it('distinguishes GitHub Open, Draft, Closed and Merged independently of analysis', () => {
  for (const [state, draft, mergedAt, label] of [
    ['open', false, null, 'Open'],
    ['open', true, null, 'Open · Draft'],
    ['closed', false, null, 'Closed'],
    ['closed', true, '2026-09-09T00:00:00Z', 'Merged'],
  ] as const) {
    const html = renderToStaticMarkup(
      <PullRequestState state={state} draft={draft} mergedAt={mergedAt} />,
    );
    expect(html).toContain(`</svg>${label}</span>`);
  }
});

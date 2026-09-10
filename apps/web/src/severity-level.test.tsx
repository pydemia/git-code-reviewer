import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';
import { reviewSeverityLevelSchema, reviewSeverityLevels } from '@gcr/contracts';
import { SeverityLevelField } from './SeverityLevelField';
import { saveAnalysisPrompt } from './api';

it.each(reviewSeverityLevelSchema.options)(
  'renders all Korean explanations with %s selected',
  (value) => {
    const html = renderToStaticMarkup(
      <SeverityLevelField value={value} disabled={false} onChange={() => {}} />,
    );
    expect(html.match(/type="radio"/g)).toHaveLength(5);
    expect(html.match(/checked=""/g)).toHaveLength(1);
    expect(html).toContain(`checked="" value="${value}"`);
    for (const level of reviewSeverityLevelSchema.options)
      expect(html).toContain(reviewSeverityLevels[level].description);
    expect(html).toContain('<legend>분석 수준 · Severity Level</legend>');
  },
);

it('disables the full field while loading and sends an empty optional prompt with the level', async () => {
  expect(
    renderToStaticMarkup(<SeverityLevelField value="moderate" disabled onChange={() => {}} />),
  ).toContain('disabled=""');
  const fetchMock = vi.fn().mockResolvedValue(Response.json({ schemaVersion: 1 }));
  vi.stubGlobal('fetch', fetchMock);
  try {
    await saveAnalysisPrompt('tenant-id', '', 'rigorous');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body)).toEqual({
      instructions: '',
      severityLevel: 'rigorous',
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

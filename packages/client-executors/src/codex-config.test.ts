import { expect, it } from 'vitest';
import { codexReviewArgs, codexReviewPrompt, reviewModelCatalog } from './codex-config.js';

it('retains the response contract in stdin with a bounded schema and no CLI schema option', () => {
  const schema = {
    type: 'object',
    properties: { summary: { type: 'string' } },
    required: ['summary'],
    additionalProperties: false,
  };
  const prompt = 'Review only the captured source. $() `literal`';
  expect(codexReviewPrompt(prompt)).toBe(prompt);
  const framed = codexReviewPrompt(prompt, schema);
  expect(framed.startsWith(prompt + '\n\n')).toBe(true);
  expect(JSON.parse(framed.slice(framed.lastIndexOf('\n') + 1))).toEqual(schema);
  expect(codexReviewArgs('/tmp/review', 'http://127.0.0.1/source')).not.toContain(
    '--output-schema',
  );
  expect(() => codexReviewPrompt(prompt, { description: 'x'.repeat(65_536) })).toThrow(
    'executor-unavailable',
  );
});

it('preserves selected model and effort while restricting the existing source harness', () => {
  const catalog = JSON.stringify({
    models: [
      {
        slug: 'selected-model',
        supported_reasoning_levels: [{ effort: 'high' }],
        base_instructions: 'original',
        supports_search_tool: true,
      },
      { slug: 'gpt-6-astra', supported_reasoning_levels: [{ effort: 'xhigh' }] },
    ],
  });
  const selected = JSON.parse(reviewModelCatalog(catalog, 'selected-model', 'high'));
  expect(selected.models).toHaveLength(1);
  expect(selected.models[0]).toMatchObject({
    slug: 'selected-model',
    supports_search_tool: false,
    apply_patch_tool_type: null,
  });
  const args = codexReviewArgs(
    '/tmp/review',
    'http://127.0.0.1/source',
    false,
    'selected-model',
    'high',
  );
  expect(args[args.indexOf('--model') + 1]).toBe('selected-model');
  expect(args).toContain('model_reasoning_effort="high"');
  expect(args).toContain('features.shell_tool=false');
  expect(args).toContain('features.multi_agent=false');
  expect(() => reviewModelCatalog(catalog, 'selected-model', 'xhigh')).toThrow();
  expect(() => reviewModelCatalog(catalog, 'absent-model', 'high')).toThrow();
});

import { expect, it } from 'vitest';
import { codexReviewArgs, reviewModelCatalog } from './codex-config.js';

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

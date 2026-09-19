import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  analyzeSnapshot,
  loadBuiltInReviewSkills,
  modelReviewFromText,
  type AnalysisInput,
  type AnalysisFile,
} from './index.js';
import { buildImpactPlan } from './impact-plan.js';
import type { ReviewTaskStore, TaskResult } from './review-task-store.js';

const file = (name: string, text = 'value = 1'): AnalysisFile => ({
  id: randomUUID(),
  path: name,
  previousPath: null,
  status: 'added',
  additions: 1,
  deletions: 0,
  patch: `@@ -0,0 +1,1 @@\n+${text}\n`,
});
const base = (files: AnalysisFile[]): AnalysisInput => ({
  analysisId: randomUUID(),
  snapshotId: randomUUID(),
  baseSha: 'a'.repeat(40),
  headSha: 'b'.repeat(40),
  patch: '',
  files,
  fixtureMode: false,
  skills: { bundle: loadBuiltInReviewSkills(), versionId: null, version: null },
  impactReview: { identity: 'fixed synthetic context' },
  budgets: { maxFiles: 5, maxBytes: 4096, maxModelCalls: 128 },
});
const response = (targets: string[] = [], comments: unknown[] = []) =>
  modelReviewFromText(
    JSON.stringify({
      summary: '합성 검증 결과',
      grade: comments.length ? 'critical' : 'adequate',
      file_comments: comments,
      reviewed_targets: targets,
    }),
    [],
  );
const store = () => {
  const cache = new Map<string, TaskResult>(),
    states = new Map<string, string>();
  let hash: string | undefined;
  const adapter: ReviewTaskStore = {
    async initialize(plan) {
      if (hash && hash !== plan.hash) throw Error('changed');
      hash = plan.hash;
      return cache;
    },
    async start(task) {
      states.set(task.id, 'running');
    },
    async complete(task, result) {
      cache.set(task.id, result);
      states.set(task.id, 'completed');
    },
    async fail(task, failure) {
      states.set(task.id, failure.state);
    },
  };
  return { adapter, cache, states };
};

describe('complete impact-group review', () => {
  it('preserves accepted groups and stops preparation on account usage exhaustion, with the reset time', async () => {
    const state = store(),
      input = base(Array.from({ length: 100 }, (_, i) => file(`quota${i}.py`)));
    const failures: unknown[] = [];
    input.impactReview!.store = {
      ...state.adapter,
      async fail(task, failure) {
        failures.push(failure);
        await state.adapter.fail(task, failure);
      },
    };
    const reset = new Date(Date.now() + 3600000);
    let calls = 0;
    input.model = {
      profile: 'synthetic',
      async review(_body, _files, _instructions, context) {
        calls++;
        if (calls === 1) return response(context?.group?.targetIds);
        throw Object.assign(Error('model_usage_limit_reached'), { resumeAfter: reset });
      },
    };
    const output = await analyzeSnapshot(input);
    expect(calls).toBe(2);
    expect(state.cache.size).toBe(1);
    expect(failures).toHaveLength(4);
    for (const failure of failures)
      expect(failure).toMatchObject({
        state: 'budget-wait',
        code: 'MODEL_USAGE_LIMIT_REACHED',
        retryAt: reset,
      });
    expect(output.state).toBe('partial');
    expect(output.report.coverage.limitations).toContain(
      '영향 그룹 검토 미완료 [MODEL_USAGE_LIMIT_REACHED]',
    );
    expect(output.report.coverage.limitations.join()).not.toContain('MODEL_TIME_BUDGET_EXHAUSTED');
  });
  it('stops preparing remaining groups and summaries after a global budget failure', async () => {
    const state = store(),
      input = base(Array.from({ length: 1045 }, (_, i) => file(`file${i}.py`)));
    input.impactReview!.store = state.adapter;
    let prepared = 0;
    input.model = {
      profile: 'synthetic-only',
      async review(_body, _files, _instructions, context) {
        prepared++;
        if (prepared === 1) return response(context?.group?.targetIds);
        throw Error('model_time_budget_exhausted');
      },
    };
    const result = await analyzeSnapshot(input);
    expect(prepared).toBe(2);
    expect(state.cache.size).toBe(1);
    expect([...state.states.values()].filter((value) => value === 'budget-wait')).toHaveLength(52);
    expect(result.report.analysis?.coverage.filesCompleted).toBe(20);
    expect(result.state).toBe('partial');
  });
  it('reviews 1045 changed files without the old file/aggregate-byte truncation or per-file summary calls', async () => {
    const input = base(Array.from({ length: 1045 }, (_, i) => file(`pkg/file${i}.py`)));
    let units = 0,
      summaries = 0,
      largest = 0;
    input.model = {
      profile: 'synthetic-only',
      async review(body, _files, _instructions, context) {
        largest = Math.max(largest, Buffer.byteLength(body));
        if (context?.group) {
          units++;
          expect(context.group.targetIds.length).toBeGreaterThan(1);
          return response(context.group.targetIds);
        }
        summaries++;
        return response();
      },
    };
    const result = await analyzeSnapshot(input);
    expect(result.report.analysis?.coverage.filesCompleted).toBe(1045);
    expect(result.report.analysis?.files).toHaveLength(1045);
    expect(result.report.coverage.filesExamined).toBe(1045);
    expect(result.report.coverage.limitations.some((text) => text.includes('file budget'))).toBe(
      false,
    );
    expect(units).toBeLessThan(128);
    expect(summaries).toBe(1);
    expect(largest).toBeLessThan(96_000);
    expect(result.state).toBe('completed');
  });
  it('groups an imported contract with its caller and validates a finding against the exact supplied side', async () => {
    const input = base([
      file('pkg/caller.py', 'from pkg.contract import validate'),
      file('pkg/contract.py', 'def validate(value): return value'),
    ]);
    input.model = {
      profile: 'synthetic-only',
      async review(body, _files, _instructions, context) {
        if (!context?.group) return response([], []);
        expect(body).toContain('pkg/caller.py');
        expect(body).toContain('pkg/contract.py');
        expect(JSON.parse(body).relations[0].kind).toBe('import');
        return response(context.group.targetIds, [
          {
            file: 'pkg/caller.py',
            side: 'head',
            line: 1,
            end_line: 1,
            category: 'correctness',
            priority: 'P3',
            comment: '합성 호출 계약 검증',
            recommendation: '고정 계약을 적용합니다.',
          },
        ]);
      },
    };
    const result = await analyzeSnapshot(input);
    expect(result.report.analysis?.coverage.filesCompleted).toBe(2);
    expect(result.report.findings).toHaveLength(1);
    expect(result.report.findings[0]?.anchor.fileId).toBe(input.files[0]!.id);
  });
  it('does not complete omitted targets, truncated responses, or invalid comment anchors', async () => {
    for (const invalid of ['missing', 'truncated', 'anchor']) {
      const state = store(),
        input = base([file('a.py'), file('b.py')]);
      input.impactReview!.store = state.adapter;
      input.model = {
        profile: 'synthetic-only',
        async review(_body, _files, _instructions, context) {
          const ids = context?.group?.targetIds ?? [];
          return {
            ...response(
              invalid === 'missing' ? ids.slice(1) : ids,
              invalid === 'anchor'
                ? [
                    {
                      file: 'unseen.py',
                      side: 'head',
                      line: 999,
                      category: 'correctness',
                      priority: 'P3',
                      comment: 'invalid',
                    },
                  ]
                : [],
            ),
            truncated: invalid === 'truncated',
          };
        },
      };
      const output = await analyzeSnapshot(input);
      expect(output.state).toBe('partial');
      expect(output.report.analysis?.coverage.filesCompleted).toBe(0);
      expect(state.cache.size).toBe(0);
    }
  });
  it('restores only validated groups after a worker interruption without repeating model calls', async () => {
    const state = store(),
      input = base(Array.from({ length: 45 }, (_, i) => file(`file${i}.py`)));
    input.impactReview!.store = state.adapter;
    const called: string[] = [];
    let interrupt = true;
    input.model = {
      profile: 'synthetic-only',
      async review(_body, _files, _instructions, context) {
        if (!context?.group) return response();
        if (interrupt && called.length === 1) throw Error('worker_draining');
        called.push(context.group.taskId);
        return response(context.group.targetIds);
      },
    };
    await expect(analyzeSnapshot(input)).rejects.toThrow('worker_draining');
    expect(state.cache.size).toBe(1);
    interrupt = false;
    const result = await analyzeSnapshot(input);
    expect(result.report.analysis?.coverage.filesCompleted).toBe(45);
    expect(new Set(called).size).toBe(called.length);
    expect(called).toHaveLength(3);
  });
  it('keeps budget-exhausted obligations and sensitive/empty-file dispositions distinct', async () => {
    const state = store(),
      files = Array.from({ length: 45 }, (_, i) => file(`file${i}.py`));
    const secret = file('.env', 'PRIVATE_VALUE_DO_NOT_SEND'),
      empty = { ...file('pkg/__init__.py'), patch: '', additions: 0 };
    files.push(secret, empty);
    const input = base(files);
    input.impactReview!.store = state.adapter;
    input.fileExclusions = new Map([[secret.id, 'private-data']]);
    input.budgets!.maxModelCalls = 1;
    input.model = {
      profile: 'synthetic-only',
      async review(body, _files, _instructions, context) {
        expect(body).not.toContain('PRIVATE_VALUE_DO_NOT_SEND');
        return response(context?.group?.targetIds);
      },
    };
    const result = await analyzeSnapshot(input);
    expect(result.state).toBe('partial');
    expect(result.report.analysis?.coverage.filesCompleted).toBeLessThan(47);
    expect([...state.states.values()]).toContain('budget-wait');
    expect(result.report.findings).toHaveLength(0);
    const plan = buildImpactPlan({
      files,
      eligibleIds: new Set(files.filter((f) => f !== secret).map((f) => f.id)),
      identity: 'fixed',
    });
    expect(plan.files).toHaveLength(47);
    expect(plan.files.find((f) => f.id === secret.id)?.disposition).toBe('excluded');
    expect(
      plan.tasks.some((task) =>
        task.targets.some((target) => target.fileId === empty.id && target.metadata),
      ),
    ).toBe(true);
  });
});

describe('impact planning boundaries', () => {
  it('resolves Python relative imports without treating import statements as SQL tables', () => {
    const files = [
      file('pkg/caller.py', 'from .contract import validate\n+sql = "SELECT id FROM records"'),
      file('pkg/contract.py', 'def validate(): return True'),
      file('db/schema.sql', 'CREATE TABLE records (id int);'),
    ];
    const plan = buildImpactPlan({
      files,
      eligibleIds: new Set(files.map((f) => f.id)),
      identity: 'relative',
    });
    expect(
      plan.edges.some(
        (e) => e.kind === 'import' && e.from === files[0]!.id && e.to === files[1]!.id,
      ),
    ).toBe(true);
    expect(plan.edges.filter((e) => e.kind === 'sql-table').map((e) => e.evidence)).toEqual([
      'records',
    ]);
  });
  it('keeps all boundary obligations and never sends oversized tasks', () => {
    const files = [
      file('pkg/contract.py', 'def validate(): return True'),
      ...Array.from({ length: 30 }, (_, i) =>
        file(`pkg/caller${i}.py`, 'from pkg.contract import validate'),
      ),
    ];
    const plan = buildImpactPlan({
      files,
      eligibleIds: new Set(files.map((f) => f.id)),
      identity: 'boundary',
      maxFilesPerGroup: 2,
      maxInputBytes: 6000,
    });
    expect(plan.tasks.some((t) => t.kind === 'boundary')).toBe(true);
    for (const edge of plan.edges)
      expect(plan.tasks.some((t) => t.edges.some((e) => e.id === edge.id))).toBe(true);
    for (const f of plan.files) expect(f.tasks.length).toBeGreaterThan(0);
    for (const t of plan.tasks) expect(Buffer.byteLength(t.body)).toBeLessThanOrEqual(6000);
  });
  it('completes eligible files while recording excluded files separately', async () => {
    const files = [file('ok.py'), file('.env', 'PRIVATE_SENTINEL')],
      input = base(files);
    input.fileExclusions = new Map([[files[1]!.id, 'private']]);
    input.model = {
      profile: 'synthetic-only',
      async review(body, _files, _instructions, context) {
        expect(body).not.toContain('PRIVATE_SENTINEL');
        return response(context?.group?.targetIds);
      },
    };
    const result = await analyzeSnapshot(input);
    expect(result.state).toBe('completed');
    expect(result.report.analysis?.coverage.filesCompleted).toBe(1);
    expect(result.report.analysis?.files).toHaveLength(2);
  });
});

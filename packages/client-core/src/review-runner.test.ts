import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clientReviewReport, reviewExitCode, type LocalReviewResponse } from '@gcr/client-contract';
import { captureLocalSource, type LocalSourceSnapshot } from './source-snapshot.js';
import { contentHash, discoverLocalIdentity } from './local-identity.js';
import { resolveLocalContext } from './review-context.js';
import { resolveLocalExecutionPolicy, type ReviewBudgetOptions } from './review-policy.js';
import { runLocalReview, type LocalReviewExecutor } from './review-runner.js';

let root: string, snapshot: LocalSourceSnapshot;
let context: Awaited<ReturnType<typeof resolveLocalContext>>;
const descriptor = {
  id: 'fixture',
  version: '1',
  model: 'fixture-model',
  configHash: contentHash('fixture'),
  capabilities: {
    available: true,
    sourceIsolation: 'fixed-source-only' as const,
    cancellation: true,
    timeout: true,
    childProcessCleanup: true,
    outputTokenLimit: false,
  },
};
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'gcr-runner-test-'));
  const git = (...args: string[]) =>
    execFileSync(
      'git',
      [
        '-C',
        root,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      {
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
        },
      },
    );
  git('init', '-b', 'main');
  fs.writeFileSync(
    path.join(root, 'cache.py'),
    'def load(keys, cache):\n    return {k: cache.get(k, 1) for k in keys}\n',
  );
  fs.writeFileSync(path.join(root, 'caller.py'), 'value = load(["a", "b"], {"a": 1})["b"]\n');
  git('add', '.');
  git('commit', '-m', 'base');
  fs.writeFileSync(path.join(root, 'cache.py'), 'def load(keys, cache):\n    return cache\n');
  git('add', '.');
  snapshot = captureLocalSource({ cwd: root, kind: 'index' });
  context = await resolveLocalContext({
    client: discoverLocalIdentity(root, 'runner'),
    snapshot,
    stores: [],
    requiredSources: [{ side: 'source', path: 'caller.py' }],
  });
}, 20_000);
afterAll(() => {
  snapshot?.close();
  if (root) fs.rmSync(root, { recursive: true, force: true });
});
function policy(budget?: ReviewBudgetOptions, paths = ['**']) {
  if (context.status !== 'ready') throw Error('fixture');
  const result = resolveLocalExecutionPolicy({
    context,
    snapshot,
    executor: descriptor,
    workspaceTrusted: true,
    approval: {
      client: context.context.client,
      executor: descriptor,
      paths,
      allowRelated: true,
      allowBase: true,
      allowKnowledge: true,
    },
    ...(budget ? { budget } : {}),
  });
  if (result.status !== 'ready') throw Error('fixture');
  return result.policy;
}
type Request = Parameters<LocalReviewExecutor['review']>[0];
async function answer(request: Request) {
  const reads = [];
  for (const [file, side] of [
    ['cache.py', 'source'],
    ['cache.py', 'base'],
    ['caller.py', 'source'],
  ])
    reads.push(JSON.parse(await request.source.execute('read_file', { path: file, side })));
  const response: LocalReviewResponse = {
    summary: 'Review complete.',
    files: [
      {
        path: 'cache.py',
        side: 'source',
        complete: true,
        summary: 'Reviewed fixed source and base.',
        readIds: reads.map((read) => read.readId),
      },
    ],
    findings: [],
    questions: [],
  };
  return { response, reads };
}
function defect(reads: Array<{ readId: string }>): LocalReviewResponse['findings'][number] {
  return {
    title: 'Missing key on partial cache',
    problem: 'The caller indexes b, but the source returns only a.',
    impact: 'KeyError for a missing cache key.',
    recommendation: 'Fill missing keys before returning.',
    category: 'correctness',
    severity: 'P2',
    confidence: 'high',
    anchor: { readId: reads[0]!.readId, startLine: 2, endLine: 2 },
    rationale: 'Base fills missing keys; source bypasses it.',
    conditions: ['Requested keys are only partially cached.'],
    readIds: reads.map((read) => read.readId),
    counterEvidence: {
      status: 'reviewed',
      summary: 'Caller expects every requested key, so a partial dictionary is not accepted.',
      readIds: [reads[2]!.readId],
    },
  };
}
async function run(
  review: LocalReviewExecutor['review'],
  options: { signal?: AbortSignal; budget?: ReviewBudgetOptions } = {},
) {
  if (context.status !== 'ready') throw Error('fixture');
  return runLocalReview({
    snapshot,
    context: context.context,
    policy: policy(options.budget),
    executor: { descriptor, review },
    ...(options.signal ? { signal: options.signal } : {}),
  });
}
describe('fixed-source review runner', () => {
  it('requires full source/base and required caller acknowledgments for a completed review', async () => {
    const report = await run(async (request) => ({
      raw: JSON.stringify((await answer(request)).response),
      model: descriptor.model,
    }));
    expect(clientReviewReport(report).status).toBe('completed');
    expect(reviewExitCode(report)).toBe(0);
    expect(report.evidence).toHaveLength(3);
    expect(
      report.evidence.every(
        (entry) => entry.kind === 'source-read' && entry.provenance.kind === 'local-observation',
      ),
    ).toBe(true);
    expect(report.grade).toBeUndefined();
  });
  it('separates source-confirmed advisory findings from test evidence and gives exit 1', async () => {
    const report = await run(async (request) => {
      const { response, reads } = await answer(request);
      response.findings.push(defect(reads));
      return { raw: JSON.stringify(response), model: descriptor.model };
    });
    expect(reviewExitCode(report)).toBe(1);
    expect(report.findings[0]).toMatchObject({
      anchor: { path: 'cache.py', startLine: 2 },
      evidenceAssessment: { level: 'source-confirmed' },
      policy: { enforcement: 'advisory' },
    });
    expect(report.evidence.some((entry) => entry.kind === 'test-execution')).toBe(false);
  });
  it.each([false, true])('distinguishes optional and required questions (%s)', async (required) => {
    const report = await run(async (request) => {
      const { response } = await answer(request);
      response.questions.push({ prompt: 'Is partial cache supported?', required });
      return { raw: JSON.stringify(response), model: descriptor.model };
    });
    expect(report.status).toBe(required ? 'partial' : 'completed');
    expect(reviewExitCode(report)).toBe(required ? 2 : 1);
  });
  it('does not accept a complete claim without base coverage', async () => {
    const report = await run(async (request) => {
      const { response, reads } = await answer(request);
      response.files[0]!.readIds = [reads[0].readId, reads[2].readId];
      return { raw: JSON.stringify(response), model: descriptor.model };
    });
    expect(report.status).toBe('partial');
    expect(reviewExitCode(report)).toBe(2);
  });
  it('preserves a model incompletion reason when the source/base reads are complete', async () => {
    const report = await run(async (request) => {
      const { response } = await answer(request);
      response.files[0]!.complete = false;
      response.files[0]!.summary = 'All source was read; the runtime contract needs clarification.';
      response.questions.push({ prompt: 'What runtime contract applies?', required: true });
      return { raw: JSON.stringify(response), model: descriptor.model };
    });
    expect(report.status).toBe('partial');
    expect(report.files[0]?.summary).toBe(
      'All source was read; the runtime contract needs clarification.',
    );
    expect(report.problems.map((problem) => problem.message).join(' ')).not.toContain('lines were');
  });
  it.each([
    'forged-read',
    'unselected-anchor',
    'out-of-range',
    'duplicate-file',
    'test-claim',
    'wrong-model',
    'invalid-json',
  ])('rejects %s without retaining a success claim', async (variant) => {
    const report = await run(async (request) => {
      const { response, reads } = await answer(request);
      const finding = defect(reads);
      response.findings.push(finding);
      if (variant === 'forged-read') finding.readIds = ['invented'];
      if (variant === 'unselected-anchor') finding.anchor.readId = reads[2].readId;
      if (variant === 'out-of-range') finding.anchor.endLine = 999;
      if (variant === 'duplicate-file') response.files.push(response.files[0]!);
      return {
        raw:
          variant === 'invalid-json'
            ? '{'
            : JSON.stringify(
                variant === 'test-claim' ? { ...response, testExecuted: true } : response,
              ),
        model: variant === 'wrong-model' ? 'fallback-model' : descriptor.model,
      };
    });
    expect(report.status).toBe('failed');
    expect(report.findings).toEqual([]);
    expect(report.problems[0]?.code).toBe('invalid-output');
    expect(reviewExitCode(report)).toBe(2);
  });
  it('keeps conflicting counter-evidence incomplete', async () => {
    const report = await run(async (request) => {
      const { response, reads } = await answer(request);
      const finding = defect(reads);
      finding.counterEvidence.status = 'conflicting';
      response.findings.push(finding);
      return { raw: JSON.stringify(response), model: descriptor.model };
    });
    expect(report.status).toBe('partial');
    expect(report.findings[0]?.evidenceAssessment.level).toBe('hypothesis');
  });
  it('does not invoke an executor after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const report = await run(
      async () => {
        calls++;
        throw Error('unexpected');
      },
      { signal: controller.signal },
    );
    expect(calls).toBe(0);
    expect(report.status).toBe('cancelled');
  });
  it('discards a late model success after cancellation', async () => {
    const controller = new AbortController();
    const report = await run(
      async (request) => {
        const { response } = await answer(request);
        controller.abort();
        return { raw: JSON.stringify(response), model: descriptor.model };
      },
      { signal: controller.signal },
    );
    expect(report.status).toBe('cancelled');
    expect(report.findings).toEqual([]);
  });
  it('records tool quota exhaustion even if an executor catches it and claims success', async () => {
    const report = await run(
      async (request) => {
        const { response } = await answer(request);
        await request.source.execute('list_files', {}).catch(() => undefined);
        return { raw: JSON.stringify(response), model: descriptor.model };
      },
      { budget: { toolCalls: 3 } },
    );
    expect(report.status).toBe('partial');
    expect(report.problems.some((problem) => problem.code === 'quota-exceeded')).toBe(true);
  });
  it('does not expose raw provider diagnostics', async () => {
    const report = await run(async () => {
      throw Error('Bearer private-provider-token');
    });
    expect(report.problems[0]?.code).toBe('provider-error');
    expect(JSON.stringify(report)).not.toContain('private-provider-token');
  });
});

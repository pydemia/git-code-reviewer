import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  captureLocalSource,
  prepareRemoteReview,
  restoreRemoteReviewSource,
  restoreRemoteReviewContext,
  resolveLocalContext,
  resolveLocalExecutionPolicy,
  runLocalReview,
} from '@gcr/client-core';
import type { ChatAccountSelection } from './account-registry.js';
import type { AgentTurnRequest, AgentTurnResult } from './agent-model.js';
import { createCentralReviewExecutor } from './central-review-executor.js';

function selection(
  turn: (request: AgentTurnRequest) => Promise<AgentTurnResult>,
): ChatAccountSelection {
  return {
    accountId: 'fixture-account',
    accountName: 'Fixture',
    modelName: 'gpt-6-astra',
    modelDisplayName: 'Astra',
    reasoningEffort: 'xhigh',
    credentialVersion: 1,
    model: {
      name: 'gpt-6-astra',
      generate: async () => {
        throw Error('Wrong interface');
      },
      turn,
    },
  };
}
const result = (content: string): AgentTurnResult => ({
  content,
  output: [],
  calls: [],
  usage: null,
});
const call = (name = 'read_file', args = '{"path":"app.ts"}', id = 'call-1'): AgentTurnResult => {
  const call = { name, arguments: args, call_id: id };
  return { content: '', output: [{ type: 'function_call', ...call }], calls: [call], usage: null };
};
const options = { version: 'fixture', modelCalls: 2 };
describe('registered model fixed-source review executor', () => {
  it('executes an uploaded fixed-source review after the original capture and checkout are removed', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gcr-central-executor-'));
    try {
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', root, ...args], {
          stdio: 'pipe',
          env: {
            ...process.env,
            GIT_INDEX_FILE: undefined,
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
          },
        });
      git('init');
      writeFileSync(path.join(root, 'app.ts'), 'export const answer = 42;\n');
      git('add', 'app.ts');
      const captured = captureLocalSource({ cwd: root, kind: 'index' });
      const client = { mode: 'standalone' as const, profileId: 'fixture', ...captured.repository };
      const local = await resolveLocalContext({ client, snapshot: captured, stores: [] });
      if (local.status !== 'ready') throw Error('fixture-context');
      const { payload } = prepareRemoteReview({
        schemaVersion: 1,
        requestId: 'request',
        audience: { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'user' },
        clientId: 'gcr-cli',
        executor: 'central',
        client,
        model: { accountId: 'fixture-account', name: 'gpt-6-astra', reasoningEffort: 'xhigh' },
        context: local.context.toRemoteContext(),
        budget: { modelCalls: 2, durationMs: 120000, sourceBytes: 1048576, toolCalls: 100 },
        retention: { sourceSeconds: 3600, resultSeconds: 86400 },
        snapshot: captured,
        sourceFiles: captured.sourceFiles,
      });
      captured.close();
      rmSync(root, { recursive: true, force: true });
      const snapshot = restoreRemoteReviewSource(payload);
      try {
        const turn = vi.fn(async (request: AgentTurnRequest) => {
          expect(request.reasoningEffort).toBe('xhigh');
          expect(request.tools.map((tool) => tool.name)).toEqual([
            'list_files',
            'read_file',
            'search_code',
          ]);
          if (request.input.length === 1) return call();
          const read = JSON.parse(String(request.input.at(-1)!.output));
          expect(read.text).toBe('export const answer = 42;\n');
          return result(
            JSON.stringify({
              summary: 'Synthetic source review',
              files: [
                {
                  path: 'app.ts',
                  side: 'source',
                  complete: true,
                  summary: 'Read the fixed source',
                  readIds: [read.readId],
                },
              ],
              findings: [],
              questions: [],
            }),
          );
        });
        const executor = createCentralReviewExecutor(selection(turn), options);
        const context = await restoreRemoteReviewContext(payload);
        const resolved = resolveLocalExecutionPolicy({
          context,
          snapshot,
          executor: executor.descriptor,
          workspaceTrusted: true,
          approval: {
            client,
            executor: executor.descriptor,
            sourceHash: snapshot.identity.hash,
            paths: ['app.ts'],
            allowRelated: false,
            allowBase: false,
            allowKnowledge: false,
          },
          budget: { modelCalls: 2 },
        });
        expect(resolved.status).toBe('ready');
        if (resolved.status !== 'ready' || !context.context)
          throw Error('Fixture policy unavailable');
        const report = await runLocalReview({
          snapshot,
          context: context.context,
          policy: resolved.policy,
          executor,
        });
        expect(report.status, JSON.stringify(report.problems)).toBe('completed');
        expect(report.files[0]!.status).toBe('completed');
        expect(turn).toHaveBeenCalledTimes(2);
        expect(report.identity.executor.id).toBe('central');
        expect(report.identity.source.hash).toBe(snapshot.identity.hash);
      } finally {
        snapshot.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    ['shell', '{}'],
    ['read_file', 'not-json'],
  ])('rejects %s without invoking the source port', async (name, args) => {
    const execute = vi.fn(),
      turn = vi.fn(async () => call(name, args));
    const executor = createCentralReviewExecutor(selection(turn), options);
    await expect(
      executor.review({ prompt: 'fixture', source: { execute }, timeoutMs: 1000 }),
    ).rejects.toThrow('invalid-tool');
    expect(execute).not.toHaveBeenCalled();
    expect(turn).toHaveBeenCalledTimes(1);
  });
  it('propagates denied source access and never switches tools or providers', async () => {
    const execute = vi.fn(async () => {
      throw Error('policy-unavailable');
    });
    const turn = vi.fn(async () => call('read_file', '{"path":"private.ts"}'));
    const executor = createCentralReviewExecutor(selection(turn), options);
    await expect(
      executor.review({ prompt: 'fixture', source: { execute }, timeoutMs: 1000 }),
    ).rejects.toThrow('policy-unavailable');
    expect(turn).toHaveBeenCalledTimes(1);
  });
  it('rejects repeated tool IDs and bounds model turns', async () => {
    const execute = vi.fn(async () => '{}'),
      turn = vi.fn(async () => call());
    const executor = createCentralReviewExecutor(selection(turn), options);
    await expect(
      executor.review({ prompt: 'fixture', source: { execute }, timeoutMs: 1000 }),
    ).rejects.toThrow('invalid-tool');
    expect(turn).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    const single = createCentralReviewExecutor(
      selection(async () => call()),
      { ...options, modelCalls: 1 },
    );
    await expect(
      single.review({ prompt: 'fixture', source: { execute }, timeoutMs: 1000 }),
    ).rejects.toThrow('model-call-limit');
  });
  it('propagates cancellation and a total timeout to the registered request', async () => {
    const controller = new AbortController();
    const turn = vi.fn(async (request: AgentTurnRequest) => {
      controller.abort();
      request.signal.throwIfAborted();
      return result('{}');
    });
    const executor = createCentralReviewExecutor(selection(turn), options);
    await expect(
      executor.review({
        prompt: 'fixture',
        source: { execute: vi.fn() },
        timeoutMs: 1000,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(turn).toHaveBeenCalledTimes(1);
    const timeout = createCentralReviewExecutor(
      selection(async (request) => {
        await new Promise((resolve) =>
          request.signal.addEventListener('abort', resolve, { once: true }),
        );
        request.signal.throwIfAborted();
        return result('{}');
      }),
      options,
    );
    await expect(
      timeout.review({ prompt: 'fixture', source: { execute: vi.fn() }, timeoutMs: 10 }),
    ).rejects.toThrow();
  });
  it('rejects an unsupported output-token cap and a mismatched registered model before invocation', () => {
    const turn = vi.fn(async () => result('{}'));
    expect(() =>
      createCentralReviewExecutor(selection(turn), { ...options, outputTokensPerCall: 4096 }),
    ).toThrow('output-token-limit-unsupported');
    const wrong = selection(turn);
    wrong.model = { ...wrong.model, name: 'unapproved-model' };
    expect(() => createCentralReviewExecutor(wrong, options)).toThrow('model-unavailable');
    expect(turn).not.toHaveBeenCalled();
  });
  it('bounds streamed and final model output', async () => {
    const huge = 'x'.repeat(1048577);
    for (const streamed of [true, false]) {
      const executor = createCentralReviewExecutor(
        selection(async (request) => {
          if (streamed) await request.onDelta(huge);
          return result(huge);
        }),
        options,
      );
      await expect(
        executor.review({ prompt: 'fixture', source: { execute: vi.fn() }, timeoutMs: 1000 }),
      ).rejects.toThrow('output-limit');
    }
  });
});

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { RemoteReviewPayload, SourceFile } from '@gcr/client-contract';
import { captureLocalSource } from './source-snapshot.js';
import { contentHash } from './local-identity.js';
import {
  prepareRemoteReview,
  validateRemoteReviewPayload,
  validateRemoteReviewRequest,
} from './remote-review.js';
import { restoreRemoteReviewSource } from './remote-review-source.js';
import { resolveLocalContext } from './review-context.js';
import { resolveLocalExecutionPolicy } from './review-policy.js';
import { runLocalReview, type LocalReviewExecutor } from './review-runner.js';

const audience = { serverId: 'server', tenantId: 'tenant', repositoryId: 'repo', userId: 'user' };
function transfer(approve: (file: SourceFile) => boolean = () => true, missingRequested = false) {
  const root = mkdtempSync(path.join(tmpdir(), 'gcr-upload-view-'));
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
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
      },
    );
  try {
    git('init', '-b', 'main');
    writeFileSync(path.join(root, 'old.ts'), 'export const value = 1;\n');
    writeFileSync(path.join(root, 'deleted.ts'), 'export const removed = true;\n');
    writeFileSync(path.join(root, 'modified.ts'), 'export const value = 10;\n');
    writeFileSync(path.join(root, 'caller.ts'), 'export const caller = 123;\n');
    git('add', '.');
    git('commit', '-m', 'base');
    git('mv', 'old.ts', 'renamed.ts');
    git('rm', 'deleted.ts');
    writeFileSync(path.join(root, 'modified.ts'), 'export const value = 11;\n');
    writeFileSync(path.join(root, 'added.ts'), 'export const added = true;\n');
    git('add', '.');
    const captured = captureLocalSource({
      cwd: root,
      kind: 'index',
      ...(missingRequested
        ? {
            paths: [
              'added.ts',
              'deleted.ts',
              'modified.ts',
              'renamed.ts',
              'missing-private-name.ts',
            ],
          }
        : {}),
    });
    try {
      return prepareRemoteReview({
        schemaVersion: 1,
        requestId: 'request',
        audience,
        clientId: 'gcr-cli',
        executor: 'central',
        client: { mode: 'standalone', profileId: 'fixture', ...captured.repository },
        model: { accountId: 'fixture-account', name: 'gpt-6-astra', reasoningEffort: 'xhigh' },
        context: { provenance: 'client-supplied', documents: [] },
        budget: { modelCalls: 2, durationMs: 120000, sourceBytes: 1048576, toolCalls: 100 },
        retention: { sourceSeconds: 3600, resultSeconds: 86400 },
        snapshot: captured,
        sourceFiles: captured.sourceFiles.filter(approve),
      });
    } finally {
      captured.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const descriptor: LocalReviewExecutor['descriptor'] = {
  id: 'central',
  version: 'fixture',
  model: 'gpt-6-astra',
  configHash: contentHash('fixture'),
  capabilities: {
    available: true,
    sourceIsolation: 'fixed-source-only',
    cancellation: true,
    timeout: true,
    childProcessCleanup: true,
    outputTokenLimit: false,
  },
};
async function run(value: RemoteReviewPayload, omitRenameBase = false) {
  const snapshot = restoreRemoteReviewSource(value);
  try {
    const context = await resolveLocalContext({ snapshot, client: value.client, stores: [] });
    const resolved = resolveLocalExecutionPolicy({
      snapshot,
      context,
      executor: descriptor,
      workspaceTrusted: true,
      approval: {
        client: value.client,
        executor: descriptor,
        sourceHash: snapshot.identity.hash,
        paths: ['**'],
        allowRelated: true,
        allowBase: true,
        allowKnowledge: false,
      },
      budget: value.budget,
    });
    if (resolved.status !== 'ready' || !context.context) throw Error('fixture-context');
    return await runLocalReview({
      snapshot,
      context: context.context,
      policy: resolved.policy,
      executor: {
        descriptor,
        async review(input) {
          expect(input.prompt).toContain('"oldPath":"old.ts"');
          const files = [];
          for (const change of snapshot.selected) {
            const readIds = [];
            for (const file of snapshot.sourceFiles.filter((file) =>
              file.side === 'base'
                ? file.path === (change.oldPath ?? change.path)
                : file.path === change.path,
            )) {
              if (omitRenameBase && file.path === 'old.ts') continue;
              const read = JSON.parse(
                await input.source.execute('read_file', { path: file.path, side: file.side }),
              );
              readIds.push(read.readId);
            }
            files.push({
              path: change.path,
              side: change.side,
              complete: true,
              summary: 'Synthetic source review',
              readIds,
            });
          }
          return {
            model: descriptor.model,
            raw: JSON.stringify({
              summary: 'Synthetic review',
              files,
              findings: [],
              questions: [],
            }),
          };
        },
      },
    });
  } finally {
    snapshot.close();
  }
}
describe('approved remote source view', () => {
  it('retains additions, deletions, modifications and rename bases after the Git checkout is removed', async () => {
    const { payload } = transfer();
    expect(payload.source.review?.changes).toEqual([
      { path: 'added.ts', side: 'source', status: 'A', base: 'absent' },
      { path: 'deleted.ts', side: 'base', status: 'D', base: 'uploaded' },
      { path: 'modified.ts', side: 'source', status: 'M', base: 'uploaded' },
      { path: 'renamed.ts', side: 'source', status: 'R', oldPath: 'old.ts', base: 'uploaded' },
    ]);
    const source = restoreRemoteReviewSource(payload);
    expect(source.identity).toEqual(payload.source.snapshot);
    expect(source.readFile('added.ts', 'base')).toEqual({ status: 'absent' });
    expect(source.readFile('deleted.ts', 'source')).toEqual({ status: 'absent' });
    expect(source).not.toHaveProperty('freeze');
    expect(source.headCommit).toBeNull();
    expect(source.branchName).toBeNull();
    source.close();
    const report = await run(payload);
    expect(report.status, JSON.stringify(report.problems)).toBe('completed');
    expect(report.files).toHaveLength(4);
    expect(report.identity.source).toEqual(payload.source.snapshot);
    expect(report.sourceFiles.some((file) => file.path === 'old.ts' && file.side === 'base')).toBe(
      true,
    );
  });
  it('does not accept a completed rename when the model omitted its approved base', async () => {
    const report = await run(transfer().payload, true);
    expect(report.status).toBe('partial');
    expect(report.files.find((file) => file.source.path === 'renamed.ts')?.status).not.toBe(
      'completed',
    );
    expect(report.problems.some((problem) => problem.code === 'missing-context')).toBe(true);
  });
  it('blocks missing base before execution and never reads an unapproved related file', async () => {
    const { payload } = transfer((file) => file.path !== 'old.ts' && file.path !== 'caller.ts');
    const source = restoreRemoteReviewSource(payload);
    try {
      expect(payload.source.review?.changes.find((change) => change.status === 'R')?.base).toBe(
        'unavailable',
      );
      expect(source.readFile('old.ts', 'base').status).toBe('unavailable');
      expect(source.readFile('caller.ts').status).toBe('unavailable');
      expect(source.readFile('unknown.ts').status).toBe('unavailable');
      expect(source.readFile('.env').status).toBe('unavailable');
      const context = await resolveLocalContext({
        snapshot: source,
        client: payload.client,
        stores: [],
      });
      expect(context.status).toBe('needs-context');
      expect(context.context?.sources.find((file) => file.path === 'old.ts')?.available).toBe(
        false,
      );
      expect(
        resolveLocalExecutionPolicy({
          context,
          snapshot: source,
          executor: descriptor,
          workspaceTrusted: true,
        }).status,
      ).toBe('needs-context');
    } finally {
      source.close();
    }
  });
  it('binds change metadata to approval and refuses to invent it for legacy receipts', () => {
    const { payload, payloadHash } = transfer();
    const old = structuredClone(payload);
    delete old.source.review;
    expect(validateRemoteReviewPayload(old)).toEqual(old);
    expect(() => restoreRemoteReviewSource(old)).toThrow('invalid-upload');
    payload.source.review!.incomplete = true;
    expect(() =>
      validateRemoteReviewRequest(
        { payload, approval: { payloadHash, approvedAt: new Date().toISOString() } },
        { audience, clientId: 'gcr-cli' },
      ),
    ).toThrow('approval-mismatch');
  });
  it.each([
    'wrong-side',
    'missing-old-path',
    'private-old-path',
    'duplicate-change',
    'missing-change',
    'false-base',
    'deleted-source',
  ])('rejects inconsistent change descriptions: %s', (kind) => {
    const value = transfer().payload,
      changes = value.source.review!.changes;
    const renamed = changes.find((change) => change.status === 'R')!;
    if (kind === 'wrong-side') renamed.side = 'base';
    if (kind === 'missing-old-path') delete renamed.oldPath;
    if (kind === 'private-old-path') {
      renamed.oldPath = '.env';
      renamed.base = 'unavailable';
    }
    if (kind === 'duplicate-change') changes.push(structuredClone(renamed));
    if (kind === 'missing-change') changes.pop();
    if (kind === 'false-base') renamed.base = 'absent';
    if (kind === 'deleted-source') {
      const file = structuredClone(
        value.source.files.find((file) => file.metadata.path === 'deleted.ts')!,
      );
      file.metadata.side = 'source';
      value.source.files.push(file);
    }
    expect(() => restoreRemoteReviewSource(value)).toThrow('invalid-upload');
  });
  it('retains aggregate capture failures without uploading excluded names or claiming completion', async () => {
    const value = transfer(() => true, true).payload;
    expect(value.source.review!.incomplete).toBe(true);
    expect(JSON.stringify(value)).not.toContain('missing-private-name.ts');
    const report = await run(value);
    expect(report.status).toBe('partial');
    expect(report.problems.some((problem) => problem.code === 'source-truncated')).toBe(true);
    expect(report.excluded).toEqual([]);
  });
  it('returns detached descriptors, uses bounded source excerpts and clears bytes on close', () => {
    const value = transfer().payload;
    const source = restoreRemoteReviewSource(value);
    value.source.files[0]!.text = 'mutation';
    const selected = source.selected;
    selected[0]!.path = 'mutation';
    const read = source.readLines('renamed.ts', 'source', 1, 1000);
    expect(read.status).toBe('available');
    if (read.status === 'available') {
      expect(read.text).toBe('export const value = 1;\n');
      read.source.path = 'mutation';
    }
    expect(source.readFile('renamed.ts').status).toBe('available');
    expect(source.selected[0]!.path).toBe('added.ts');
    expect(() => source.readLines('renamed.ts', 'source', 0)).toThrow('invalid-source-request');
    expect(() => source.readLines('renamed.ts', 'source', 999)).toThrow('invalid-source-request');
    source.close();
    expect(() => source.readFile('renamed.ts')).toThrow('snapshot-closed');
    expect(() => source.sourceFiles).toThrow('snapshot-closed');
  });
});

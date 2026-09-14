import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { remoteReviewStatus, type RemoteReviewPayload } from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import { captureLocalSource } from './source-snapshot.js';
import {
  assertFreshRemoteReviewApproval,
  prepareRemoteReview,
  validateRemoteReviewPayload,
  validateRemoteReviewRequest,
} from './remote-review.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const at = '2026-09-14T00:00:00.000Z';
const audience = { serverId: 'server', tenantId: 'tenant', userId: 'user', repositoryId: 'repo' };
function payload(): RemoteReviewPayload {
  const text = 'export const value = 1;\n';
  return {
    schemaVersion: 1,
    requestId: 'request',
    audience,
    clientId: 'commit-defender',
    executor: 'central',
    client: {
      mode: 'standalone',
      profileId: 'profile',
      repositoryKey: 'a'.repeat(64),
      worktreeKey: 'b'.repeat(64),
    },
    model: { accountId: 'account', name: 'gpt-6-astra', reasoningEffort: 'xhigh' },
    source: {
      provenance: 'client-captured',
      snapshot: {
        kind: 'working-tree',
        hash: 'c'.repeat(64),
        objectFormat: 'sha1',
        baseCommit: null,
        baseTree: 'd'.repeat(40),
      },
      files: [
        {
          metadata: {
            path: 'app.ts',
            side: 'source',
            hash: hash(text),
            byteLength: Buffer.byteLength(text),
            lineCount: 2,
          },
          text,
        },
      ],
      selected: [{ path: 'app.ts', side: 'source' }],
    },
    context: {
      provenance: 'client-supplied',
      documents: [
        {
          id: 'note',
          kind: 'instructions',
          text: 'Review null handling.',
          hash: hash('Review null handling.'),
        },
      ],
    },
    budget: {
      modelCalls: 2,
      durationMs: 120000,
      sourceBytes: 1048576,
      toolCalls: 100,
      outputTokensPerCall: 4096,
    },
    retention: { sourceSeconds: 3600, resultSeconds: 86400 },
  };
}
function request(value = payload()) {
  return { payload: value, approval: { payloadHash: contentHash(value), approvedAt: at } };
}
const expected = { audience, clientId: 'commit-defender' as const };

describe('explicit central review transfer', () => {
  it('allows local knowledge with an independently chosen central executor', () => {
    expect(validateRemoteReviewRequest(request(), expected).payload.client.mode).toBe('standalone');
  });
  it('returns detached data and does not issue approval while preparing source', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'gcr-remote-source-'));
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
      writeFileSync(path.join(root, 'app.ts'), 'export const value = 2;\n');
      writeFileSync(path.join(root, 'other.ts'), 'unapproved related text');
      writeFileSync(path.join(root, '.env'), 'SYNTHETIC_EXCLUDED_VALUE=secret');
      git('add', 'app.ts', 'other.ts');
      const snapshot = captureLocalSource({ cwd: root, kind: 'index', paths: ['app.ts'] });
      try {
        const input = payload();
        const sourceFiles = snapshot.sourceFiles.filter((file) => file.path === 'app.ts');
        const prepared = prepareRemoteReview({
          ...input,
          client: { ...input.client, ...snapshot.repository },
          snapshot,
          sourceFiles,
        });
        expect(prepared.payload.source.files.map((file) => file.metadata.path)).toEqual(['app.ts']);
        const wire = JSON.stringify(prepared.payload);
        for (const excluded of [
          root,
          'unapproved related text',
          '.env',
          'SYNTHETIC_EXCLUDED_VALUE',
          'diff --git',
        ])
          expect(wire).not.toContain(excluded);
        expect(prepared).not.toHaveProperty('approval');
        expect(prepared.payloadHash).toBe(contentHash(prepared.payload));
        writeFileSync(path.join(root, 'app.ts'), 'later edit');
        expect(prepared.payload.source.files[0]!.text).toBe('export const value = 2;\n');
        expect(() => prepareRemoteReview({ ...input, snapshot, sourceFiles })).toThrow(
          'invalid-upload',
        );
        expect(() =>
          prepareRemoteReview({
            ...input,
            client: prepared.payload.client,
            snapshot,
            sourceFiles: [],
          }),
        ).toThrow('invalid-upload');
      } finally {
        snapshot.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    '../app.ts',
    '/app.ts',
    'C:/app.ts',
    'a\\b.ts',
    '.env',
    '.git/config',
    'node_modules/a.ts',
  ])('rejects unauthorized source path %s', (file) => {
    const value = payload();
    value.source.files[0]!.metadata.path = file;
    value.source.selected[0]!.path = file;
    expect(() => validateRemoteReviewPayload(value)).toThrow('invalid-upload');
  });
  it.each(['hash', 'byteLength', 'lineCount', 'gitBlob'] as const)(
    'verifies transmitted %s',
    (field) => {
      const value = payload();
      Object.assign(value.source.files[0]!.metadata, {
        [field]: field === 'hash' ? '0'.repeat(64) : field === 'gitBlob' ? '0'.repeat(40) : 99,
      });
      expect(() => validateRemoteReviewPayload(value)).toThrow('invalid-upload');
    },
  );
  it.each(['sha1', 'sha256'] as const)('validates Git blob content for %s', (format) => {
    const value = payload(),
      file = value.source.files[0]!;
    value.source.snapshot.objectFormat = format;
    value.source.snapshot.baseTree = 'd'.repeat(format === 'sha1' ? 40 : 64);
    file.metadata.gitBlob = createHash(format)
      .update(`blob ${Buffer.byteLength(file.text)}\0${file.text}`)
      .digest('hex');
    expect(validateRemoteReviewPayload(value)).toEqual(value);
  });
  it.each(['\0', '\ud800'])('rejects binary or non-roundtrippable text', (suffix) => {
    const value = payload(),
      file = value.source.files[0]!;
    file.text += suffix;
    file.metadata.hash = hash(file.text);
    file.metadata.byteLength = Buffer.byteLength(file.text);
    expect(() => validateRemoteReviewPayload(value)).toThrow('invalid-upload');
  });
  it('rejects duplicate sources, missing selected bytes and duplicate context IDs', () => {
    const duplicate = payload();
    duplicate.source.files.push(structuredClone(duplicate.source.files[0]!));
    const missing = payload();
    missing.source.selected[0]!.side = 'base';
    const duplicateContext = payload();
    duplicateContext.context.documents.push(duplicateContext.context.documents[0]!);
    const changedContext = payload();
    changedContext.context.documents[0]!.text += ' changed';
    for (const value of [duplicate, missing, duplicateContext, changedContext])
      expect(() => validateRemoteReviewPayload(value)).toThrow('invalid-upload');
  });
  it('rejects raw diff, credential fields and PR snapshot claims', () => {
    const rawDiff = payload();
    Object.assign(rawDiff.source, { diff: 'unapproved source' });
    const credential = payload();
    Object.assign(credential.model, { token: 'SYNTHETIC_ONLY' });
    const pr = payload();
    Object.assign(pr.source, { pullRequestId: '123' });
    for (const value of [rawDiff, credential, pr])
      expect(() => validateRemoteReviewPayload(value)).toThrow('invalid-upload');
  });
  it.each(['account', 'model', 'budget', 'retention', 'source', 'context', 'request'] as const)(
    'requires new approval after a %s change',
    (field) => {
      const value = request();
      if (field === 'account') value.payload.model.accountId = 'other';
      if (field === 'model') value.payload.model.reasoningEffort = 'high';
      if (field === 'budget') value.payload.budget.modelCalls++;
      if (field === 'retention') value.payload.retention.resultSeconds++;
      if (field === 'source') value.payload.source.snapshot.hash = 'e'.repeat(64);
      if (field === 'context') value.payload.context.documents = [];
      if (field === 'request') value.payload.requestId = 'other';
      expect(() => validateRemoteReviewRequest(value, expected)).toThrow('approval-mismatch');
    },
  );
  it.each(['serverId', 'tenantId', 'userId', 'repositoryId'] as const)(
    'binds authenticated %s independently of submitted approval',
    (field) => {
      expect(() =>
        validateRemoteReviewRequest(request(), {
          ...expected,
          audience: { ...audience, [field]: 'other' },
        }),
      ).toThrow('audience-mismatch');
    },
  );
  it('binds the client type and rejects conflicting central knowledge audience', () => {
    expect(() =>
      validateRemoteReviewRequest(request(), { ...expected, clientId: 'gcr-cli' }),
    ).toThrow('audience-mismatch');
    const value = payload();
    value.client = {
      ...value.client,
      mode: 'centralized',
      audience: { ...audience, repositoryId: 'other' },
    };
    expect(() => validateRemoteReviewPayload(value)).toThrow('invalid-upload');
  });
  it('bounds total JSON bytes, individual file bytes, budgets and retention', () => {
    const huge = payload();
    huge.context.documents = Array.from({ length: 128 }, (_, index) => ({
      id: `doc${index}`,
      kind: 'memory',
      text: '한'.repeat(100000),
      hash: 'a'.repeat(64),
    }));
    const hugeFile = payload();
    hugeFile.source.files[0]!.text = '한'.repeat(800000);
    const zeroBudget = payload();
    zeroBudget.budget.modelCalls = 0;
    const longRetention = payload();
    longRetention.retention.sourceSeconds = 86401;
    const shortRetention = payload();
    shortRetention.retention.sourceSeconds = 60;
    for (const value of [huge, hugeFile, zeroBudget, longRetention, shortRetention])
      expect(() => validateRemoteReviewPayload(value)).toThrow('invalid-upload');
  });
  it('checks approval freshness only for new admission so an old receipt can be recovered', () => {
    const value = request();
    expect(() => assertFreshRemoteReviewApproval(value, Date.parse(at) + 300000)).not.toThrow();
    expect(() => assertFreshRemoteReviewApproval(value, Date.parse(at) + 300001)).toThrow(
      'approval-expired',
    );
    expect(() => assertFreshRemoteReviewApproval(value, Date.parse(at) - 60001)).toThrow(
      'approval-expired',
    );
    expect(validateRemoteReviewRequest(value, expected)).toEqual(value);
  });
  it('keeps uncertain execution distinct from cancellation and completed reports', () => {
    const receipt = {
      schemaVersion: 1,
      requestId: 'request',
      audience,
      clientId: 'commit-defender',
      payloadHash: 'a'.repeat(64),
      receivedAt: at,
      sourceExpiresAt: '2026-09-14T01:00:00.000Z',
      resultExpiresAt: '2026-09-15T00:00:00.000Z',
    };
    expect(
      remoteReviewStatus({ ...receipt, state: 'uncertain', reason: 'execution-lost' }).state,
    ).toBe('uncertain');
    expect(() => remoteReviewStatus({ ...receipt, state: 'completed' })).toThrow();
    expect(() =>
      remoteReviewStatus({ ...receipt, state: 'running', reportHash: 'b'.repeat(64) }),
    ).toThrow();
    expect(() =>
      remoteReviewStatus({ ...receipt, state: 'cancelled', reason: 'execution-lost' }),
    ).toThrow();
  });
});

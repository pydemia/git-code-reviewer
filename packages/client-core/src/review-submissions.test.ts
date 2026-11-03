import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
  reviewSubmission,
  reviewSubmissionJson,
  REVIEW_SUBMISSION_RETENTION_MS,
  type ReviewSubmission,
} from '@gcr/client-contract';
import { contentHash, canonicalJson } from './local-identity.js';
import { ReviewSubmissionQueue, prepareReviewSubmission } from './review-submissions.js';
import { ReviewSubmissionDeliveryError } from './knowledge-http.js';
import type { CentralConnections } from './central-connection.js';
vi.setConfig({ testTimeout: 20000 });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanup.splice(0)) await clean();
});
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gcr-submit-'));
  const audience = {
    serverId: randomUUID(),
    tenantId: randomUUID(),
    repositoryId: randomUUID(),
    userId: randomUUID(),
  };
  const connectionId = contentHash(audience),
    keys = new Map<string, Buffer>();
  let now = new Date(),
    selected = audience,
    deliveries = 0,
    mode: number | 'ambiguous' | 'hold' = 200;
  let release = () => {};
  const connections = {
    async historyIdentity() {
      return { id: connectionId, audience: selected };
    },
    async status() {
      return { status: 'connected', clientId: 'gcr-cli' };
    },
    async submitReview(_id: string, payload: ReviewSubmission) {
      deliveries++;
      if (mode === 'hold')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (mode === 'ambiguous') throw Error('private transport diagnostics must not persist');
      if (typeof mode === 'number' && mode !== 200) throw new ReviewSubmissionDeliveryError(mode);
      return {
        schemaVersion: 1,
        id: 'server-receipt',
        requestId: payload.id,
        payloadHash: contentHash(payload),
        audience: payload.audience,
        clientId: payload.clientId,
        kind: payload.kind,
        status: 'submitted',
        evidence: 'client-reported',
        receivedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + REVIEW_SUBMISSION_RETENTION_MS).toISOString(),
      };
    },
  } as unknown as Pick<CentralConnections, 'historyIdentity' | 'status' | 'submitReview'>;
  const options = {
    scope: {
      kind: 'repository' as const,
      profileId: 'fixture',
      repositoryKey: contentHash('repo'),
      worktreeKey: contentHash('worktree'),
    },
    dataDirectory: directory,
    keys: {
      async read(id: string) {
        const key = keys.get(id);
        return key && Buffer.from(key);
      },
      async write(id: string, key: Buffer) {
        keys.set(id, Buffer.from(key));
      },
      async remove(id: string) {
        keys.delete(id);
      },
    },
    connectionId,
    connections,
    now: () => now,
  };
  const queues: ReviewSubmissionQueue[] = [];
  const open = async () => {
    const queue = await ReviewSubmissionQueue.open(options);
    queues.push(queue);
    return queue;
  };
  const queue = await open();
  cleanup.push(async () => {
    for (const q of queues) q.close();
    await rm(directory, { recursive: true, force: true });
  });
  const input = () =>
    reviewSubmission({
      schemaVersion: 1,
      id: randomUUID(),
      audience,
      clientId: 'gcr-cli',
      approvedAt: now.toISOString(),
      visibility: 'repository-reviewers',
      review: {
        runId: 'review',
        mode: 'standalone',
        sourceHash: contentHash('source'),
        contextHash: contentHash('context'),
        snapshot: null,
      },
      kind: 'feedback',
      feedback: {
        kind: 'judgment',
        message: 'Explicit public judgment',
        findingId: null,
        rule: null,
        source: null,
      },
    });
  return {
    queue,
    open,
    input,
    audience,
    deliveries: () => deliveries,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    release: () => release(),
    switchUser: () => {
      selected = { ...audience, userId: randomUUID() };
    },
    advance: () => {
      now = new Date(now.getTime() + REVIEW_SUBMISSION_RETENTION_MS + 1000);
    },
  };
}
it('requires confirmation of a narrow projection, rejects hidden data and persists without sending', async () => {
  const f = await fixture(),
    input = f.input();
  await expect(f.queue.enqueue(input, contentHash('other'))).rejects.toThrow(
    'confirmation-required',
  );
  for (const extra of [{ chat: 'secret' }, { memory: 'secret' }, { sourceBody: 'secret' }])
    expect(() => reviewSubmission({ ...input, ...extra })).toThrow();
  expect(reviewSubmissionJson(input)).toBe(canonicalJson(input));
  await f.queue.enqueue(input, contentHash(input));
  expect(f.deliveries()).toBe(0);
  expect((await (await f.open()).get(input.id)).value.payload).toEqual(input);
  const corpus = JSON.parse(
    await readFile(
      new URL('../../../tests/fixtures/client-contract/reports.json', import.meta.url),
      'utf8',
    ),
  );
  const report = structuredClone(corpus.cases[0].report);
  report.summary = 'PRIVATE_SUMMARY_CANARY';
  const projected = prepareReviewSubmission({
    report,
    id: randomUUID(),
    audience: f.audience,
    clientId: 'gcr-cli',
    approvedAt: input.approvedAt,
    selection: { kind: 'feedback', feedbackKind: 'judgment', message: 'Public user decision' },
  });
  expect(JSON.stringify(projected)).not.toContain('PRIVATE_SUMMARY_CANARY');
  expect(JSON.stringify(projected)).not.toContain('entries');
  expect(projected.payloadHash).toBe(contentHash(projected.submission));
});
it('keeps ambiguous delivery pending, reuses the same request and requires explicit retry after denial', async () => {
  const f = await fixture(),
    input = f.input();
  await f.queue.enqueue(input, contentHash(input));
  f.setMode('ambiguous');
  expect((await f.queue.send(input.id)).value).toMatchObject({
    status: 'pending',
    lastError: 'delivery-unconfirmed',
  });
  const reopened = await f.open();
  f.setMode(403);
  expect((await reopened.send(input.id)).value.status).toBe('rejected');
  await expect(reopened.send(input.id)).rejects.toThrow('explicit-retry-required');
  expect(f.deliveries()).toBe(2);
  f.setMode(200);
  const receipt = (await reopened.send(input.id, undefined, true)).value.receipt;
  expect(receipt?.requestId).toBe(input.id);
  await reopened.send(input.id);
  expect(f.deliveries()).toBe(3);
  await expect(
    reopened.enqueue(
      { ...input, approvedAt: new Date(Date.parse(input.approvedAt) + 1).toISOString() },
      contentHash({
        ...input,
        approvedAt: new Date(Date.parse(input.approvedAt) + 1).toISOString(),
      }),
    ),
  ).rejects.toThrow('id-conflict');
});
it('fences concurrent senders, prevents cross-user delivery and prunes expired encrypted payloads', async () => {
  const f = await fixture(),
    input = f.input();
  await f.queue.enqueue(input, contentHash(input));
  f.setMode('hold');
  const running = f.queue.send(input.id);
  await vi.waitFor(() => expect(f.deliveries()).toBe(1));
  const other = await f.open();
  await expect(other.send(input.id)).rejects.toThrow('busy');
  await expect(other.cancel(input.id)).rejects.toThrow('delivery-unconfirmed');
  f.release();
  await running;
  const second = f.input();
  await f.queue.enqueue(second, contentHash(second));
  await f.queue.cancel(second.id);
  await expect(f.queue.send(second.id)).rejects.toThrow('cancelled');
  f.advance();
  expect((await f.queue.prune()).deleted).toBe(2);
  expect(await f.queue.list()).toEqual([]);
  const third = f.input();
  await f.queue.enqueue(third, contentHash(third));
  f.switchUser();
  await expect(f.queue.send(third.id)).rejects.toThrow('selection-changed');
  expect(f.deliveries()).toBe(1);
  f.advance();
  expect((await f.queue.prune()).deleted).toBe(1);
});

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { admittedFetch, withModelBudget } from './model-admission.js';

const url = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!url)('parallel account admission', () => {
  const schema = `gcr_parallel_${randomUUID().replaceAll('-', '')}`;
  let root: Database, database: Database;
  beforeAll(async () => {
    const target = new URL(url!);
    if (!['localhost', '127.0.0.1', '[::1]'].includes(target.hostname))
      throw Error('Use a local test database');
    root = createDatabase(target.href);
    await root.query(`create schema ${schema}`);
    target.searchParams.set('options', `-c search_path=${schema}`);
    database = createDatabase(target.href);
    await runMigrations(database, path.resolve('packages/db/migrations'));
  });
  afterAll(async () => {
    await database?.end();
    if (root) {
      await root.query(`drop schema ${schema} cascade`);
      await root.end();
    }
  });
  const reserve = async (
    quota: string,
    run: string,
    maxCalls = 100,
    batch = true,
    concurrency = 4,
    bytes = 1,
  ) =>
    (
      await database.query<{ id: string | null }>(
        'select reserve_model_request($1,$2,$3,$4,$5,$6) as id',
        [quota, run, maxCalls, bytes, batch, concurrency],
      )
    ).rows[0]!.id;
  const finish = (id: string, cooldown: Date | null = null) =>
    database.query("select finish_model_request($1,'completed',$2)", [id, cooldown]);

  it('atomically limits concurrent workers to four batch reservations and reserves one chat slot', async () => {
    const quota = randomUUID(),
      run = randomUUID();
    const ids = (await Promise.all(Array.from({ length: 20 }, () => reserve(quota, run)))).filter(
      (id) => id !== null,
    );
    expect(ids).toHaveLength(4);
    expect(await reserve(quota, randomUUID())).toBeNull();
    const chat = await reserve(quota, randomUUID(), 8, false);
    expect(chat).not.toBeNull();
    expect(await reserve(quota, randomUUID(), 8, false)).toBeNull();
    await Promise.all([...ids, chat!].map((id) => finish(id)));
    expect(await reserve(quota, run)).not.toBeNull();
  });
  it('does not overrun a run budget even when several accounts race', async () => {
    const run = randomUUID();
    const ids = await Promise.all(Array.from({ length: 12 }, () => reserve(randomUUID(), run, 2)));
    expect(ids.filter(Boolean)).toHaveLength(2);
  });
  it('retains account-wide byte/rate budgets and the longest cooldown', async () => {
    const quota = randomUUID();
    const first = await reserve(quota, randomUUID(), 100, true, 4, 700000);
    expect(await reserve(quota, randomUUID(), 100, true, 4, 400000)).toBeNull();
    const second = await reserve(quota, randomUUID());
    const later = new Date(Date.now() + 60000);
    await finish(first!, later);
    await finish(second!, new Date(Date.now() + 5000));
    expect(await reserve(quota, randomUUID())).toBeNull();
    const current = (
      await database.query('select cooldown_until from model_account_capacity where quota_key=$1', [
        quota,
      ])
    ).rows[0];
    expect(current.cooldown_until.getTime()).toBe(later.getTime());
    const rateQuota = randomUUID();
    for (let n = 0; n < 60; n++) await finish((await reserve(rateQuota, randomUUID()))!);
    expect(await reserve(rateQuota, randomUUID())).toBeNull();
  });
  it('recovers expired slots, rejects stale heartbeats and never frees a replacement slot', async () => {
    const quota = randomUUID();
    const first = await reserve(quota, randomUUID(), 8, true, 1);
    await database.query(
      "update model_request_ledger set lease_expires_at=clock_timestamp()-interval '1 second' where id=$1",
      [first],
    );
    const next = await reserve(quota, randomUUID(), 8, true, 1);
    expect(next).not.toBeNull();
    expect(
      (await database.query('select heartbeat_model_request($1) as ok', [first])).rows[0].ok,
    ).toBe(false);
    await finish(first!);
    expect(await reserve(quota, randomUUID(), 8, true, 1)).toBeNull();
    expect(
      (await database.query('select heartbeat_model_request($1) as ok', [next])).rows[0].ok,
    ).toBe(true);
  });
  it('honors a legacy worker lease and protects new leases from legacy admission during rollout', async () => {
    const quota = randomUUID();
    await database.query(
      "insert into model_account_capacity(quota_key,reservation_id,lease_expires_at) values($1,gen_random_uuid(),clock_timestamp()+interval '1 minute')",
      [quota],
    );
    expect(await reserve(quota, randomUUID())).toBeNull();
    await database.query(
      "update model_account_capacity set lease_expires_at=clock_timestamp()-interval '1 second' where quota_key=$1",
      [quota],
    );
    const id = await reserve(quota, randomUUID());
    expect(id).not.toBeNull();
    expect(
      (
        await database.query(
          'select reservation_id,lease_expires_at>clock_timestamp() as active from model_account_capacity where quota_key=$1',
          [quota],
        )
      ).rows[0],
    ).toEqual({ reservation_id: null, active: true });
  });
  it('runs four transports at once and releases slots only after response consumption', async () => {
    const quota = randomUUID();
    let active = 0,
      peak = 0;
    const transport = admittedFetch(database, quota, async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 15));
      active--;
      return new Response('synthetic');
    });
    const responses = await withModelBudget(
      { runKey: `analysis:${randomUUID()}`, maxCalls: 4, wait: true, concurrency: 4 },
      () =>
        Promise.all(
          Array.from({ length: 4 }, () => transport('https://synthetic.invalid/v1/responses')),
        ),
    );
    expect(peak).toBe(4);
    expect(await reserve(quota, randomUUID())).toBeNull();
    await Promise.all(responses.map((response) => response.text()));
    expect(await reserve(quota, randomUUID())).not.toBeNull();
  });
});

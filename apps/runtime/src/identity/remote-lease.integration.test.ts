import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@gcr/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { withIdentityRemoteLease } from './remote-lease.js';

const url = process.env.GCR_TEST_DATABASE_URL;
describe.skipIf(!url).sequential('Realm remote-operation serialization', () => {
  let database: Database, replica: Database;
  beforeAll(() => {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(url!).hostname))
      throw Error('Isolated local PostgreSQL only');
    database = createDatabase(url!, 2);
    replica = createDatabase(url!, 2);
  });
  afterAll(async () => {
    await database?.end();
    await replica?.end();
  });
  const issuer = () => `https://identity.test/realms/fixture-${randomUUID()}`;
  it('excludes another realm writer while allowing unrelated realms and SQL transactions', async () => {
    const realm = issuer();
    const first = await withIdentityRemoteLease(database, realm, async ({ assertHeld }) => {
      assertHeld();
      expect(await withIdentityRemoteLease(replica, realm, async () => 'wrong')).toEqual({
        acquired: false,
      });
      expect(await withIdentityRemoteLease(replica, issuer(), async () => 'separate')).toEqual({
        acquired: true,
        result: 'separate',
      });
      const client = await database.connect();
      try {
        await client.query('begin');
        await client.query('select 1');
        await client.query('commit');
      } finally {
        client.release();
      }
      return 'first';
    });
    expect(first).toEqual({ acquired: true, result: 'first' });
    expect(await withIdentityRemoteLease(replica, realm, async () => 'next')).toEqual({
      acquired: true,
      result: 'next',
    });
  });
  it('releases ownership after an action fails and bounds further network work', async () => {
    const realm = issuer();
    await expect(
      withIdentityRemoteLease(database, realm, async () => {
        throw Error('synthetic-action');
      }),
    ).rejects.toThrow('synthetic-action');
    await withIdentityRemoteLease(replica, realm, async ({ assertHeld }) => {
      const now = Date.now();
      const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 90_001);
      try {
        expect(assertHeld).toThrow('IDENTITY_ADMIN_UNAVAILABLE');
      } finally {
        clock.mockRestore();
      }
    });
    expect((await withIdentityRemoteLease(database, realm, async () => true)).acquired).toBe(true);
  });
  it('invalidates the request guard when the dedicated owning connection is lost', async () => {
    const realm = issuer();
    await withIdentityRemoteLease(database, realm, async ({ assertHeld }) => {
      const lock = (
        await replica.query<{ pid: number }>(
          `select pid from pg_locks where locktype='advisory'
        and classid=13372027::oid and objid=hashtext($1)::oid and granted`,
          [realm],
        )
      ).rows;
      expect(lock).toHaveLength(1);
      await replica.query('select pg_terminate_backend($1)', [lock[0]!.pid]);
      await vi.waitFor(() => expect(assertHeld).toThrow('IDENTITY_ADMIN_UNAVAILABLE'), {
        timeout: 2000,
      });
      expect((await withIdentityRemoteLease(replica, realm, async () => true)).acquired).toBe(true);
    });
  });
});

import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { startLocalService, callLocalService, localServiceAddress } from './local-service.js';
import type { LocalKeyStore } from './local-credentials.js';

describe.skipIf(process.platform !== 'win32')('Windows native service IPC', () => {
  it('keeps same-user IPC, profile boundaries, ownership and restart', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-w03-ipc-'));
    const values = new Map<string, Buffer>();
    const keys: LocalKeyStore = {
      read: async (id) => {
        const value = values.get(id);
        return value && Buffer.from(value);
      },
      write: async (id, value) => {
        values.set(id, Buffer.from(value));
      },
      remove: async (id) => {
        values.delete(id);
      },
    };
    const location = { profileId: randomUUID(), dataDirectory: path.join(root, 'private') };
    const options = {
      ...location,
      keys,
      run: async () => ({ exitCode: 0 as const, status: 'completed' }),
    };
    let service: Awaited<ReturnType<typeof startLocalService>> | undefined;
    try {
      service = await startLocalService(options);
      const status = (await callLocalService(location, { action: 'status' })) as {
        pid: number;
        profileId: string;
        status: string;
      };
      expect(status).toMatchObject({
        status: 'running',
        pid: process.pid,
        profileId: location.profileId,
      });
      await expect(startLocalService(options)).rejects.toMatchObject({ code: 'service-busy' });
      await expect(callLocalService(location, { action: 'unknown' })).rejects.toMatchObject({
        code: 'service-invalid',
      });
      await expect(
        callLocalService({ ...location, profileId: randomUUID() }, { action: 'status' }, 500),
      ).rejects.toMatchObject({ code: 'service-unavailable' });
      expect(
        await localServiceAddress({
          ...location,
          dataDirectory: location.dataDirectory.toUpperCase(),
        }),
      ).toBe(service.address);
      await expect(
        callLocalService(
          { ...location, dataDirectory: path.join(root, 'other-private') },
          { action: 'status' },
          500,
        ),
      ).rejects.toMatchObject({ code: 'service-unavailable' });
      expect(await callLocalService(location, { action: 'stop' })).toEqual({ status: 'stopping' });
      expect(await service.closed).toEqual({ problem: null });
      service = await startLocalService(options);
      expect(await callLocalService(location, { action: 'registrations' })).toEqual([]);
    } finally {
      await service?.close();
      for (const value of values.values()) value.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  }, 60000);
});

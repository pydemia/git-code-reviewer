import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { windowsNative, windowsNativeExecutable } from './windows-native.js';

describe.skipIf(process.platform !== 'win32')('Windows storage session', () => {
  it('keeps framing and per-operation validation, rejects process execution, and closes at EOF', () => {
    const result = execFileSync(
      windowsNativeExecutable(),
      ['--storage-session', String(process.pid)],
      {
        input:
          [
            { operation: 'identity' },
            { operation: 'process' },
            { operation: 'read', path: '\\\\untrusted\\share\\data', maximum: 1 },
            { operation: 'identity' },
          ]
            .map((value) => JSON.stringify(value))
            .join('\n') + '\n',
        encoding: 'utf8',
        timeout: 5000,
        windowsHide: true,
        stdio: 'pipe',
      },
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(result).toHaveLength(4);
    expect(result[0].version).toBe('1.0.2');
    expect(result[1]).toEqual({ error: 'invalid-request' });
    expect(result[2]).toEqual({ error: 'insecure-storage' });
    expect(result[3]).toEqual(result[0]);
  });

  it('cancels an unsent request without interrupting adjacent storage requests', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'w02-session-'));
    try {
      const directory = path.join(root, 'private');
      const first = windowsNative({ operation: 'directory', path: directory });
      const controller = new AbortController();
      const cancelled = windowsNative(
        {
          operation: 'read',
          path: path.join(directory, 'missing'),
          maximum: 10,
        },
        { signal: controller.signal },
      );
      controller.abort();
      const last = windowsNative({ operation: 'validate-directory', path: directory });
      expect((await first).error).toBeUndefined();
      expect(await cancelled).toEqual({ error: 'cancelled' });
      expect((await last).error).toBeUndefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('exits when its owner dies even while the input pipe remains open elsewhere', async () => {
    const owner = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const helper = spawn(windowsNativeExecutable(), ['--storage-session', String(owner.pid)], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    try {
      const ready = once(helper.stdout, 'data');
      helper.stdin.write('{"operation":"identity"}\n');
      const [bytes] = await ready;
      expect(JSON.parse(String(bytes)).version).toBe('1.0.2');
      const exited = once(helper, 'exit');
      owner.kill();
      const [code] = await exited;
      expect(code).toBe(0);
    } finally {
      owner.kill();
      helper.kill();
      helper.stdin.destroy();
    }
  }, 10000);

  it('keeps an interrupted publication uncertain and reopens a fresh session', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'w02-publication-'));
    try {
      const directory = path.join(root, 'private');
      expect(
        (await windowsNative({ operation: 'directory', path: directory })).error,
      ).toBeUndefined();
      const target = path.join(directory, 'record');
      const bytes = Buffer.alloc(1024 * 1024, 7);
      const controller = new AbortController();
      const publishing = windowsNative(
        {
          operation: 'publish',
          path: target,
          bytes: bytes.toString('base64'),
        },
        { signal: controller.signal },
      );
      controller.abort();
      expect(await publishing).toEqual({ error: 'commit-unknown' });
      const restored = await windowsNative({
        operation: 'read',
        path: target,
        maximum: bytes.length,
      });
      expect(restored.error).toBeUndefined();
      if (!restored.missing) expect(Buffer.from(restored.bytes!, 'base64')).toEqual(bytes);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FilesystemArtifactStore } from './index.js';

const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true }))));

describe('FilesystemArtifactStore', () => {
  it('atomically reuses identical immutable content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gcr-artifacts-'));
    roots.push(root);
    const store = new FilesystemArtifactStore(root);
    const first = await store.commitText('snapshots/one/diff.json', '{"ok":true}');
    const second = await store.commitText('snapshots/one/diff.json', '{"ok":true}');
    expect(first.reused).toBe(false);
    expect(second.reused).toBe(true);
    expect(await readFile(path.join(root, first.locator), 'utf8')).toBe('{"ok":true}');
    expect(await store.inspect(first.locator)).toMatchObject({
      exists: true,
      checksum: first.checksum,
      byteSize: first.byteSize,
    });
    expect((await store.list()).map((artifact) => artifact.locator)).toEqual([
      'snapshots/one/diff.json',
    ]);
  });

  it('rejects path traversal and conflicting content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gcr-artifacts-'));
    roots.push(root);
    const store = new FilesystemArtifactStore(root);
    await expect(store.commitText('../secret', 'x')).rejects.toThrow('Invalid locator');
    await store.commitText('snapshots/one/diff.json', 'one');
    await expect(store.commitText('snapshots/one/diff.json', 'two')).rejects.toThrow(
      'integrity conflict',
    );
  });

  it('deletes artifacts idempotently and reports missing files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gcr-artifacts-'));
    roots.push(root);
    const store = new FilesystemArtifactStore(root);
    await store.commitText('analyses/one/report.json', '{}');
    await store.delete('analyses/one/report.json');
    await store.delete('analyses/one/report.json');
    expect(await store.inspect('analyses/one/report.json')).toEqual({
      exists: false,
      checksum: null,
      byteSize: null,
      modifiedAt: null,
    });
  });
});

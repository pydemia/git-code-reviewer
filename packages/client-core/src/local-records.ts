import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { localScope, type LocalScope } from '@gcr/client-contract';
import { canonicalJson, defaultLocalDataDirectory } from './local-identity.js';
import { LocalStoreError, errorCode } from './local-errors.js';
import { PlatformLocalKeyStore, type LocalKeyStore } from './local-credentials.js';
import {
  privateRoot,
  privateDirectory,
  publishImmutable,
  readPrivateFile,
  syncDirectory,
} from './private-files.js';

export type LocalRecordKind = 'knowledge' | 'reviews' | 'chats' | 'settings';
export type LocalRecord =
  { revision: number; deleted: false; value: unknown } | { revision: number; deleted: true };
export interface LocalRecordOptions {
  scope: LocalScope;
  dataDirectory?: string;
  keys?: LocalKeyStore;
}
interface Marker {
  formatVersion: 1;
  revision: number;
  blob: string;
  sha256: string;
}
const maximumRevision = 999_999_999_999;
const maximumPlaintext = 16 * 1024 * 1024;
const maximumEnvelope = 24 * 1024 * 1024;
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const corrupt = () =>
  new LocalStoreError(
    'corrupt-storage',
    'Local encrypted record is missing, malformed or fails authentication.',
  );
const conflict = () =>
  new LocalStoreError(
    'revision-conflict',
    'Local record changed. Reload it before applying this edit.',
  );
const validateId = (id: string) => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id)) throw corrupt();
};
function parse(bytes: Buffer | undefined): Record<string, unknown> {
  if (!bytes) throw corrupt();
  try {
    const value: unknown = JSON.parse(bytes.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw corrupt();
    return value as Record<string, unknown>;
  } catch {
    throw corrupt();
  }
}
function onlyFields(value: Record<string, unknown>, fields: string[]): void {
  if (
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    throw corrupt();
}
function binary(value: unknown, size?: number): Buffer {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw corrupt();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (size !== undefined && bytes.length !== size))
    throw corrupt();
  return bytes;
}

async function profileKey(
  directory: string,
  profileId: string,
  keys: LocalKeyStore,
): Promise<Buffer> {
  const referenceFile = path.join(directory, 'key-ref.json');
  const read = async (): Promise<Buffer | undefined> => {
    const bytes = await readPrivateFile(referenceFile, 1024);
    if (!bytes) return undefined;
    const reference = parse(bytes);
    onlyFields(reference, ['formatVersion', 'profileId', 'id']);
    if (
      reference.formatVersion !== 1 ||
      reference.profileId !== profileId ||
      typeof reference.id !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(reference.id)
    )
      throw corrupt();
    const key = await keys.read(`${profileId}.${reference.id}`);
    if (!key || key.length !== 32)
      throw new LocalStoreError(
        'credential-unavailable',
        'The OS key for existing local data is unavailable.',
      );
    return key;
  };
  const existing = await read();
  if (existing) return existing;
  if ((await readdir(directory)).some((name) => !name.startsWith('.pending-'))) {
    const raced = await read();
    if (raced) return raced;
    // A lost reference must not generate a new key over existing encrypted records.
    throw new LocalStoreError(
      'credential-unavailable',
      'Local data exists without its OS key reference.',
    );
  }
  const id = randomUUID();
  const reference = `${profileId}.${id}`;
  const candidate = randomBytes(32);
  let preserve = false;
  try {
    await keys.write(reference, candidate);
    preserve = await publishImmutable(
      referenceFile,
      Buffer.from(canonicalJson({ formatVersion: 1, profileId, id })),
    );
    if (preserve) return candidate;
    const winner = await read();
    if (!winner) throw corrupt();
    return winner;
  } catch (error) {
    if (error instanceof LocalStoreError && error.code === 'commit-unknown') preserve = true;
    throw error;
  } finally {
    if (!preserve) {
      candidate.fill(0);
      // A failed cleanup cannot remove the winning key or replace the original error.
      await keys.remove(reference).catch(() => undefined);
    }
  }
}

/** Encrypted immutable revisions. An exclusive marker is the compare-and-swap commit point. */
export class LocalRecordStore {
  private closed = false;
  #key: Buffer;
  private constructor(
    readonly scope: Readonly<LocalScope>,
    private readonly directory: string,
    key: Buffer,
  ) {
    this.#key = key;
  }
  static async open(options: LocalRecordOptions): Promise<LocalRecordStore> {
    const scope = Object.freeze(localScope(options.scope));
    const root = await privateRoot(options.dataDirectory ?? defaultLocalDataDirectory());
    const profiles = await privateDirectory(root, 'profiles');
    const profile = await privateDirectory(profiles, scope.profileId);
    const local = await privateDirectory(profile, 'local');
    const key = await profileKey(
      local,
      scope.profileId,
      options.keys ?? new PlatformLocalKeyStore(),
    );
    try {
      let directory = local;
      if (scope.kind === 'repository') {
        directory = await privateDirectory(directory, 'repositories');
        directory = await privateDirectory(directory, scope.repositoryKey);
        directory = await privateDirectory(directory, scope.worktreeKey);
      } else directory = await privateDirectory(directory, 'profile');
      return new LocalRecordStore(scope, directory, key);
    } catch (error) {
      key.fill(0);
      throw error;
    }
  }
  close(): void {
    this.closed = true;
    this.#key.fill(0);
  }
  private assertOpen(): void {
    if (this.closed) throw new LocalStoreError('store-closed', 'Local store is closed.');
  }
  private aad(kind: LocalRecordKind, id: string, revision: number): Buffer {
    this.assertOpen();
    return Buffer.from(
      canonicalJson({
        formatVersion: 1,
        purpose: 'local-record',
        scope: this.scope,
        kind,
        id,
        revision,
      }),
    );
  }
  private async recordDirectory(
    kind: LocalRecordKind,
    id: string,
    create = false,
  ): Promise<string | undefined> {
    this.assertOpen();
    validateId(id);
    if (!['knowledge', 'reviews', 'chats', 'settings'].includes(kind)) throw corrupt();
    const namespace = await privateDirectory(this.directory, kind);
    if (!create) {
      try {
        await lstat(path.join(namespace, id));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return undefined;
        throw error;
      }
    }
    return privateDirectory(namespace, id);
  }
  private async head(directory: string): Promise<Marker | undefined> {
    const entries = await readdir(directory);
    if (
      entries.some(
        (name) => name !== 'blobs' && !name.startsWith('.pending-') && !/^\d{12}\.json$/.test(name),
      )
    )
      throw corrupt();
    const names = entries.filter((name) => /^\d{12}\.json$/.test(name)).sort();
    const name = names.at(-1);
    if (!name) return undefined;
    const marker = parse(await readPrivateFile(path.join(directory, name), 1024));
    onlyFields(marker, ['formatVersion', 'revision', 'blob', 'sha256']);
    if (
      marker.formatVersion !== 1 ||
      marker.revision !== Number(name.slice(0, 12)) ||
      !Number.isSafeInteger(marker.revision) ||
      Number(marker.revision) < 1 ||
      typeof marker.blob !== 'string' ||
      !/^[a-f0-9-]{36}\.enc$/.test(marker.blob) ||
      typeof marker.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(marker.sha256)
    )
      throw corrupt();
    return marker as unknown as Marker;
  }
  async read(kind: LocalRecordKind, id: string): Promise<LocalRecord | undefined> {
    const directory = await this.recordDirectory(kind, id);
    if (!directory) return undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const marker = await this.head(directory);
      if (!marker) return undefined;
      try {
        return await this.readRevision(directory, kind, id, marker);
      } catch (error) {
        // A concurrent delete may reclaim the body selected by this reader. Move only to a
        // newer committed head; never fall back to an older report after corruption.
        if (
          !(error instanceof LocalStoreError) ||
          error.code !== 'corrupt-storage' ||
          (await this.head(directory))?.revision === marker.revision
        )
          throw error;
      }
    }
    throw conflict();
  }
  private async readRevision(
    directory: string,
    kind: LocalRecordKind,
    id: string,
    marker: Marker,
  ): Promise<LocalRecord> {
    const blobs = await privateDirectory(directory, 'blobs');
    const bytes = await readPrivateFile(path.join(blobs, marker.blob), maximumEnvelope);
    if (!bytes || digest(bytes) !== marker.sha256) throw corrupt();
    const envelope = parse(bytes);
    onlyFields(envelope, ['formatVersion', 'iv', 'tag', 'ciphertext']);
    if (envelope.formatVersion !== 1) throw corrupt();
    let plaintext: Buffer | undefined;
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.#key, binary(envelope.iv, 12));
      decipher.setAAD(this.aad(kind, id, marker.revision));
      decipher.setAuthTag(binary(envelope.tag, 16));
      plaintext = Buffer.concat([decipher.update(binary(envelope.ciphertext)), decipher.final()]);
      if (plaintext.length > maximumPlaintext) throw corrupt();
      const payload = parse(plaintext);
      if (payload.deleted === true) {
        onlyFields(payload, ['deleted']);
        return { revision: marker.revision, deleted: true };
      }
      onlyFields(payload, ['deleted', 'value']);
      if (payload.deleted !== false) throw corrupt();
      return { revision: marker.revision, deleted: false, value: payload.value };
    } catch (error) {
      if (error instanceof LocalStoreError) throw error;
      throw corrupt();
    } finally {
      plaintext?.fill(0);
    }
  }
  async listIds(kind: LocalRecordKind): Promise<string[]> {
    this.assertOpen();
    if (!['knowledge', 'reviews', 'chats', 'settings'].includes(kind)) throw corrupt();
    const namespace = await privateDirectory(this.directory, kind);
    const ids = (await readdir(namespace)).filter((name) => name !== '.DS_Store');
    for (const id of ids) validateId(id);
    return ids.sort();
  }
  private async commit(
    kind: LocalRecordKind,
    id: string,
    value: unknown,
    expectedRevision: number,
    deleted: boolean,
  ): Promise<LocalRecord> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= maximumRevision
    )
      throw conflict();
    // Capture caller-owned data before the first await, including the value returned on success.
    const snapshot = canonicalJson(
      deleted ? { deleted: true } : { deleted: false, value },
      maximumPlaintext,
    );
    const directory = (await this.recordDirectory(kind, id, true))!;
    const previous = await this.read(kind, id);
    if ((previous?.revision ?? 0) !== expectedRevision || previous?.deleted) throw conflict();
    const revision = expectedRevision + 1;
    const plaintext = Buffer.from(snapshot);
    let bytes: Buffer;
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
      cipher.setAAD(this.aad(kind, id, revision));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      bytes = Buffer.from(
        canonicalJson(
          {
            formatVersion: 1,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
          },
          maximumEnvelope,
        ),
      );
    } finally {
      plaintext.fill(0);
    }
    const blobs = await privateDirectory(directory, 'blobs');
    const blob = `${randomUUID()}.enc`;
    const blobPath = path.join(blobs, blob);
    if (!(await publishImmutable(blobPath, bytes))) throw conflict();
    let preserve = false;
    try {
      const marker = { formatVersion: 1, revision, blob, sha256: digest(bytes) };
      preserve = await publishImmutable(
        path.join(directory, `${String(revision).padStart(12, '0')}.json`),
        Buffer.from(canonicalJson(marker)),
      );
      if (!preserve) throw conflict();
      return deleted
        ? { revision, deleted: true }
        : { revision, deleted: false, value: JSON.parse(snapshot).value };
    } catch (error) {
      if (error instanceof LocalStoreError && error.code === 'commit-unknown') preserve = true;
      throw error;
    } finally {
      if (!preserve) await unlink(blobPath).catch(() => undefined);
    }
  }
  write(
    kind: LocalRecordKind,
    id: string,
    value: unknown,
    expectedRevision: number,
  ): Promise<LocalRecord> {
    return this.commit(kind, id, value, expectedRevision, false);
  }
  async remove(
    kind: LocalRecordKind,
    id: string,
    expectedRevision: number,
  ): Promise<{ revision: number; cleanupPending: boolean }> {
    const result = await this.commit(kind, id, null, expectedRevision, true);
    let cleanupPending = true;
    try {
      cleanupPending = !(await this.purgeDeleted(kind, id));
    } catch {
      /* Tombstone is committed; cleanup is retriable. */
    }
    return { revision: result.revision, cleanupPending };
  }
  /** Reclaim encrypted old bodies while retaining revision markers to fence stale writers. */
  async purgeDeleted(kind: LocalRecordKind, id: string): Promise<boolean> {
    const current = await this.read(kind, id);
    if (!current?.deleted) throw conflict();
    const directory = (await this.recordDirectory(kind, id))!;
    const marker = (await this.head(directory))!;
    const blobs = await privateDirectory(directory, 'blobs');
    let complete = true;
    for (const name of await readdir(blobs)) {
      if (name === marker.blob || !/^[a-f0-9-]{36}\.enc$/.test(name)) continue;
      try {
        await unlink(path.join(blobs, name));
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') complete = false;
      }
    }
    try {
      await syncDirectory(blobs);
    } catch {
      complete = false;
    }
    return complete;
  }
}

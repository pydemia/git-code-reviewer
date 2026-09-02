import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ArtifactCommit = {
  locator: string;
  checksum: string;
  byteSize: number;
  reused: boolean;
};

export class FilesystemArtifactStore {
  constructor(private readonly root: string) {}

  async commitText(locator: string, content: string | Uint8Array): Promise<ArtifactCommit> {
    const safeLocator = validateLocator(locator);
    const data = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
    const checksum = createHash('sha256').update(data).digest('hex');
    const destination = path.join(this.root, safeLocator);
    const staging = path.join(this.root, '.staging', `${randomUUID()}.tmp`);
    await mkdir(path.dirname(staging), { recursive: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(staging, data, { flag: 'wx', mode: 0o600 });

    try {
      await link(staging, destination);
      return { locator: safeLocator, checksum, byteSize: data.byteLength, reused: false };
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
      const existing = await readFile(destination);
      const existingChecksum = createHash('sha256').update(existing).digest('hex');
      if (existingChecksum !== checksum) {
        throw new Error(`Artifact integrity conflict for ${safeLocator}`);
      }
      return { locator: safeLocator, checksum, byteSize: data.byteLength, reused: true };
    } finally {
      await rm(staging, { force: true });
    }
  }

  async readText(locator: string): Promise<string> {
    return readFile(path.join(this.root, validateLocator(locator)), 'utf8');
  }

  async readJson<T>(locator: string): Promise<T> {
    return JSON.parse(await this.readText(locator)) as T;
  }
}

function validateLocator(locator: string): string {
  if (!locator || path.isAbsolute(locator) || locator.includes('\\'))
    throw new Error('Invalid locator');
  const segments = locator.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('Invalid locator');
  }
  return segments.join('/');
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

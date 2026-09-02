import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ArtifactCommit = {
  locator: string;
  checksum: string;
  byteSize: number;
  reused: boolean;
};

export type ArtifactInspection = {
  exists: boolean;
  checksum: string | null;
  byteSize: number | null;
  modifiedAt: Date | null;
};

export type ArtifactFile = {
  locator: string;
  byteSize: number;
  modifiedAt: Date;
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

  async inspect(locator: string): Promise<ArtifactInspection> {
    const artifactPath = path.join(this.root, validateLocator(locator));
    try {
      const [data, metadata] = await Promise.all([readFile(artifactPath), stat(artifactPath)]);
      return {
        exists: true,
        checksum: createHash('sha256').update(data).digest('hex'),
        byteSize: metadata.size,
        modifiedAt: metadata.mtime,
      };
    } catch (error) {
      if (isMissing(error)) {
        return { exists: false, checksum: null, byteSize: null, modifiedAt: null };
      }
      throw error;
    }
  }

  async delete(locator: string): Promise<void> {
    await rm(path.join(this.root, validateLocator(locator)), { force: true });
  }

  async list(): Promise<ArtifactFile[]> {
    await mkdir(this.root, { recursive: true });
    return walkFiles(this.root);
  }
}

async function walkFiles(root: string, relativeDirectory = ''): Promise<ArtifactFile[]> {
  const directory = path.join(root, relativeDirectory);
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry): Promise<ArtifactFile[]> => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return walkFiles(root, relativePath);
      if (!entry.isFile()) return [];
      const metadata = await stat(path.join(root, relativePath));
      return [
        {
          locator: relativePath.split(path.sep).join('/'),
          byteSize: metadata.size,
          modifiedAt: metadata.mtime,
        },
      ];
    }),
  );
  return nested.flat().sort((left, right) => left.locator.localeCompare(right.locator));
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

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}

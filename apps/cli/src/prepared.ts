import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  LocalRecordStore,
  restoreLocalSource,
  type FrozenLocalSource,
  type LocalRecordOptions,
} from '@gcr/client-core';
import { CliError } from './arguments.js';
export type PreparedReview = {
  version: 1;
  id: string;
  expiresAt: string;
  source: FrozenLocalSource;
  contextHash: string;
  clientHash: string;
  mode: 'standalone' | 'centralized';
  connectionId: string | null;
  requiredKnowledge: string[];
  requiredSource: string[];
};
export class PreparedReviews {
  private constructor(private readonly records: LocalRecordStore) {}
  static async open(options: LocalRecordOptions & { dataDirectory: string }) {
    return new PreparedReviews(
      await LocalRecordStore.open({
        ...options,
        dataDirectory: path.join(options.dataDirectory, 'prepared-reviews'),
      }),
    );
  }
  close() {
    this.records.close();
  }
  async get(id: string): Promise<PreparedReview> {
    const row = await this.records.read('settings', id);
    if (!row || row.deleted)
      throw new CliError('prepared-missing', 'Prepared review was not found.');
    const value = row.value as PreparedReview;
    if (
      value?.version !== 1 ||
      value.id !== id ||
      !Number.isFinite(Date.parse(value.expiresAt)) ||
      !/^[a-f0-9]{64}$/.test(value.contextHash) ||
      !/^[a-f0-9]{64}$/.test(value.clientHash) ||
      !['standalone', 'centralized'].includes(value.mode) ||
      !Array.isArray(value.requiredKnowledge) ||
      !value.requiredKnowledge.every((x) => typeof x === 'string') ||
      !Array.isArray(value.requiredSource) ||
      !value.requiredSource.every((x) => typeof x === 'string')
    )
      throw new CliError('prepared-invalid', 'Prepared review is invalid.');
    if (Date.parse(value.expiresAt) <= Date.now()) {
      await this.records.remove('settings', id, row.revision);
      throw new CliError('prepared-expired', 'Prepare a new review; this snapshot has expired.');
    }
    const snapshot = restoreLocalSource(value.source);
    snapshot.close();
    return value;
  }
  async save(input: Omit<PreparedReview, 'version' | 'id' | 'expiresAt'>) {
    let count = 0;
    for (const id of await this.records.listIds('settings')) {
      const row = await this.records.read('settings', id);
      if (!row || row.deleted) continue;
      const expires = Date.parse((row.value as PreparedReview)?.expiresAt);
      if (!Number.isFinite(expires))
        throw new CliError('prepared-invalid', 'Prepared review is invalid.');
      if (expires <= Date.now()) await this.records.remove('settings', id, row.revision);
      else count++;
    }
    if (count >= 50)
      throw new CliError(
        'prepared-limit',
        'At most 50 unexpired preparations may be stored per worktree.',
      );
    const value: PreparedReview = {
      ...input,
      version: 1,
      id: randomUUID(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
    };
    await this.records.write('settings', value.id, value, 0);
    return value;
  }
}

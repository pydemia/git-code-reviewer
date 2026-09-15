import {
  approvedCheckRunner,
  checkRunnerProfile,
  checkRunnerObservation,
  type CheckRunnerObservation,
} from '@gcr/client-contract';
import { contentHash } from './local-identity.js';
import { LocalRecordStore } from './local-records.js';

export class CheckRunnerError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CheckRunnerError';
  }
}
/** This store must be opened in the current local repository/worktree scope. */
export class CheckRunnerStore {
  constructor(private readonly records: LocalRecordStore) {
    if (records.scope.kind !== 'repository')
      throw new CheckRunnerError(
        'runner-scope',
        'Runner approvals require repository and worktree scope.',
      );
  }
  async approve(input: unknown) {
    const profile = checkRunnerProfile(input),
      key = `runner-profile-${profile.id}`;
    const old = await this.records.read('settings', key);
    if (this.records.scope.kind !== 'repository')
      throw new CheckRunnerError('runner-scope', 'Repository scope required.');
    const value = approvedCheckRunner({
      repositoryKey: this.records.scope.repositoryKey,
      worktreeKey: this.records.scope.worktreeKey,
      clientProfileId: this.records.scope.profileId,
      version: 1,
      profile,
      profileHash: contentHash(profile),
      approvedAt: new Date().toISOString(),
      authority: 'local-user',
      enabled: true,
    });
    await this.records.write('settings', key, value, old?.revision ?? 0);
    return value;
  }
  async get(profileId: string) {
    const value = await this.records.read('settings', `runner-profile-${profileId}`);
    if (!value || value.deleted || (value.value as { enabled?: boolean }).enabled === false)
      throw new CheckRunnerError(
        'runner-not-approved',
        'Approve this exact runner profile locally before executing checks.',
      );
    const approval = approvedCheckRunner(value.value);
    if (
      this.records.scope.kind !== 'repository' ||
      approval.repositoryKey !== this.records.scope.repositoryKey ||
      approval.worktreeKey !== this.records.scope.worktreeKey ||
      approval.clientProfileId !== this.records.scope.profileId ||
      approval.profile.id !== profileId ||
      contentHash(approval.profile) !== approval.profileHash
    )
      throw new CheckRunnerError(
        'runner-profile-corrupt',
        'The approved runner profile does not match its recorded hash.',
      );
    return approval;
  }
  async list() {
    const profiles = [];
    for (const id of await this.records.listIds('settings')) {
      if (!id.startsWith('runner-profile-')) continue;
      const row = await this.records.read('settings', id);
      if (!row || row.deleted || (row.value as { enabled?: boolean }).enabled === false) continue;
      profiles.push(await this.get(id.slice('runner-profile-'.length)));
    }
    return profiles;
  }
  async revoke(profileId: string) {
    const key = `runner-profile-${profileId}`,
      row = await this.records.read('settings', key);
    if (!row || row.deleted) return;
    await this.records.write('settings', key, { version: 1, enabled: false }, row.revision);
  }
  async save(input: CheckRunnerObservation) {
    const value = checkRunnerObservation(input);
    await this.records.write('settings', `runner-result-${value.id}`, value, 0);
    return value;
  }
  async result(id: string) {
    const row = await this.records.read('settings', `runner-result-${id}`);
    return row && !row.deleted ? checkRunnerObservation(row.value) : null;
  }
}

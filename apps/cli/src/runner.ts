import path from 'node:path';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import {
  CheckRunnerStore,
  LocalRecordStore,
  contentHash,
  defaultLocalDataDirectory,
  discoverLocalIdentity,
  runApprovedCheck,
} from '@gcr/client-core';
import type { CliDependencies, CliResult } from './cli.js';
import { CliError, type argumentsFor } from './arguments.js';
import { PreparedReviews } from './prepared.js';

export async function executeRunnerCommand(
  args: ReturnType<typeof argumentsFor>,
  dependencies: CliDependencies,
): Promise<CliResult> {
  const { values, positionals } = args;
  const option = (name: string, fallback?: string) => {
    const v = values[name];
    if (v === undefined) return fallback;
    if (typeof v !== 'string' || !v) throw new CliError('usage', 'Expected one nonempty option.');
    return v;
  };
  const action = positionals[0],
    id = positionals[1];
  if (
    !action ||
    !['profiles', 'approve', 'revoke', 'run', 'result'].includes(action) ||
    positionals.length > (['revoke', 'run', 'result'].includes(action) ? 2 : 1)
  )
    throw new CliError('usage', 'Use runner profiles|approve|revoke|run|result.');
  if (['revoke', 'run', 'result'].includes(action) && !id)
    throw new CliError('usage', 'Runner command requires an ID.');
  if (option('connection') || option('mode', 'standalone') !== 'standalone')
    throw new CliError(
      'usage',
      'Runner execution is local. Omit central connection options; prepared central context may still be used.',
    );
  for (const [flag, owner] of [
    ['input', 'approve'],
    ['prepared', 'run'],
    ['side', 'run'],
  ]) {
    if (values[flag!] !== undefined && action !== owner)
      throw new CliError('usage', `--${flag} is only valid for runner ${owner}.`);
  }
  const cwd = path.resolve(option('cwd', dependencies.cwd ?? process.cwd())!),
    profileId = option('profile', 'default')!;
  const dataDirectory = path.resolve(option('data-dir', defaultLocalDataDirectory())!);
  const client = discoverLocalIdentity(cwd, profileId);
  const scope = {
    kind: 'repository' as const,
    profileId,
    repositoryKey: client.repositoryKey,
    worktreeKey: client.worktreeKey,
  };
  const records = await LocalRecordStore.open({
    scope,
    dataDirectory,
    ...(dependencies.keys ? { keys: dependencies.keys } : {}),
  });
  const store = new CheckRunnerStore(records);
  let prepared: PreparedReviews | undefined;
  try {
    if (action === 'profiles') return { value: await store.list(), exitCode: 0 };
    if (action === 'approve') {
      const file = option('input');
      if (!file) throw new CliError('usage', 'runner approve requires --input <profile.json>.');
      const handle = await open(
        path.resolve(cwd, file),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > 300000)
          throw new CliError(
            'invalid-input',
            'Runner profile must be a JSON file of at most 300 KB.',
          );
        bytes = Buffer.alloc(300001);
        const read = await handle.read(bytes, 0, bytes.length, 0);
        bytes = bytes.subarray(0, read.bytesRead);
        if (bytes.length > 300000)
          throw new CliError('invalid-input', 'Runner profile exceeds its size limit.');
      } finally {
        await handle.close();
      }
      return {
        value: await store.approve(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
        ),
        exitCode: 0,
      };
    }
    if (action === 'revoke') {
      await store.revoke(id!);
      return { value: { id, enabled: false }, exitCode: 0 };
    }
    if (action === 'result') {
      const value = await store.result(id!);
      if (!value)
        throw new CliError(
          'runner-result-missing',
          'Runner observation was not found in this worktree.',
        );
      return {
        value,
        exitCode:
          value.cleanup === 'pending' || value.status !== 'completed'
            ? 2
            : value.exitCode === 0
              ? 0
              : 1,
      };
    }
    const preparedId = option('prepared');
    if (!preparedId)
      throw new CliError('usage', 'runner run requires --prepared from gcr prepare.');
    const side = option('side', 'source');
    if (!['base', 'source', 'both'].includes(side!))
      throw new CliError('usage', 'Use --side base, source or both.');
    const approval = await store.get(id!);
    prepared = await PreparedReviews.open({
      scope,
      dataDirectory,
      ...(dependencies.keys ? { keys: dependencies.keys } : {}),
    });
    const fixed = await prepared.get(preparedId);
    if (
      fixed.source.repository.repositoryKey !== client.repositoryKey ||
      fixed.source.repository.worktreeKey !== client.worktreeKey
    )
      throw new CliError(
        'source-scope-mismatch',
        'Prepared source belongs to a different repository/worktree.',
      );
    const observations = [];
    for (const selected of side === 'both'
      ? (['base', 'source'] as const)
      : [side as 'base' | 'source']) {
      const observation = await runApprovedCheck({
        approval,
        source: fixed.source,
        contextHash: fixed.contextHash,
        side: selected,
        ...(dependencies.signal ? { signal: dependencies.signal } : {}),
        ...(dependencies.checkRunnerCommand ? { command: dependencies.checkRunnerCommand } : {}),
        revalidateApproval: async () => {
          const current = await store.get(id!);
          if (contentHash(current) !== contentHash(approval))
            throw new CliError(
              'runner-approval-changed',
              'The runner approval changed before execution.',
            );
          await prepared!.get(preparedId);
        },
      });
      await store.save(observation);
      observations.push(observation);
      if (observation.status !== 'completed' || observation.cleanup === 'pending') break;
    }
    return {
      value: { preparedId, assessment: 'execution-observation', observations },
      exitCode: observations.some((o) => o.status !== 'completed' || o.cleanup === 'pending')
        ? 2
        : observations.some((o) => o.exitCode !== 0)
          ? 1
          : 0,
    };
  } finally {
    prepared?.close();
    records.close();
  }
}

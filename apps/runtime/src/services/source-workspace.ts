import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { request } from 'node:http';
import { readFile, realpath, readdir, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareSourceWorkspace, workspaceSize, type SourceToolInput } from '@gcr/git-engine';
import type { Database } from '@gcr/db';
import type { AppConfig } from '../config.js';
import { registeredGitHubReader } from './account-registry.js';
import { createGitHubReader, getRepository } from './repositories.js';
let preparationQueue = Promise.resolve();
async function serializedPreparation<Result>(operation: () => Promise<Result>): Promise<Result> {
  const previous = preparationQueue;
  let release = () => {};
  preparationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

export async function acquireSourceWorkspace(
  database: Database,
  config: AppConfig,
  snapshotId: string,
  ownerId: string,
) {
  const result = await database.query<{
    base_sha: string;
    head_sha: string;
    merge_base_sha: string;
    repository_id: string;
    number: number;
  }>(
    `select sr.base_sha,sr.head_sha,s.merge_base_sha,pr.repository_id,pr.number from snapshots s join snapshot_requests sr on sr.id=s.request_id join pull_requests pr on pr.id=sr.pull_request_id where s.id=$1 and s.resolution='exact'`,
    [snapshotId],
  );
  const snapshot = result.rows[0];
  if (!snapshot) throw Error('source_snapshot_unavailable');
  const repository = await getRepository(database, snapshot.repository_id);
  if (!repository) throw Error('source_repository_unavailable');
  const credentialVersion = repository.credentialId
    ? (
        await database.query<{ credential_version: number }>(
          'select credential_version from github_credentials where id=$1 and enabled',
          [repository.credentialId],
        )
      ).rows[0]?.credential_version
    : 0;
  if (credentialVersion === undefined) throw Error('source_credential_unavailable');
  const workspaceId = createHash('sha256')
    .update(
      JSON.stringify([
        ownerId,
        repository.id,
        repository.webBaseUrl,
        repository.owner,
        repository.name,
        snapshot.base_sha,
        snapshot.head_sha,
        snapshot.merge_base_sha,
        repository.credentialId ?? 'deployment',
        credentialVersion,
      ]),
    )
    .digest('hex');
  const workspace = path.resolve(config.WORKSPACE_ROOT, workspaceId);
  const reader = repository.credentialId
    ? await registeredGitHubReader(
        database,
        config.CREDENTIAL_ENCRYPTION_KEY,
        repository.credentialId,
      )
    : await createGitHubReader(config);
  if (!reader?.getGitCredential) throw Error('source_credential_unavailable');
  const getGitCredential = reader.getGitCredential.bind(reader);
  return prepareLeasedWorkspace(database, config, workspaceId, async () => {
    await prepareSourceWorkspace({
      workspace,
      webBaseUrl: repository.webBaseUrl,
      owner: repository.owner,
      repository: repository.name,
      pullNumber: snapshot.number,
      baseSha: snapshot.base_sha,
      headSha: snapshot.head_sha,
      mergeBaseSha: snapshot.merge_base_sha,
      credential: await getGitCredential(repository),
      maxBytes: config.GIT_WORKSPACE_MAX_BYTES,
    });
  });
}

export async function prepareLeasedWorkspace(
  database: Database,
  config: AppConfig,
  workspaceId: string,
  prepare: () => Promise<void>,
) {
  if (!/^[a-f0-9]{64}$/.test(workspaceId)) throw Error('invalid_workspace_id');
  const workspace = path.resolve(config.WORKSPACE_ROOT, workspaceId);
  const nodeId = `${process.env.HOSTNAME ?? 'local'}:${path.resolve(config.WORKSPACE_ROOT)}`;
  const leaseId = randomUUID();
  let reused = false;
  await serializedPreparation(async () => {
    const client = await database.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [`workspace:${nodeId}`]);
      await client.query('delete from source_workspace_leases where expires_at<clock_timestamp()');
      const leases = await client.query<{ workspace_id: string }>(
        'select distinct workspace_id from source_workspace_leases where node_id=$1 and expires_at>clock_timestamp()',
        [nodeId],
      );
      const active = new Set(leases.rows.map((lease) => lease.workspace_id));
      let bytes = 0;
      for (const entry of await readdir(config.WORKSPACE_ROOT, { withFileTypes: true }).catch(
        () => [],
      )) {
        if (!entry.isDirectory() || !/^[a-f0-9]{64}$/.test(entry.name)) continue;
        const location = path.join(config.WORKSPACE_ROOT, entry.name);
        const metadata = await stat(location);
        if (
          Date.now() - metadata.mtimeMs > 1800000 &&
          location !== workspace &&
          !active.has(entry.name)
        )
          await rm(location, { recursive: true, force: true });
        else bytes += await workspaceSize(location, config.GIT_WORKSPACE_MAX_BYTES);
      }
      const cached = await readFile(path.join(workspace, 'manifest.json'))
        .then(() => true)
        .catch(() => false);
      reused = cached;
      if (!cached && bytes + config.GIT_WORKSPACE_MAX_BYTES > config.GIT_WORKSPACE_MAX_BYTES * 3)
        throw Error('workspace_capacity_limit');
      await prepare();
      await utimes(workspace, new Date(), new Date());
      await client.query(
        "insert into source_workspace_leases(node_id,workspace_id,lease_id,expires_at) values($1,$2,$3,clock_timestamp()+interval '90 seconds')",
        [nodeId, workspaceId, leaseId],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  });
  let released = false;
  let lost = false;
  const renew = async () => {
    if (released || lost) throw Error('workspace_lease_lost');
    const updated = await database.query(
      "update source_workspace_leases set expires_at=clock_timestamp()+interval '90 seconds' where lease_id=$1 and expires_at>clock_timestamp() returning lease_id",
      [leaseId],
    );
    if (!updated.rowCount) {
      lost = true;
      throw Error('workspace_lease_lost');
    }
  };
  const timer = setInterval(() => {
    void renew().catch(() => {
      lost = true;
    });
  }, 20000);
  timer.unref();
  return {
    workspaceId,
    workspace,
    reused,
    renew,
    release: async () => {
      released = true;
      clearInterval(timer);
      await database.query('delete from source_workspace_leases where lease_id=$1', [leaseId]);
    },
  };
}

export async function executeSourceTool(
  config: AppConfig,
  workspace: { workspaceId: string; workspace: string; renew?: () => Promise<void> },
  tool: SourceToolInput,
  signal?: AbortSignal,
): Promise<unknown> {
  await workspace.renew?.();
  await utimes(workspace.workspace, new Date(), new Date());
  if (config.GIT_SANDBOX_SOCKET) {
    return new Promise((resolve, reject) => {
      const outgoing = request(
        {
          socketPath: config.GIT_SANDBOX_SOCKET,
          path: '/',
          method: 'POST',
          signal,
          timeout: 120000,
          headers: { 'content-type': 'application/json' },
        },
        (response) => {
          let body = '';
          response.on('data', (chunk) => {
            body += String(chunk);
            if (body.length > 131072) outgoing.destroy(Error('tool_output_limit'));
          });
          response.on('end', () => {
            try {
              if (response.statusCode !== 200) throw Error('sandbox_tool_unavailable');
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      outgoing.on('timeout', () => outgoing.destroy(Error('tool_timeout')));
      outgoing.on('error', reject);
      outgoing.end(JSON.stringify({ workspaceId: workspace.workspaceId, tool }));
    });
  }
  if (process.platform !== 'darwin' || config.NODE_ENV === 'production')
    throw Error('sandbox_unavailable');
  const modulePath = fileURLToPath(
    new URL('../../../../packages/git-engine/dist/local-tools.js', import.meta.url),
  );
  await readFile(modulePath);
  const root = await realpath(workspace.workspace);
  const binary = await realpath(process.execPath);
  const parserRoot = path.dirname(
    path.dirname(
      await realpath(
        fileURLToPath(
          new URL(
            '../../../../packages/git-engine/node_modules/typescript/lib/typescript.js',
            import.meta.url,
          ),
        ),
      ),
    ),
  );
  const quote = (value: string) => JSON.stringify(value);
  const profile = `(version 1)(deny default)(allow process-fork)(allow process-exec)(allow sysctl-read)(allow mach-lookup)(allow file-read-metadata)(allow file-write-data (literal "/dev/null"))(allow file-read* (literal "/") (subpath "/usr") (subpath "/System") (subpath "/Library/Apple") (subpath "/Library/Developer") (subpath "/private/var/db/dyld") (subpath "/opt/homebrew") (literal "/dev/null") (literal "/dev/urandom") (subpath ${quote(root)}) (subpath ${quote(parserRoot)}) (subpath ${quote(path.dirname(modulePath))}))`;
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-p', profile, binary, modulePath, root], {
      signal,
      cwd: root,
      env: { PATH: process.env.PATH, HOME: root },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.stdout.on('data', (chunk) => {
      output += String(chunk);
      if (output.length > 131072) child.kill('SIGKILL');
    });
    child.stderr.resume();
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timeout);
      try {
        if (code !== 0) throw Error('sandbox_tool_failed');
        resolve(JSON.parse(output));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(JSON.stringify(tool));
  });
}

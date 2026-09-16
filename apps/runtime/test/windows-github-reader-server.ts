/** W02 live GitHub PR -> production GCR reader, Windows-native API. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { GitHubAccessTokenClient } from '@gcr/github';
import { PlatformCentralCredentialStore } from '@gcr/client-core';
import { canonicalKnowledgeJson } from '@gcr/client-contract';
import { windowsPrivateTemporary } from '../../../packages/client-core/src/windows-native.js';
import { loadConfig } from '../src/config.js';
import { registerAuthentication } from '../src/auth/index.js';
import { registerClientCredentialRoutes } from '../src/auth/client-routes.js';
import { ClientCredentialError } from '../src/auth/client-credentials.js';
import { AuthorizationService } from '../src/services/authorization.js';
import { ensureFixtureRepository } from '../src/services/repositories.js';
import { executeHistoryCollectionJob } from '../src/services/review-history-collection.js';
import { claimJob } from '../src/jobs/worker.js';
import {
  KnowledgeSigner,
  bindKnowledgeSigner,
  ensureKnowledgeScopes,
} from '../src/services/knowledge-manifest.js';
import { publishNextKnowledge } from '../src/services/knowledge-publication.js';
import { registerReviewHistoryRoutes } from '../src/routes/review-history.js';
import { registerKnowledgeRoutes } from '../src/routes/review-knowledge.js';
import { registerMutationOriginGuard } from '../src/auth/mutation-origin.js';

assert.equal(process.platform, 'win32');
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const evidenceDirectory = path.join(repositoryRoot, 'tmp/w02-live');
const evidenceFile = path.join(evidenceDirectory, 'server-proof.json');
const connectionFile = path.join(evidenceDirectory, 'connection.json');
const root = windowsPrivateTemporary('w02-github-');
const unique = 'w02-github-' + randomUUID();
const image = 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const password = randomBytes(32).toString('base64url');
const credentialReference = unique + '.reader';
const credentials = new PlatformCentralCredentialStore();
const requests: Array<{
  at: string;
  method: string;
  route: string;
  queryKeys: string[];
  bodyBytes: number;
}> = [];
const githubRequests: Array<{ method: string; path: string; queryKeys: string[] }> = [];
type SourceEvidence = {
  id: string;
  githubId: number;
  kind: string;
  contentHash: string;
  observationHash: string | null;
  url: string;
  inReplyToGithubId: number | null;
  bodyExact: boolean;
};
const proof: Record<string, unknown> & {
  collections: Array<{ id: string; state: string; parity: SourceEvidence[] }>;
} = {
  status: 'starting',
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  realGitHubOriginals: true,
  reconstructedHistory: false,
  realGcrAuthentication: true,
  realGcrCollection: true,
  realGcrReader: true,
  databaseRuntime: 'Docker Linux PostgreSQL; GCR API and CD run on Windows',
  pullUrl: 'https://github.com/pydemia/commit-defender/pull/3',
  modelCalls: 0,
  requests,
  githubRequests,
  collections: [],
};
let volume = false,
  container = false,
  db: Database | undefined;
let app: FastifyInstance | undefined,
  credentialStored = false;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const save = async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(evidenceFile, JSON.stringify(proof, null, 2) + '\n');
};
proof.sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  windowsHide: true,
}).trim();
proof.harnessSha256 = digest(await readFile(import.meta.filename, 'utf8'));
const docker = (args: string[], input?: string) =>
  new Promise<string>((resolve, reject) => {
    const child = spawn('docker', args, {
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '',
      size = 0;
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.on('data', (bytes) => {
      size += bytes.length;
      if (size > 1048576) child.kill();
      else output += bytes.toString();
    });
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(Error('Owned Docker operation failed'));
      else resolve(output.trim());
    });
    child.stdin.end(input);
  });

try {
  assert(!process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith('npipe:////./pipe/'));
  const endpoint = JSON.parse(
    await docker(['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}']),
  );
  assert(String(endpoint).startsWith('npipe:////./pipe/'), 'Local Docker Desktop pipe required');
  proof.dockerEndpoint = endpoint;
  await docker(['volume', 'create', '--label', `gcr.w02=${unique}`, unique]);
  volume = true;
  // initdb reads the password only from stdin and stores its SCRAM hash.
  await docker(
    [
      'run',
      '--rm',
      '-i',
      '--pull=never',
      '--name',
      unique + '-init',
      '--user',
      'postgres',
      '-v',
      `${unique}:/var/lib/postgresql/data`,
      '--entrypoint',
      'initdb',
      image,
      '-D',
      '/var/lib/postgresql/data',
      '--username=w02',
      '--auth=scram-sha-256',
      '--pwfile=/dev/stdin',
    ],
    password + '\n',
  );
  // The Windows client reaches the container through Docker's bridge address.
  // Only this disposable database/role is admitted, always with SCRAM auth.
  await docker(
    [
      'run',
      '--rm',
      '-i',
      '--pull=never',
      '--user',
      'postgres',
      '-v',
      `${unique}:/var/lib/postgresql/data`,
      '--entrypoint',
      'tee',
      image,
      '/var/lib/postgresql/data/pg_hba.conf',
    ],
    'local all all scram-sha-256\nhost postgres w02 0.0.0.0/0 scram-sha-256\n',
  );
  await docker([
    'run',
    '-d',
    '--pull=never',
    '--name',
    unique,
    '--label',
    `gcr.w02=${unique}`,
    '--user',
    'postgres',
    '--memory',
    '1g',
    '-v',
    `${unique}:/var/lib/postgresql/data`,
    '-p',
    '127.0.0.1::5432',
    '--entrypoint',
    'postgres',
    image,
    '-D',
    '/var/lib/postgresql/data',
    '-c',
    'listen_addresses=*',
  ]);
  container = true;
  const port = Number((await docker(['port', unique, '5432/tcp'])).split(':').at(-1)!);
  let ready = false;
  for (let i = 0; i < 20; i++) {
    try {
      await docker(['exec', unique, 'pg_isready', '-U', 'w02', '-d', 'postgres']);
      ready = true;
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  assert(ready);
  const databaseUrl = `postgresql://w02:${password}@127.0.0.1:${port}/postgres`;
  db = createDatabase(databaseUrl);
  proof.phase = 'migrations';
  await runMigrations(db, path.join(repositoryRoot, 'packages/db/migrations'));
  const tlsOutput = execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=W02 Local Reader',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      '-',
      '-out',
      '-',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15000,
    },
  );
  const tlsKey = tlsOutput.match(
    /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/,
  )![0];
  const ca = tlsOutput.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/)![0];
  const repo = (await ensureFixtureRepository(db))!;
  await db.query(
    `update github_instances set api_base_url='https://api.github.com/',web_base_url='https://github.com/',name='W02 GitHub' where id=(select instance_id from repositories where id=$1)`,
    [repo],
  );
  await db.query(
    `update repositories set github_id='1206672409',owner='pydemia',name='commit-defender',installation_id='w02-local',polling_enabled=false where id=$1`,
    [repo],
  );
  const tenant = (await db.query('select tenant_id from repositories where id=$1', [repo])).rows[0]
    .tenant_id;
  const gitCredential = execFileSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'ignore'],
    timeout: 15000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' },
  });
  const token = gitCredential
    .split(/\r?\n/)
    .find((line) => line.startsWith('password='))
    ?.slice(9);
  assert(token, 'Existing GitHub credential unavailable');
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    assert.equal(url.origin, 'https://api.github.com');
    assert(
      url.pathname.startsWith('/repos/pydemia/commit-defender/') || url.pathname === '/graphql',
    );
    if (method !== 'GET') {
      assert.equal(url.pathname, '/graphql');
      assert.equal(method, 'POST');
      const query = JSON.parse(String(init?.body)).query;
      assert(typeof query === 'string' && !/\bmutation\b/.test(query));
    }
    githubRequests.push({ method, path: url.pathname, queryKeys: [...url.searchParams.keys()] });
    return fetch(input, { ...init, signal: AbortSignal.timeout(20000), redirect: 'error' });
  };
  const github = new GitHubAccessTokenClient(token, observedFetch);
  const target = {
    owner: 'pydemia',
    name: 'commit-defender',
    installationId: 'w02-local',
    apiBaseUrl: 'https://api.github.com/',
  };
  const metadata = await observedFetch(
    new URL('https://api.github.com/repos/pydemia/commit-defender/pulls/3'),
    {
      headers: { authorization: 'Bearer ' + token, accept: 'application/vnd.github+json' },
    },
  );
  assert.equal(metadata.status, 200);
  const pull = await metadata.json();
  assert.equal(pull.head.sha, '2aca9bbc54e811f0d7d8d0c966148d85fff1636a');
  assert.equal(pull.draft, true);
  await db.query(
    `insert into pull_requests(repository_id,github_id,number,title,state,draft,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at)
    values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      repo,
      pull.id,
      pull.number,
      pull.title,
      pull.state,
      pull.draft,
      pull.user.login,
      pull.html_url,
      pull.base.ref,
      pull.base.sha,
      pull.head.ref,
      pull.head.sha,
      pull.updated_at,
    ],
  );
  proof.pull = {
    number: pull.number,
    githubId: pull.id,
    url: pull.html_url,
    baseSha: pull.base.sha,
    headSha: pull.head.sha,
  };
  const serverId = randomUUID();
  const signer = new KnowledgeSigner(
    serverId,
    'w02-github',
    generateKeyPairSync('ed25519').privateKey,
    3600,
  );
  await bindKnowledgeSigner(db, signer);
  const config = loadConfig({
    DATABASE_URL: databaseUrl,
    AUTH_MODE: 'local',
    GITHUB_MODE: 'disabled',
    CLIENT_API_KEYS_ENABLED: 'true',
    NODE_ENV: 'test',
    PUBLIC_BASE_URL: 'https://127.0.0.1',
    SESSION_SECRET: randomBytes(32).toString('hex'),
    KNOWLEDGE_PUBLICATION_ENABLED: 'true',
    KNOWLEDGE_DISTRIBUTION_ENABLED: 'true',
    KNOWLEDGE_SIGNING_KEY_ID: signer.keyId,
    KNOWLEDGE_SIGNING_KEY_FILE: 'in-memory-test-bootstrap',
    KNOWLEDGE_SERVER_ID: serverId,
    LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'w02-local',
    LOCAL_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(32).toString('base64url'),
    LOCAL_BOOTSTRAP_REVIEWER_USERNAME: 'w02-reader',
    LOCAL_BOOTSTRAP_REVIEWER_PASSWORD: randomBytes(32).toString('base64url'),
  });
  app = Fastify({ logger: false, https: { key: tlsKey, cert: ca } }) as unknown as FastifyInstance;
  const api = app;
  api.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof ClientCredentialError ? error.statusCode : 500).send({
      error: { code: error instanceof ClientCredentialError ? error.code : 'LIVE_READER_ERROR' },
    }),
  );
  api.addHook('onRequest', async (request, reply) => {
    if (request.headers.authorization) {
      const url = new URL(request.url, 'https://127.0.0.1');
      requests.push({
        at: new Date().toISOString(),
        method: request.method,
        route: url.pathname,
        queryKeys: [...url.searchParams.keys()],
        bodyBytes: Number(request.headers['content-length'] ?? 0),
      });
      if (request.method !== 'GET') return reply.code(405).send({});
    }
  });
  registerMutationOriginGuard(api, config);
  await registerAuthentication(api, config, db);
  const authorization = new AuthorizationService(config);
  const store = new FilesystemArtifactStore(path.join(root, 'artifacts'));
  await registerClientCredentialRoutes(api, db, config, authorization, signer);
  await registerReviewHistoryRoutes(api, db, authorization);
  await registerKnowledgeRoutes(api, db, authorization, store, signer);
  const row = (
    await db.query("select id,oidc_subject from users where oidc_subject='local:w02-reader'")
  ).rows[0];
  await db.query(
    'insert into tenant_memberships(tenant_id,user_id) values($1,$2) on conflict do nothing',
    [tenant, row.id],
  );
  await db.query(
    "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer') on conflict do nothing",
    [repo, row.oidc_subject],
  );
  const address = await api.listen({ host: '127.0.0.1', port: 0 });
  config.PUBLIC_BASE_URL = address;
  const login = async (username: string, password: string) => {
    const response = await api.inject({
      method: 'POST',
      url: '/auth/local/login',
      headers: { origin: address },
      payload: { username, password },
    });
    assert.equal(response.statusCode, 200, 'Local login failed');
    const cookies = response.headers['set-cookie'];
    const cookie = String(Array.isArray(cookies) ? cookies[0] : cookies).split(';')[0];
    assert(cookie?.startsWith('gcr_session='));
    return cookie;
  };
  const adminCookie = await login('w02-local', config.LOCAL_BOOTSTRAP_ADMIN_PASSWORD!);
  const readerCookie = await login('w02-reader', config.LOCAL_BOOTSTRAP_REVIEWER_PASSWORD!);
  const admin = async (method: 'GET' | 'POST', url: string, payload?: Record<string, unknown>) => {
    const response = await api.inject({
      method,
      url,
      headers: { cookie: adminCookie, origin: address },
      ...(payload === undefined ? {} : { payload }),
    });
    assert(
      response.statusCode >= 200 && response.statusCode < 300,
      `Admin request failed: ${response.statusCode}`,
    );
    return response.json();
  };
  const issued = await api.inject({
    method: 'POST',
    url: '/api/v1/me/client-credentials',
    headers: { cookie: readerCookie, origin: address },
    payload: {
      name: 'W02 GitHub temporary reader',
      clientId: 'commit-defender',
      tenantId: tenant,
      repositoryIds: [repo],
      scopes: ['knowledge:read'],
      lifetimeDays: 1,
    },
  });
  assert.equal(issued.statusCode, 201, 'Reader issuance failed');
  const credential = issued.json();
  await credentials.write(credentialReference, credential.token);
  credentialStored = true;
  const connection: Record<string, unknown> & { prefix: string } = {
    config: {
      serverUrl: address,
      serverId,
      tenantId: tenant,
      repositoryId: repo,
      trustedKeys: [{ id: signer.keyId, pem: signer.publicKeyPem }],
      ca,
    },
    credentialReference,
    pullNumber: 3,
    prefix: 'vscode-extension/test/fixtures/w02-history/',
    githubHeadSha: pull.head.sha,
  };
  const publish = async () => {
    await ensureKnowledgeScopes(db!, repo, row.id);
    for (let index = 0; index < 20; index++) {
      const state = await publishNextKnowledge(db!, store);
      assert.notEqual(state, 'failed');
      if (state === 'idle') return;
    }
    throw Error('Publication did not drain');
  };
  const collect = async () => {
    const created = await admin('POST', `/api/v1/repositories/${repo}/review-history/collections`, {
      requestKey: randomUUID(),
      pullNumbers: [3],
    });
    const job = await claimJob(db!, unique);
    assert(job && job.type === 'history.collect');
    await executeHistoryCollectionJob(db!, github, config, job);
    await db!.query(
      "update jobs set state='completed',lease_owner=null,lease_expires_at=null where id=$1",
      [job.id],
    );
    await db!.query('update job_attempts set ended_at=clock_timestamp() where id=$1', [
      job.attempt_id,
    ]);
    const status = await admin(
      'GET',
      `/api/v1/repositories/${repo}/review-history/collections/${created.id}`,
    );
    assert.equal(status.state, 'completed');
    const originals = await github.listPullRequestMessages(target, 3);
    const parity = [];
    for (const original of originals) {
      const stored = (
        await db!.query(
          'select id,body,content_hash,observation_hash,html_url,in_reply_to_github_id from github_pr_messages where repository_id=$1 and github_id=$2 and kind=$3',
          [repo, String(original.githubId), original.kind],
        )
      ).rows[0];
      assert(stored);
      assert.equal(stored.body, original.body);
      assert.equal(stored.content_hash, digest(original.body));
      assert.equal(stored.html_url, original.url);
      assert.equal(
        stored.in_reply_to_github_id,
        original.inReplyToGithubId == null ? null : String(original.inReplyToGithubId),
      );
      parity.push({
        id: stored.id,
        githubId: original.githubId,
        kind: original.kind,
        contentHash: stored.content_hash,
        observationHash: stored.observation_hash,
        url: original.url,
        inReplyToGithubId: original.inReplyToGithubId,
        bodyExact: true,
      });
    }
    proof.collections.push({ id: created.id, state: status.state, parity });
    proof.phase = 'collected';
    await save();
    console.log(JSON.stringify({ phase: proof.phase, messages: parity }));
  };
  const activate = async (sourceGithubId: number) => {
    assert(Number.isSafeInteger(sourceGithubId));
    const source = (
      await db!.query(
        "select id,content_hash,observation_hash from github_pr_messages where repository_id=$1 and github_id=$2 and kind='review-comment'",
        [repo, String(sourceGithubId)],
      )
    ).rows[0];
    assert(source, 'Collected review comment required');
    const draft = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          '.documents/execution/review-memory-pull/evidence/G02-guidance-draft.json',
        ),
        'utf8',
      ),
    );
    const content = draft.content;
    content.detail =
      '검증용 PR #3의 실제 리뷰 원문에 따라 요청 값만으로 판정할 수 있는 제약을 BlockUpdateRequest의 Pydantic validator에서 검증한다. 답글의 수정 주장만으로 현재 코드의 수정 여부를 확정하지 않는다.';
    content.appliesTo.filePaths = content.appliesTo.filePaths.map(
      (file: string) => connection.prefix + file,
    );
    const created = await admin('POST', `/api/v1/repositories/${repo}/review-history/guidance`, {
      sourceId: source.id,
      contentHash: source.content_hash,
      observationHash: source.observation_hash,
      content,
    });
    const active = await admin(
      'POST',
      `/api/v1/repositories/${repo}/review-history/guidance/${created.id}/activate`,
      { revision: created.revision },
    );
    assert.equal(active.state, 'active');
    await publish();
    const detail = await admin(
      'GET',
      `/api/v1/repositories/${repo}/review-history/pulls/3/messages/${source.id}`,
    );
    const replies = proof.collections
      .at(-1)!
      .parity.filter((item) => item.inReplyToGithubId === sourceGithubId);
    assert.equal(replies.length, 1, 'One actual GitHub reply required');
    connection.source = {
      id: source.id,
      githubId: sourceGithubId,
      contentHash: source.content_hash,
      observationHash: source.observation_hash,
      url: detail.item.htmlUrl,
    };
    connection.reply = replies[0];
    connection.guidance = {
      id: active.id,
      revision: active.revision,
      contentSha256: digest(canonicalKnowledgeJson(active.content)),
      sourceContentHash: active.source.contentHash,
      state: active.state,
    };
    proof.source = connection.source;
    proof.reply = connection.reply;
    proof.guidance = connection.guidance;
    const versions = await admin(
      'GET',
      `/api/v1/repositories/${repo}/review-history/pulls/3/messages/${source.id}/versions`,
    );
    proof.bodyVersions = versions.items.map(
      (item: { id: string; contentHash: string; githubUpdatedAt: string }) => ({
        id: item.id,
        contentHash: item.contentHash,
        githubUpdatedAt: item.githubUpdatedAt,
      }),
    );
    connection.bodyVersions = proof.bodyVersions;
    await writeFile(connectionFile, JSON.stringify(connection, null, 2) + '\n');
    proof.phase = 'ready-for-host';
    await save();
    console.log(
      JSON.stringify({
        phase: proof.phase,
        source: proof.source,
        guidance: proof.guidance,
        bodyVersions: proof.bodyVersions,
      }),
    );
  };
  await publish();
  proof.status = 'running';
  proof.phase = 'awaiting-collection';
  proof.address = address;
  await writeFile(connectionFile, JSON.stringify(connection, null, 2) + '\n');
  await save();
  console.log(JSON.stringify({ phase: proof.phase, address, connectionFile }));
  const input = createInterface({ input: process.stdin, terminal: false });
  const deadline = setTimeout(() => input.close(), 2400000);
  try {
    for await (const line of input) {
      const command = JSON.parse(line);
      if (command.action === 'stop') break;
      if (command.action === 'collect') await collect();
      else if (command.action === 'activate') await activate(command.sourceGithubId);
      else if (command.action === 'status') {
        await save();
        console.log(JSON.stringify({ phase: proof.phase, requests: requests.length }));
      } else throw Error('Unknown control action');
    }
  } finally {
    clearTimeout(deadline);
    input.close();
  }
  proof.readerReadOnly = requests.every((item) => item.method === 'GET' && item.bodyBytes === 0);
  assert(proof.readerReadOnly);
  const revoked = await api.inject({
    method: 'DELETE',
    url: `/api/v1/me/client-credentials/${credential.id}`,
    headers: { cookie: readerCookie, origin: address },
  });
  assert.equal(revoked.statusCode, 204);
  proof.testReaderRevoked = true;
  proof.status = 'stopped';
} catch (error) {
  proof.status = 'failed';
  proof.failure = {
    name: error instanceof Error ? error.name : 'unknown',
    code: (error as { code?: string }).code ?? null,
  };
  // Error output intentionally excludes credentials, response bodies and argv.
  console.log(JSON.stringify({ status: proof.status, phase: proof.phase, failure: proof.failure }));
  process.exitCode = 1;
} finally {
  if (credentialStored) await credentials.remove(credentialReference);
  await app?.close();
  await db?.end();
  if (container) await docker(['rm', '-f', unique]);
  if (volume) await docker(['volume', 'rm', unique]);
  assert(path.basename(root).startsWith('w02-github-'));
  await rm(root, { recursive: true, force: true });
  proof.cleanup = {
    readerCredentialRemoved: credentialStored,
    containerRemoved: container,
    volumeRemoved: volume,
    temporaryFilesRemoved: true,
  };
  await save();
  console.log(JSON.stringify({ status: proof.status, cleanup: proof.cleanup }));
}

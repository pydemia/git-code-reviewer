/** Manual W02 probe: real reader routes, disposable DB, no account model calls. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request as httpsRequest } from 'node:https';
import Fastify, { type FastifyInstance } from 'fastify';
import { createDatabase, runMigrations, type Database } from '@gcr/db';
import { FilesystemArtifactStore } from '@gcr/artifact-store';
import { CentralConnections, PlatformLocalKeyStore } from '@gcr/client-core';
import type { ReviewHistoryRequest } from '@gcr/client-contract';
import { windowsPrivateTemporary } from '../../../packages/client-core/src/windows-native.js';
import { loadConfig } from '../src/config.js';
import { registerAuthentication, type AuthUser } from '../src/auth/index.js';
import { registerClientCredentialRoutes } from '../src/auth/client-routes.js';
import {
  issueClientKey,
  revokeClientKey,
  ClientCredentialError,
} from '../src/auth/client-credentials.js';
import { AuthorizationService } from '../src/services/authorization.js';
import {
  ensureFixtureRepository,
  persistPullRequestMessages,
} from '../src/services/repositories.js';
import {
  createHistoryGuidance,
  activateHistoryGuidance,
  guidanceTransaction,
} from '../src/services/review-history-guidance.js';
import {
  KnowledgeSigner,
  bindKnowledgeSigner,
  ensureKnowledgeScopes,
} from '../src/services/knowledge-manifest.js';
import { publishNextKnowledge } from '../src/services/knowledge-publication.js';
import { registerReviewHistoryRoutes } from '../src/routes/review-history.js';
import { registerKnowledgeRoutes } from '../src/routes/review-knowledge.js';

assert.equal(process.platform, 'win32');
const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const evidenceFile = path.join(repositoryRoot, 'tmp/w02/W02-product-reader.json');
const root = windowsPrivateTemporary('w02-reader-');
const unique = `w02-reader-${randomUUID()}`;
const image = 'postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73';
const password = randomBytes(32).toString('base64url');
const requests: Array<{ method: string; route: string; queryKeys: string[]; bodyBytes: number }> =
  [];
const readerResults: Array<{
  request: ReviewHistoryRequest;
  revision: string | number;
  count: number | undefined;
  offlineExact: boolean;
}> = [];
const proof: Record<string, unknown> = {
  status: 'running',
  platform: process.platform,
  arch: process.arch,
  node: process.version,
  realProductReaderRoutes: true,
  realPrismData: false,
  modelCalls: 0,
  databaseRuntime: 'Docker Linux ARM64 PostgreSQL; API/client run in Windows Node',
  image,
  phase: 'database-init',
  requests,
  readerResults,
};
let volume = false,
  container = false,
  db: Database | undefined;
let app: FastifyInstance | undefined;
let manager: CentralConnections | undefined, connectionId: string | undefined;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
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
  const port = Number((await docker(['port', unique, '5432/tcp'])).split(':').at(-1));
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
  const repo = (await ensureFixtureRepository(db))!;
  const tenant = (await db.query('select tenant_id from repositories where id=$1', [repo])).rows[0]
    .tenant_id;
  const serverId = randomUUID();
  const keys = generateKeyPairSync('ed25519');
  const signer = new KnowledgeSigner(serverId, 'w02-local', keys.privateKey, 3600);
  await bindKnowledgeSigner(db, signer);
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
    KNOWLEDGE_SIGNING_KEY_FILE: 'memory-only-probe',
    KNOWLEDGE_SERVER_ID: serverId,
    LOCAL_BOOTSTRAP_ADMIN_USERNAME: 'w02-local',
    LOCAL_BOOTSTRAP_ADMIN_PASSWORD: randomBytes(32).toString('base64url'),
    LOCAL_BOOTSTRAP_REVIEWER_USERNAME: 'w02-reader',
    LOCAL_BOOTSTRAP_REVIEWER_PASSWORD: randomBytes(32).toString('base64url'),
  });
  // Register production authentication and reader routes; no fabricated actor hook.
  app = Fastify({ logger: false, https: { key: tlsKey, cert: ca } }) as unknown as FastifyInstance;
  const api = app!;
  api.setErrorHandler((error, _request, reply) =>
    reply.code(error instanceof ClientCredentialError ? error.statusCode : 500).send({
      error: { code: error instanceof ClientCredentialError ? error.code : 'PROBE_ERROR' },
    }),
  );
  api.addHook('onRequest', async (request, reply) => {
    const url = new URL(request.url, 'https://fixture.invalid');
    requests.push({
      method: request.method,
      route: url.pathname,
      queryKeys: [...url.searchParams.keys()],
      bodyBytes: Number(request.headers['content-length'] ?? 0),
    });
    if (request.method !== 'GET') return reply.code(405).send({});
  });
  await registerAuthentication(api, config, db);
  const authorization = new AuthorizationService(config);
  const store = new FilesystemArtifactStore(path.join(root, 'artifacts'));
  await registerClientCredentialRoutes(api, db, config, authorization, signer);
  await registerReviewHistoryRoutes(api, db, authorization);
  await registerKnowledgeRoutes(api, db, authorization, store, signer);
  const row = (
    await db.query("select id,oidc_subject from users where oidc_subject='local:w02-reader'")
  ).rows[0];
  const adminId = (await db.query("select id from users where oidc_subject='local:w02-local'"))
    .rows[0].id;
  await db.query(
    'insert into tenant_memberships(tenant_id,user_id) values($1,$2) on conflict do nothing',
    [tenant, row.id],
  );
  await db.query(
    "insert into repository_grants(repository_id,subject_or_group,role) values($1,$2,'reviewer') on conflict do nothing",
    [repo, row.oidc_subject],
  );
  const actor: AuthUser = {
    id: row.id,
    subject: row.oidc_subject,
    displayName: 'W02',
    role: 'reviewer',
    enabled: true,
    groups: [],
    tenantIds: [tenant],
    tenants: [],
  };
  const session = randomBytes(32).toString('base64url');
  await db.query(
    "insert into user_sessions(id_hash,user_id,expires_at) values($1,$2,clock_timestamp()+interval '1 hour')",
    [digest(session), row.id],
  );
  const credential = await issueClientKey(db, {
    user: actor,
    sessionToken: session,
    serverId,
    authMode: 'local',
    requestId: 'w02-local',
    input: {
      name: 'W02 temporary reader',
      clientId: 'commit-defender',
      tenantId: tenant,
      repositoryIds: [repo],
      scopes: ['knowledge:read'],
      lifetimeDays: 1,
    },
  });
  proof.phase = 'local-data-publication';
  const draft = JSON.parse(
    await readFile(
      path.join(
        repositoryRoot,
        '.documents/execution/review-memory-pull/evidence/G02-guidance-draft.json',
      ),
      'utf8',
    ),
  );
  for (const number of [917, 915]) {
    await db.query(
      `insert into pull_requests(repository_id,github_id,number,title,state,draft,author_login,html_url,base_ref,base_sha,head_ref,head_sha,github_updated_at)
      values($1,$2::int,$2::int,'W02 reconstruction','closed',false,'fixture',$3,'main',$4,'fixture',$5,clock_timestamp())`,
      [repo, number, `https://example.invalid/w02/pull/${number}`, 'a'.repeat(40), 'b'.repeat(40)],
    );
  }
  const body = '[W02 LOCAL RECONSTRUCTION; NOT ORIGINAL COMMENT]\n' + draft.content.detail;
  const sourceMessage = {
    githubId: 3967869279,
    kind: 'review-comment' as const,
    author: 'fixture',
    authorType: 'User',
    body,
    path: draft.content.appliesTo.filePaths[0],
    line: 1,
    side: 'RIGHT' as const,
    commitSha: 'b'.repeat(40),
    inReplyToGithubId: null,
    url: draft.source.htmlUrl,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  proof.phase = 'local-message-persistence';
  await persistPullRequestMessages(
    db,
    repo,
    917,
    [
      sourceMessage,
      {
        ...sourceMessage,
        githubId: 3968842864,
        body: '[W02 LOCAL RECONSTRUCTED REPLY]',
        inReplyToGithubId: 3967869279,
        url: 'https://example.invalid/w02/reply',
      },
    ],
    new Date(),
    undefined,
    { complete: true },
  );
  const source = (
    await db.query(
      'select id,content_hash,observation_hash from github_pr_messages where repository_id=$1 and github_id=$2',
      [repo, String(sourceMessage.githubId)],
    )
  ).rows[0];
  proof.phase = 'local-guidance-publication';
  const guidance = await guidanceTransaction(db, async (transaction) => {
    const value = await createHistoryGuidance(transaction, repo, adminId, {
      sourceId: source.id,
      contentHash: source.content_hash,
      observationHash: source.observation_hash,
      content: draft.content,
    });
    return activateHistoryGuidance(transaction, repo, adminId, value.id, value.revision);
  });
  await ensureKnowledgeScopes(db, repo, actor.id);
  let drained = false;
  for (let i = 0; i < 20; i++) {
    const state = await publishNextKnowledge(db, store);
    assert.notEqual(state, 'failed');
    if (state === 'idle') {
      drained = true;
      break;
    }
  }
  assert(drained);
  proof.phase = 'reader-https';
  const address = await api.listen({ host: '127.0.0.1', port: 0 });
  const scope = {
    kind: 'repository' as const,
    profileId: unique,
    repositoryKey: 'a'.repeat(64),
    worktreeKey: 'b'.repeat(64),
  };
  const dataDirectory = path.join(root, 'client');
  const open = () => CentralConnections.open({ scope, dataDirectory });
  manager = await open();
  const connection = await manager.connect(
    {
      serverUrl: address,
      serverId,
      tenantId: tenant,
      repositoryId: repo,
      trustedKeys: [{ id: signer.keyId, pem: signer.publicKeyPem }],
      ca,
    },
    credential.token,
    'commit-defender',
  );
  connectionId = connection.id;
  manager.close();
  manager = await open();
  const reads: ReviewHistoryRequest[] = [
    { kind: 'pulls', pullNumber: 917 },
    { kind: 'pulls', pullNumber: 915 },
    { kind: 'message', pullNumber: 917, sourceId: source.id },
    { kind: 'messages', pullNumber: 917, parentId: source.id },
    { kind: 'versions', pullNumber: 917, sourceId: source.id },
    { kind: 'observations', pullNumber: 917, sourceId: source.id },
    { kind: 'guidance-detail', guidanceId: guidance.id },
  ];
  for (const request of reads) {
    const online = await manager.readHistory(connectionId, request);
    const offline = await manager.readHistory(connectionId, request, 'offline');
    assert.deepEqual(online.data, offline.data);
    readerResults.push({
      request,
      revision: online.data.revision,
      count: 'items' in online.data ? online.data.items.length : undefined,
      offlineExact: true,
    });
  }
  const snapshot = await (await manager.review(connectionId, 'online')).cache.read('online');
  assert(
    Date.parse(snapshot.manifest.payload.refreshAfter) -
      Date.parse(snapshot.manifest.payload.issuedAt) <=
      300000,
  );
  assert(JSON.stringify(snapshot.bundles.collective).includes(guidance.id));
  proof.manifest = snapshot.manifest;
  proof.localGuidance = {
    id: guidance.id,
    revision: guidance.revision,
    state: guidance.state,
    sourceId: source.id,
    localSourceHash: source.content_hash,
    historicalSourceId: draft.source.id,
    historicalSourceHash: draft.source.contentHash,
    guidanceContentEqual: JSON.stringify(guidance.content) === JSON.stringify(draft.content),
  };
  proof.phase = 'reader-scope-and-expiry';
  const get = (route: string, token: string) =>
    new Promise<{ status: number; code: string | undefined }>((resolve, reject) => {
      const request = httpsRequest(
        address + route,
        {
          ca,
          method: 'GET',
          headers: {
            authorization: `Bearer ${token}`,
            'x-gcr-server-id': serverId,
          },
        },
        (response) => {
          let body = '';
          response.on('data', (bytes) => {
            body += bytes.toString();
            if (body.length > 16384) request.destroy(Error('Response limit'));
          });
          response.on('end', () => {
            try {
              resolve({ status: response.statusCode!, code: JSON.parse(body).error?.code });
            } catch {
              reject(Error('Invalid probe response'));
            }
          });
        },
      );
      request.setTimeout(5000, () => request.destroy(Error('Probe deadline')));
      request.on('error', reject);
      request.end();
    });
  const otherRepo = (
    await db.query(
      `insert into repositories(tenant_id,instance_id,github_id,installation_id,owner,name,polling_enabled)
    select tenant_id,instance_id,'999998','1','fixture','other',false from repositories where id=$1 returning id`,
      [repo],
    )
  ).rows[0].id;
  proof.deniedRepository = await get(
    `/api/v1/repositories/${otherRepo}/review-history`,
    credential.token,
  );
  assert.deepEqual(proof.deniedRepository, { status: 403, code: 'CLIENT_SCOPE_DENIED' });
  const expiring = await issueClientKey(db, {
    user: actor,
    sessionToken: session,
    serverId,
    authMode: 'local',
    requestId: 'w02-expiry',
    input: {
      name: 'W02 expiry-only reader',
      clientId: 'commit-defender',
      tenantId: tenant,
      repositoryIds: [repo],
      scopes: ['knowledge:read'],
      lifetimeDays: 1,
    },
  });
  // Shorten this dedicated fixture credential; never renew expired cache/key.
  await db.query(
    "update client_api_keys set created_at=clock_timestamp()-interval '2 seconds',expires_at=clock_timestamp()-interval '1 second' where id=$1",
    [expiring.id],
  );
  const expiredCredential = await get('/api/v1/client-auth/me', expiring.token);
  assert.equal(expiredCredential.status, 401);
  assert.equal(expiredCredential.code, 'CLIENT_AUTHENTICATION_REQUIRED');
  proof.expiredCredential = {
    ...expiredCredential,
    cause: 'Dedicated test key expiry shortened in owned DB; no renewal',
  };
  proof.phase = 'revocation';
  await revokeClientKey(db, actor.id, credential.id, 'w02-local-cleanup');
  await assert.rejects(manager.synchronize(connectionId), { code: 'revoked' });
  await assert.rejects(manager.review(connectionId, 'offline'));
  proof.revokedTestReaderDenied = true;
  proof.readOnlyHttp = requests.every(
    (request) => request.method === 'GET' && request.bodyBytes === 0,
  );
  assert(proof.readOnlyHttp);
  proof.status = 'passed';
} catch (error) {
  proof.status = 'failed';
  proof.failure = {
    name: error instanceof Error ? error.name : 'unknown',
    code: (error as { code?: string }).code ?? null,
  };
  process.exitCode = 1;
} finally {
  try {
    if (connectionId) await manager?.disconnect(connectionId);
  } finally {
    manager?.close();
    await app?.close();
    await db?.end();
  }
  if (container) await docker(['rm', '-f', unique]);
  if (volume) await docker(['volume', 'rm', unique]);
  const keys = new PlatformLocalKeyStore();
  const cleanupKeys = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw Error('Unexpected reparse entry in owned probe');
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await cleanupKeys(target);
      else if (entry.name === 'key-ref.json') {
        const ref = JSON.parse(await readFile(target, 'utf8'));
        assert.equal(ref.profileId, unique);
        await keys.remove(`${ref.profileId}.${ref.id}`);
      }
    }
  };
  await cleanupKeys(root);
  assert(path.basename(root).startsWith('w02-reader-'));
  await rm(root, { recursive: true, force: true });
  proof.cleanup = {
    containerRemoved: container,
    volumeRemoved: volume,
    readerCredentialRemoved: true,
    profileKeysRemoved: true,
    temporaryFilesRemoved: true,
  };
  await mkdir(path.dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, JSON.stringify(proof, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: proof.status,
      phase: proof.phase,
      failure: proof.failure,
      modelCalls: 0,
      cleanup: proof.cleanup,
    }),
  );
}

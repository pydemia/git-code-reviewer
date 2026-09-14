// Opt-in real-account review/chat verification; synthetic repository only.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const consumer = process.env.GCR_CHAT_CONSUMER;
const modulePath = (name) =>
  consumer
    ? path.join(consumer, 'node_modules/@gcr', name, 'dist/index.js')
    : path.join(project, 'packages', name, 'dist/index.js');
const core = await import(pathToFileURL(modulePath('client-core')).href);
const executors = await import(pathToFileURL(modulePath('client-executors')).href);
const executable = process.env.GCR_CHAT_CODEX;
assert(
  executable && path.isAbsolute(executable),
  'GCR_CHAT_CODEX must select an absolute executable',
);
const phase = process.argv[2];
if (phase) {
  assert(['begin', 'answer'].includes(phase));
  const root = process.env.GCR_CHAT_FIXTURE;
  assert(root && path.isAbsolute(root));
  const metadata = JSON.parse(await readFile(path.join(root, 'metadata.json'), 'utf8'));
  const repo = path.join(root, 'repo'),
    dataDirectory = path.join(root, 'data');
  const client = core.discoverLocalIdentity(repo, metadata.profileId);
  const records = await core.LocalRecordStore.open({
    dataDirectory,
    scope: {
      kind: 'repository',
      profileId: client.profileId,
      repositoryKey: client.repositoryKey,
      worktreeKey: client.worktreeKey,
    },
  });
  const store = new core.ReviewConversationStore(records);
  let snapshot;
  try {
    snapshot =
      phase === 'begin'
        ? core.captureLocalSource({ cwd: repo, kind: 'index' })
        : core.restoreLocalSource((await store.get('chat')).source);
    const executor = await executors.prepareCodexAccountExecutor({
      executablePath: executable,
      model: 'gpt-6-astra',
      reasoningEffort: 'xhigh',
    });
    assert.equal(executor.conversationCapability, 'checkpoint-tool-v1');
    const context = await core.resolveLocalContext({
      client,
      snapshot,
      stores: [],
      requiredSources: [{ side: 'source', path: 'caller.py' }],
    });
    assert.equal(context.status, 'ready');
    const resolved = core.resolveLocalExecutionPolicy({
      context,
      snapshot,
      executor: executor.descriptor,
      workspaceTrusted: true,
      approval: {
        client,
        executor: executor.descriptor,
        paths: ['**'],
        allowRelated: true,
        allowBase: true,
        allowKnowledge: true,
      },
      budget: { modelCalls: 3, durationMs: 360000, sourceBytes: 2097152, toolCalls: 80 },
    });
    assert.equal(resolved.status, 'ready');
    const policy = resolved.policy;
    if (phase === 'begin') {
      process.stdout.write('Actual fixed-source review started.\n');
      const report = await core.runLocalReview({
        snapshot,
        context: context.context,
        policy,
        executor,
      });
      assert(
        ['completed', 'partial', 'needs-context'].includes(report.status),
        `Review status: ${report.status}`,
      );
      await store.create({ id: 'chat', review: report, snapshot, policy });
      await store.append(
        'chat',
        'turn',
        'Explain the missing cache-key finding. Before recommending a fix, ask me with ask_user whether missing requested keys must be filled with a default or omitted from the response. That is a product choice only I can answer. Read source/base/caller first, then pause for my answer.',
      );
    } else {
      const pending = await store.get('chat');
      assert.equal(pending.conversation.turns[0].status, 'awaiting_input');
      const question = pending.conversation.turns[0].questions.at(-1);
      await store.answer(
        'chat',
        'turn',
        question.id,
        'Missing requested keys must be present in the result with default value 1. Explain the defect and the fix against the captured source, base, and caller; no further product question is needed.',
      );
      const revision = (await store.get('chat')).revision;
      await store.answer(
        'chat',
        'turn',
        question.id,
        'Missing requested keys must be present in the result with default value 1. Explain the defect and the fix against the captured source, base, and caller; no further product question is needed.',
      );
      assert.equal((await store.get('chat')).revision, revision);
      process.stdout.write('Reopened conversation and accepted an idempotent answer.\n');
    }
    const sourceReads = [];
    const result = await core.runReviewConversation({
      store,
      conversationId: 'chat',
      turnId: 'turn',
      context: context.context,
      policy,
      executor: {
        descriptor: executor.descriptor,
        conversationCapability: executor.conversationCapability,
        review: (input) => executor.review(input),
        converse: (input) =>
          executor.converse({
            ...input,
            source: {
              async execute(name, args) {
                const text = await input.source.execute(name, args);
                const read = JSON.parse(text);
                if (name === 'read_file' && read.status === 'available')
                  sourceReads.push({
                    readId: read.readId,
                    path: read.source.path,
                    side: read.source.side,
                    hash: read.source.hash,
                  });
                return text;
              },
            },
          }),
      },
      async assertAuthorized() {
        // Explicitly approved synthetic fixture only. This host grants no other root.
        assert.equal(
          core.discoverLocalIdentity(repo, metadata.profileId).worktreeKey,
          client.worktreeKey,
        );
      },
    });
    const turn = result.conversation.turns[0];
    const proof = {
      phase,
      pid: process.pid,
      status: turn.status,
      model: executor.descriptor.model,
      effort: 'xhigh',
      sourceHash: result.conversation.identity.source.hash,
      contextHash: result.conversation.identity.context.hash,
      conversationId: result.conversation.id,
      turnId: turn.id,
      questionCount: turn.questions.length,
      sourceReads,
      usage: turn.usage,
      citationCount: turn.response?.citations.length ?? 0,
      citationPaths: [
        ...new Set(
          turn.response?.citations.map((c) => `${c.location.side}:${c.location.path}`) ?? [],
        ),
      ],
      content: turn.response?.content ?? null,
      error: turn.error,
    };
    await writeFile(path.join(root, `${phase}.json`), JSON.stringify(proof, null, 2) + '\n', {
      mode: 0o600,
    });
    assert.equal(
      turn.status,
      phase === 'begin' ? 'awaiting_input' : 'completed',
      JSON.stringify(proof),
    );
    assert(sourceReads.some((read) => read.path === 'cache.py' && read.side === 'source'));
    assert(sourceReads.some((read) => read.path === 'cache.py' && read.side === 'base'));
    assert(sourceReads.some((read) => read.path === 'caller.py' && read.side === 'source'));
    if (phase === 'answer') {
      assert(turn.response.citations.length > 0);
      assert(!turn.response.content.includes('POST_CHECKPOINT_LIVE_CANARY'));
      assert.equal(turn.usage.modelCalls, 2);
    }
    process.stdout.write(`Conversation phase ${phase}: ${turn.status}.\n`);
  } finally {
    snapshot?.close();
    records.close();
  }
} else {
  const evidence = process.env.GCR_CHAT_EVIDENCE;
  assert(evidence && path.isAbsolute(evidence));
  const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-chat-live-'));
  const profileId = `chat-live-${randomUUID()}`;
  const repo = path.join(root, 'repo');
  await mkdir(repo);
  const proof = { status: 'running', packageVersion: core.clientCorePackage.version, events: [] };
  await writeFile(evidence, JSON.stringify(proof) + '\n', { flag: 'wx', mode: 0o600 });
  const save = () => writeFile(evidence, JSON.stringify(proof, null, 2) + '\n', { mode: 0o600 });
  const gitEnv = {
    PATH: process.env.PATH,
    HOME: root,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  };
  const git = (...args) =>
    execFileSync(
      'git',
      [
        '-C',
        repo,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        '-c',
        'core.hooksPath=/dev/null',
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { env: gitEnv, stdio: 'pipe' },
    );
  let success = false;
  try {
    git('init', '-b', 'main');
    await writeFile(
      path.join(repo, 'cache.py'),
      'def load(keys, cache):\n    return {k: cache.get(k, 1) for k in keys}\n',
    );
    await writeFile(
      path.join(repo, 'caller.py'),
      'from cache import load\nvalue = load(["a", "b"], {"a": 1})["b"]\n',
    );
    git('add', '.');
    git('commit', '-m', 'synthetic base');
    await writeFile(path.join(repo, 'cache.py'), 'def load(keys, cache):\n    return cache\n');
    git('add', '.');
    await writeFile(path.join(root, 'metadata.json'), JSON.stringify({ profileId }) + '\n', {
      mode: 0o600,
    });
    for (const stage of ['begin', 'answer']) {
      if (stage === 'answer')
        await writeFile(path.join(repo, 'cache.py'), 'POST_CHECKPOINT_LIVE_CANARY\n');
      const child = execFile(process.execPath, [fileURLToPath(import.meta.url), stage], {
        env: { ...process.env, GCR_CHAT_FIXTURE: root },
        maxBuffer: 1048576,
      });
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
      await new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code) =>
          code === 0 ? resolve() : reject(Error(`Verifier phase ${stage} exited ${code}`)),
        );
      });
      proof.events.push(JSON.parse(await readFile(path.join(root, `${stage}.json`), 'utf8')));
      await save();
    }
    assert.notEqual(proof.events[0].pid, proof.events[1].pid);
    assert.equal(proof.events[0].sourceHash, proof.events[1].sourceHash);
    assert.equal(proof.events[0].contextHash, proof.events[1].contextHash);
    proof.status = 'passed';
    success = true;
  } catch (error) {
    proof.status = 'failed';
    proof.error = error.message;
    proof.fixture = root;
    throw error;
  } finally {
    if (success) {
      const reference = JSON.parse(
        await readFile(path.join(root, 'data/profiles', profileId, 'local/key-ref.json'), 'utf8'),
      );
      assert.equal(reference.profileId, profileId);
      await new core.PlatformLocalKeyStore().remove(`${profileId}.${reference.id}`);
      await rm(root, { recursive: true, force: true });
      proof.fixtureAndKeyRemoved = true;
    }
    await save();
  }
}

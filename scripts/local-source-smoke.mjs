// Copy beside an offline-installed consumer's node_modules, then run with Node >=18.
// The fixture is synthetic; this checks source capture, not a model's review quality.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { captureLocalSource, clientCorePackage } from '@gcr/client-core';

const root = fs.mkdtempSync(path.join(tmpdir(), 'gcr-installed-source-'));
const repo = path.join(root, 'repo');
fs.mkdirSync(repo);
const git = (...args) =>
  execFileSync(
    'git',
    [
      '-C',
      repo,
      '-c',
      'user.name=Source Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
      },
    },
  ).trim();
const write = (file, body) => {
  const destination = path.join(repo, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, body);
};
const inventory = (directory) =>
  fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? inventory(path.join(directory, entry.name)).map((file) => `${entry.name}/${file}`)
        : [entry.name],
    )
    .sort();
let evidence;
try {
  git('init', '-b', 'main');
  write('api.py', 'def load():\n    return 0\n');
  write('caller.py', 'from api import load\nassert load() == 0\n');
  write('old.ts', 'export const moved = 1;\n');
  git('add', '.');
  git('commit', '-m', 'synthetic base');
  const base = git('rev-parse', 'HEAD');
  write('api.py', 'def load():\n    return 1\n');
  git('add', 'api.py');
  git('mv', 'old.ts', 'new.ts');
  write('api.py', 'def load():\n    return 2 # unstaged\n');
  write('new.py', 'untracked = True\n');
  write('.env', 'SYNTHETIC_PRIVATE_CANARY');
  git('add', '-f', '.env');
  const index = git('rev-parse', '--path-format=absolute', '--git-path', 'index');
  const originalIndex = fs.readFileSync(index),
    mtime = fs.statSync(index).mtimeMs;
  const objects = git('rev-parse', '--path-format=absolute', '--git-path', 'objects');
  const originalObjects = inventory(objects);
  const stage = captureLocalSource({ cwd: repo, kind: 'index' });
  const working = captureLocalSource({
    cwd: repo,
    kind: 'working-tree',
    includeUntracked: ['new.py'],
  });
  assert.equal(stage.identity.baseCommit, base);
  assert.equal(stage.readFile('api.py').text, 'def load():\n    return 1\n');
  assert.equal(working.readFile('api.py').text, 'def load():\n    return 2 # unstaged\n');
  assert.equal(working.readFile('new.py').text, 'untracked = True\n');
  assert.equal(stage.readFile('new.py').status, 'absent');
  assert.equal(stage.readFile('.env').reason, 'private-data');
  assert(stage.diff.includes('rename from old.ts'));
  assert(!stage.diff.includes('PRIVATE_CANARY'));
  assert.deepEqual(fs.readFileSync(index), originalIndex);
  assert.equal(fs.statSync(index).mtimeMs, mtime);
  assert.deepEqual(inventory(objects), originalObjects);
  const file = stage.readFile('api.py');
  assert.equal(file.source.hash, createHash('sha256').update(file.text).digest('hex'));
  git('rm', '-f', 'api.py');
  const deletion = captureLocalSource({ cwd: repo, kind: 'index' });
  assert.equal(deletion.readFile('api.py').status, 'absent');
  assert.equal(deletion.readFile('api.py', 'base').text, 'def load():\n    return 0\n');
  const gitVersion = git('--version');
  fs.rmSync(repo, { recursive: true });
  assert.equal(stage.readFile('caller.py').text, 'from api import load\nassert load() == 0\n');
  assert(stage.search('load').matches.length >= 2);
  evidence = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    git: gitVersion,
    packageVersion: clientCorePackage.version,
    verification: 'installed-artifact',
    partialStage: true,
    savedWorkingTree: true,
    explicitUntracked: true,
    rename: true,
    deletionBase: true,
    privateExclusion: true,
    sourceHashVerified: true,
    originalIndexBytesAndMtimeUnchanged: true,
    originalGitObjectInventoryUnchanged: true,
    readsAfterOriginalRepositoryRemoval: true,
    syntheticData: true,
    modelCalls: 0,
  };
  stage.close();
  working.close();
  deletion.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
process.stdout.write(JSON.stringify({ ...evidence, cleanup: 'completed' }, null, 2) + '\n');

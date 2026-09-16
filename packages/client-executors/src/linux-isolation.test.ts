import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runIsolatedCodex } from './codex-isolation.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-linux-account-'));
  roots.push(root);
  const account = path.join(root, '계정 with spaces');
  await mkdir(account, { mode: 0o700 });
  await writeFile(path.join(account, 'auth.json'), 'synthetic-account', { mode: 0o600 });
  for (const name of ['AGENTS.md', 'AGENTS.override.md', 'config.toml'])
    await writeFile(path.join(account, name), `PRIVATE_${name}`, { mode: 0o600 });
  return {
    root,
    account,
    input: {
      command: process.execPath,
      args: ['-e', 'process.exit(0)', '--'],
      cwd: root,
      env: { HOME: root, CODEX_HOME: account },
      stdin: '',
      timeoutMs: 5000,
    },
  };
}

describe.skipIf(process.platform !== 'linux')('Linux private Codex account', () => {
  it('uses the same private inode and preserves refreshes without exposing global documents', async () => {
    const { account, input } = await fixture();
    const file = path.join(account, 'auth.json');
    const before = await lstat(file);
    const result = await runIsolatedCodex({
      ...input,
      args: [
        '-e',
        `
        const fs=require('fs'),p=require('path');
        const h=process.env.CODEX_HOME, file=p.join(h,'auth.json');
        const s=fs.statSync(file), d=fs.statSync(h);
        console.log(JSON.stringify({home:h,names:fs.readdirSync(h),
          ino:s.ino,dev:s.dev,links:s.nlink,uid:s.uid,mode:d.mode&511,
          value:fs.readFileSync(file,'utf8')}));
        fs.writeFileSync(file,'synthetic-refreshed-account');
      `,
        '--',
      ],
    });
    expect(result.code).toBe(0);
    const observed = JSON.parse(result.stdout);
    expect(observed).toMatchObject({
      names: ['auth.json'],
      ino: before.ino,
      dev: before.dev,
      links: before.nlink + 1,
      uid: process.getuid!(),
      mode: 0o700,
      value: 'synthetic-account',
    });
    await expect(lstat(observed.home)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(file)).nlink).toBe(before.nlink);
    expect(await readFile(file, 'utf8')).toBe('synthetic-refreshed-account');
    for (const name of ['AGENTS.md', 'AGENTS.override.md', 'config.toml'])
      expect(await readFile(path.join(account, name), 'utf8')).toBe(`PRIVATE_${name}`);
  });

  it.each([
    'missing-auth',
    'public-auth',
    'writable-home',
    'auth-symlink',
    'home-symlink',
    'auth-directory',
  ])('rejects %s before launch and leaves no temporary account', async (kind) => {
    const { root, account, input } = await fixture();
    const auth = path.join(account, 'auth.json');
    if (['missing-auth', 'auth-symlink', 'auth-directory'].includes(kind)) await rm(auth);
    if (kind === 'auth-symlink') await symlink(path.join(account, 'config.toml'), auth);
    if (kind === 'auth-directory') await mkdir(auth, { mode: 0o700 });
    if (kind === 'public-auth') await chmod(auth, 0o644);
    if (kind === 'writable-home') await chmod(account, 0o770);
    if (kind === 'home-symlink') {
      const alias = path.join(root, 'alias');
      await symlink(account, alias);
      input.env.CODEX_HOME = alias;
    }
    const marker = path.join(root, 'started');
    input.args = ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'started')`, '--'];
    await expect(runIsolatedCodex(input)).rejects.toMatchObject({ code: 'executor-unavailable' });
    await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await readdir(account)).filter((name) => name.startsWith('.gcr-account-'))).toEqual([]);
  });

  it.each(['timeout', 'cancelled', 'output-limit', 'executable-unavailable'])(
    'removes the link after %s',
    async (kind) => {
      const { root, account, input } = await fixture();
      const marker = path.join(root, 'ready');
      const controller = new AbortController();
      const script = `require('fs').writeFileSync(${JSON.stringify(marker)},'ready');
        ${kind === 'output-limit' ? "process.stdout.write('x'.repeat(1000));" : ''}
        setInterval(()=>{},1000);`;
      const run = runIsolatedCodex({
        ...input,
        args: ['-e', script, '--'],
        signal: controller.signal,
        timeoutMs: kind === 'timeout' ? 1000 : 5000,
        outputBytes: 100,
        ...(kind === 'executable-unavailable' ? { command: path.join(root, 'missing') } : {}),
      });
      const result = run.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      if (kind === 'cancelled') {
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            await lstat(marker);
            ready = true;
            break;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        controller.abort();
        expect(ready).toBe(true);
      }
      expect(await result).toMatchObject({ error: { code: kind } });
      expect((await lstat(path.join(account, 'auth.json'))).nlink).toBe(1);
      expect((await readdir(account)).filter((name) => name.startsWith('.gcr-account-'))).toEqual(
        [],
      );
      expect(await readFile(path.join(account, 'auth.json'), 'utf8')).toBe('synthetic-account');
    },
  );
});

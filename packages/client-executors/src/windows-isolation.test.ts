import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { runIsolatedCodex } from './codex-isolation.js';
import { runManagedProcess } from './process.js';
import { codexAccountEnvironment } from './codex-config.js';

describe.skipIf(process.platform !== 'win32')('Windows execution boundary', () => {
  it('links only existing auth and removes its pathname after execution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'w01-isolation-'));
    const account = path.join(root, 'original');
    const cwd = path.join(root, 'run', 'cwd');
    await mkdir(account);
    await mkdir(cwd, { recursive: true });
    const auth = path.join(account, 'auth.json');
    await writeFile(auth, 'synthetic account');
    await writeFile(path.join(account, 'AGENTS.md'), 'GLOBAL_CANARY');
    await writeFile(path.join(account, 'AGENTS.override.md'), 'OVERRIDE_CANARY');
    const before = await stat(auth);
    try {
      const result = await runIsolatedCodex({
        command: process.execPath,
        args: [
          '-e',
          `const fs=require('fs'),p=require('path');const h=process.env.CODEX_HOME;console.log(JSON.stringify({home:h,auth:fs.readFileSync(p.join(h,'auth.json'),'utf8'),names:fs.readdirSync(h),links:fs.statSync(p.join(h,'auth.json')).nlink}));`,
          '--',
        ],
        cwd,
        env: { ...codexAccountEnvironment(), CODEX_HOME: account },
        stdin: '',
        timeoutMs: 5000,
      });
      expect(result.code).toBe(0);
      const observed = JSON.parse(result.stdout);
      expect(observed.auth).toBe('synthetic account');
      expect(observed.names).toEqual(['auth.json']);
      expect(observed.links).toBe(before.nlink + 1);
      await expect(stat(observed.home)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(auth, 'utf8')).toBe('synthetic account');
      expect((await stat(auth)).nlink).toBe(before.nlink);
      const alias = path.join(root, 'alias');
      await symlink(account, alias, 'junction');
      await expect(
        runIsolatedCodex({
          command: process.execPath,
          args: ['-e', 'process.exit(0)', '--'],
          cwd,
          env: { ...codexAccountEnvironment(), CODEX_HOME: alias },
          stdin: '',
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ code: 'insecure-storage' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps arguments literal and rejects shell wrappers', async () => {
    const args = ['한글 공백', 'a"b', 'tail\\', '& whoami', '$(secret)'];
    const result = await runManagedProcess({
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args],
      cwd: os.tmpdir(),
      env: codexAccountEnvironment(),
      stdin: '',
      timeoutMs: 5000,
    });
    expect(JSON.parse(result.stdout)).toEqual(args);
    for (const wrapper of ['fixture.cmd', 'fixture.bat'])
      await expect(
        runManagedProcess({
          command: path.join(os.tmpdir(), wrapper),
          args: [],
          cwd: os.tmpdir(),
          env: codexAccountEnvironment(),
          stdin: '',
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ code: 'executable-unavailable' });
  }, 15_000);

  it('kills child and grandchild when the owning Node process exits', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'w01-owner-'));
    const marker = path.join(root, 'ready.json');
    const independent = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    const childCode = `const {spawn}=require('node:child_process');const fs=require('node:fs');const g=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,g.pid]));setInterval(()=>{},1000);`;
    const executable = path.resolve('packages/client-core/dist/windows-native.exe');
    const request = {
      operation: 'process',
      command: process.execPath,
      args: ['-e', childCode],
      cwd: root,
      env: codexAccountEnvironment(),
      stdin: '',
      timeout: 15000,
      maximum: 4096,
    };
    const owner = spawn(
      process.execPath,
      [
        '-e',
        `const{spawn}=require('node:child_process');const fs=require('fs');const h=spawn(${JSON.stringify(executable)},[],{stdio:['pipe','ignore','ignore'],windowsHide:true});h.stdin.write(${JSON.stringify(JSON.stringify(request) + '\n')});const w=fs.watch(${JSON.stringify(root)},()=>{if(fs.existsSync(${JSON.stringify(marker)})){w.close();process.exit(0)}});`,
      ],
      {
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          owner.kill();
          reject(Error('Owner fixture timeout'));
        }, 10000);
        owner.on('exit', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(Error('Owner failed'));
        });
      });
      const pids: number[] = JSON.parse(await readFile(marker, 'utf8'));
      // A native wait on each process avoids treating a termination request as exit.
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `$pids=@(${pids
            .map((pid) => {
              if (!Number.isSafeInteger(pid) || pid < 1) throw Error('Invalid PID');
              return pid;
            })
            .join(
              ',',
            )}); $pids | ForEach-Object { $p=Get-Process -Id $_ -ErrorAction SilentlyContinue; if($p -and -not $p.WaitForExit(5000)){exit 1} }`,
        ],
        {
          windowsHide: true,
          stdio: 'pipe',
          timeout: 12000,
        },
      );
      for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
      expect(() => process.kill(independent.pid!, 0)).not.toThrow();
    } finally {
      owner.kill();
      independent.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 25_000);
});

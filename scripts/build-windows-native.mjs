import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') process.exit(0);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'packages/client-core/dist');
const source = path.join(root, 'packages/client-core/native/windows/Native.cs');
const framework = process.arch === 'arm64' ? 'FrameworkArm64' : 'Framework64';
const references = path.join(process.env.SystemRoot, 'Microsoft.NET', framework, 'v4.0.30319');
const sdk = execFileSync('dotnet', ['--list-sdks'], {
  encoding: 'utf8',
  windowsHide: true,
})
  .trim()
  .split(/\r?\n/)
  .filter((line) => /^8\./.test(line))
  .at(-1);
if (!sdk) throw Error('Building the Windows helper requires .NET SDK 8.');
const [, version, sdkRoot] = /^(\S+) \[(.+)\]$/.exec(sdk);
const compiler = path.join(sdkRoot, version, 'Roslyn/bincore/csc.dll');
await mkdir(output, { recursive: true });
// Never let a compiler truncate the helper used by a running consumer.
const stage = await mkdtemp(path.join(output, '.native-build-'));
const executable = path.join(stage, 'windows-native.exe');
try {
  execFileSync(
    'dotnet',
    [
      compiler,
      '/nologo',
      '/noconfig',
      '/nostdlib+',
      '/deterministic+',
      '/optimize+',
      '/platform:anycpu',
      '/target:exe',
      `/pathmap:${root}=/_/gcr`,
      ...['mscorlib', 'System', 'System.Core', 'System.Web.Extensions'].map(
        (name) => `/r:${path.join(references, name + '.dll')}`,
      ),
      `/out:${executable}`,
      source,
    ],
    { stdio: 'inherit', windowsHide: true },
  );
  const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
  await writeFile(
    path.join(stage, 'windows-native.json'),
    JSON.stringify(
      {
        version: '1.0.0',
        format: 'CLI AnyCPU / .NET Framework 4.x',
        buildArchitecture: process.arch,
        license: 'Apache-2.0',
        sha256: sha256(await readFile(executable)),
        sourceSha256: sha256(await readFile(source)),
      },
      null,
      2,
    ) + '\n',
  );
  await rename(executable, path.join(output, 'windows-native.exe'));
  await rename(path.join(stage, 'windows-native.json'), path.join(output, 'windows-native.json'));
} finally {
  await rm(stage, { recursive: true, force: true });
}

// Account selection and stdin/ephemeral CLI invocation derive from Commit Defender
// src/ai/providers.ts at 35575ad (Apache-2.0). The fixed-source harness is GCR-owned.
import { createHash } from 'node:crypto';
import { createReadStream, constants } from 'node:fs';
import { access, mkdtemp, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FixedSourceToolPort } from '@gcr/client-contract';
import {
  codexAccountEnvironment,
  codexReviewArgs,
  CODEX_REVIEW_MODEL,
  CODEX_REVIEW_EFFORT,
  reviewModelCatalog,
} from './codex-config.js';
import { probeCodexCatalog } from './catalog-probe.js';
import { ExecutorError, runManagedProcess } from './process.js';
import { fixedSourceTools, startSourceBridge } from './source-bridge.js';
import { runIsolatedCodex } from './codex-isolation.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
async function binaryHash(command: string): Promise<string> {
  const info = await stat(command);
  if (!info.isFile() || info.size > 512 * 1024 * 1024)
    throw new ExecutorError('executor-unavailable');
  const digest = createHash('sha256');
  for await (const bytes of createReadStream(command)) digest.update(bytes);
  return digest.digest('hex');
}
async function executablePath(value: string): Promise<string> {
  const candidates = value.includes(path.sep)
    ? [path.resolve(value)]
    : (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.join(directory, value));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return await realpath(candidate);
    } catch {
      /* Try only the explicitly selected command name. */
    }
  }
  throw new ExecutorError('executable-unavailable');
}

export interface CodexReviewRequest {
  prompt: string;
  source: FixedSourceToolPort;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Output schema constrains final JSON, not permissions or tool calls. */
  responseSchema?: Record<string, unknown>;
}
export interface CodexReviewResult {
  raw: string;
  model: typeof CODEX_REVIEW_MODEL;
  reasoningEffort: typeof CODEX_REVIEW_EFFORT;
  elapsedMs: number;
  usage?: { inputTokens: number; outputTokens: number; cachedInputTokens: number };
}

class CodexAccountExecutor {
  constructor(
    private readonly command: string,
    private readonly fingerprint: string,
    private readonly catalog: string,
    private readonly configHash: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}
  get descriptor() {
    return {
      id: 'codex-account',
      version: '0.153.4/gcr-fixed-source-v1',
      model: CODEX_REVIEW_MODEL,
      configHash: this.configHash,
      capabilities: {
        available: true,
        sourceIsolation: 'fixed-source-only' as const,
        cancellation: true,
        timeout: true,
        childProcessCleanup: true,
        outputTokenLimit: false,
      },
    };
  }
  async review(input: CodexReviewRequest): Promise<CodexReviewResult> {
    if (input.signal?.aborted) throw new ExecutorError('cancelled');
    if ((await binaryHash(this.command)) !== this.fingerprint)
      throw new ExecutorError('executor-unavailable');
    const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-codex-review-'));
    const started = performance.now();
    let bridge: Awaited<ReturnType<typeof startSourceBridge>> | undefined;
    try {
      const cwd = path.join(root, 'cwd');
      await mkdir(cwd, { mode: 0o700 });
      await writeFile(path.join(root, 'models.json'), this.catalog, { mode: 0o600 });
      bridge = await startSourceBridge(input.source);
      const args = codexReviewArgs(root, bridge.url);
      if (input.responseSchema) {
        const schema = JSON.stringify(input.responseSchema);
        if (Buffer.byteLength(schema) > 65_536) throw new ExecutorError('executor-unavailable');
        const file = path.join(root, 'response-schema.json');
        await writeFile(file, schema, { mode: 0o600 });
        args.push('--output-schema', file);
      }
      args.push('-');
      const response = await runIsolatedCodex({
        command: this.command,
        args,
        cwd,
        env: { ...this.environment, GCR_FIXED_SOURCE_TOKEN: bridge.token },
        stdin: input.prompt,
        timeoutMs: input.timeoutMs,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (response.code !== 0) throw new ExecutorError('process-failed');
      const events = response.stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const complete = events.filter((event) => event.type === 'turn.completed');
      if (
        complete.length !== 1 ||
        events.some((event) => event.type === 'turn.failed' || event.type === 'error')
      )
        throw new ExecutorError('invalid-response');
      const final = events
        .filter((event) => event.type === 'item.completed')
        .map((event) => event.item as Record<string, unknown>)
        .filter((item) => item?.type === 'agent_message')
        .at(-1);
      if (typeof final?.text !== 'string' || !final.text.trim())
        throw new ExecutorError('invalid-response');
      const usage = complete[0]?.usage as Record<string, unknown> | undefined;
      const counters = usage
        ? [usage.input_tokens, usage.output_tokens, usage.cached_input_tokens]
        : [];
      const validUsage =
        counters.length === 3 &&
        counters.every((value) => Number.isSafeInteger(value) && (value as number) >= 0);
      return {
        raw: final.text,
        model: CODEX_REVIEW_MODEL,
        reasoningEffort: CODEX_REVIEW_EFFORT,
        elapsedMs: Math.round(performance.now() - started),
        ...(validUsage
          ? {
              usage: {
                inputTokens: counters[0] as number,
                outputTokens: counters[1] as number,
                cachedInputTokens: counters[2] as number,
              },
            }
          : {}),
      };
    } catch (error) {
      if (error instanceof ExecutorError) throw error;
      throw new ExecutorError('invalid-response');
    } finally {
      try {
        await bridge?.close();
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
}
export type { CodexAccountExecutor };

/** The selected executable must pass a real tool-catalog probe before it is enabled.
 * No login, model, provider or executable fallback is attempted. */
export async function prepareCodexAccountExecutor(options: {
  executablePath?: string;
  model: string;
  reasoningEffort: string;
}): Promise<CodexAccountExecutor> {
  if (
    options.model !== CODEX_REVIEW_MODEL ||
    options.reasoningEffort !== CODEX_REVIEW_EFFORT ||
    process.platform !== 'darwin'
  )
    throw new ExecutorError('executor-unavailable');
  const command = await executablePath(options.executablePath ?? 'codex');
  const root = await mkdtemp(path.join(os.tmpdir(), 'gcr-codex-probe-'));
  try {
    const fingerprint = await binaryHash(command);
    const env = { PATH: '/usr/bin:/bin', HOME: root, CODEX_HOME: root };
    const version = await runManagedProcess({
      command,
      args: ['--version'],
      cwd: root,
      env,
      stdin: '',
      timeoutMs: 5000,
      outputBytes: 4096,
    });
    if (version.code !== 0 || version.stdout.trim() !== 'codex-cli 0.153.4')
      throw new ExecutorError('executor-unavailable');
    const bundled = await runManagedProcess({
      command,
      args: ['debug', 'models', '--bundled'],
      cwd: root,
      env,
      stdin: '',
      timeoutMs: 10_000,
      outputBytes: 2_097_152,
    });
    if (bundled.code !== 0) throw new ExecutorError('executor-unavailable');
    const catalog = reviewModelCatalog(bundled.stdout);
    await writeFile(path.join(root, 'models.json'), catalog, { mode: 0o600 });
    const tools = await probeCodexCatalog(command, root);
    if ((await binaryHash(command)) !== fingerprint)
      throw new ExecutorError('executor-unavailable');
    const environment = codexAccountEnvironment();
    const configHash = hash(
      JSON.stringify({
        version: 1,
        command,
        fingerprint,
        model: options.model,
        effort: options.reasoningEffort,
        catalogHash: hash(catalog),
        tools,
        toolDefinitions: fixedSourceTools,
        settings: codexReviewArgs('/gcr/run', 'http://127.0.0.1/source'),
        isolation: 'macos-global-instruction-deny-v1',
        authHome: environment.CODEX_HOME ?? path.join(os.homedir(), '.codex'),
      }),
    );
    return new CodexAccountExecutor(command, fingerprint, catalog, configHash, environment);
  } catch (error) {
    if (error instanceof ExecutorError) throw error;
    throw new ExecutorError('executor-unavailable');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

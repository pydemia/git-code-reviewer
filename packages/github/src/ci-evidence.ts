import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  githubCiCheckSchema,
  githubCiRunSchema,
  type GitHubCiCheck,
  type GitHubCiRun,
} from '@gcr/contracts';
import type { RepositoryTarget } from './index.js';
type Request = (url: URL, init: RequestInit) => Promise<Response>;
const sha = /^[a-f0-9]{40}$/;
const id = /^[1-9][0-9]{0,18}$/;
export interface GitHubCiReader {
  listValidationChecks(
    target: RepositoryTarget,
    headSha: string,
    name: string,
  ): Promise<GitHubCiCheck[]>;
  readValidationRun(target: RepositoryTarget, runId: string, attempt: number): Promise<GitHubCiRun>;
  readValidationWorkflowHash(
    target: RepositoryTarget,
    headSha: string,
    path: string,
  ): Promise<string>;
}
function url(target: RepositoryTarget, suffix: string): URL {
  return new URL(
    `repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}/${suffix}`,
    target.apiBaseUrl.replace(/\/?$/, '/'),
  );
}
async function json(request: Request, target: URL) {
  const response = await request(target, {
    method: 'GET',
    signal: AbortSignal.timeout(10000),
    redirect: 'error',
    headers: { 'cache-control': 'no-cache' },
  });
  if (response.status !== 200 || !response.body) throw Error('CI evidence response unavailable');
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > 2 * 1024 * 1024) throw Error('CI evidence response limit');
      buffers.push(part.value);
    }
    return JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(buffers)),
    ) as unknown;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
export function ciReader(targetRequest: Request): GitHubCiReader {
  return {
    async listValidationChecks(target, headSha, name) {
      if (!sha.test(headSha) || !name || name.length > 256) throw Error('Invalid CI check scope');
      const endpoint = url(target, `commits/${headSha}/check-runs`);
      endpoint.search = new URLSearchParams({
        check_name: name,
        filter: 'all',
        per_page: '100',
        page: '1',
      }).toString();
      const response = z
        .object({
          total_count: z.number().int().nonnegative(),
          check_runs: z.array(githubCiCheckSchema).max(100),
        })
        .parse(await json(targetRequest, endpoint));
      if (response.total_count !== response.check_runs.length)
        throw Error('Incomplete CI check discovery');
      if (new Set(response.check_runs.map((run) => run.id)).size !== response.check_runs.length)
        throw Error('Duplicate CI check identity');
      return response.check_runs;
    },
    async readValidationRun(target, runId, attempt) {
      if (!id.test(runId) || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 1000)
        throw Error('Invalid CI run scope');
      return githubCiRunSchema.parse(
        await json(targetRequest, url(target, `actions/runs/${runId}/attempts/${attempt}`)),
      );
    },
    async readValidationWorkflowHash(target, headSha, workflow) {
      if (!sha.test(headSha) || !/^\.github\/workflows\/[a-zA-Z0-9_.-]+\.ya?ml$/.test(workflow))
        throw Error('Invalid workflow scope');
      const endpoint = url(
        target,
        `contents/${workflow.split('/').map(encodeURIComponent).join('/')}`,
      );
      endpoint.searchParams.set('ref', headSha);
      const file = z
        .object({
          type: z.literal('file'),
          path: z.literal(workflow),
          encoding: z.literal('base64'),
          content: z.string().max(1500000),
          size: z
            .number()
            .int()
            .min(1)
            .max(1024 * 1024),
        })
        .parse(await json(targetRequest, endpoint));
      const encoded = file.content.replace(/\n/g, '');
      const bytes = Buffer.from(encoded, 'base64');
      if (bytes.toString('base64') !== encoded) throw Error('Invalid workflow encoding');
      if (bytes.length !== file.size) throw Error('Workflow content size mismatch');
      return createHash('sha256').update(bytes).digest('hex');
    },
  };
}

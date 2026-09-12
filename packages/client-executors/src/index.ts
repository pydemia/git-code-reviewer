import { CLIENT_CONTRACT_VERSION, type ClientPackageInfo } from '@gcr/client-contract';
export { prepareCodexAccountExecutor } from './codex.js';
export type { CodexAccountExecutor, CodexReviewRequest, CodexReviewResult } from './codex.js';
export { ExecutorError } from './process.js';

export const clientExecutorsPackage: ClientPackageInfo = Object.freeze({
  name: '@gcr/client-executors',
  version: '0.1.0-alpha.9',
  contractVersion: CLIENT_CONTRACT_VERSION,
});

import { CLIENT_CONTRACT_VERSION, type ClientPackageInfo } from '@gcr/client-contract';

export const clientCorePackage: ClientPackageInfo = Object.freeze({
  name: '@gcr/client-core',
  version: '0.1.0-alpha.31',
  contractVersion: CLIENT_CONTRACT_VERSION,
});

export * from './local-errors.js';
export * from './local-identity.js';
export * from './local-credentials.js';
export * from './local-records.js';
export * from './local-knowledge.js';
export * from './local-history.js';
export * from './source-policy.js';
export * from './source-snapshot.js';
export type { ReviewSourceView, FixedSourceLines } from './review-source.js';
export * from './builtin-review.js';
export * from './review-mode.js';
export * from './review-context.js';
export * from './review-policy.js';
export * from './review-source-port.js';
export * from './review-runner.js';
export * from './knowledge-signature.js';
export * from './central-binding.js';
export * from './central-cache.js';
export * from './knowledge-http.js';

export * from './central-selection.js';
export * from './central-connection.js';
export * from './knowledge-sync-loop.js';
export * from './review-execution.js';
export * from './review-requests.js';
export * from './automatic-scheduler.js';
export * from './automatic-source.js';
export * from './push-source.js';
export * from './service-jobs.js';
export * from './service-watch.js';
export * from './local-service.js';
export * from './review-conversations.js';
export * from './review-chat-runner.js';
export * from './review-submissions.js';
export * from './remote-review.js';
export * from './remote-review-source.js';
export * from './remote-review-context.js';

import { CLIENT_CONTRACT_VERSION, type ClientPackageInfo } from '@gcr/client-contract';

export const clientCorePackage: ClientPackageInfo = Object.freeze({
  name: '@gcr/client-core',
  version: '0.1.0-alpha.9',
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
export * from './builtin-review.js';
export * from './review-mode.js';
export * from './review-context.js';
export * from './review-policy.js';
export * from './review-source-port.js';
export * from './review-runner.js';

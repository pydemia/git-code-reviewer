import { CLIENT_CONTRACT_VERSION, type ClientPackageInfo } from '@gcr/client-contract';

export const clientCorePackage: ClientPackageInfo = Object.freeze({
  name: '@gcr/client-core',
  version: '0.1.0-alpha.4',
  contractVersion: CLIENT_CONTRACT_VERSION,
});

export * from './local-errors.js';
export * from './local-identity.js';
export * from './local-credentials.js';
export * from './local-records.js';
export * from './local-knowledge.js';
export * from './local-history.js';

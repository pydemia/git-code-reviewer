/** Increment only when readers must reject an incompatible contract. */
export const CLIENT_CONTRACT_VERSION = 1 as const;

export * from './identity.js';
export * from './knowledge.js';
export * from './review.js';
export { ContractError, sourcePath } from './codec.js';

export interface ClientPackageInfo {
  readonly name: string;
  readonly version: string;
  readonly contractVersion: number;
}

export const clientContractPackage: ClientPackageInfo = Object.freeze({
  name: '@gcr/client-contract',
  version: '0.1.0-alpha.9',
  contractVersion: CLIENT_CONTRACT_VERSION,
});
export * from './legacy.js';
export * from './executor.js';
export * from './local-review-response.js';

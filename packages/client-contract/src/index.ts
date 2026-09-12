/** Increment only when readers must reject an incompatible contract. */
export const CLIENT_CONTRACT_VERSION = 1 as const;

export type ClientMode = 'standalone' | 'centralized';

export interface ClientPackageInfo {
  readonly name: string;
  readonly version: string;
  readonly contractVersion: number;
}

export const clientContractPackage: ClientPackageInfo = Object.freeze({
  name: '@gcr/client-contract',
  version: '0.1.0-alpha.1',
  contractVersion: CLIENT_CONTRACT_VERSION,
});

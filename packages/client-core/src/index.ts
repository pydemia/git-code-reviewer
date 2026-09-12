import { CLIENT_CONTRACT_VERSION, type ClientPackageInfo } from '@gcr/client-contract';

export const clientCorePackage: ClientPackageInfo = Object.freeze({
  name: '@gcr/client-core',
  version: '0.1.0-alpha.2',
  contractVersion: CLIENT_CONTRACT_VERSION,
});

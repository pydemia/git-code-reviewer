export type LocalStoreErrorCode =
  | 'unsupported-platform'
  | 'credential-unavailable'
  | 'storage-unavailable'
  | 'insecure-storage'
  | 'corrupt-storage'
  | 'revision-conflict'
  | 'commit-unknown'
  | 'record-too-large'
  | 'store-closed';

/** Messages must not contain credentials, decrypted data or child-process output. */
export class LocalStoreError extends Error {
  constructor(
    readonly code: LocalStoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LocalStoreError';
  }
}
export const errorCode = (error: unknown): string | undefined =>
  error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;

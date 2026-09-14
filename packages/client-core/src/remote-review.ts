import { createHash } from 'node:crypto';
import {
  REMOTE_REVIEW_MAX_BYTES,
  remoteReviewPayload,
  remoteReviewRequest,
  type CentralAudience,
  type RemoteReviewPayload,
  type RemoteReviewRequest,
  type SourceFile,
} from '@gcr/client-contract';
import { canonicalJson, contentHash } from './local-identity.js';
import { sourcePathPolicy } from './source-policy.js';
import type { LocalSourceSnapshot } from './source-snapshot.js';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export class RemoteReviewValidationError extends Error {
  constructor(
    readonly code:
      'invalid-upload' | 'approval-mismatch' | 'audience-mismatch' | 'approval-expired',
  ) {
    super(code);
    this.name = 'RemoteReviewValidationError';
  }
}

/** Validate transmitted bytes independently of the client's claimed Git snapshot hash.
 * No checkout, Git command, filesystem read, credential discovery or model call occurs here. */
export function validateRemoteReviewPayload(input: unknown): RemoteReviewPayload {
  try {
    canonicalJson(input, REMOTE_REVIEW_MAX_BYTES);
    const payload = remoteReviewPayload(input);
    const excluded = sourcePathPolicy();
    for (const file of payload.source.files) {
      const { metadata, text } = file;
      const bytes = Buffer.from(text, 'utf8');
      if (
        excluded(metadata.path) ||
        bytes.length > 2 * 1024 * 1024 ||
        text.includes('\0') ||
        bytes.toString('utf8') !== text ||
        bytes.length !== metadata.byteLength ||
        text.split('\n').length !== metadata.lineCount ||
        hash(text) !== metadata.hash
      )
        throw Error('invalid-upload');
      if (metadata.gitBlob) {
        const oid = createHash(payload.source.snapshot.objectFormat)
          .update(`blob ${bytes.length}\0`)
          .update(bytes)
          .digest('hex');
        if (oid !== metadata.gitBlob) throw Error('invalid-upload');
      }
    }
    for (const document of payload.context.documents) {
      if (
        hash(document.text) !== document.hash ||
        Buffer.from(document.text, 'utf8').toString('utf8') !== document.text
      )
        throw Error('invalid-upload');
    }
    return payload;
  } catch {
    // Contract paths can contain client-controlled field names. Never surface them as API errors.
    throw new RemoteReviewValidationError('invalid-upload');
  }
}

/** Build the reviewable proposal from a frozen view and an exact list of approved file sides.
 * Diff text, branch names, local paths, remotes and excluded file names are not uploaded. */
export function prepareRemoteReview(
  input: Omit<RemoteReviewPayload, 'source'> & {
    snapshot: LocalSourceSnapshot;
    sourceFiles: readonly SourceFile[];
  },
): { payload: RemoteReviewPayload; payloadHash: string; bytes: number } {
  const { snapshot, sourceFiles, ...fields } = input;
  if (
    snapshot.repository.repositoryKey !== fields.client.repositoryKey ||
    snapshot.repository.worktreeKey !== fields.client.worktreeKey
  )
    throw new RemoteReviewValidationError('invalid-upload');
  const files = sourceFiles
    .map((metadata) => {
      const file = snapshot.readFile(metadata.path, metadata.side);
      if (file.status !== 'available' || contentHash(file.source) !== contentHash(metadata))
        throw new RemoteReviewValidationError('invalid-upload');
      return { metadata, text: file.text };
    })
    .sort((a, b) => {
      const left = `${a.metadata.side}:${a.metadata.path}`,
        right = `${b.metadata.side}:${b.metadata.path}`;
      return left < right ? -1 : left > right ? 1 : 0;
    });
  const payload = validateRemoteReviewPayload({
    ...fields,
    source: {
      provenance: 'client-captured',
      snapshot: snapshot.identity,
      files,
      selected: snapshot.selected.map(({ path, side }) => ({ path, side })),
    },
  });
  const json = canonicalJson(payload, REMOTE_REVIEW_MAX_BYTES);
  return { payload, payloadHash: hash(json), bytes: Buffer.byteLength(json) };
}

/** Both client submission and server intake use this check. An approval is supplied by the host;
 * preparing a proposal does not issue it. A payload edit always requires a new approval. */
export function validateRemoteReviewRequest(
  input: unknown,
  expected: {
    audience: CentralAudience;
    clientId: RemoteReviewPayload['clientId'];
  },
): RemoteReviewRequest {
  let request: RemoteReviewRequest;
  try {
    canonicalJson(input, REMOTE_REVIEW_MAX_BYTES + 1024);
    request = remoteReviewRequest(input);
  } catch {
    throw new RemoteReviewValidationError('invalid-upload');
  }
  request.payload = validateRemoteReviewPayload(request.payload);
  if (request.approval.payloadHash !== contentHash(request.payload))
    throw new RemoteReviewValidationError('approval-mismatch');
  if (
    request.payload.clientId !== expected.clientId ||
    (['serverId', 'tenantId', 'userId', 'repositoryId'] as const).some(
      (key) => request.payload.audience[key] !== expected.audience[key],
    )
  )
    throw new RemoteReviewValidationError('audience-mismatch');
  return request;
}

/** Only new admission checks freshness. An idempotent lookup must remain possible after expiry. */
export function assertFreshRemoteReviewApproval(
  request: RemoteReviewRequest,
  now = Date.now(),
): void {
  const age = now - Date.parse(request.approval.approvedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > 300_000)
    throw new RemoteReviewValidationError('approval-expired');
}

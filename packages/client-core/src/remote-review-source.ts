import { sourcePath, type RemoteReviewPayload, type SourceFile } from '@gcr/client-contract';
import { fixedSourceLines, type FixedSourceRead, type ReviewSourceView } from './review-source.js';
import { RemoteReviewValidationError, validateRemoteReviewPayload } from './remote-review.js';
import { SourceCaptureError, sourcePathPolicy } from './source-policy.js';

/** Bytes approved by the uploading client. Snapshot hashes/OIDs are not server Git attestations. */
class RemoteReviewSource implements ReviewSourceView {
  #source: RemoteReviewPayload['source'];
  #repository: ReviewSourceView['repository'];
  #files: Map<string, { metadata: SourceFile; text: string }>;
  #closed = false;
  constructor(payload: RemoteReviewPayload) {
    this.#source = structuredClone(payload.source);
    this.#repository = {
      repositoryKey: payload.client.repositoryKey,
      worktreeKey: payload.client.worktreeKey,
    };
    this.#files = new Map(
      this.#source.files.map((file) => [`${file.metadata.side}:${file.metadata.path}`, file]),
    );
  }
  private open() {
    if (this.#closed) throw new SourceCaptureError('snapshot-closed');
  }
  get identity() {
    this.open();
    return structuredClone(this.#source.snapshot);
  }
  get repository() {
    this.open();
    return { ...this.#repository };
  }
  // Branch/HEAD observations are not part of the approved transfer.
  get headCommit() {
    this.open();
    return null;
  }
  get branchName() {
    this.open();
    return null;
  }
  get selected() {
    this.open();
    return this.#source.review!.changes.map((change) => ({
      path: change.path,
      side: change.side,
      status: change.status,
      ...(change.oldPath === undefined ? {} : { oldPath: change.oldPath }),
    }));
  }
  get sourceFiles() {
    this.open();
    return [...this.#files.values()].map((file) => structuredClone(file.metadata));
  }
  get limitations() {
    this.open();
    return this.#source
      .review!.changes.filter((change) => change.base === 'unavailable')
      .map((change) => ({
        path: change.oldPath ?? change.path,
        side: 'base' as const,
        reason: 'unsupported-source' as const,
        detail: 'Base content is not included in the approved upload.',
      }));
  }
  get incomplete() {
    this.open();
    return this.#source.review!.incomplete;
  }
  readFile(file: string, side: 'source' | 'base' = 'source'): FixedSourceRead {
    this.open();
    sourcePath(file);
    if (side !== 'source' && side !== 'base')
      throw new SourceCaptureError('invalid-source-request');
    const found = this.#files.get(`${side}:${file}`);
    if (found)
      return { status: 'available', source: structuredClone(found.metadata), text: found.text };
    const denied = sourcePathPolicy()(file);
    if (denied) return { status: 'unavailable', reason: denied, detail: denied };
    const changes = this.#source.review!.changes;
    if (
      changes.some((change) =>
        side === 'base'
          ? (change.oldPath ?? change.path) === file && change.base === 'absent'
          : change.path === file && change.status === 'D',
      )
    )
      return { status: 'absent' };
    return {
      status: 'unavailable',
      reason: 'unsupported-source',
      detail: 'Source is outside the approved upload.',
    };
  }
  readLines(
    file: string,
    side: 'source' | 'base' = 'source',
    startLine = 1,
    endLine = startLine + 159,
  ) {
    return fixedSourceLines(this.readFile(file, side), startLine, endLine);
  }
  close() {
    this.#files.clear();
    this.#source.files = [];
    this.#closed = true;
  }
}

/** Call after validating the job's exact approval and authenticated audience. No source is fetched. */
export function restoreRemoteReviewSource(input: unknown): RemoteReviewSource {
  const payload = validateRemoteReviewPayload(input);
  if (!payload.source.review) throw new RemoteReviewValidationError('invalid-upload');
  return new RemoteReviewSource(payload);
}

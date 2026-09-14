import { createHash } from 'node:crypto';
import type { SnapshotIdentity, SourceFile } from '@gcr/client-contract';
import { SourceCaptureError, type SourceExclusionReason } from './source-policy.js';

type Side = 'base' | 'source';
export interface SourceLimitation {
  path: string;
  side: Side;
  reason: SourceExclusionReason;
  detail: string;
}
export interface SourceChange {
  path: string;
  oldPath?: string;
  status: 'A' | 'M' | 'D' | 'R' | 'T';
  side: Side;
}
export type FixedSourceRead =
  | { status: 'available'; source: SourceFile; text: string }
  | { status: 'absent' }
  | { status: 'unavailable'; reason: SourceExclusionReason; detail: string };
export type FixedSourceLines =
  | Exclude<FixedSourceRead, { status: 'available' }>
  | {
      status: 'available';
      source: SourceFile;
      text: string;
      startLine: number;
      endLine: number;
      excerptHash: string;
      truncated: boolean;
    };

/** Read-only review input. A transmitted view need not possess a Git checkout or a restorable tree. */
export interface ReviewSourceView {
  readonly identity: SnapshotIdentity;
  readonly repository: { repositoryKey: string; worktreeKey: string };
  readonly headCommit: string | null;
  readonly branchName: string | null;
  readonly selected: SourceChange[];
  readonly sourceFiles: SourceFile[];
  readonly limitations: SourceLimitation[];
  /** Capture failures can be disclosed without transmitting excluded filenames. */
  readonly incomplete: boolean;
  readFile(file: string, side?: Side): FixedSourceRead;
  readLines(file: string, side?: Side, startLine?: number, endLine?: number): FixedSourceLines;
}

export function fixedSourceLines(
  result: FixedSourceRead,
  startLine: number,
  endLine: number,
): FixedSourceLines {
  if (
    !Number.isSafeInteger(startLine) ||
    !Number.isSafeInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine
  )
    throw new SourceCaptureError('invalid-source-request');
  if (result.status !== 'available') return result;
  const lines = result.text.split('\n');
  if (startLine > lines.length) throw new SourceCaptureError('invalid-source-request');
  const end = Math.min(endLine, startLine + 199, lines.length);
  const full = lines.slice(startLine - 1, end).join('\n');
  const text = full.slice(0, 24_000);
  return {
    status: 'available',
    source: result.source,
    startLine,
    endLine: startLine + text.split('\n').length - 1,
    text,
    excerptHash: createHash('sha256').update(text).digest('hex'),
    truncated: text.length !== full.length || end < Math.min(endLine, lines.length),
  };
}

import { SourceGit } from './source-git.js';
import { SourceCaptureError } from './source-policy.js';
import type { CaptureSourceOptions } from './source-snapshot.js';

export interface PushRefInput {
  localRef: string;
  localOid: string;
  remoteRef: string;
  remoteOid: string;
}
export interface PushRefSource extends PushRefInput {
  status: 'ready' | 'ref-deleted' | 'unchanged' | 'unsupported';
  action?: 'create' | 'fast-forward' | 'force-update';
  reason?: 'invalid-ref' | 'missing-or-noncommit-object';
  capture?: CaptureSourceOptions;
}
/** Parse the complete pre-push stream before resolving or reviewing any ref. */
export function parsePrePush(input: string, format: 'sha1' | 'sha256'): PushRefInput[] {
  if (
    !['sha1', 'sha256'].includes(format) ||
    typeof input !== 'string' ||
    Buffer.byteLength(input) > 262144 ||
    /[\0\r]/.test(input)
  )
    throw new SourceCaptureError('invalid-source-request');
  const lines = input === '' ? [] : input.replace(/\n$/, '').split('\n');
  if (lines.length > 64) throw new SourceCaptureError('capture-limit');
  const oid = format === 'sha1' ? /^[a-f0-9]{40}$/ : /^[a-f0-9]{64}$/;
  const seen = new Set<string>();
  return lines.map((line) => {
    const parts = line.split(' ');
    if (
      parts.length !== 4 ||
      parts.some(
        (part) =>
          !part ||
          part.length > 1024 ||
          [...part].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127),
      )
    )
      throw new SourceCaptureError('invalid-source-request');
    const [localRef, localOid, remoteRef, remoteOid] = parts as [string, string, string, string];
    if (
      !oid.test(localOid) ||
      !oid.test(remoteOid) ||
      !remoteRef.startsWith('refs/') ||
      seen.has(remoteRef) ||
      /^0+$/.test(localOid) !== (localRef === '(delete)') ||
      (/^0+$/.test(localOid) && /^0+$/.test(remoteOid))
    )
      throw new SourceCaptureError('invalid-source-request');
    seen.add(remoteRef);
    return { localRef, localOid, remoteRef, remoteOid };
  });
}
/** No fetch, checkout, hook invocation or use of the mutable local ref to select source. */
export function resolvePrePush(cwd: string, input: string, excludePatterns: string[] = []) {
  const git = new SourceGit(cwd, Date.now() + 30000, null);
  try {
    const refs = parsePrePush(input, git.objectFormat);
    const resolved: PushRefSource[] = refs.map((ref) => {
      try {
        git.text(['check-ref-format', ref.remoteRef]);
      } catch {
        return { ...ref, status: 'unsupported', reason: 'invalid-ref' };
      }
      if (/^0+$/.test(ref.localOid)) return { ...ref, status: 'ref-deleted' };
      if (ref.localOid === ref.remoteOid) return { ...ref, status: 'unchanged' };
      try {
        const peel = (oid: string) =>
          git.oid(git.text(['rev-parse', '--verify', `${git.oid(oid)}^{commit}`]).trim());
        const sourceCommit = peel(ref.localOid);
        const baseCommit = /^0+$/.test(ref.remoteOid) ? null : peel(ref.remoteOid);
        const ancestor = baseCommit
          ? git.text(['merge-base', baseCommit, sourceCommit], undefined, undefined, [0, 1]).trim()
          : null;
        return {
          ...ref,
          status: 'ready',
          action:
            baseCommit === null
              ? 'create'
              : ancestor === baseCommit
                ? 'fast-forward'
                : 'force-update',
          capture: {
            cwd: git.root,
            kind: 'commit-tree',
            sourceCommit,
            baseCommit,
            ...(ref.remoteRef.startsWith('refs/heads/')
              ? { targetBranch: ref.remoteRef.slice('refs/heads/'.length) }
              : {}),
            excludePatterns,
          },
        };
      } catch {
        return { ...ref, status: 'unsupported', reason: 'missing-or-noncommit-object' };
      }
    });
    return { objectFormat: git.objectFormat, refs: resolved };
  } finally {
    git.close();
  }
}

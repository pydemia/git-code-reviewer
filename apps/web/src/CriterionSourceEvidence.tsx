import type { criterionSourceSchema } from '@gcr/contracts';
import type { z } from 'zod';

export function CriterionSourceEvidence({
  source,
}: {
  source: z.infer<typeof criterionSourceSchema>;
}) {
  const change = source.codeChange;
  if (!change) return source.headSha ? <small>Commit {source.headSha}</small> : null;
  return (
    <span className="criteria-code-source">
      <small>
        PR #{change.pullRequestNumber} · {change.previousPath ? `${change.previousPath} → ` : ''}
        {change.path} · {change.status}
      </small>
      <small>변경 전 (merge base) {change.mergeBaseSha}</small>
      <small>변경 후 {change.headSha}</small>
      <small>
        대상 브랜치 {change.baseSha} · Snapshot {change.snapshotId}
      </small>
      <small>변경 부분의 diff입니다. 파일 전체 문맥과 실행 검증 결과는 포함하지 않습니다.</small>
    </span>
  );
}

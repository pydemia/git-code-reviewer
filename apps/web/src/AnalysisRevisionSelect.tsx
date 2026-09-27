import type { AnalysisRevision } from './api.ts';

const stateLabels: Record<string, string> = {
  queued: '분석 대기',
  analyzing: '분석 중',
  completed: '분석 완료',
  partial: '일부 검토',
  failed: '실패',
  cancelled: '취소',
};

function analysisRevisionLabel(analysis: AnalysisRevision) {
  const scope = analysis.revisionScope === 'personal' ? '개인 ' : '';
  // Older servers do not supply the PR sequence; do not mislabel snapshot revision as PR history.
  return analysis.pullRevision
    ? `${scope}Revision ${analysis.pullRevision}`
    : `${scope}Snapshot revision ${analysis.revision ?? '-'}`;
}

export function AnalysisRevisionSelect({
  analyses,
  current,
}: {
  analyses: AnalysisRevision[];
  current: AnalysisRevision | null;
}) {
  const options = analyses.filter((item) => item.id);
  const latest = options[0];
  if (current?.id && !options.some((item) => item.id === current.id)) options.push(current);
  return (
    <>
      {latest && current?.id && latest.id !== current.id ? (
        <a className="latest-revision-link" href={`/reviews/${latest.id}`}>
          최신 {analysisRevisionLabel(latest)} 보기
        </a>
      ) : null}
      <select
        className="revision-button"
        aria-label="분석 revision 선택"
        value={current?.id ?? ''}
        disabled={!options.length}
        onChange={(event) => {
          const selected = options.find((item) => item.id === event.target.value);
          if (selected?.id) window.location.assign(`/reviews/${selected.id}`);
        }}
      >
        {!current?.id ? <option value="">Revision —</option> : null}
        {options.map((item) => (
          <option key={item.id} value={item.id!}>
            {analysisRevisionLabel(item)} · {item.headSha.slice(0, 8)} ·{' '}
            {stateLabels[item.state ?? ''] ?? item.state ?? '준비 중'}
          </option>
        ))}
      </select>
    </>
  );
}

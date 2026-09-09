import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import type { PullRequestStateFilter } from '@gcr/contracts';

export function PullRequestFilters({
  value,
  counts,
  onChange,
}: {
  value: PullRequestStateFilter;
  counts: Record<PullRequestStateFilter, number> | null;
  onChange: (value: PullRequestStateFilter) => void;
}) {
  return (
    <div className="filter-bar" role="group" aria-label="PR 상태 필터">
      {(['open', 'closed', 'all'] as const).map((state) => (
        <button
          key={state}
          type="button"
          className={`filter-button${value === state ? ' active' : ''}`}
          aria-pressed={value === state}
          onClick={() => onChange(state)}
          aria-describedby={state === 'closed' ? 'closed-filter-help' : undefined}
        >
          {state === 'open' ? 'Open' : state === 'closed' ? 'Closed' : 'All'}
          <span>{counts?.[state] ?? '–'}</span>
        </button>
      ))}
    </div>
  );
}

export function PullRequestState({
  state,
  draft,
  mergedAt,
}: {
  state: 'open' | 'closed';
  draft: boolean;
  mergedAt?: string | null;
}) {
  const label =
    state === 'open' ? (draft ? 'Open · Draft' : 'Open') : mergedAt ? 'Merged' : 'Closed';
  const Icon = state === 'open' ? GitPullRequest : mergedAt ? GitMerge : GitPullRequestClosed;
  return (
    <span className={`pull-state ${state === 'open' ? 'open' : mergedAt ? 'merged' : 'closed'}`}>
      <Icon size={14} aria-hidden="true" />
      {label}
    </span>
  );
}

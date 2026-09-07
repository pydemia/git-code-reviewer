import { Fragment, useEffect, useMemo, useRef } from 'react';
import type { WorkspaceData } from './api.ts';
import { parseReviewDiff, splitReviewDiff, type DiffLine } from './review-diff.ts';
import { priorityLabels } from './review-diff.ts';
import { ReviewText } from './ReviewReportPanel.tsx';

type Finding = NonNullable<WorkspaceData['report']>['findings'][number];
export type CodeTarget = {
  fileId: string;
  side: 'mergeBase' | 'head';
  startLine?: number | undefined;
  endLine?: number | undefined;
  request: number;
};

export function ReviewDiff({
  patch,
  fileId,
  mode,
  target,
  finding,
}: {
  patch: string;
  fileId: string;
  mode: 'split' | 'unified';
  target: CodeTarget | null;
  finding?: Finding | undefined;
}) {
  const lines = useMemo(() => parseReviewDiff(patch), [patch]);
  const rows = useMemo(
    () =>
      mode === 'split' ? splitReviewDiff(lines) : lines.map((line) => ({ base: line, head: line })),
    [lines, mode],
  );
  const container = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLDivElement>(null);
  const active = target?.fileId === fileId ? target : null;
  const side = active?.side === 'mergeBase' ? 'base' : 'head';
  const found =
    active?.startLine !== undefined && lines.some((line) => line[side] === active.startLine);
  useEffect(() => {
    const panel = container.current;
    if (!panel) return;
    const row = selected.current;
    panel.scrollTop = row
      ? Math.max(
          0,
          panel.scrollTop +
            row.getBoundingClientRect().top -
            panel.getBoundingClientRect().top -
            64,
        )
      : 0;
  }, [target, mode, patch]);
  const cell = (line: DiffLine | null, column: 'base' | 'head') => (
    <div className={`review-code-cell ${line?.kind ?? 'placeholder'}`}>
      <i>{line?.[column] ?? ''}</i>
      <span className="diff-sign">
        {line?.kind === 'added' ? '+' : line?.kind === 'removed' ? '−' : ''}
      </span>
      <code>{line?.content || ' '}</code>
    </div>
  );
  return (
    <div
      className={`review-diff ${mode}`}
      ref={container}
      tabIndex={0}
      aria-label="Snapshot 코드 diff"
    >
      <div className="review-diff-labels">
        <span>{mode === 'split' ? 'MERGE BASE' : 'MERGE BASE → HEAD'}</span>
        {mode === 'split' ? <span>HEAD</span> : null}
      </div>
      {active && !found ? (
        <div className="code-location-notice" role="status">
          {active.startLine
            ? `요청한 ${active.side} line ${active.startLine}은 이 diff에 없습니다. 아래 설명과 GHES 원문을 확인하세요.`
            : '파일 전체에 대한 설명입니다. 특정 line에 연결되지 않았습니다.'}
          {finding ? <InlineReview finding={finding} /> : null}
        </div>
      ) : null}
      {rows.map((row, index) => {
        const line = row[side];
        const anchored = Boolean(found && line?.[side] === active?.startLine);
        const highlighted = Boolean(
          found &&
          line?.[side] != null &&
          line[side]! >= active!.startLine! &&
          line[side]! <= (active!.endLine ?? active!.startLine!),
        );
        return (
          <Fragment key={index}>
            <div
              className={`review-code-row${highlighted ? ' selected-line' : ''}`}
              ref={anchored ? selected : undefined}
              data-selected-line={anchored ? active?.startLine : undefined}
            >
              {mode === 'split' ? (
                <>
                  {cell(row.base, 'base')}
                  {cell(row.head, 'head')}
                </>
              ) : (
                <div className={`review-code-cell unified-cell ${row.head!.kind}`}>
                  <i>{row.head!.base ?? ''}</i>
                  <i>{row.head!.head ?? ''}</i>
                  <span className="diff-sign">
                    {row.head!.kind === 'added' ? '+' : row.head!.kind === 'removed' ? '−' : ''}
                  </span>
                  <code>{row.head!.content || ' '}</code>
                </div>
              )}
            </div>
            {anchored && finding ? <InlineReview finding={finding} /> : null}
          </Fragment>
        );
      })}
      {!lines.length ? (
        <div className="code-location-notice">표시할 text diff가 없습니다.</div>
      ) : null}
    </div>
  );
}

function InlineReview({ finding }: { finding: Finding }) {
  return (
    <article className="inline-review" aria-label="선택한 Review comment">
      <header>
        <strong className={`review-priority priority-${finding.priority.toLowerCase()}`}>
          {priorityLabels[finding.priority]}
        </strong>
        <span>{finding.category}</span>
        <span>{finding.anchor.startLine ? `line ${finding.anchor.startLine}` : '파일 전체'}</span>
      </header>
      <h3>
        <ReviewText text={finding.title} />
      </h3>
      {finding.problem !== finding.title ? (
        <p>
          <ReviewText text={finding.problem} />
        </p>
      ) : null}
      {finding.impact ? (
        <p>
          <b>영향</b> <ReviewText text={finding.impact} />
        </p>
      ) : null}
      {finding.recommendation ? (
        <p>
          <b>수정 제안</b> <ReviewText text={finding.recommendation} />
        </p>
      ) : null}
    </article>
  );
}

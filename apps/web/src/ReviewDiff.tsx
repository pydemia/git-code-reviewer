import { Fragment, useEffect, useMemo, useRef } from 'react';
import { MessageSquare } from 'lucide-react';
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
  findings = [],
}: {
  patch: string;
  fileId: string;
  mode: 'split' | 'unified';
  target: CodeTarget | null;
  finding?: Finding | undefined;
  findings?: Finding[];
}) {
  const lines = useMemo(() => parseReviewDiff(patch), [patch]);
  const rows = useMemo(
    () =>
      mode === 'split' ? splitReviewDiff(lines) : lines.map((line) => ({ base: line, head: line })),
    [lines, mode],
  );
  const container = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLDivElement>(null);
  const fileFindings = useMemo(
    () => findings.filter((item) => item.anchor.fileId === fileId),
    [findings, fileId],
  );
  const rowFindings = useMemo(() => {
    const byRow = new Map<number, Finding[]>();
    const unanchored: Finding[] = [];
    for (const item of fileFindings) {
      const column = item.anchor.side === 'mergeBase' ? 'base' : 'head';
      const index =
        item.anchor.startLine === undefined
          ? -1
          : rows.findIndex((row) => row[column]?.[column] === item.anchor.startLine);
      if (index < 0) unanchored.push(item);
      else byRow.set(index, [...(byRow.get(index) ?? []), item]);
    }
    return { byRow, unanchored };
  }, [fileFindings, rows]);
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
  const marker = (items: Finding[], column: 'base' | 'head') => {
    const comments = items.filter(
      (item) => item.anchor.side === (column === 'base' ? 'mergeBase' : 'head'),
    );
    const first = comments[0];
    return (
      <span className="line-comment-gutter">
        {first ? (
          <button
            type="button"
            className="line-comment-marker"
            aria-label={`${column === 'base' ? '이전 코드' : '변경 코드'} line ${first.anchor.startLine} · 검토 의견 ${comments.length}개`}
            aria-controls={`review-comment-${first.id}`}
            onClick={() => {
              const comment = document.getElementById(`review-comment-${first.id}`);
              comment?.focus({ preventScroll: true });
              comment?.scrollIntoView({ block: 'nearest' });
            }}
          >
            <MessageSquare size={14} aria-hidden="true" />
            {comments.length > 1 ? <small>{comments.length}</small> : null}
          </button>
        ) : null}
      </span>
    );
  };
  const cell = (line: DiffLine | null, column: 'base' | 'head', items: Finding[]) => (
    <div className={`review-code-cell ${line?.kind ?? 'placeholder'}`}>
      {marker(items, column)}
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
          {finding && !fileFindings.some((item) => item.id === finding.id) ? (
            <InlineReview finding={finding} anchored={false} />
          ) : null}
        </div>
      ) : null}
      {rows.map((row, index) => {
        const comments = rowFindings.byRow.get(index) ?? [];
        const line = row[side];
        const anchored = Boolean(found && line?.[side] === active?.startLine);
        return (
          <Fragment key={index}>
            <div
              className={`review-code-row${anchored ? ' selected-line' : ''}`}
              ref={anchored ? selected : undefined}
              data-selected-line={anchored ? active?.startLine : undefined}
            >
              {mode === 'split' ? (
                <>
                  {cell(row.base, 'base', comments)}
                  {cell(row.head, 'head', comments)}
                </>
              ) : (
                <div className={`review-code-cell unified-cell ${row.head!.kind}`}>
                  {marker(comments, 'base')}
                  <i>{row.head!.base ?? ''}</i>
                  {marker(comments, 'head')}
                  <i>{row.head!.head ?? ''}</i>
                  <span className="diff-sign">
                    {row.head!.kind === 'added' ? '+' : row.head!.kind === 'removed' ? '−' : ''}
                  </span>
                  <code>{row.head!.content || ' '}</code>
                </div>
              )}
            </div>
            {comments.map((item) => (
              <InlineReview key={item.id} finding={item} />
            ))}
            {anchored && finding && !fileFindings.some((item) => item.id === finding.id) ? (
              <InlineReview finding={finding} />
            ) : null}
          </Fragment>
        );
      })}
      {!lines.length ? (
        <div className="code-location-notice">표시할 text diff가 없습니다.</div>
      ) : null}
      {rowFindings.unanchored.map((item) => (
        <InlineReview key={item.id} finding={item} anchored={false} />
      ))}
    </div>
  );
}

function InlineReview({ finding, anchored = true }: { finding: Finding; anchored?: boolean }) {
  return (
    <article
      className={`inline-review priority-border-${finding.priority.toLowerCase()}`}
      id={`review-comment-${finding.id}`}
      tabIndex={-1}
      aria-label="줄별 검토 의견"
      data-finding-id={finding.id}
      data-side={finding.anchor.side}
      data-anchored={anchored && finding.anchor.startLine !== undefined}
    >
      <header>
        <MessageSquare size={16} aria-hidden="true" />
        <strong className={`review-priority priority-${finding.priority.toLowerCase()}`}>
          {priorityLabels[finding.priority]}
        </strong>
        <span>{finding.category}</span>
        <span>
          {finding.anchor.side === 'mergeBase' ? '이전 코드' : '변경 코드'} ·{' '}
          {finding.anchor.startLine
            ? `line ${finding.anchor.startLine}${finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine ? `–${finding.anchor.endLine}` : ''}`
            : '파일 전체'}
        </span>
      </header>
      <h3>
        <ReviewText text={finding.title} />
      </h3>
      {!anchored && finding.anchor.startLine !== undefined ? (
        <p className="inline-review-location-note">
          이 line은 현재 diff에 포함되지 않습니다. Comments의 GHES 원문에서 확인하세요.
        </p>
      ) : null}
      {finding.problem !== finding.title ? (
        <p>
          <ReviewText text={finding.problem} />
        </p>
      ) : null}
      {finding.impact ? (
        <div className="inline-review-detail">
          <b>영향</b>
          <p>
            <ReviewText text={finding.impact} />
          </p>
        </div>
      ) : null}
      {finding.recommendation ? (
        <div className="inline-review-detail inline-review-recommendation">
          <b>수정 제안</b>
          <p>
            <ReviewText text={finding.recommendation} />
          </p>
        </div>
      ) : null}
    </article>
  );
}

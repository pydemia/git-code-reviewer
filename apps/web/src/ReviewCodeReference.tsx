import { referencedCode, type DiffLine } from './review-diff.ts';

export function ReviewCodeReference({
  path,
  commit,
  href,
  lines,
  side,
  start,
  end,
}: {
  path: string;
  commit?: string | undefined;
  href?: string | undefined;
  lines: DiffLine[];
  side: 'mergeBase' | 'head';
  start?: number | undefined;
  end?: number | undefined;
}) {
  const { rows, partial } = referencedCode(lines, side, start, end);
  if (!start) return null;
  return (
    <figure className="review-code-reference" aria-label={`${path} 코드 참조`}>
      <figcaption>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            {path}
          </a>
        ) : (
          <span>{path}</span>
        )}
        <span>
          {side === 'mergeBase' ? '이전 코드' : '변경 코드'} · L{start}
          {end && end !== start ? `–L${end}` : ''}
          {commit ? ` · ${commit.slice(0, 8)}` : ''}
        </span>
      </figcaption>
      {rows.length ? (
        <div
          className="review-code-reference-scroll"
          tabIndex={0}
          aria-label="참조 코드 · 가로 스크롤 가능"
        >
          <pre>
            <code>
              {rows.map((row, index) => (
                <span key={row.number}>
                  {index > 0 && row.number !== rows[index - 1]!.number + 1 ? (
                    <span className="review-code-reference-gap">…</span>
                  ) : null}
                  <span
                    className={`review-code-reference-line${row.selected ? ' referenced-line' : ''}`}
                  >
                    <span
                      className="review-code-reference-number"
                      aria-label={`line ${row.number}`}
                    >
                      {row.number}
                    </span>
                    <span>
                      {row.content || ' '}
                      {'\n'}
                    </span>
                  </span>
                </span>
              ))}
            </code>
          </pre>
        </div>
      ) : null}
      {!rows.length || partial ? (
        <p>
          {rows.length
            ? '긴 참조 범위 중 일부를 표시합니다.'
            : '저장된 diff에 이 코드 범위가 없습니다.'}
          {href ? (
            <>
              {' '}
              <a href={href} target="_blank" rel="noreferrer">
                GitHub에서 전체 코드 보기
              </a>
            </>
          ) : null}
        </p>
      ) : null}
    </figure>
  );
}

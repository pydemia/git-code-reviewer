import { useEffect, useState } from 'react';
import {
  loadGitHubPrMessageHistory,
  type GitHubPrMessageHistory,
  type GitHubPrMemorySource,
} from './api.ts';

type Evidence = Pick<
  GitHubPrMemorySource,
  'provenance' | 'path' | 'line' | 'commitSha' | 'inReplyToGithubId'
>;
const reviewStates: Record<string, string> = {
  APPROVED: '승인',
  CHANGES_REQUESTED: '변경 요청',
  COMMENTED: '의견',
  DISMISSED: '리뷰 기각',
  PENDING: '제출 전',
};
export function GitHubMessageProvenance({ source }: { source: Evidence }) {
  const p = source.provenance;
  if (!p) return <small>위치·리뷰 상태: 이전 수집 자료로 확인되지 않음</small>;
  return (
    <div className="memory-source-provenance">
      {p.reviewState ? (
        <span>리뷰 상태: {reviewStates[p.reviewState] ?? p.reviewState}</span>
      ) : null}
      {p.reviewGithubId ? <span>리뷰 #{p.reviewGithubId}</span> : null}
      {source.inReplyToGithubId ? <span>댓글 #{source.inReplyToGithubId}의 답글</span> : null}
      {source.path ? (
        <span>
          현재 위치: {source.path}
          {source.line
            ? `:${p.startLine ? `${p.startLine}–` : ''}${source.line}`
            : ' · 현재 줄 미확인'}
          {source.commitSha ? ` @ ${source.commitSha.slice(0, 12)}` : ''}
        </span>
      ) : null}
      {p.originalLine || p.originalCommitSha ? (
        <span>
          원래 위치: {source.path ?? '경로 미확인'}
          {p.originalLine
            ? `:${p.originalStartLine ? `${p.originalStartLine}–` : ''}${p.originalLine}`
            : ''}
          {p.originalCommitSha ? ` @ ${p.originalCommitSha.slice(0, 12)}` : ''}
        </span>
      ) : null}
      <small>스레드 해결·outdated: 미확인</small>
      {p.diffHunk ? (
        <details>
          <summary>원문 diff</summary>
          <pre>{p.diffHunk}</pre>
        </details>
      ) : null}
    </div>
  );
}

export function GitHubMessageEvidence({
  repositoryId,
  pullNumber,
  source,
}: {
  repositoryId: string;
  pullNumber: number;
  source: GitHubPrMemorySource;
}) {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [history, setHistory] = useState<GitHubPrMessageHistory | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setHistory(null);
    setFailed(false);
    if (!open) return;
    const controller = new AbortController();
    void loadGitHubPrMessageHistory(repositoryId, pullNumber, source.id, controller.signal, cursor)
      .then((value) => {
        if (!controller.signal.aborted) setHistory(value);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => controller.abort();
  }, [repositoryId, pullNumber, source.id, source.observationHash, open, cursor, attempt]);
  return (
    <>
      <GitHubMessageProvenance source={source} />
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>수집한 변경 이력</summary>
        <small>
          관측한 원문·상태·위치 변경만 표시합니다. 수집 사이의 변경이나 원문 삭제 여부는 확인되지
          않을 수 있습니다.
        </small>
        {failed ? (
          <p role="alert">
            이력을 불러오지 못했습니다.{' '}
            <button type="button" onClick={() => setAttempt((value) => value + 1)}>
              다시 시도
            </button>
          </p>
        ) : !history ? (
          <p role="status">이력을 불러오는 중입니다.</p>
        ) : (
          <>
            {history.items.map((item) => (
              <article key={item.id} className="memory-observation">
                <small>
                  관측 시각 {item.observedAt} · 원문 시각 {item.snapshot.githubUpdatedAt}
                </small>
                <p>{item.snapshot.body || '본문 없음'}</p>
                <GitHubMessageProvenance source={item.snapshot} />
                <small>원문 SHA-256 {item.snapshot.contentHash}</small>
              </article>
            ))}
            {!history.items.length ? (
              <p>
                보관된 관측 이력이 없습니다. 이전 본문 버전을 상태 변경 이력으로 추정하지 않습니다.
              </p>
            ) : null}
            <div className="memory-actions">
              {history.nextCursor ? (
                <button type="button" onClick={() => setCursor(history.nextCursor)}>
                  이전 이력
                </button>
              ) : null}
              {cursor ? (
                <button type="button" onClick={() => setCursor(null)}>
                  최근 이력
                </button>
              ) : null}
            </div>
          </>
        )}
      </details>
    </>
  );
}

import { Brain, ExternalLink, GitPullRequest, MessageSquare, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  createReviewMemoryCandidate,
  loadGitHubPrMemorySources,
  loadReviewMemories,
  reviewPersonalMemory,
  updateGitHubPrMemorySource,
  type ChatMessage,
  type GitHubPrMemorySource,
  type ReviewMemoryList,
  type WorkspaceData,
} from './api.ts';

export function ReviewMemoryPanel({
  data,
  chatMessages,
}: {
  data: WorkspaceData;
  chatMessages: ChatMessage[];
}) {
  const analysisId = data.analysis?.id;
  const [memory, setMemory] = useState<ReviewMemoryList | null>(null);
  const [sources, setSources] = useState<GitHubPrMemorySource[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      if (!analysisId) return;
      const controller = signal ? null : new AbortController();
      const activeSignal = signal ?? controller!.signal;
      const [nextMemory, nextSources] = await Promise.all([
        loadReviewMemories(analysisId, activeSignal),
        loadGitHubPrMemorySources(data.pull.repositoryId, data.pull.number, activeSignal),
      ]);
      setMemory(nextMemory);
      setSources(nextSources);
      setStatus('ready');
    },
    [analysisId, data.pull.number, data.pull.repositoryId],
  );

  useEffect(() => {
    if (!analysisId) return;
    const controller = new AbortController();
    setStatus('loading');
    void reload(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.error(error);
        setStatus('error');
      }
    });
    return () => controller.abort();
  }, [analysisId, reload]);

  const run = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await action();
      await reload();
    } catch (error) {
      console.error(error);
      setStatus('error');
    } finally {
      setBusy(null);
    }
  };

  if (!analysisId)
    return <div className="bottom-tool-empty">분석이 시작되면 Memory를 사용할 수 있습니다.</div>;
  if (status === 'loading')
    return <div className="bottom-tool-empty">Memory를 불러오는 중입니다.</div>;

  const collective = memory?.pinned.filter(({ scope }) => scope === 'collective') ?? [];
  const pinnedPersonal = memory?.pinned.filter(({ scope }) => scope === 'personal') ?? [];
  return (
    <div className="memory-panel bottom-tool-content">
      {status === 'error' ? (
        <p className="memory-error">Memory 요청을 처리하지 못했습니다.</p>
      ) : null}
      <section className="memory-section">
        <header>
          <ShieldCheck size={15} />
          <strong>Repository Memory</strong>
          <span>집단 메모리 우선 · {collective.length}개 고정</span>
        </header>
        <MemoryCards items={collective} empty="이 분석에 적용된 집단 메모리가 없습니다." />
      </section>

      <section className="memory-section">
        <header>
          <Brain size={15} />
          <strong>내 Memory</strong>
          <span>
            분석 고정 {pinnedPersonal.length} · 관리 {memory?.personal.length ?? 0}
          </span>
        </header>
        <div className="memory-card-grid">
          {memory?.personal.map((item) => (
            <article className="memory-card" key={item.id}>
              <div className="memory-card-heading">
                <span className={`memory-state ${item.state}`}>{memoryState(item.state)}</span>
                <strong>{item.summary}</strong>
              </div>
              {item.detail ? <p>{item.detail}</p> : null}
              <small>{memorySource(item.sourceKind)}</small>
              <div className="memory-actions">
                {item.state === 'candidate' ? (
                  <>
                    <button
                      type="button"
                      disabled={busy === item.id}
                      onClick={() =>
                        void run(item.id, () => reviewPersonalMemory(item.id, 'activate'))
                      }
                    >
                      적용
                    </button>
                    <button
                      type="button"
                      disabled={busy === item.id}
                      onClick={() =>
                        void run(item.id, () => reviewPersonalMemory(item.id, 'reject'))
                      }
                    >
                      제외
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={busy === item.id}
                    onClick={() => void run(item.id, () => reviewPersonalMemory(item.id, 'retire'))}
                  >
                    폐기
                  </button>
                )}
              </div>
            </article>
          ))}
          {!memory?.personal.length ? (
            <p className="memory-empty">관리할 개인 메모리가 없습니다.</p>
          ) : null}
        </div>
      </section>

      <section className="memory-section">
        <header>
          <GitPullRequest size={15} />
          <strong>PR 대화</strong>
          <span>GitHub에서 수집한 검토 대화</span>
        </header>
        <div className="memory-source-list">
          {sources.map((source) => (
            <article className={`memory-source ${source.state}`} key={source.id}>
              <div>
                <strong>{source.authorLogin}</strong>
                <span>{source.kind}</span>
                {source.path ? (
                  <code>
                    {source.path}
                    {source.line ? `:${source.line}` : ''}
                  </code>
                ) : null}
                <a
                  href={source.htmlUrl}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="GitHub에서 열기"
                >
                  <ExternalLink size={13} />
                </a>
              </div>
              <p>{source.body}</p>
              <div className="memory-actions">
                {source.state !== 'saved' ? (
                  <button
                    type="button"
                    disabled={busy === source.id}
                    onClick={() =>
                      void run(source.id, () =>
                        createReviewMemoryCandidate(analysisId, {
                          kind: 'decision',
                          summary: summary(source.body),
                          detail: source.body.slice(0, 4_000),
                          filePaths: source.path ? [source.path] : [],
                          categories: ['review-history'],
                          confidence: 0.7,
                          importance: 4,
                          sourceGithubPrMessageId: source.id,
                        }),
                      )
                    }
                  >
                    Memory 후보
                  </button>
                ) : (
                  <span className="memory-saved">후보로 저장됨</span>
                )}
                <button
                  type="button"
                  disabled={busy === source.id || source.state === 'saved'}
                  onClick={() =>
                    void run(source.id, () =>
                      updateGitHubPrMemorySource(
                        data.pull.repositoryId,
                        data.pull.number,
                        source.id,
                        source.state === 'ignored' ? 'available' : 'ignored',
                      ),
                    )
                  }
                >
                  {source.state === 'ignored' ? '다시 표시' : '무시'}
                </button>
              </div>
            </article>
          ))}
          {!sources.length ? (
            <p className="memory-empty">수집된 GitHub PR 대화가 없습니다.</p>
          ) : null}
        </div>
      </section>

      <section className="memory-section">
        <header>
          <MessageSquare size={15} />
          <strong>현재 Review와 Chat</strong>
          <span>확인한 내용을 개인 후보로 저장</span>
        </header>
        <div className="memory-quick-sources">
          {data.report?.findings.slice(0, 20).map((finding) => {
            const filePath = data.files.find(({ id }) => id === finding.anchor.fileId)?.path;
            return (
              <button
                type="button"
                key={finding.id}
                disabled={busy === finding.id}
                onClick={() =>
                  void run(finding.id, () =>
                    createReviewMemoryCandidate(analysisId, {
                      kind: 'recurring-finding',
                      summary: finding.title,
                      detail: finding.problem.slice(0, 4_000),
                      recommendation: finding.recommendation.slice(0, 2_000),
                      categories: [finding.category],
                      filePaths: filePath ? [filePath] : [],
                      confidence:
                        finding.confidence === 'high'
                          ? 0.9
                          : finding.confidence === 'medium'
                            ? 0.7
                            : 0.4,
                      importance: finding.priority === 'P3' ? 5 : finding.priority === 'P2' ? 4 : 3,
                      sourceFindingId: finding.id,
                    }),
                  )
                }
              >
                <span>{finding.priority}</span> {finding.title}
              </button>
            );
          })}
          {chatMessages
            .filter(({ status }) => status === 'completed')
            .slice(-10)
            .map((message) => (
              <button
                type="button"
                key={message.id}
                disabled={busy === message.id}
                onClick={() =>
                  void run(message.id, () =>
                    createReviewMemoryCandidate(analysisId, {
                      kind: 'decision',
                      summary: summary(message.content),
                      detail: message.content.slice(0, 4_000),
                      categories: ['review-history'],
                      confidence: 0.6,
                      importance: 3,
                      sourceChatMessageId: message.id,
                    }),
                  )
                }
              >
                <span>{message.role === 'assistant' ? 'AI' : '나'}</span> {summary(message.content)}
              </button>
            ))}
        </div>
      </section>
    </div>
  );
}

function MemoryCards({ items, empty }: { items: ReviewMemoryList['pinned']; empty: string }) {
  if (!items.length) return <p className="memory-empty">{empty}</p>;
  return (
    <div className="memory-card-grid">
      {items.map((item) => (
        <article className="memory-card" key={item.id}>
          <div className="memory-card-heading">
            <span className={`memory-kind ${item.kind}`}>{memoryKind(item.kind)}</span>
            <strong>{item.summary}</strong>
          </div>
          {item.detail ? <p>{item.detail}</p> : null}
          <small>
            기여 {item.contributorCount} · 충돌 {item.conflictCount} · 신뢰도{' '}
            {Math.round(item.confidence * 100)}%
          </small>
        </article>
      ))}
    </div>
  );
}

function summary(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length <= 120 ? compact : `${compact.slice(0, 119)}…`;
}

function memoryState(state: string) {
  return state === 'active' ? '적용 중' : '검토 대기';
}

function memoryKind(kind: string) {
  return (
    {
      'recurring-finding': '반복 Finding',
      decision: '결정',
      'false-positive': 'False positive',
      'open-question': '확인 필요',
    }[kind] ?? kind
  );
}

function memorySource(source: string) {
  return (
    {
      finding: 'AI review finding',
      'chat-message': 'Review Chat',
      'github-pr-message': 'GitHub PR 대화',
      manual: '직접 입력',
    }[source] ?? source
  );
}

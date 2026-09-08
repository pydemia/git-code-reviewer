import { Brain, Check, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import {
  loadAdminReviewMemories,
  reviewCollectiveMemory,
  type AdminRepository,
  type ReviewMemory,
} from './api.ts';

export function AdminMemoryPanel({
  tenantId,
  repositories,
}: {
  tenantId: string;
  repositories: AdminRepository[];
}) {
  const visibleRepositories = repositories.filter((repository) => repository.tenantId === tenantId);
  const [repositoryId, setRepositoryId] = useState('');
  const [items, setItems] = useState<ReviewMemory[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(
    async (signal?: AbortSignal) => {
      const controller = signal ? null : new AbortController();
      const next = await loadAdminReviewMemories(signal ?? controller!.signal, {
        ...(tenantId ? { tenantId } : {}),
        ...(repositoryId ? { repositoryId } : {}),
      });
      setItems(next);
      setStatus('ready');
    },
    [repositoryId, tenantId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void reload(controller.signal).catch((error: unknown) => {
      if (!controller.signal.aborted) {
        console.error(error);
        setStatus('error');
      }
    });
    return () => controller.abort();
  }, [reload]);

  const review = async (memory: ReviewMemory, action: 'activate' | 'reject' | 'retire') => {
    setBusy(memory.id);
    try {
      await reviewCollectiveMemory(memory.id, action);
      await reload();
    } catch (error) {
      console.error(error);
      setStatus('error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="admin-section memory-admin-section">
      <div className="admin-title-row">
        <div>
          <p className="eyebrow">Collective intelligence</p>
          <h1>Repository Memory</h1>
        </div>
      </div>
      <p className="admin-section-description">
        서로 다른 사용자 두 명 이상이 승인한 개인 메모리를 검토합니다. 활성화된 집단 메모리는 개인
        메모리보다 먼저 분석에 적용됩니다.
      </p>
      <div className="admin-toolbar">
        <label>
          Repository
          <select value={repositoryId} onChange={(event) => setRepositoryId(event.target.value)}>
            <option value="">전체 repository</option>
            {visibleRepositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.owner}/{repository.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="memory-admin-list">
        {items.map((memory) => {
          const repository = repositories.find(({ id }) => id === memory.repositoryId);
          return (
            <article className="memory-admin-card" key={memory.id}>
              <header>
                <Brain size={15} />
                <strong>{memory.summary}</strong>
                <span className={`memory-state ${memory.state}`}>{memory.state}</span>
              </header>
              <p>{memory.detail || memory.recommendation || '추가 설명 없음'}</p>
              <small>
                {repository ? `${repository.owner}/${repository.name}` : memory.repositoryId} · 기여{' '}
                {memory.contributorCount} · 충돌 {memory.conflictCount} · revision {memory.revision}
              </small>
              <div className="memory-actions">
                {memory.state === 'candidate' ? (
                  <>
                    <button
                      type="button"
                      disabled={busy === memory.id}
                      onClick={() => void review(memory, 'activate')}
                    >
                      <Check size={13} /> 활성화
                    </button>
                    <button
                      type="button"
                      disabled={busy === memory.id}
                      onClick={() => void review(memory, 'reject')}
                    >
                      <X size={13} /> 기각
                    </button>
                  </>
                ) : memory.state === 'active' ? (
                  <button
                    type="button"
                    disabled={busy === memory.id}
                    onClick={() => void review(memory, 'retire')}
                  >
                    폐기
                  </button>
                ) : null}
              </div>
            </article>
          );
        })}
        {status === 'loading' ? <p className="admin-empty">Memory를 불러오는 중입니다.</p> : null}
        {status === 'error' ? <p className="admin-empty">Memory를 불러오지 못했습니다.</p> : null}
        {status === 'ready' && !items.length ? (
          <p className="admin-empty">집단 Memory 후보가 없습니다.</p>
        ) : null}
      </div>
    </section>
  );
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  centralMemoryContent,
  type KnowledgePublicationStatus,
  type CentralMemoryContent,
} from '@gcr/client-contract';
import {
  loadKnowledgeStatus,
  loadKnowledgeMemories,
  loadKnowledgeProjection,
  approveKnowledgeProjection,
} from './knowledge-api.ts';
const labels = {
  policy: '정책·Skill·리뷰 기준',
  collective: '집단 메모리',
  personal: '내 개인 메모리',
};
const states = {
  disabled: '배포 꺼짐',
  unpublished: '미발행',
  pending: '발행 대기',
  failed: '발행 실패',
  published: '발행됨',
  unavailable: '파일 사용 불가',
};
const failure = (cause: unknown) =>
  cause instanceof Error ? cause.message : '배포 정보를 불러오지 못했습니다.';
type Memory = Awaited<ReturnType<typeof loadKnowledgeMemories>>['items'][number];
type Projection = Awaited<ReturnType<typeof loadKnowledgeProjection>>;
export function ReviewKnowledgePanel({ repositoryId }: { repositoryId: string }) {
  const [status, setStatus] = useState<KnowledgePublicationStatus | null>(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void loadKnowledgeStatus(repositoryId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setStatus(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) {
          setStatus(null);
          setError(failure(cause));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [repositoryId, refresh]);
  return (
    <section className="knowledge-panel" aria-label="리뷰 지식 배포">
      <div className="criteria-list-heading">
        <h2>리뷰 지식 배포</h2>
        <button type="button" disabled={loading} onClick={() => setRefresh((value) => value + 1)}>
          배포 상태 새로고침
        </button>
      </div>
      {loading ? <p role="status">배포 상태를 확인하는 중입니다.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {status ? (
        <>
          {!status.enabled ? (
            <p>이 서버의 지식 배포가 꺼져 있습니다. 기준 관리는 계속 사용할 수 있습니다.</p>
          ) : null}
          <div className="knowledge-table-wrap">
            <table className="knowledge-table">
              <caption className="sr-only">현재 저장소의 번들 발행 상태</caption>
              <thead>
                <tr>
                  <th scope="col">자료</th>
                  <th scope="col">발행 상태</th>
                  <th scope="col">버전</th>
                  <th scope="col">발행에서 제외</th>
                </tr>
              </thead>
              <tbody>
                {status.components.map((item) => (
                  <tr key={item.component}>
                    <th scope="row">{labels[item.component]}</th>
                    <td>
                      {states[item.state]}
                      {item.lastError ? (
                        <small className="knowledge-error">오류: {item.lastError}</small>
                      ) : null}
                      {item.state === 'pending' && item.bundleId ? (
                        <small>
                          이전 버전은 보관 중입니다. 새 다운로드는 최신 발행을 기다립니다.
                        </small>
                      ) : null}
                    </td>
                    <td>
                      {item.bundleId ? (
                        <details>
                          <summary>v{item.releaseSequence}</summary>
                          <dl>
                            <dt>Bundle ID</dt>
                            <dd>{item.bundleId}</dd>
                            <dt>SHA-256</dt>
                            <dd>{item.contentHash}</dd>
                            <dt>크기</dt>
                            <dd>{item.sizeBytes?.toLocaleString()} bytes</dd>
                            <dt>갱신 시각</dt>
                            <dd>
                              {item.updatedAt ? new Date(item.updatedAt).toLocaleString() : '—'}
                            </dd>
                          </dl>
                        </details>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{item.excludedCount}개</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="knowledge-note">
            지원 지식 contract: v{status.compatibleClientContracts.minimum}. 다른 버전은 다운로드
            요청 시 거부됩니다. 클라이언트 동기화: 확인되지 않음.
          </p>
          <p className="knowledge-note">
            발행된 자료가 클라이언트에 적용됐는지는 별도 확인이 필요합니다. 개인 번들은 본인의 최초
            다운로드 요청 때 준비됩니다.
          </p>
          {status.enabled ? (
            <details className="knowledge-curation">
              <summary>메모리 배포 내용 검토·승인</summary>
              <MemoryPublication
                repositoryId={repositoryId}
                onApproved={() => setRefresh((value) => value + 1)}
              />
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
function MemoryPublication({
  repositoryId,
  onApproved,
}: {
  repositoryId: string;
  onApproved: () => void;
}) {
  const [items, setItems] = useState<Memory[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Memory | null>(null);
  const [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const load = async (next?: string) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const result = await loadKnowledgeMemories(repositoryId, controller.signal, next);
      if (!controller.signal.aborted) {
        setItems((previous) =>
          next
            ? [
                ...previous,
                ...result.items.filter((item) => !previous.some((old) => old.id === item.id)),
              ]
            : result.items,
        );
        setCursor(result.nextCursor);
      }
    } catch (cause) {
      if (!controller.signal.aborted) setError(failure(cause));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  };
  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    void loadKnowledgeMemories(repositoryId, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) {
          setItems(value.items);
          setCursor(value.nextCursor);
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(failure(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
      request.current?.abort();
    };
  }, [repositoryId]);
  return (
    <div>
      <p>
        활성 메모리 중 배포 내용을 검토할 수 있는 자료입니다. 공용 자료는 유지관리자, 개인 자료는
        본인만 승인할 수 있습니다.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {loading ? (
        <p role="status">메모리를 불러오는 중입니다.</p>
      ) : !items.length ? (
        <p>검토할 활성 메모리가 없습니다.</p>
      ) : null}
      <div className="knowledge-memory-list">
        {items.map((memory) => (
          <button
            type="button"
            key={memory.id}
            aria-pressed={selected?.id === memory.id}
            onClick={() => {
              setSelected(memory);
              setNotice('');
            }}
          >
            <strong>{memory.summary}</strong>
            <small>
              {memory.scope === 'personal' ? '내 개인 자료' : '공용 자료'} ·{' '}
              {memory.projectionRevision
                ? `배포 승인 v${memory.projectionRevision}`
                : '배포 승인 없음'}
            </small>
          </button>
        ))}
      </div>
      {cursor ? (
        <button type="button" disabled={loading} onClick={() => void load(cursor)}>
          메모리 더 보기
        </button>
      ) : null}
      {selected ? (
        <ProjectionEditor
          key={selected.id}
          repositoryId={repositoryId}
          memory={selected}
          onClose={() => setSelected(null)}
          onSaved={() => {
            setSelected(null);
            setNotice('배포 내용을 승인했습니다. 발행 상태에서 반영 결과를 확인해 주세요.');
            void load();
            onApproved();
          }}
        />
      ) : null}
    </div>
  );
}
const scopeLabels = {
  languages: '언어',
  filePaths: '파일 경로',
  symbols: '심볼',
  contracts: 'API 계약',
  branches: '브랜치',
};
function ProjectionEditor({
  repositoryId,
  memory,
  onClose,
  onSaved,
}: {
  repositoryId: string;
  memory: Memory;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [projection, setProjection] = useState<Projection | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    const controller = new AbortController();
    setProjection(null);
    setError('');
    void loadKnowledgeProjection(repositoryId, memory.id, controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setProjection(value);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setError(failure(cause));
      });
    return () => {
      active.current = false;
      controller.abort();
    };
  }, [repositoryId, memory.id, reload]);
  const content = projection?.projection?.content;
  const stale =
    projection?.projection && projection.projection.sourceFingerprint !== projection.fingerprint;
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!projection?.fingerprint) return;
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    const lines = (name: string) =>
      text(name)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    try {
      const input = centralMemoryContent({
        summary: text('summary'),
        detail: text('detail'),
        recommendation: text('recommendation'),
        categories: lines('categories'),
        counterEvidence: lines('counterEvidence'),
        expiresAt: text('expiresAt') ? new Date(text('expiresAt')).toISOString() : null,
        appliesTo: Object.fromEntries(Object.keys(scopeLabels).map((key) => [key, lines(key)])),
      });
      setBusy(true);
      setError('');
      await approveKnowledgeProjection(repositoryId, memory.id, projection.fingerprint, input);
      if (active.current) onSaved();
    } catch (cause) {
      if (active.current) setError(failure(cause));
    } finally {
      if (active.current) setBusy(false);
    }
  };
  return (
    <section className="knowledge-editor" aria-label="메모리 배포 승인">
      <h3>{memory.summary}</h3>
      <p>
        클라이언트에 전달할 내용을 직접 검토해 작성하세요. 원문과 개인 식별 정보는 자동으로 포함하지
        않습니다.
      </p>
      {error ? <p role="alert">{error}</p> : null}
      {stale ? (
        <p role="status">
          승인 이후 원문이 변경됐습니다. 아래 내용을 다시 검토해야 배포에 포함됩니다.
        </p>
      ) : null}
      {!projection && !error ? <p role="status">현재 원문 상태를 확인하는 중입니다.</p> : null}
      {projection ? (
        <form key={`${projection.fingerprint}:${reload}`} onSubmit={(event) => void submit(event)}>
          <fieldset disabled={busy}>
            {!projection.reviewed || projection.state !== 'active' || !projection.fingerprint ? (
              <p>활성·검토 상태와 출처를 먼저 확인해야 배포를 승인할 수 있습니다.</p>
            ) : null}
            <label>
              배포 요약
              <input
                name="summary"
                maxLength={500}
                required
                defaultValue={content?.summary ?? memory.summary}
              />
            </label>
            <label>
              배포 설명
              <textarea name="detail" maxLength={4000} defaultValue={content?.detail} />
            </label>
            <label>
              배포 권고
              <textarea
                name="recommendation"
                maxLength={2000}
                defaultValue={content?.recommendation}
              />
            </label>
            <label>
              배포 반증 조건
              <textarea
                name="counterEvidence"
                defaultValue={content?.counterEvidence.join('\n')}
                placeholder="한 줄에 하나"
              />
            </label>
            <details>
              <summary>배포 적용 범위·분류·만료</summary>
              <div className="criteria-fields">
                {Object.entries(scopeLabels).map(([key, label]) => (
                  <label key={key}>
                    배포 {label}
                    <textarea
                      name={key}
                      defaultValue={content?.appliesTo[
                        key as keyof CentralMemoryContent['appliesTo']
                      ].join('\n')}
                      placeholder="한 줄에 하나"
                    />
                  </label>
                ))}
                <label>
                  배포 분류
                  <textarea name="categories" defaultValue={content?.categories.join('\n')} />
                </label>
                <label>
                  배포 만료 시각
                  <input
                    name="expiresAt"
                    type="datetime-local"
                    defaultValue={localDate(content?.expiresAt ?? null)}
                  />
                </label>
              </div>
            </details>
            <div className="criteria-actions">
              <button
                type="submit"
                disabled={
                  !projection.reviewed || projection.state !== 'active' || !projection.fingerprint
                }
              >
                {busy ? '승인 저장 중…' : '배포 내용 승인'}
              </button>
              <button type="button" onClick={onClose}>
                검토 닫기
              </button>
            </div>
          </fieldset>
        </form>
      ) : null}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setProjection(null);
          setError('');
          setReload((value) => value + 1);
        }}
      >
        현재 입력을 버리고 최신 상태 불러오기
      </button>
    </section>
  );
}
function localDate(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

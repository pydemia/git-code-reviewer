import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowUpRight,
  Clipboard,
  CircleCheck,
  Download,
  FileCode2,
  FileJson,
  MessageSquare,
} from 'lucide-react';
import {
  formatReviewDuration,
  presentReviewReport,
  reviewPriorityLabels,
  reviewFileStatusLabels,
} from '@gcr/contracts';
import type { WorkspaceData } from './api.ts';

type Report = NonNullable<WorkspaceData['report']>;
type Finding = Report['findings'][number];

export function ReviewText({ text }: { text: string }) {
  return (
    <>
      {text
        .split(/(`[^`\n]+`)/g)
        .map((part, index) =>
          part.startsWith('`') && part.endsWith('`') ? (
            <code key={index}>{part.slice(1, -1)}</code>
          ) : (
            part
          ),
        )}
    </>
  );
}

function ReviewCommentBlock({
  finding,
  selected,
  onSelect,
}: {
  finding: Finding;
  selected: boolean;
  onSelect: (finding: Finding) => void;
}) {
  const ghesLink = finding.links.find((link) => link.rel === 'ghes' && link.available);
  return (
    <article
      className={`report-unit priority-border-${finding.priority.toLowerCase()}${selected ? ' active' : ''}`}
      aria-label="검토 의견"
      data-comment-id={finding.id}
    >
      <header className="report-unit-meta">
        <MessageSquare size={15} aria-hidden="true" />
        <b className={`review-priority priority-${finding.priority.toLowerCase()}`}>
          {reviewPriorityLabels[finding.priority]}
        </b>
        <span>{finding.category}</span>
        <span>
          {finding.anchor.side === 'mergeBase' ? '이전 코드' : '변경 코드'} ·{' '}
          {finding.anchor.startLine
            ? `line ${finding.anchor.startLine}${finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine ? `–${finding.anchor.endLine}` : ''}`
            : '파일 전체'}
        </span>
      </header>
      <h4>
        <button type="button" className="report-unit-title" onClick={() => onSelect(finding)}>
          <ReviewText text={finding.title} />
        </button>
      </h4>
      {finding.problem && finding.problem !== finding.title ? (
        <p className="report-narrative">
          <ReviewText text={finding.problem} />
        </p>
      ) : null}
      {finding.impact ? (
        <div className="report-unit-detail">
          <b>영향</b>
          <p>
            <ReviewText text={finding.impact} />
          </p>
        </div>
      ) : null}
      {finding.recommendation ? (
        <div className="report-unit-detail report-recommendation">
          <b>수정 제안</b>
          <p>
            <ReviewText text={finding.recommendation} />
          </p>
        </div>
      ) : null}
      <footer>
        <button type="button" className="report-code-link" onClick={() => onSelect(finding)}>
          코드에서 보기 <ArrowUpRight size={13} aria-hidden="true" />
        </button>
        <span className="comment-verification">
          <CircleCheck size={13} aria-hidden="true" />
          {finding.verification.status === 'verified' ? '코드 위치 확인' : '코드 위치 확인 제한'}
        </span>
        {ghesLink ? (
          <a className="report-code-link" href={ghesLink.href} target="_blank" rel="noreferrer">
            GHES 원문 <ArrowUpRight size={13} aria-hidden="true" />
          </a>
        ) : null}
      </footer>
    </article>
  );
}

// Summary는 PR·파일 요약, FNB Comments는 상세 의견을 담당합니다.
export function ReviewReportPanel({
  report,
  files,
  section,
  selectedFindingId,
  onFindingSelect,
  onFileSelect,
}: {
  report: Report;
  files: WorkspaceData['files'];
  section: 'summary' | 'comments';
  selectedFindingId: string | null;
  onFindingSelect: (finding: Finding) => void;
  onFileSelect: (path: string) => void;
}) {
  const view = useMemo(() => presentReviewReport(report, files), [report, files]);
  const [copyState, setCopyState] = useState('');
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (section !== 'comments' || !selectedFindingId) return;
    const host = panel.current?.closest<HTMLElement>('.bottom-comments-host');
    const selected = [
      ...(panel.current?.querySelectorAll<HTMLElement>('[data-comment-id]') ?? []),
    ].find((item) => item.dataset.commentId === selectedFindingId);
    if (host && selected)
      host.scrollTop +=
        selected.getBoundingClientRect().top - host.getBoundingClientRect().top - 12;
  }, [section, selectedFindingId]);
  const link = (rel: string) =>
    report.links.find((item) => item.rel === rel && item.available)?.href;
  const self = link('self');
  const json = link('json');
  const markdown = link('markdown');
  function selectFile(fileId: string, path: string) {
    const finding = report.findings.find((item) => item.anchor.fileId === fileId);
    if (finding) onFindingSelect(finding);
    else onFileSelect(path);
  }
  return (
    <article
      className="structured-report"
      aria-label={section === 'summary' ? 'PR 검토 요약' : '검토 의견 목록'}
      ref={panel}
    >
      {section === 'summary' ? (
        <header className="structured-report-heading">
          <div className="report-title-row">
            <h2>분석 요약</h2>
            <div className="report-export-actions">
              {json ? (
                <a href={json} target="_blank" rel="noreferrer">
                  <FileJson size={13} /> Raw JSON
                </a>
              ) : null}
              {markdown ? (
                <a href={markdown}>
                  <Download size={13} /> Markdown
                </a>
              ) : null}
              <button
                type="button"
                className="icon-button small"
                aria-label="Report 링크 복사"
                disabled={!self}
                onClick={() => {
                  if (self)
                    void navigator.clipboard.writeText(self).then(
                      () => setCopyState('Report 링크를 복사했습니다.'),
                      () =>
                        setCopyState('링크를 복사하지 못했습니다. 주소 표시줄의 URL을 복사하세요.'),
                    );
                }}
              >
                <Clipboard size={13} />
              </button>
            </div>
          </div>
          {copyState ? <p role="status">{copyState}</p> : null}
          <div className="structured-report-verdict">
            <strong className={`report-state state-${view.state}`}>{view.label}</strong>
            {view.priority ? (
              <b className={`review-priority priority-${view.priority.toLowerCase()}`}>
                {reviewPriorityLabels[view.priority]}
              </b>
            ) : null}
            {view.showGrade ? (
              <span>
                Grade: {report.grade}
                {view.state === 'incomplete' ? ' · 검토 범위 내' : ''}
              </span>
            ) : null}
          </div>
          <dl className="report-metrics">
            <div>
              <dt>{view.filesCompleted === null ? '수집 파일' : '검토 완료 파일'}</dt>
              <dd>
                {view.filesCompleted ?? report.coverage.filesExamined}
                <span> / {report.coverage.filesChanged}</span>
              </dd>
            </div>
            <div>
              <dt>검토 의견</dt>
              <dd>
                {report.findings.length}
                <span>개</span>
              </dd>
            </div>
            <div>
              <dt>소요 시간</dt>
              <dd>{formatReviewDuration(report.durationMs)}</dd>
            </div>
          </dl>
          {['demo', 'failed', 'unavailable'].includes(view.state) ? (
            <p className="report-state-explanation">
              {view.state === 'demo'
                ? '데모 데이터입니다. 실제 코드의 AI review가 아닙니다.'
                : 'AI 검토가 완료되지 않았습니다.'}{' '}
              분석 Provider의 account·model·effort와 tenant 권한을 확인하고 새로고침하여 다시
              분석하세요.
            </p>
          ) : null}
          {report.coverage.limitations.length ? (
            <details className="report-limitations">
              <summary>분석 제한 {report.coverage.limitations.length}건</summary>
              <ul>
                {report.coverage.limitations.map((item, index) => (
                  <li key={index}>{item}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </header>
      ) : null}
      {section === 'summary' ? (
        <section className="report-section report-overview" aria-labelledby="pr-summary-title">
          <h3 id="pr-summary-title">PR 전체 요약</h3>
          <p className="report-pr-title">
            #{report.context.pullNumber} {report.context.pullTitle}
          </p>
          {view.overview ? (
            <p className="report-narrative">
              <ReviewText text={view.overview} />
            </p>
          ) : (
            <p className="report-state-explanation">
              이 report에는 별도의 PR 전체 요약이 없습니다. 아래 파일별 검토와 분석 제한을
              확인하세요. 전체 요약이 필요하면 분석 설정을 확인한 뒤 다시 분석하세요.
            </p>
          )}
        </section>
      ) : null}
      {section === 'summary' ? (
        <section className="report-section" aria-labelledby="overall-summary-title">
          <h3 id="overall-summary-title">
            파일별 검토 <span>{view.groups.length}개 파일</span>
          </h3>
          {view.groups.map((file) => (
            <article className="report-file-summary" key={file.fileId}>
              <header className="report-file-heading">
                <FileCode2 size={17} aria-hidden="true" />
                <button
                  className="report-file-path"
                  type="button"
                  onClick={() => selectFile(file.fileId, file.path)}
                >
                  {file.path}
                </button>
                <span className="report-comment-count">
                  <MessageSquare size={13} aria-hidden="true" />
                  {file.findings.length}
                </span>
              </header>
              <div className="report-file-body">
                <div className="report-file-meta">
                  {file.priority ? (
                    <b className={`priority-${file.priority.toLowerCase()}`}>
                      {reviewPriorityLabels[file.priority]}
                    </b>
                  ) : null}
                  <span>{reviewFileStatusLabels[file.status]}</span>
                </div>
                <details className="report-file-overview" open>
                  <summary>파일 검토 요약</summary>
                  <p className="report-narrative">
                    <ReviewText text={file.summary} />
                  </p>
                </details>
              </div>
            </article>
          ))}
        </section>
      ) : null}
      {section === 'comments' ? (
        <section
          className="report-section report-comments-section"
          aria-labelledby="ai-comments-title"
        >
          <h3 id="ai-comments-title">
            검토 의견 <span>{report.findings.length}개</span>
          </h3>
          {view.groups
            .filter((file) => file.findings.length)
            .map((file) => (
              <div className="report-file-comments" key={file.fileId}>
                <button
                  className="report-file-path"
                  type="button"
                  onClick={() => selectFile(file.fileId, file.path)}
                >
                  {file.path}
                </button>
                {file.findings.map((finding) => (
                  <ReviewCommentBlock
                    key={finding.id}
                    finding={finding}
                    selected={finding.id === selectedFindingId}
                    onSelect={onFindingSelect}
                  />
                ))}
              </div>
            ))}
          {!report.findings.length ? (
            <p className="report-state-explanation">
              표시할 comment가 없습니다. 분석 상태와 제한을 함께 확인하세요.
            </p>
          ) : null}
        </section>
      ) : null}
      {section === 'summary' ? (
        <details className="report-section report-file-list">
          <summary>전체 파일 목록 · {view.groups.length}개</summary>
          <ul className="report-analyzed-files">
            {view.groups.map((file) => (
              <li key={file.fileId}>
                <button
                  className="report-file-path"
                  type="button"
                  onClick={() => onFileSelect(file.path)}
                >
                  {file.path}
                </button>
                <small>
                  {reviewFileStatusLabels[file.status]} · {file.findings.length} comments
                </small>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {section === 'summary' ? (
        <details className="report-provenance">
          <summary>적용 Model·Skill</summary>
          <p>
            Model: <code>{report.versions.model}</code> · {view.mode}
          </p>
          {report.analysis ? (
            <>
              <p>
                Skill bundle:{' '}
                {report.analysis.skills.version === null
                  ? 'Built-in'
                  : `Version ${report.analysis.skills.version}`}
              </p>
              <code className="report-hash">{report.analysis.skills.bundleHash}</code>
              <p>
                {report.analysis.coverage.windowsReviewed}/{report.analysis.coverage.windowsPlanned}{' '}
                windows 검토 · {report.analysis.coverage.modelCalls} model calls
              </p>
              <ul>
                {report.analysis.skills.entries.map((skill) => (
                  <li key={skill.name}>
                    {skill.name} v{skill.version} · {skill.enabled ? skill.unit : '비활성'}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p>이전 report에는 Skill provenance가 없습니다.</p>
          )}
        </details>
      ) : null}
    </article>
  );
}

import { useMemo, useRef, useState } from 'react';
import { Clipboard, Download, FileJson } from 'lucide-react';
import { presentReviewReport, reviewPriorityLabels, reviewFileStatusLabels } from '@gcr/contracts';
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

// Read/Operate: summary → 파일별 설명 → unit-comment-block → 파일 목록. 설명은 생략하지 않는다.
// Comment 선택이 exact revision의 diff/inline comment/Chat scope를 함께 이동시키는 기존 동작을 유지한다.
export function ReviewReportPanel({
  report,
  files,
  selectedFindingId,
  onFindingSelect,
  onFileSelect,
}: {
  report: Report;
  files: WorkspaceData['files'];
  selectedFindingId: string | null;
  onFindingSelect: (finding: Finding) => void;
  onFileSelect: (path: string) => void;
}) {
  const view = useMemo(() => presentReviewReport(report, files), [report, files]);
  const [copyState, setCopyState] = useState('');
  const article = useRef<HTMLElement>(null);
  const jumpTo = (id: string) => {
    const target = article.current?.querySelector<HTMLElement>(`#${id}`);
    const scroller = article.current?.closest('.review-list');
    const navigationHeight =
      article.current?.querySelector('.report-section-jumps')?.getBoundingClientRect().height ?? 0;
    if (target && scroller)
      scroller.scrollTop +=
        target.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top -
        navigationHeight -
        12;
  };
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
    <article ref={article} className="structured-report" aria-label="Commit Defender 형식 Report">
      <header className="structured-report-heading">
        <h2>Git Code Reviewer</h2>
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
                  () => setCopyState('링크를 복사하지 못했습니다. 주소 표시줄의 URL을 복사하세요.'),
                );
            }}
          >
            <Clipboard size={13} />
          </button>
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
        <p className="structured-report-meta">
          {view.filesCompleted === null
            ? `${report.coverage.filesExamined}/${report.coverage.filesChanged} files 수집`
            : `${view.filesCompleted}/${report.coverage.filesChanged} files 검토 완료`}{' '}
          · {report.findings.length} comments · {view.mode} ·{' '}
          {report.durationMs.toLocaleString('ko-KR')} ms
        </p>
        <p className="report-narrative">
          <ReviewText text={report.summary} />
        </p>
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
          <details className="report-limitations" open={view.state === 'incomplete'}>
            <summary>분석 제한 {report.coverage.limitations.length}건</summary>
            <ul>
              {report.coverage.limitations.map((item, index) => (
                <li key={index}>{item}</li>
              ))}
            </ul>
          </details>
        ) : null}
      </header>
      <nav className="report-section-jumps" aria-label="Report 바로가기">
        <button type="button" onClick={() => jumpTo('overall-summary-title')}>
          Overall Summary
        </button>
        <button type="button" onClick={() => jumpTo('ai-comments-title')}>
          AI Comments
        </button>
        <button type="button" onClick={() => jumpTo('analyzed-files-title')}>
          File List
        </button>
      </nav>
      <section className="report-section" aria-labelledby="overall-summary-title">
        <h3 id="overall-summary-title">Overall Summary</h3>
        {view.groups.map((file) => (
          <div className="report-file-summary" key={file.fileId}>
            <button
              className="report-file-path"
              type="button"
              onClick={() => selectFile(file.fileId, file.path)}
            >
              {file.path}
            </button>
            <div className="report-file-meta">
              {file.priority ? (
                <b className={`priority-${file.priority.toLowerCase()}`}>
                  {reviewPriorityLabels[file.priority]}
                </b>
              ) : null}
              <span>{reviewFileStatusLabels[file.status]}</span>
            </div>
            <p className="report-narrative">
              <ReviewText text={file.summary} />
            </p>
          </div>
        ))}
      </section>
      <section className="report-section" aria-labelledby="ai-comments-title">
        <h3 id="ai-comments-title">
          AI Comments <span>{report.findings.length}</span>
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
                <button
                  className={`report-unit${finding.id === selectedFindingId ? ' active' : ''}`}
                  key={finding.id}
                  type="button"
                  aria-pressed={finding.id === selectedFindingId}
                  onClick={() => onFindingSelect(finding)}
                >
                  <span className="report-unit-meta">
                    <b className={`priority-${finding.priority.toLowerCase()}`}>
                      {reviewPriorityLabels[finding.priority]}
                    </b>
                    <span>{finding.category}</span>
                    <span>
                      {finding.anchor.side} ·{' '}
                      {finding.anchor.startLine
                        ? `line ${finding.anchor.startLine}${finding.anchor.endLine && finding.anchor.endLine !== finding.anchor.startLine ? `–${finding.anchor.endLine}` : ''}`
                        : '파일 전체'}
                    </span>
                  </span>
                  <span className="report-narrative">
                    <ReviewText text={finding.problem || finding.title} />
                  </span>
                  {finding.impact ? (
                    <span className="report-unit-detail">
                      <b>영향</b> <ReviewText text={finding.impact} />
                    </span>
                  ) : null}
                  {finding.recommendation ? (
                    <span className="report-unit-detail">
                      <b>수정 제안</b> <ReviewText text={finding.recommendation} />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
          ))}
        {!report.findings.length ? (
          <p className="report-state-explanation">
            표시할 comment가 없습니다. 분석 상태와 제한을 함께 확인하세요.
          </p>
        ) : null}
      </section>
      <section className="report-section" aria-labelledby="analyzed-files-title">
        <h3 id="analyzed-files-title">Analyzed File List</h3>
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
      </section>
      <details className="report-provenance">
        <summary>적용 Model·Skill</summary>
        <p>
          Model: <code>{report.versions.model}</code>
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
    </article>
  );
}

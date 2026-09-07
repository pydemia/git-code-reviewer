import { randomUUID } from 'node:crypto';
import {
  analyzeSnapshot,
  loadBuiltInReviewSkills,
  modelReviewFromText,
} from '@gcr/analysis-engine';
import { formatReviewMarkdown, presentReviewReport, reportViewSchema } from '@gcr/contracts';
import type { ReviewReport } from '@gcr/review-contract';
import { beforeAll, describe, expect, it } from 'vitest';
import { renderReviewComment } from './review-publication.js';

describe('shared Commit Defender report presentation', () => {
  let report: ReviewReport;
  beforeAll(async () => {
    const files = ['src/config.ts', 'src/deleted.ts'].map((path) => ({
      id: randomUUID(),
      path,
      previousPath: null,
      status: 'modified',
      additions: 1,
      deletions: 1,
      patch: '@@ -10,1 +10,1 @@\n-const key = "public";\n+const key = supplied;\n',
    }));
    report = (
      await analyzeSnapshot({
        analysisId: randomUUID(),
        snapshotId: randomUUID(),
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        patch: '',
        files,
        fixtureMode: false,
        skills: { bundle: loadBuiltInReviewSkills(), versionId: null, version: null },
        model: {
          profile: 'synthetic-only',
          async review(body, names, _instructions, stage) {
            return modelReviewFromText(
              JSON.stringify({
                summary: '검증용 요약입니다. @all <script> [link](javascript:alert(1))',
                grade: 'critical',
                file_comments:
                  stage?.stage === 'unit-comment-block'
                    ? [
                        {
                          file: names[0],
                          line: 10,
                          end_line: 10,
                          side: /side=(head|mergeBase)/.exec(body)?.[1],
                          category: 'security',
                          priority: 'P3',
                          comment: '`SESSION_SECRET` 입력을 검증하세요. <img src=x> @everyone',
                          impact: '검증용 영향',
                          recommendation: '검증용 수정 제안',
                        },
                      ]
                    : [],
              }),
              [],
            );
          },
        },
      })
    ).report;
  });
  it('retains canonical grouping, representative priority, coverage and pinned provenance in the view', () => {
    const view = presentReviewReport(report);
    expect(view).toMatchObject({
      state: 'blocked',
      label: '분석 완료 · BLOCKED',
      priority: 'P3',
      filesCompleted: 2,
      mode: 'ai-powered',
    });
    expect(view.groups.map((file) => file.path)).toEqual(['src/config.ts', 'src/deleted.ts']);
    expect(view.groups.every((file) => file.findings.length === 2)).toBe(true);
    const parsed = reportViewSchema.parse({
      ...report,
      findings: report.findings.map((finding) => ({ ...finding, links: [] })),
      context: {
        repositoryId: randomUUID(),
        owner: 'org-name',
        name: 'repo-name',
        pullNumber: 1,
        pullTitle: '검증',
        snapshotId: report.snapshotId,
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      },
      links: [],
    });
    expect(parsed.analysis).toEqual(report.analysis);
    expect(JSON.stringify(parsed.analysis)).not.toContain('instructions');
  });
  it('uses the same hierarchy for Markdown and PR publication with safe content and exact finding links', () => {
    const reportUrl = `https://review.example/reviews/${report.analysisRevisionId}`;
    const markdown = formatReviewMarkdown(report, [], { reportUrl });
    for (const title of [
      '## Overall Summary',
      '## AI Comments',
      '## Analyzed File List',
      'BLOCKED',
      'P3 Critical',
      'mergeBase · line 10',
      'head · line 10',
      'Skill bundle: Built-in',
    ])
      expect(markdown).toContain(title);
    expect(markdown.indexOf('## Overall Summary')).toBeLessThan(markdown.indexOf('## AI Comments'));
    expect(markdown.indexOf('## AI Comments')).toBeLessThan(
      markdown.indexOf('## Analyzed File List'),
    );
    expect(markdown).toContain(`finding=${report.findings[0]!.id}`);
    for (const unsafe of ['@all', '@everyone', '<script>', '<img', '[link](javascript:'])
      expect(markdown).not.toContain(unsafe);
    const published = renderReviewComment({
      context: {
        analysisId: report.analysisRevisionId,
        owner: 'org-name',
        name: 'repo-name',
        pullNumber: 1,
        headSha: 'b'.repeat(40),
        report,
      },
      findings: report.findings,
      canonicalReport: report,
      marker: '<!-- synthetic -->',
      publicBaseUrl: 'https://review.example',
    });
    expect(published).toContain(markdown);
    expect(published.startsWith('<!-- synthetic -->')).toBe(true);
  });
  it('does not label unavailable/failed/demo/skipped work PASS or invent Praise for no comments', () => {
    for (const state of ['unavailable', 'failed', 'demo', 'incomplete'] as const) {
      const changed = {
        ...report,
        analysis: { ...report.analysis!, status: state, priority: null },
        findings: [],
      };
      const view = presentReviewReport(changed);
      const markdown = formatReviewMarkdown(changed);
      expect(view.label).not.toContain('PASS');
      expect(markdown).not.toContain('P0 Praise');
      if (state === 'incomplete') expect(view.label).toBe('분석 완료 · 제한 있음');
      if (state !== 'incomplete') expect(view.showGrade).toBe(false);
    }
    const complete = {
      ...report,
      analysis: { ...report.analysis!, status: 'pass' as const, priority: null },
      findings: [],
    };
    expect(presentReviewReport(complete).label).toBe('분석 완료 · PASS');
    expect(presentReviewReport(complete).priority).toBeNull();
  });
  it('preserves legacy readability without claiming Skill coverage or synthetic line anchors', () => {
    const legacy = structuredClone(report);
    delete legacy.analysis;
    delete legacy.findings[0]!.anchor.startLine;
    delete legacy.findings[0]!.anchor.endLine;
    const paths = [{ id: legacy.findings[0]!.anchor.fileId, path: 'src/config.ts' }];
    const view = presentReviewReport(legacy, paths);
    expect(view.filesCompleted).toBeNull();
    expect(view.groups[0]!.status).toBe('legacy');
    expect(formatReviewMarkdown(legacy, paths)).toContain('파일 전체');
    expect(formatReviewMarkdown(legacy, paths)).not.toContain('Skill bundle:');
  });
  it('bounds publication length at block boundaries and retains the full report link', () => {
    const huge = { ...report, summary: '긴 요약'.repeat(20000) };
    const text = formatReviewMarkdown(huge, [], {
      maxLength: 59000,
      reportUrl: 'https://review.example/reviews/one',
    });
    expect(text.length).toBeLessThanOrEqual(59000);
    expect(text).toContain('길이 제한');
    expect(text).toContain('[전체 review와 evidence 보기](https://review.example/reviews/one)');
  });
});

import { randomUUID } from 'node:crypto';
import {
  analyzeSnapshot,
  loadBuiltInReviewSkills,
  modelReviewFromText,
} from '@gcr/analysis-engine';
import {
  escapeReviewMarkdown,
  formatReviewDuration,
  formatReviewMarkdown,
  presentReviewReport,
  reportViewSchema,
} from '@gcr/contracts';
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
  it.each([
    ['exceptional', '탁월'],
    ['proficient', '우수'],
    ['adequate', '양호'],
    ['insufficient', '개선 필요'],
    ['critical', '심각'],
  ] as const)(
    'uses the localized %s grade in Markdown without hiding priority or limitations',
    (grade, label) => {
      const changed = {
        ...report,
        grade,
        analysis: { ...report.analysis!, status: 'incomplete' as const },
      };
      const markdown = formatReviewMarkdown(changed);
      expect(markdown).toContain(`코드 품질: ${label} (${grade}) · 검토 범위 내`);
      expect(markdown).toContain('분석 완료 · 제한 있음');
      expect(markdown).toContain('P3 Critical');
      expect(changed.grade).toBe(grade);
    },
  );
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
    expect(published).toContain(
      formatReviewMarkdown(report, [], { reportUrl, includeTitle: false }),
    );
    expect(published.match(/Git Code Reviewer/g)).toHaveLength(1);
    expect(published.startsWith('<!-- synthetic -->')).toBe(true);
    expect(markdown).toContain('<code>SESSION&#95;SECRET</code>');
    expect(markdown).toContain('> 💬 **P3 Critical');
    expect(markdown).toContain('<details>\n<summary><code>src/config.ts</code>');
  });
  it('shows a stored file-summary rollup once while preserving independent overall summaries', () => {
    const changed = structuredClone(report);
    changed.analysis!.files.forEach((file, i) => {
      file.summary = `Unique file summary ${i}`;
    });
    changed.summary = changed
      .analysis!.files.map((file) => `${file.path}: ${file.summary}`)
      .join('\n\n');
    expect(presentReviewReport(changed).overview).toBeNull();
    const markdown = formatReviewMarkdown(changed);
    for (const file of changed.analysis!.files)
      expect(markdown.split(file.summary)).toHaveLength(2);
    changed.summary = 'An independent cross-file conclusion';
    expect(presentReviewReport(changed).overview).toBe(changed.summary);
    expect(formatReviewMarkdown(changed)).toContain(escapeReviewMarkdown(changed.summary));
  });
  it('escapes HTML inside collapsed headers and code, preserves paragraphs, and rejects unsafe URLs', () => {
    const changed = structuredClone(report);
    changed.summary =
      '`<img src=x onerror=alert(1)>`은 텍스트입니다.\n\n두 번째 문단입니다. `[link](https://example.com)` `*literal*`';
    changed.analysis!.files[0]!.path = '</summary><script>@everyone</script>.ts';
    const markdown = formatReviewMarkdown(changed, [], { reportUrl: 'javascript:alert(1)' });
    expect(markdown).toContain('<code>&lt;img src=x onerror=alert&#40;1&#41;&gt;</code>은');
    expect(markdown).toContain('<code>&#91;link&#93;&#40;https://example&#46;com&#41;</code>');
    expect(markdown).toContain('<code>&#42;literal&#42;</code>');
    expect(markdown).toContain('\n\n두 번째 문단입니다');
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('@everyone');
    expect(markdown).not.toContain('](javascript:');
    expect(markdown.match(/<summary>/g)?.length).toBe(markdown.match(/<\/summary>/g)?.length);
  });
  it.each([
    [2025, '2초'],
    [417238, '6분 57초'],
    [3660000, '1시간 1분'],
  ])('formats elapsed time %s for readers', (duration, label) => {
    expect(formatReviewDuration(Number(duration))).toBe(label);
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
  it.each(['unavailable', 'failed'] as const)(
    'keeps %s publication short even when hundreds of files have limitations',
    (status) => {
      const changed = structuredClone(report);
      changed.analysis!.status = status;
      changed.analysis!.mode = status === 'unavailable' ? 'disabled' : 'ai-powered';
      changed.analysis!.priority = null;
      changed.findings = [];
      changed.summary = '長いエラー @everyone <script>'.repeat(1000);
      changed.coverage.filesChanged = 238;
      changed.coverage.limitations = Array.from(
        { length: 238 },
        (_, i) => `assets/image-${i}.png: binary file`,
      );
      changed.analysis!.files = Array.from({ length: 238 }, (_, i) => ({
        fileId: randomUUID(),
        path: `assets/image-${i}.png`,
        status: 'not-reviewed',
        summary: '이 파일의 AI review를 완료하지 못했습니다.',
        priority: null,
        unitIds: [],
      }));
      changed.analysis!.coverage = {
        filesCompleted: 0,
        windowsPlanned: 0,
        windowsReviewed: 0,
        modelCalls: 0,
      };
      const body = renderReviewComment({
        context: {
          analysisId: changed.analysisRevisionId,
          owner: 'org-name',
          name: 'repo-name',
          pullNumber: 1,
          headSha: 'b'.repeat(40),
          report: changed,
        },
        findings: [],
        canonicalReport: changed,
        marker: '<!-- synthetic -->',
        publicBaseUrl: 'https://review.example',
      });
      expect(body.length).toBeLessThan(500);
      expect(body).toContain(status === 'unavailable' ? '모델을 설정' : '오류가 발생');
      expect(body).toContain('재분석하세요');
      expect(body).toContain(`https://review.example/reviews/${changed.analysisRevisionId}`);
      expect(body).toContain('<!-- synthetic -->');
      for (const omitted of [
        'image-',
        'binary file',
        'Overall Summary',
        'AI Comments',
        'Skill bundle',
        '코드 품질:',
        '@everyone',
        '<script>',
      ])
        expect(body).not.toContain(omitted);
      delete changed.analysis;
      changed.versions.review = status;
      changed.versions.model = status === 'unavailable' ? 'disabled' : 'synthetic-only';
      const legacy = formatReviewMarkdown(changed);
      expect(legacy.length).toBeLessThan(200);
      expect(legacy).not.toContain('image-');
    },
  );
  it('bounds publication length at block boundaries and retains the full report link', () => {
    const huge = { ...report, summary: '긴 요약'.repeat(20000) };
    const text = formatReviewMarkdown(huge, [], {
      maxLength: 59000,
      reportUrl: 'https://review.example/reviews/one',
    });
    expect(text.length).toBeLessThanOrEqual(59000);
    expect(text).toContain('길이 제한');
    expect(text).toContain('[전체 review와 evidence 보기](https://review.example/reviews/one)');
    expect(text).toContain('> 💬 **P3 Critical');
    expect(text.match(/<details>/g)?.length).toBe(text.match(/<\/details>/g)?.length);
  });
});

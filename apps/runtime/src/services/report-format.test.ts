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
  it('shares safe content and exact finding links while using a compact PR layout', () => {
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
      formatReviewMarkdown(report, [], {
        reportUrl,
        includeTitle: false,
        audience: 'pull-request',
      }),
    );
    expect(published.match(/Git Code Reviewer/g)).toHaveLength(1);
    expect(published.startsWith('<!-- synthetic -->')).toBe(true);
    expect(published).toContain('## 전체 분석 요약');
    expect(published).not.toContain('## Overall Summary');
    expect(published).not.toContain('## Analyzed File List');
    expect(markdown).toContain('<code>SESSION&#95;SECRET</code>');
    expect(markdown).toContain('> 💬 **P3 Critical');
    expect(markdown).toContain('<details>\n<summary><code>src/config.ts</code>');
  });
  it.each(['pull-request', 'full'] as const)(
    'keeps long overview and limitations outside disclosures in %s output',
    (audience) => {
      const changed = structuredClone(report);
      changed.summary =
        '전체 변경을 검토했습니다. '.repeat(60) + '\n\n## 확인 사항\n\n- 검토 의견을 확인하세요.';
      changed.coverage.limitations = ['대상 파일 일부 미검토', '추가 source 조회 범위 제한'];
      const before = JSON.stringify(changed);
      const body = formatReviewMarkdown(changed, [], { audience });
      const overview = body.slice(body.indexOf('## 전체 분석 요약'), body.indexOf('## 분석 제한'));
      const limitations = body.slice(
        body.indexOf('## 분석 제한'),
        body.indexOf(audience === 'full' ? '## Overall Summary' : '## AI Comments'),
      );
      expect(overview).toContain('##### 확인 사항\n\n- 검토 의견을 확인하세요');
      expect(overview).not.toMatch(/<\/?details|<summary>/);
      expect(limitations).toContain(
        '## 분석 제한 2건\n\n- 대상 파일 일부 미검토\n- 추가 source 조회 범위 제한',
      );
      expect(limitations).not.toMatch(/<\/?details|<summary>/);
      expect(JSON.stringify(changed)).toBe(before);
    },
  );
  it('collapses all AI Comments by default while keeping status and the full report link outside', () => {
    const body = renderReviewComment({
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
    const [before, rest] = body.split('## AI Comments\n\n');
    const [comments, after] = rest!.split('\n\n<details>\n<summary>적용 Model·Skill');
    expect(comments).toMatch(
      /^<details>\n<summary>검토 의견 4개 · 파일 2개 — 펼쳐 보기<\/summary>\n\n/,
    );
    expect(comments).toMatch(/\n\n<\/details>$/);
    expect(comments!.match(/<details>/g)).toHaveLength(1);
    expect(comments).not.toMatch(/<details[^>]*\bopen\b/);
    expect(comments).not.toContain('전체 review와 evidence 보기');
    expect(comments!.match(/> 💬 \*\*P3 Critical/g)).toHaveLength(report.findings.length);
    expect(comments).toContain(`### ${escapeReviewMarkdown('src/config.ts')}`);
    expect(comments).toContain(`### ${escapeReviewMarkdown('src/deleted.ts')}`);
    expect(comments).toContain('**영향**');
    expect(comments).toContain('**수정 제안**');
    for (const finding of report.findings) expect(comments).toContain(`finding=${finding.id}`);
    expect(before).toContain('BLOCKED');
    expect(before).toContain('P3 Critical');
    expect(before).toContain('## 전체 분석 요약');
    expect(comments).toContain('**파일 요약 · 검토 완료**');
    expect(after).toContain('[전체 review와 evidence 보기]');
    expect(after).toContain('이 댓글은 새 분석이 완료되면 같은 위치에서 갱신됩니다.');
  });
  it('does not create an empty AI Comments disclosure when no findings exist', () => {
    const changed = { ...report, findings: [] };
    const section = formatReviewMarkdown(changed)
      .split('## AI Comments\n\n')[1]!
      .split('\n\n## Analyzed File List')[0];
    expect(section).toBe('표시할 comment가 없습니다. 분석 상태와 제한을 함께 확인하세요.');
    expect(section).not.toContain('<details>');
  });
  it('omits uncommented files from PR comments but keeps full export and coverage limitations', () => {
    const changed = structuredClone(report);
    const hidden = changed.analysis!.files[1]!;
    changed.findings = changed.findings.filter(
      (finding) => finding.anchor.fileId !== hidden.fileId,
    );
    hidden.summary = '의견 없는 파일의 긴 설명';
    hidden.unitIds = [];
    hidden.priority = null;
    const before = JSON.stringify(changed);
    const pr = formatReviewMarkdown(changed, [], { audience: 'pull-request' });
    expect(pr).not.toContain(escapeReviewMarkdown(hidden.path));
    expect(pr).not.toContain(hidden.summary);
    expect(pr).not.toContain('## Analyzed File List');
    expect(pr).not.toContain('## Overall Summary');
    expect(pr).toContain('파일 요약');
    expect(pr).toContain('검토 의견 2개 · 파일 1개');
    expect(formatReviewMarkdown(changed)).toContain(escapeReviewMarkdown(hidden.path));
    expect(JSON.stringify(changed)).toBe(before);
    changed.analysis!.status = 'incomplete';
    changed.coverage.limitations = ['일부 검토 범위는 확인하지 못했습니다.'];
    changed.findings = [];
    const incomplete = formatReviewMarkdown(changed, [], { audience: 'pull-request' });
    expect(incomplete).toContain('분석 완료 · 제한 있음');
    expect(incomplete).toContain('일부 검토 범위는 확인하지 못했습니다');
    expect(incomplete).not.toContain('문제가 발견되지 않았습니다.');
    expect(incomplete).not.toContain('검토 의견 0개 · 파일');
  });
  it('renders readable lists and emphasis in summaries and comment blocks without permitting active content', () => {
    const changed = structuredClone(report);
    const narrative =
      '변경 요약입니다.\n\n## 검토 의견\n\n- **권한 검증**: `check()`를 확인하세요.\n- __예외 처리__: 반환값을 확인하세요.\n  - 실패 조건도 확인하세요.\n\n1. 입력 확인\n2. 오류 처리\n\n<script>@everyone</script> [링크](javascript:alert(1))';
    changed.summary = narrative;
    changed.analysis!.files[0]!.summary = narrative;
    changed.findings[0]!.problem = narrative;
    const markdown = formatReviewMarkdown(changed, [], { audience: 'pull-request' });
    expect(markdown).toContain('##### 검토 의견\n\n- **권한 검증**: <code>check&#40;&#41;</code>');
    expect(markdown).toContain('- **예외 처리**');
    expect(markdown).toContain('  - 실패 조건');
    expect(markdown).toContain('1. 입력 확인\n2. 오류 처리');
    expect(markdown).toContain('> - **권한 검증**');
    for (const unsafe of ['<script>', '@everyone', '[링크](javascript:', '\\- \\*\\*권한'])
      expect(markdown).not.toContain(unsafe);
  });
  it('does not allow comment content to close or open a disclosure', () => {
    const changed = structuredClone(report);
    const injected = '</details><details open><summary>@everyone</summary>';
    changed.findings[0]!.title = injected;
    changed.findings[0]!.problem = injected;
    changed.findings[0]!.impact = injected;
    changed.findings[0]!.recommendation = injected;
    const section = formatReviewMarkdown(changed)
      .split('## AI Comments\n\n')[1]!
      .split('\n\n## Analyzed File List')[0]!;
    expect(section).not.toContain(injected);
    expect(section).not.toContain('<details open>');
    expect(section).not.toContain('@everyone');
    expect(section.match(/<details>/g)).toHaveLength(1);
    expect(section.match(/<\/details>/g)).toHaveLength(1);
    expect(section.match(/<summary>/g)).toHaveLength(1);
    expect(section.match(/<\/summary>/g)).toHaveLength(1);
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
  it('shortens completed no-issue files in UI and Markdown without rewriting stored content or limitations', () => {
    const changed = structuredClone(report);
    const original =
      '이 파일은 2개로 계획된 검토 범위를 모두 확인했으며, 확정된 review unit이 없어 추가로 지적할 사항은 없습니다. 다만 이는 제공된 변경 범위에 대한 결과만을 의미합니다.';
    changed.analysis!.files.forEach((file) => {
      file.summary = original;
      file.unitIds = [];
      file.priority = null;
    });
    changed.analysis!.units = [];
    changed.analysis!.status = 'incomplete';
    changed.analysis!.priority = null;
    changed.findings = [];
    changed.coverage.limitations = ['추가 주변 source 조회 제한'];
    changed.summary = changed
      .analysis!.files.map((file) => `${file.path}: ${file.summary}`)
      .join('\n\n');
    const before = JSON.stringify(changed);
    const view = presentReviewReport(changed);
    const concise = '검토한 변경 범위에서 문제가 발견되지 않았습니다.';
    expect(view.groups.every((file) => file.summary === concise)).toBe(true);
    expect(view.overview).toBeNull();
    expect(view.label).toBe('분석 완료 · 제한 있음');
    const markdown = formatReviewMarkdown(changed);
    expect(markdown).toContain(escapeReviewMarkdown(concise));
    expect(markdown).toContain('추가 주변 source 조회 제한');
    expect(markdown).not.toContain('확정된 review unit');
    expect(JSON.stringify(changed)).toBe(before);

    for (const mode of ['fixture', 'disabled', 'rule-based'] as const) {
      changed.analysis!.mode = mode;
      expect(presentReviewReport(changed).groups[0]!.summary).toBe(original);
    }
    changed.analysis!.mode = 'ai-powered';
    for (const status of ['failed', 'unavailable', 'demo'] as const) {
      changed.analysis!.status = status;
      expect(presentReviewReport(changed).groups[0]!.summary).toBe(original);
    }
    changed.analysis!.status = 'incomplete';
    for (const status of ['partial', 'not-reviewed'] as const) {
      changed.analysis!.files[0]!.status = status;
      expect(presentReviewReport(changed).groups[0]!.summary).toBe(original);
    }
    changed.analysis!.files[0]!.status = 'reviewed';
    changed.findings = report.findings;
    expect(presentReviewReport(changed).groups[0]!.summary).toBe(original);
    changed.findings = [];
    changed.analysis!.files[0]!.unitIds = [randomUUID()];
    expect(presentReviewReport(changed).groups[0]!.summary).toBe(original);
    changed.analysis!.files[0]!.unitIds = [];
    changed.analysis!.files[0]!.priority = 'P2';
    expect(presentReviewReport(changed).groups[0]!.summary).toBe(original);
    delete changed.analysis;
    expect(presentReviewReport(changed).groups.every((file) => file.status === 'legacy')).toBe(
      true,
    );
    expect(presentReviewReport(changed).groups.every((file) => file.summary !== concise)).toBe(
      true,
    );
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
  it('omits an oversized AI Comments disclosure atomically within the PR publication limit', () => {
    const changed = structuredClone(report);
    changed.findings[0]!.problem = '긴 comment 본문'.repeat(10000);
    const body = renderReviewComment({
      context: {
        analysisId: changed.analysisRevisionId,
        owner: 'org-name',
        name: 'repo-name',
        pullNumber: 1,
        headSha: 'b'.repeat(40),
        report: changed,
      },
      findings: changed.findings,
      canonicalReport: changed,
      marker: '<!-- synthetic -->',
      publicBaseUrl: 'https://review.example',
    });
    expect(body.length).toBeLessThanOrEqual(60000);
    expect(body).toContain('길이 제한으로 일부 항목을 생략했습니다.');
    expect(body).toContain('BLOCKED');
    expect(body).toContain('P3 Critical');
    expect(body).not.toContain('긴 comment 본문');
    expect(body).not.toContain('검토 의견 4개 · 파일 2개 — 펼쳐 보기');
    expect(body.match(/<details>/g)?.length).toBe(body.match(/<\/details>/g)?.length);
    expect(body.match(/<summary>/g)?.length).toBe(body.match(/<\/summary>/g)?.length);
    expect(body.lastIndexOf('</details>')).toBeLessThan(body.indexOf('길이 제한'));
    expect(body).toContain(
      `[전체 review와 evidence 보기](https://review.example/reviews/${changed.analysisRevisionId})`,
    );
  });
});

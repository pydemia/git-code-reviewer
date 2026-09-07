import type { Database } from '@gcr/db';
import type { GitHubReader, GitHubReviewPublisher } from '@gcr/github';
import { describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../config.js';
import { publishReviewToGitHub, renderReviewComment } from './review-publication.js';

const context = {
  analysisId: '8de3ff59-e936-4822-9fc8-d79be6af7d02',
  owner: 'platform',
  name: 'reviewer-api',
  pullNumber: 17,
  headSha: 'd91b7a4f19af10fcb571cefb2d8a61495166c11a',
  report: {
    grade: 'insufficient' as const,
    summary: '권한 검증에 @all 호출과 <script>가 포함되어 있습니다.',
    hasCriticalFindings: true,
    coverage: {
      filesChanged: 7,
      filesExamined: 6,
      objectsExamined: 10,
      relationsExamined: 8,
      truncated: true,
      limitations: ['binary file 제외'],
    },
  },
};

describe('GitHub review publication', () => {
  it('renders a bounded Korean PR summary with a stable marker and report link', () => {
    const findings = Array.from({ length: 7 }, (_, index) => ({
      priority: (index === 0 ? 'P3' : 'P2') as 'P3' | 'P2',
      title: `권한 검증 ${index + 1}`,
      problem: '검증되지 않은 값이 사용됩니다.',
      recommendation: '명시적으로 검증하십시오.',
    }));
    const body = renderReviewComment({
      context,
      findings,
      marker: '<!-- git-code-reviewer:managed -->',
      publicBaseUrl: 'https://review.example.internal',
    });

    expect(body.startsWith('<!-- git-code-reviewer:managed -->')).toBe(true);
    expect(body).toContain('## Git Code Reviewer 결과');
    expect(body).toContain('| Findings | 1 | 6 | 0 | 0 |');
    expect(body).toContain('6/7 files를 검사했습니다.');
    expect(body).toContain(
      'https://review.example.internal/reviews/8de3ff59-e936-4822-9fc8-d79be6af7d02',
    );
    expect(body).not.toContain('@all');
    expect(body).not.toContain('<script>');
    expect(body).not.toContain('권한 검증 6');
  });

  it('states when no actionable finding exists', () => {
    const body = renderReviewComment({
      context: {
        ...context,
        report: {
          ...context.report,
          grade: 'proficient',
          hasCriticalFindings: false,
          coverage: { ...context.report.coverage, truncated: false, limitations: [] },
        },
      },
      findings: [
        {
          priority: 'P0',
          title: '테스트가 추가되었습니다.',
          problem: '문제 없음',
          recommendation: '유지하십시오.',
        },
      ],
      marker: '<!-- git-code-reviewer:managed -->',
    });
    expect(body).toContain('조치가 필요한 finding은 발견되지 않았습니다.');
    expect(body).not.toContain('전체 review와 evidence 보기');
  });

  it('publishes with the stored comment id and persists publication metadata', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('from analysis_runs analysis')) {
        return {
          rows: [
            {
              analysisId: context.analysisId,
              analysisCreatedAt: '2026-09-07T01:00:00.000Z',
              pullRequestId: '361d30e9-21e3-4638-96c7-c5a644c0747a',
              pullNumber: 17,
              repositoryId: '74546f97-2da7-4d4a-9a02-244126cb8c2c',
              credentialId: null,
              installationId: '10',
              apiBaseUrl: 'https://github.example/api/v3/',
              owner: context.owner,
              name: context.name,
              headSha: context.headSha,
              reportId: '26067e71-af4d-466f-9344-bf1cddf6fb03',
              ...context.report,
            },
          ],
        };
      }
      if (sql.includes('from github_review_publications publication')) {
        return {
          rows: [{ commentId: '91', bodyHash: null, publishedAnalysisCreatedAt: null }],
        };
      }
      if (sql.includes('from findings')) {
        return {
          rows: [
            {
              priority: 'P3',
              title: '권한 검증',
              problem: '검증되지 않은 값이 사용됩니다.',
              recommendation: '명시적으로 검증하십시오.',
            },
          ],
        };
      }
      if (sql.includes('insert into event_log')) return { rows: [{ id: '1' }] };
      return { rows: [], rowCount: 1 };
    });
    const connection = { query, release: vi.fn() };
    const database = { connect: vi.fn(async () => connection) } as unknown as Database;
    const upsertPullRequestComment = vi.fn(async () => ({
      commentId: 91,
      commentUrl: 'https://github.example/platform/reviewer-api/pull/17#issuecomment-91',
      outcome: 'updated' as const,
    }));
    const github = {
      listOpenPulls: vi.fn(),
      upsertPullRequestComment,
    } as unknown as GitHubReader & GitHubReviewPublisher;

    await publishReviewToGitHub(
      database,
      github,
      {
        PUBLIC_BASE_URL: 'https://review.example.internal',
        SESSION_SECRET: 'test-session-secret',
      } as AppConfig,
      {
        id: 'job-id',
        payload: {
          analysisId: context.analysisId,
          pullRequestId: '361d30e9-21e3-4638-96c7-c5a644c0747a',
        },
      },
    );

    expect(upsertPullRequestComment).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'platform', name: 'reviewer-api' }),
      expect.objectContaining({ pullNumber: 17, existingCommentId: 91 }),
    );
    expect(
      query.mock.calls.some(([sql]) => String(sql).includes('published_analysis_run_id = $2')),
    ).toBe(true);
    expect(connection.release).toHaveBeenCalledOnce();
  });
});

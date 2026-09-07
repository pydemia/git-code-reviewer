import { describe, expect, it } from 'vitest';
import {
  githubRepositoryExample,
  normalizeGitHubBaseUrl,
  parseGitHubRepositoryUrl,
} from './github-urls.js';

describe('GitHub repository URL input', () => {
  it.each(['', '/', '.git', '.git/'])(
    'extracts owner/name from the repository URL with suffix %s',
    (suffix) => {
      expect(
        parseGitHubRepositoryUrl(` ${githubRepositoryExample}${suffix} `, 'https://github.com'),
      ).toEqual({
        owner: 'org-name',
        name: 'repo-name',
        url: githubRepositoryExample,
      });
    },
  );
  it('supports a private GHES origin including its port', () => {
    expect(
      parseGitHubRepositoryUrl(
        'https://git.internal:8443/team/backend',
        'https://git.internal:8443/',
      ).owner,
    ).toBe('team');
  });
  it.each([
    'https://github.com/org-name',
    `${githubRepositoryExample}/pull/1`,
    `${githubRepositoryExample}/tree/main`,
    `${githubRepositoryExample}?token=secret`,
    'https://user:secret@github.com/org-name/backend',
    'git@github.com:org-name/backend.git',
    'https://api.github.com/repos/org-name/backend',
    'https://github.com.evil.example/org-name/backend',
    'http://github.com/org-name/backend',
    'https://github.com/org-name/encoded%2Frepo',
  ])('rejects invalid URLs or connection origin mismatch: %s', (value) => {
    expect(() => parseGitHubRepositoryUrl(value, 'https://github.com')).toThrow();
  });
});

describe('GitHub base URL input', () => {
  it('normalizes GitHub.com and GHES examples', () => {
    expect(normalizeGitHubBaseUrl('https://api.github.com', 'api')).toBe('https://api.github.com/');
    expect(normalizeGitHubBaseUrl('https://github.com', 'web')).toBe('https://github.com/');
    expect(normalizeGitHubBaseUrl('https://git.internal/api/v3', 'api')).toBe(
      'https://git.internal/api/v3/',
    );
  });
  it.each([
    ['https://github.com', 'api'],
    ['https://api.github.com/api/v3', 'api'],
    ['https://github.com/org-name', 'web'],
    ['https://api.github.com', 'web'],
    ['https://github.com?token=secret', 'web'],
    ['https://secret@api.github.com', 'api'],
  ] as const)('rejects confusing base URL %s (%s)', (url, kind) => {
    expect(() => normalizeGitHubBaseUrl(url, kind)).toThrow();
  });
});

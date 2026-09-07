export const githubRepositoryExample = 'https://github.com/org-name/repo-name';

export function normalizeGitHubBaseUrl(value: string, kind: 'api' | 'web'): string {
  const label = kind === 'api' ? 'API base URL' : 'Web base URL';
  const url = parseHttpUrl(value, label);
  if (url.search || url.hash) throw new Error(`${label}에는 query나 fragment를 넣지 마십시오.`);
  const path = url.pathname.replace(/\/+$/, '');
  if (kind === 'web') {
    if (path || url.hostname === 'api.github.com') {
      throw new Error(
        'Web base URL에는 organization이나 repository 경로 없이 https://github.com처럼 사이트 주소만 입력하십시오.',
      );
    }
  } else if (url.hostname === 'github.com') {
    throw new Error(
      'GitHub.com의 API base URL은 https://api.github.com입니다. https://github.com은 Web base URL에 입력하십시오.',
    );
  } else if (url.hostname === 'api.github.com' ? Boolean(path) : path !== '/api/v3') {
    throw new Error(
      'API base URL은 GitHub.com이면 https://api.github.com, 사내 GHES이면 https://사내-host/api/v3 형식입니다. Organization이나 repository 경로는 넣지 마십시오.',
    );
  }
  if (
    ['github.com', 'api.github.com'].includes(url.hostname) &&
    (url.protocol !== 'https:' || url.port)
  ) {
    throw new Error(`${label}의 GitHub.com 주소에는 HTTPS와 기본 port를 사용하십시오.`);
  }
  url.pathname = kind === 'api' && path ? `${path}/` : '/';
  return url.toString();
}

export function parseGitHubRepositoryUrl(
  value: string,
  webBaseUrl?: string,
): {
  owner: string;
  name: string;
  url: string;
} {
  const url = parseHttpUrl(value, 'Repository URL');
  if (webBaseUrl && url.origin !== new URL(normalizeGitHubBaseUrl(webBaseUrl, 'web')).origin) {
    throw new Error(
      'Repository URL의 host가 선택한 연결의 Web base URL과 다릅니다. 해당 GitHub 연결을 선택하십시오.',
    );
  }
  const match = url.pathname.match(/^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/?$/);
  const owner = match?.[1];
  const name = match?.[2]?.replace(/\.git$/i, '');
  if (
    !owner ||
    !name ||
    ['.', '..'].includes(owner) ||
    ['.', '..'].includes(name) ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      `Repository URL에는 ${githubRepositoryExample}처럼 repository의 전체 주소를 입력하십시오. PR·branch·file 경로는 제외합니다.`,
    );
  }
  return { owner, name, url: `${url.origin}/${owner}/${name}` };
}

function parseHttpUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error(`${label}에 https://로 시작하는 전체 주소를 입력하십시오.`);
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    value.includes('\\')
  ) {
    throw new Error(`${label}에는 token·username·password가 없는 HTTP(S) 주소를 입력하십시오.`);
  }
  return url;
}

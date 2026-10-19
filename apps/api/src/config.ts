export interface GitLabConfig {
  url: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  webOrigin: string;
  secureCookies: boolean;
}

export function readGitLabConfig(env: NodeJS.ProcessEnv = process.env): GitLabConfig | undefined {
  const names = ['GITLAB_URL', 'GITLAB_CLIENT_ID', 'GITLAB_CLIENT_SECRET', 'GITLAB_REDIRECT_URI', 'WEB_ORIGIN'] as const;
  if (names.every(name => !env[name]?.trim())) return undefined;
  if (names.some(name => !env[name]?.trim())) throw new Error('GitLab OAuth configuration is incomplete: set GITLAB_URL, GITLAB_CLIENT_ID, GITLAB_CLIENT_SECRET, GITLAB_REDIRECT_URI and WEB_ORIGIN');
  const instance = checkedUrl(env.GITLAB_URL!);
  const redirect = checkedUrl(env.GITLAB_REDIRECT_URI!);
  const origin = checkedUrl(env.WEB_ORIGIN!);
  if (instance.search || instance.hash || redirect.search || redirect.hash || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Invalid GitLab OAuth URLs');
  if (redirect.origin !== origin.origin || redirect.pathname !== '/api/auth/callback') throw new Error('OAuth callback must be WEB_ORIGIN/api/auth/callback');
  return {
    url: instance.href.replace(/\/+$/, ''), clientId: env.GITLAB_CLIENT_ID!.trim(), clientSecret: env.GITLAB_CLIENT_SECRET!.trim(),
    redirectUri: redirect.href, webOrigin: origin.origin, secureCookies: origin.protocol === 'https:'
  };
}
function checkedUrl(value: string): URL {
  const url = new URL(value);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))) throw new Error('Use HTTPS URLs (HTTP is only supported for local development)');
  return url;
}

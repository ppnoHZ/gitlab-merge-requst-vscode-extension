import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createApp } from '../src/app';
import { readGitLabConfig } from '../src/config';
import type { ReleaseOverviewSnapshot, WebStatus } from '@gitlab-workbench/core';

async function listen(server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}
async function close(server: Server) { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
function cookies(response: Response): string { return response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => !value.endsWith('=')).join('; '); }

test('OAuth through GitLab HTTP to project/branch/MR overview; permissions, expiry, pagination and logout', async () => {
  let challenge = '';
  let refreshCalls = 0;
  let failMr = false;
  let revokeMr = false;
  const urls: URL[] = [];
  const project = { id: 1, name: 'Project', path_with_namespace: 'company/project', web_url: 'https://gitlab.company.test/company/project' };
  const upstream = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://local'); urls.push(url);
    response.setHeader('Content-Type', 'application/json');
    const send = (body: unknown, next?: string) => { if (next !== undefined) response.setHeader('x-next-page', next); response.end(JSON.stringify(body)); };
    if (url.pathname === '/oauth/token') {
      let body = ''; for await (const chunk of request) body += chunk;
      const form = new URLSearchParams(body);
      assert.equal(form.get('client_secret'), 'test-client-secret');
      if (form.get('grant_type') === 'refresh_token') {
        refreshCalls++; assert.equal(form.get('refresh_token'), 'test-refresh-token');
        return send({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: 3600 });
      }
      assert.equal(createHash('sha256').update(form.get('code_verifier')!).digest('base64url'), challenge);
      return send({ access_token: 'test-access-token', refresh_token: 'test-refresh-token', expires_in: form.get('code') === 'expiring' ? 1 : 3600 });
    }
    assert.equal(request.headers.authorization, 'Bearer test-access-token');
    if (url.pathname === '/api/v4/user') return send({ id: 7, name: 'Alice', username: 'alice', private_token: 'must-not-leak' });
    if (url.pathname === '/api/v4/projects') {
      assert.equal(url.searchParams.get('membership'), 'true');
      return send([project], url.searchParams.get('page') === '1' ? '2' : '');
    }
    if (url.pathname === '/api/v4/projects/2') { response.statusCode = 403; return send({ secret: 'must-not-leak' }); }
    if (url.pathname === '/api/v4/projects/1') return send({ ...project, http_url_to_repo: `${base}/company/project.git` });
    if (url.pathname.endsWith('/repository/branches')) {
      return url.searchParams.get('page') === '1'
        ? send([{ name: 'main' }, { name: 'release/v1', commit: { author_name: 'Alice', committed_date: '2026-10-19T00:00:00Z' } }, { name: 'feature/v1/missing' }, { name: 'feature/v10/other' }], '2')
        : send([{ name: 'feature/v1/open' }], '');
    }
    if (url.pathname.endsWith('/merge_requests')) {
      assert.equal(url.searchParams.get('target_branch'), 'release/v1');
      if (failMr) { response.statusCode = 403; return send({ secret: 'must-not-leak' }); }
      if (revokeMr) { response.statusCode = 401; return send({ secret: 'must-not-leak' }); }
      const item = (source: string, state: string, iid: number) => ({ source_branch: source, target_branch: 'release/v1', state, iid, title: 'Real change', web_url: `${base}/mr/${iid}` });
      return url.searchParams.get('page') === '1' ? send([item('feature/v1/deleted', 'merged', 1)], '2') : send([item('feature/v1/open', 'opened', 2)], '');
    }
    response.statusCode = 404; send({ error: 'unknown path' });
  });
  const base = await listen(upstream);
  let repositoryCalls = 0;
  const app = createApp({ config: { url: base, clientId: 'test-client', clientSecret: 'test-client-secret', redirectUri: 'http://127.0.0.1:5173/api/auth/callback', webOrigin: 'http://127.0.0.1:5173', secureCookies: false },
    checkRepository: async (_session, id, remote, token, branches) => {
      repositoryCalls++; assert.equal(id, 1); assert.equal(remote, `${base}/company/project.git`); assert.equal(token, 'test-access-token'); assert.deepEqual(branches, ['main', 'release/v1']);
      return new Set(['release/v1']);
    } });
  const appBase = await listen(app);
  async function login(code = 'valid'): Promise<string> {
    const start = await fetch(`${appBase}/api/auth/login`, { redirect: 'manual' });
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get('location')!);
    assert.equal(authorize.pathname, '/oauth/authorize');
    assert.equal(authorize.searchParams.get('scope'), 'read_user read_api read_repository');
    assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
    challenge = authorize.searchParams.get('code_challenge')!;
    const done = await fetch(`${appBase}/api/auth/callback?${new URLSearchParams({ code, state: authorize.searchParams.get('state')! })}`, { headers: { cookie: cookies(start) }, redirect: 'manual' });
    assert.equal(done.status, 302);
    assert.equal(done.headers.get('location'), 'http://127.0.0.1:5173/');
    assert(done.headers.getSetCookie().some(value => value.includes('workbench_session=') && value.includes('HttpOnly') && value.includes('SameSite=Lax')));
    return cookies(done);
  }
  try {
    assert.equal((await fetch(`${appBase}/api/projects`)).status, 401);
    assert.equal((await fetch(`${appBase}/api/auth/callback?state=invalid&code=bad`)).status, 400);
    const pendingLogin = await fetch(`${appBase}/api/auth/login`, { redirect: 'manual' });
    const pendingLocation = new URL(pendingLogin.headers.get('location')!);
    assert.equal((await fetch(`${appBase}/api/auth/callback?state=wrong&code=bad`, { headers: { cookie: cookies(pendingLogin) } })).status, 400);
    assert.equal((await fetch(`${appBase}/api/auth/callback?state=${pendingLocation.searchParams.get('state')}&code=bad`, { headers: { cookie: cookies(pendingLogin) } })).status, 400, 'OAuth state is one-time even after a failed callback');
    const session = await login();
    const headers = { cookie: session };
    const status = await (await fetch(`${appBase}/api/status`, { headers })).json() as WebStatus;
    assert(status.gitlab.connected && status.gitlab.configured && status.csrfToken);
    assert.deepEqual(status.gitlab.user, { id: 7, name: 'Alice', username: 'alice' });
    assert(!JSON.stringify(status).includes('test-access-token'));
    assert(!JSON.stringify(status).includes('must-not-leak'));
    const list = await (await fetch(`${appBase}/api/projects?search=company%20%26%20one&page=1`, { headers })).json();
    assert.equal(list.items[0].id, 1); assert.equal(list.hasMore, true);
    assert(urls.some(url => url.searchParams.get('search') === 'company & one'));
    assert.equal((await fetch(`${appBase}/api/projects?page=-1`, { headers })).status, 400);
    assert.equal((await fetch(`${appBase}/api/projects/2/overview`, { headers })).status, 403);
    assert.equal(repositoryCalls, 0);
    const result = await (await fetch(`${appBase}/api/projects/1/overview`, { headers })).json() as ReleaseOverviewSnapshot;
    assert.equal(result.project, 'company/project');
    assert.deepEqual(result.entries[0].features.map(item => [item.branch, item.state]), [['feature/v1/deleted', 'merged'], ['feature/v1/missing', 'not-created'], ['feature/v1/open', 'open']]);
    assert.equal(result.entries[0].mergedIntoMain, true);
    assert.equal(result.entries[0].committedDate, '2026-10-19T00:00:00Z');
    failMr = true;
    const partialResponse = await fetch(`${appBase}/api/projects/1/overview`, { headers });
    const partial = await partialResponse.json() as ReleaseOverviewSnapshot;
    assert.equal(partialResponse.status, 200);
    assert(partial.entries[0].error?.includes('权限'));
    assert.equal(partial.entries[0].features.length, 0, 'failed MR load must never invent missing MRs');
    assert(!JSON.stringify(partial).includes('must-not-leak'));
    failMr = false;
    assert.equal((await fetch(`${appBase}/api/auth/logout`, { method: 'POST', headers })).status, 403);
    assert.equal((await fetch(`${appBase}/api/auth/logout`, { method: 'POST', headers: { ...headers, Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': status.csrfToken! } })).status, 200);
    assert.equal((await fetch(`${appBase}/api/projects`, { headers })).status, 401);
    const expiring = await login('expiring');
    await Promise.all([fetch(`${appBase}/api/status`, { headers: { cookie: expiring } }), fetch(`${appBase}/api/projects`, { headers: { cookie: expiring } })]);
    assert.equal(refreshCalls, 1, 'concurrent requests refresh OAuth once');
    revokeMr = true;
    assert.equal((await fetch(`${appBase}/api/projects/1/overview`, { headers: { cookie: expiring } })).status, 401);
    const revokedStatus = await (await fetch(`${appBase}/api/status`, { headers: { cookie: expiring } })).json() as WebStatus;
    assert.equal(revokedStatus.gitlab.connected, false);
  } finally { await close(app); await close(upstream); }
});

test('configuration reserves unset fields and rejects unsafe/incomplete redirects', () => {
  assert.equal(readGitLabConfig({}), undefined);
  assert.throws(() => readGitLabConfig({ GITLAB_URL: 'https://gitlab.example.com' }), /incomplete/);
  const values = { GITLAB_URL: 'https://gitlab.example.com', GITLAB_CLIENT_ID: 'id', GITLAB_CLIENT_SECRET: 'secret', GITLAB_REDIRECT_URI: 'http://127.0.0.1:5173/api/auth/callback', WEB_ORIGIN: 'http://127.0.0.1:5173' };
  assert.equal(readGitLabConfig(values)?.secureCookies, false);
  assert.throws(() => readGitLabConfig({ ...values, GITLAB_URL: 'http://gitlab.example.com' }), /HTTPS/);
  assert.throws(() => readGitLabConfig({ ...values, GITLAB_REDIRECT_URI: 'https://evil.example.com/api/auth/callback' }), /callback/);
});

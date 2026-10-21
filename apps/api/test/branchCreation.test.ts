import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { test } from 'node:test';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileBranchAudit } from '../src/branchCreation';
import { createApp } from '../src/app';
import { branchName, type BranchDraft } from '@gitlab-workbench/core';

async function listen(server: Server) { await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const a = server.address(); assert(a && typeof a !== 'string'); return `http://127.0.0.1:${a.port}`; }
async function close(server: Server) { await new Promise<void>(resolve => server.close(() => resolve())); }
const cookie = (r: Response) => r.headers.getSetCookie().map(v => v.split(';')[0]).filter(v => !v.endsWith('=')).join('; ');

test('release/hotfix HTTP creation: confirmation, CSRF, tags, stale SHA, audit and uncertain POST reconciliation', async () => {
  let main = 'a'.repeat(40); const tag = 'b'.repeat(40); let writes = 0; let loseResponse = false; let dontCreate = false; let auditFail = false;
  const stored = new Map<string, string>(); const events: Record<string, unknown>[] = [];
  const upstream = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    const u = new URL(req.url!, 'http://local'); const send = (body: unknown) => res.end(JSON.stringify(body));
    if (u.pathname === '/oauth/token') return send({ access_token: 'test-token', expires_in: 3600 });
    if (u.pathname === '/api/v4/user') return send({ id: 1, name: 'User', username: 'user' });
    if (u.pathname === '/api/v4/projects/1') return send({ id: 1, name: 'P', path_with_namespace: 'group/project', web_url: `${base}/group/project`, http_url_to_repo: `${base}/group/project.git`, default_branch: 'main' });
    const ref = (name: string, sha: string) => ({ name, commit: { id: sha, title: 'baseline', committed_date: '2026-10-21T00:00:00Z' } });
    if (u.pathname === '/api/v4/projects/1/repository/branches' && req.method === 'POST') {
      writes++; let raw = ''; for await (const chunk of req) raw += chunk; const body = JSON.parse(raw);
      assert(/^[ab]{40}$/.test(body.ref), 'POST must use the confirmed immutable SHA');
      if (stored.has(body.branch)) { res.statusCode = 400; return send({ message: 'exists' }); }
      if (!dontCreate) stored.set(body.branch, body.ref);
      if (loseResponse) { req.socket.destroy(); return; }
      return send(ref(body.branch, body.ref));
    }
    if (u.pathname === '/api/v4/projects/1/repository/branches') { res.setHeader('x-next-page', ''); return send([ref('main', main)]); }
    const match = u.pathname.match(/repository\/(branches|tags)\/(.+)$/);
    if (match) {
      const name = decodeURIComponent(match[2]);
      const sha = match[1] === 'tags' && name === 'v1' ? tag : name === 'main' ? main : stored.get(name);
      if (sha) return send(ref(name, sha));
      res.statusCode = 404; return send({ message: 'missing' });
    }
    res.statusCode = 404; send({ message: 'missing' });
  });
  const base = await listen(upstream);
  const app = createApp({ config: { url: base, clientId: 'id', clientSecret: 'secret', redirectUri: 'http://127.0.0.1:5173/api/auth/callback', webOrigin: 'http://127.0.0.1:5173', secureCookies: false, allowBranchCreation: true }, branchAudit: async event => { if (auditFail) throw new Error('disk full'); events.push(event); } });
  const host = await listen(app);
  try {
    const start = await fetch(host + '/api/auth/login', { redirect: 'manual' }); const auth = new URL(start.headers.get('location')!);
    assert.equal(auth.searchParams.get('scope'), 'api read_repository');
    const done = await fetch(host + '/api/auth/callback?code=ok&state=' + auth.searchParams.get('state'), { redirect: 'manual', headers: { cookie: cookie(start) } });
    const c = cookie(done); const status = await (await fetch(host + '/api/status', { headers: { cookie: c } })).json();
    assert.equal(status.branchCreationEnabled, true);
    const headers = { cookie: c, Origin: 'http://127.0.0.1:5173', 'X-CSRF-Token': status.csrfToken, 'Content-Type': 'application/json' };
    const post = (path: string, body: unknown, h = headers) => fetch(host + '/api/projects/1/branches' + path, { method: 'POST', headers: h, body: JSON.stringify(body) });
    const draft: BranchDraft = { kind: 'release', version: '2.8.0', baseKind: 'branch', baseName: 'main' };
    assert.equal((await post('/preview', draft, { ...headers, 'X-CSRF-Token': 'wrong' })).status, 403);
    const refs = await (await fetch(host + '/api/projects/1/refs', { headers })).json(); assert.equal(refs.defaultBranch, 'main');
    const preview = await (await post('/preview', draft)).json(); assert.equal(preview.base.sha, main); assert.equal(preview.branch, 'release/2.8.0'); assert.equal(writes, 0);
    main = 'c'.repeat(40);
    assert.equal((await post('', { ticket: preview.ticket })).status, 409); assert.equal(writes, 0);
    main = 'a'.repeat(40);
    const ready = await (await post('/preview', draft)).json();
    const responses = await Promise.all([post('', { ticket: ready.ticket }), post('', { ticket: ready.ticket })]);
    assert(responses.every(r => r.status === 200)); assert.equal(writes, 1); assert.equal(stored.get('release/2.8.0'), main);
    assert.equal((await post('', { ticket: ready.ticket })).status, 200); assert.equal(writes, 1);
    assert.equal((await post('/preview', draft)).status, 409);
    assert(events.some(e => e.outcome === 'created' && e.actor === 1 && e.sha === main));
    assert(!JSON.stringify(events).includes('test-token'));
    const hotfix = { ...draft, kind: 'hotfix', version: '2.7.1', issue: 'PROJ-1', baseKind: 'tag', baseName: 'v1' };
    const hotPreview = await (await post('/preview', hotfix)).json(); assert.equal(hotPreview.base.sha, tag);
    loseResponse = true;
    const recovered = await (await post('', { ticket: hotPreview.ticket })).json(); assert.equal(recovered.recovered, true); assert.equal(writes, 2);
    dontCreate = true;
    const uncertain = await (await post('/preview', { ...hotfix, issue: 'PROJ-2' })).json();
    assert.equal((await post('', { ticket: uncertain.ticket })).status, 502); const attempted = writes;
    assert.equal((await post('', { ticket: uncertain.ticket })).status, 502); assert.equal(writes, attempted, 'uncertain retries only query; never issue a second POST');
    loseResponse = false; dontCreate = false;
    const audited = await (await post('/preview', { ...draft, version: '3.0.0' })).json(); auditFail = true;
    assert.equal((await post('', { ticket: audited.ticket })).status, 503); assert.equal(writes, attempted, 'audit must be durable before mutation');
    assert.equal((await post('', { ticket: 'tampered' })).status, 409);
    assert.equal((await post('/preview', { ...draft, version: '../main' })).status, 400);
  } finally { await close(app); await close(upstream); }
});

test('branch name rules distinguish release and hotfix and reject unsafe segments', () => {
  assert.equal(branchName({ kind: 'release', version: '2.8.0' }), 'release/2.8.0');
  assert.equal(branchName({ kind: 'hotfix', version: '2.7.1', issue: 'PROJ-123', description: 'fix-login' }), 'hotfix/2.7.1/PROJ-123-fix-login');
  for (const version of ['a..b', 'bad.lock', 'v1/', 'bad name']) assert.throws(() => branchName({ kind: 'release', version }));
  assert.throws(() => branchName({ kind: 'hotfix', version: 'v1' }));
});

test('branch audit persists complete JSON records with restricted file permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'branch-audit-'));
  const old = process.env.WORKBENCH_DATA_DIR;
  process.env.WORKBENCH_DATA_DIR = directory;
  try {
    await fileBranchAudit({ actor: 1, branch: 'release/v1', outcome: 'requested' });
    await fileBranchAudit({ actor: 1, branch: 'release/v1', outcome: 'created' });
    const path = join(directory, 'branch-creations.jsonl');
    const records = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(records.map(record => record.outcome), ['requested', 'created']);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    if (old === undefined) delete process.env.WORKBENCH_DATA_DIR; else process.env.WORKBENCH_DATA_DIR = old;
    await rm(directory, { recursive: true, force: true });
  }
});

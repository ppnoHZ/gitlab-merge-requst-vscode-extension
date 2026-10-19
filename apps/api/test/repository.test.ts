import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { RepositoryChecks } from '../src/repository';

test('Web Git checks use authenticated HTTP, support squash/rebase and fresh SHAs without embedding credentials', async () => {
  const root = mkdtempSync(join(tmpdir(), 'web-git-test-'));
  const seed = join(root, 'seed'); const remote = join(root, 'repo.git');
  mkdirSync(seed);
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(root, 'init', '--bare', remote); git(seed, 'init', '-b', 'main');
  git(seed, 'config', 'user.email', 'test@example.test'); git(seed, 'config', 'user.name', 'Web test');
  function commit(file: string, text: string) { writeFileSync(join(seed, file), text); git(seed, 'add', file); git(seed, 'commit', '-m', file); }
  commit('base', 'base'); const base = git(seed, 'rev-parse', 'HEAD');
  git(seed, 'switch', '-c', 'release/normal'); commit('normal', 'normal'); git(seed, 'switch', 'main'); git(seed, 'merge', '--no-ff', 'release/normal', '-m', 'merge');
  git(seed, 'switch', '-c', 'release/squash', base); commit('squash', 'one'); commit('squash', 'two'); git(seed, 'switch', 'main'); git(seed, 'merge', '--squash', 'release/squash'); git(seed, 'commit', '-m', 'squash');
  git(seed, 'switch', '-c', 'release/rebase', base); commit('rebased', 'rebased'); const rebased = git(seed, 'rev-parse', 'HEAD'); git(seed, 'switch', 'main'); git(seed, 'cherry-pick', rebased);
  git(seed, 'switch', '-c', 'release/pending', base); commit('pending', 'pending');
  git(seed, 'switch', '-c', 'release/conflict', base); commit('base', 'branch'); git(seed, 'switch', 'main'); commit('base', 'main'); commit('later', 'later');
  git(seed, 'remote', 'add', 'origin', remote); git(seed, 'push', 'origin', '--all');
  let authenticated = 0;
  const server = createServer(async (request, response) => {
    if (request.headers.authorization !== 'Basic ' + Buffer.from('oauth2:test-git-token').toString('base64')) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="GitLab"' }); response.end(); return;
    }
    authenticated++;
    const url = new URL(request.url!, 'http://local');
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    try {
      const output = execFileSync('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: request.method!, CONTENT_TYPE: request.headers['content-type'] ?? '', REMOTE_USER: 'oauth2' },
        input: Buffer.concat(chunks), maxBuffer: 16 * 1024 * 1024 });
      const split = output.indexOf('\r\n\r\n'); assert(split >= 0);
      for (const line of output.subarray(0, split).toString().split('\r\n')) {
        const index = line.indexOf(':'); const name = line.slice(0, index); const value = line.slice(index + 1).trim();
        if (name === 'Status') response.statusCode = Number(value.split(' ')[0]); else response.setHeader(name, value);
      }
      response.end(output.subarray(split + 4));
    } catch { response.statusCode = 500; response.end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert(address && typeof address !== 'string');
  const url = `http://127.0.0.1:${address.port}`;
  const checks = new RepositoryChecks(url);
  try {
    const branches = ['main', 'release/normal', 'release/squash', 'release/rebase', 'release/pending', 'release/conflict'];
    const result = await checks.check('test-session', 1, `${url}/repo.git`, 'test-git-token', branches);
    assert.deepEqual([...result].sort(), ['release/normal', 'release/rebase', 'release/squash']);
    assert(authenticated > 0);
    git(seed, 'switch', 'release/squash'); commit('new', 'new after merge'); git(seed, 'push', 'origin', 'release/squash');
    const fresh = await checks.check('test-session', 1, `${url}/repo.git`, 'test-git-token', [...branches, 'release/missing']);
    assert.equal(fresh.has('release/squash'), false);
    assert(fresh.errors?.has('release/missing'));
    const cacheRoot = (checks as unknown as { root: string }).root;
    for (const file of ['config', 'askpass.cjs']) assert(!readFileSync(join(cacheRoot, 'test-session', '1', file), 'utf8').includes('test-git-token'));
    assert.throws(() => checks.check('test-session', 1, 'https://other.example/repo.git', 'test-git-token', branches), /实例不一致/);
    assert.throws(() => checks.check('../escape', 1, `${url}/repo.git`, 'test-git-token', branches), /标识无效/);
  } finally {
    await checks.dispose();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

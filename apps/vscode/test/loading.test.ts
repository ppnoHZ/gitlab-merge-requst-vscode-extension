import assert from 'assert';
import axios from 'axios';
import { createServer } from 'http';
import { GitLabService } from '../src/gitlabService';
import { GitHubProvider } from '../src/providers/githubProvider';
import './vscodeMock';
import { createRepositoryProvider, invalidateRepositoryProviders } from '../src/providers/factory';
import { resolveProviderConnection } from '../src/providers/connection';
import { matchesBranchSearch } from '../src/providers/githubProvider';
import { SharedReads } from '../src/providers/sharedReads';
import { countPendingApprovals } from '../src/reviewStatus';
import { PendingReviewsProvider } from '../src/pendingReviewsView';
import { ReleaseOverviewProvider } from '../src/releaseOverviewView';
import type { ReleaseOverviewSnapshot } from '../src/releaseOverview';
import type { RepositoryProvider } from '../src/providers/repositoryProvider';

async function run() {
  const nativeAdapter = axios.defaults.adapter;
  assert(matchesBranchSearch('feature/v1/ABC', '^feature/v1/'));
  assert(!matchesBranchSearch('other/feature/v1/ABC', '^feature/v1/'));
  assert(!matchesBranchSearch('feature/v10/ABC', '^feature/v1/'));
  assert(matchesBranchSearch('feature/v1/ABC', 'abc$'));
  assert(matchesBranchSearch('release/v1.2', '^release/v1.2$'));
  assert(!matchesBranchSearch('release/v1x2', '^release/v1.2$'));
  let now = 0; let calls = 0; let finish!: (value: { count: number }) => void;
  const reads = new SharedReads(10, () => now);
  const first = reads.read('x', () => { calls++; return new Promise<{ count: number }>(resolve => { finish = resolve; }); });
  const second = reads.read('x', async () => { calls++; return { count: 2 }; });
  await Promise.resolve(); now = 100; finish({ count: 1 });
  const [a, b] = await Promise.all([first, second]); assert.equal(calls, 1);
  a.count = 9; assert.equal(b.count, 1);
  assert.equal((await reads.read('x', async () => ({ count: 2 }))).count, 1);
  now = 111; assert.equal((await reads.read('x', async () => ({ count: 2 }))).count, 2);
  await assert.rejects(reads.read('error', async () => { throw new Error('failed'); }));
  assert.equal(await reads.read('error', async () => 3), 3);

  invalidateRepositoryProviders();
  const connection = resolveProviderConnection({ instanceUrl: 'https://gitlab.test' });
  const requests: Array<{ path: string; token: unknown; timeout: unknown; signal: any; method: string | undefined }> = [];
  const request = { id: 1, iid: 2, project_id: 3, state: 'opened', title: 'MR', web_url: 'https://gitlab.test/p/2', source_branch: 'feature/v1/ABC', target_branch: 'release/v1', author: { id: 9, username: 'other', name: 'Other' } };
  let failApprovals = false;
  axios.defaults.adapter = async config => {
    const path = new URL(config.url!).pathname;
    requests.push({ path, token: config.headers['PRIVATE-TOKEN'], timeout: config.timeout, signal: config.signal, method: config.method });
    if (failApprovals && path.endsWith('/approvals')) throw new Error('timeout');
    const data = path.endsWith('/user') ? { id: 7, name: 'Me', username: 'me' }
      : path.endsWith('/approvals') ? { approved_by: [] }
      : path.endsWith('/projects/3') ? { id: 3, name: 'p', path_with_namespace: 'g/p', web_url: 'https://gitlab.test/g/p' }
      : path.endsWith('/merge_requests') && config.method === 'post' ? { id: 20, iid: 5, title: 'New', web_url: 'https://gitlab.test/p/5', state: 'opened' }
      : [request];
    return { config, data: JSON.stringify(data), status: 200, statusText: 'OK', headers: {} };
  };
  const service = createRepositoryProvider(connection, 'one');
  const tree = new PendingReviewsProvider(async () => createRepositoryProvider(connection, 'one'));
  await Promise.all([tree.refresh(), countPendingApprovals(service)]);
  assert.equal(requests.filter(item => item.path.endsWith('/user')).length, 1);
  assert.equal(requests.filter(item => item.path.endsWith('/approvals')).length, 1);
  assert.equal(requests.filter(item => item.path.endsWith('/merge_requests')).length, 1);
  assert(requests.every(item => item.timeout === 20000));
  assert.equal(await countPendingApprovals(service), 1);
  assert.equal(requests.length, 4); // user, list, approvals, project
  await createRepositoryProvider(connection, 'two').getCurrentUser();
  assert.equal(requests.filter(item => item.path.endsWith('/user')).length, 2);
  await service.createMergeRequest({ projectId: 3, sourceBranch: 'feature/v1/ABC', targetBranch: 'release/v1', title: 'New', description: 'Description' });
  const post = requests.find(item => item.method === 'post')!;
  assert.equal(post.signal, undefined); // cancellation never obscures an in-flight write
  await countPendingApprovals(service);
  assert.equal(requests.filter(item => item.path.endsWith('/approvals')).length, 2);
  const oldSignal = requests[0].signal;
  invalidateRepositoryProviders(); assert(oldSignal.aborted);
  failApprovals = true;
  const fresh = createRepositoryProvider(connection, 'one');
  await assert.rejects(countPendingApprovals(fresh), /timeout/);
  failApprovals = false;
  assert.equal(await countPendingApprovals(fresh), 1);
  tree.dispose(); invalidateRepositoryProviders();

  const snapshot: ReleaseOverviewSnapshot = { project: 'g/p', updatedAt: '2026-10-22T00:00:00Z', entries: [] };
  let fail = false; let wait = false; let release!: () => void;
  const overview = new ReleaseOverviewProvider(async () => {
    if (wait) await new Promise<void>(resolve => { release = resolve; });
    if (fail) throw new Error('offline');
    return snapshot;
  });
  await overview.refresh(); wait = true;
  const refresh = overview.refresh(); assert.equal(overview.snapshot, snapshot);
  fail = true; release(); await refresh;
  assert.equal(overview.snapshot, snapshot); assert(overview.message.includes('offline'));
  overview.invalidate(); assert.equal(overview.snapshot, undefined); overview.dispose();

  let finishList!: (value: any[]) => void; let pending = false; let listFailure = false;
  const mock = {
    capabilities: { todos: true }, getCurrentUser: async () => ({ id: 7 }),
    getReviewMergeRequests: async () => { if (pending) return new Promise<any[]>(resolve => { finishList = resolve; }); if (listFailure) throw new Error('offline'); return [request]; },
    hasUserApprovedMergeRequest: async () => false,
    getReviewProject: async () => ({ id: 3, path_with_namespace: 'g/p' })
  } as unknown as RepositoryProvider;
  const todos = new PendingReviewsProvider(async () => mock);
  await todos.refresh(); const oldProject = todos.getChildren()[0]; const oldRequest = todos.getChildren(oldProject)[0];
  pending = true; const loading = todos.refresh();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert(todos.getChildren().includes(oldProject));
  assert(todos.getChildren(oldProject).includes(oldRequest));
  await assert.rejects(todos.approve(oldRequest), /正在刷新/);
  finishList([request]); await loading;
  pending = false; listFailure = true;
  const loadedProject = todos.getChildren()[0];
  await todos.refresh(false);
  assert(todos.getChildren().includes(loadedProject)); assert(todos.summary.includes('旧数据'));
  todos.reset(); assert.deepEqual(todos.getChildren(), []); todos.dispose();
  axios.defaults.adapter = async config => ({ config, status: 200, statusText: 'OK', headers: { link: '<https://api.github.com/next>; rel="next"' }, data: JSON.stringify([{ name: 'feature/v1/A' }, { name: 'feature/v10/B' }]) });
  const github = new GitHubProvider(resolveProviderConnection({ provider: 'github' }), 'test');
  assert.deepEqual(await github.getProjectBranches('g/p', 1, '^feature/v1/'), { items: ['feature/v1/A'], hasMore: true });
  assert.deepEqual(await github.getProjectBranches('g/p', 1, '^release/'), { items: [], hasMore: true });

  axios.defaults.adapter = nativeAdapter;
  let received: (() => void) | undefined;
  const server = createServer((_req, res) => { received?.(); setTimeout(() => res.end('{}'), 200); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address() as { port: number };
    const local = `http://127.0.0.1:${address.port}`;
    await assert.rejects((new GitLabService(local, 'test') as any).request('/user', { timeout: 40 }), /timeout/i);
    const controller = new AbortController();
    const reached = new Promise<void>(resolve => { received = resolve; });
    const cancelled = assert.rejects(new GitLabService(local, 'test', controller.signal).getCurrentUser(), /连接 GitLab 失败/);
    await reached; controller.abort(); await cancelled;
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  console.log('Loading: anchored search, scoped shared reads, timeout/cancellation, write invalidation, stale view retention and failure recovery passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'assert';
import axios from 'axios';
import { configuration, configurationScopes, window, warningDialog } from './vscodeMock';
import { GitService } from '../src/gitService';
import { handleCreateRemoteBranch } from '../src/branchCreation';
import { GitHubProvider } from '../src/providers/githubProvider';
import { resolveProviderConnection, credentialKey } from '../src/providers/connection';
import { createRepositoryProvider } from '../src/providers/factory';
import { GitLabService } from '../src/gitlabService';
import { TokenManager } from '../src/tokenManager';
import { PendingReviewsProvider } from '../src/pendingReviewsView';

async function run() {
  const connection = resolveProviderConnection({ remoteHost: 'github.com' });
  assert.equal(connection.kind, 'github');
  assert.equal(connection.apiUrl, 'https://api.github.com');
  assert(createRepositoryProvider(resolveProviderConnection({ remoteHost: 'gitlab.example' }), 'x') instanceof GitLabService);
  const enterprise = resolveProviderConnection({ provider: 'github', instanceUrl: 'https://git.example/' });
  assert.equal(enterprise.apiUrl, 'https://git.example/api/v3');
  assert.equal(resolveProviderConnection({ remoteHost: 'git.example', remoteUrl: 'https://git.example:8443/g/p.git' }).instanceUrl, 'https://git.example:8443');
  assert.throws(() => resolveProviderConnection({ instanceUrl: 'https://user:secret@example.com' }));
  assert.throws(() => resolveProviderConnection({ provider: 'unknown' }));
  const secrets = new Map<string, string>();
  const tokens = new TokenManager({ secrets: {
    get: async (key: string) => secrets.get(key), store: async (key: string, value: string) => { secrets.set(key, value); },
    delete: async (key: string) => { secrets.delete(key); }
  } as any });
  configuration.set('accessToken', 'legacy');
  configurationScopes.workspace.set('accessToken', 'workspace-legacy');
  configurationScopes.workspaceFolder.set('accessToken', 'folder-legacy');
  secrets.set('gitlabMr.personalAccessToken', 'older-legacy');
  assert.equal(await tokens.getToken(connection), undefined);
  assert.equal(await tokens.getToken(enterprise), undefined);
  const gitlab = resolveProviderConnection({});
  assert.equal(await tokens.getToken(gitlab), 'legacy');
  assert.equal(secrets.get(credentialKey(gitlab)), 'legacy');
  assert.equal(configuration.has('accessToken'), false);
  assert.equal(configurationScopes.workspace.has('accessToken'), false);
  assert.equal(configurationScopes.workspaceFolder.has('accessToken'), false);
  assert.equal(secrets.has('gitlabMr.personalAccessToken'), false);
  await tokens.setToken('github-only', connection);
  assert.equal(configuration.get('accessToken'), undefined);
  assert.equal(await tokens.getToken(connection), 'github-only');
  assert.equal(await tokens.getToken(enterprise), undefined);
  configuration.set('instanceUrl', 'https://other.gitlab');
  assert.equal(await tokens.getToken(resolveProviderConnection({ instanceUrl: 'https://other.gitlab' })), undefined);
  await tokens.clearToken(connection);
  assert.equal(await tokens.getToken(connection), undefined);
  configuration.clear();
  const sha = 'a'.repeat(40); const changed = 'b'.repeat(40);
  const branches = new Map<string, string>([['main', sha]]);
  let posts = 0; let lost = false; let lookupDenied = false;
  const bodies: any[] = [];
  axios.defaults.adapter = async config => {
    assert.equal(config.headers.Authorization, 'Bearer test');
    assert.equal(config.maxRedirects, 0);
    const path = new URL(config.url!).pathname;
    let data: any; let status = 200; const headers: Record<string, string> = {};
    const ref = (name: string, hash: string) => ({ name, commit: { sha: hash, commit: { message: 'baseline' } } });
    if (path === '/user') data = { id: 3, login: 'author' };
    else if (path === '/repos/o/r') data = { id: 1, name: 'r', full_name: 'o/r', html_url: 'https://github.com/o/r', default_branch: 'main' };
    else if (path === '/users/reviewer') data = { id: 2, login: 'reviewer' };
    else if (path.endsWith('/branches')) { data = [ref('main', sha)]; headers.link = '<https://api.github.com/repos/o/r/branches?page=2>; rel="next"'; }
    else if (path.includes('/branches/')) {
      const name = decodeURIComponent(path.split('/branches/')[1]);
      if (lookupDenied && name !== 'main') { status = 403; data = { message: 'forbidden' }; }
      else if (branches.has(name)) data = ref(name, branches.get(name)!);
      else { status = 404; data = { message: 'not found' }; }
    } else if (path.endsWith('/git/ref/tags/v1')) data = { ref: 'refs/tags/v1', object: { type: 'tag', sha: changed } };
    else if (path.endsWith(`/git/tags/${changed}`)) data = { object: { type: 'commit', sha } };
    else if (path.endsWith(`/commits/${sha}`)) data = { sha, commit: { message: 'tag baseline' } };
    else if (path.endsWith('/git/refs')) {
      posts++; const body = JSON.parse(config.data); bodies.push(body);
      branches.set(body.ref.replace('refs/heads/', ''), body.sha);
      if (lost) throw new Error('connection reset');
      data = { ref: body.ref, object: { type: 'commit', sha: body.sha } };
    } else if (path.endsWith('/requested_reviewers')) { status = 422; data = { message: 'reviewer not collaborator' }; }
    else if (path.endsWith('/pulls')) {
      if (config.method === 'post') {
        posts++; const body = JSON.parse(config.data); bodies.push(body);
        data = { id: 10, number: 7, title: body.title, head: { ref: body.head }, base: { ref: body.base }, html_url: 'https://github.com/o/r/pull/7' };
      } else data = [{ number: 7, title: 'Merged', head: { ref: 'release/1' }, base: { ref: 'main' }, state: 'closed', merged_at: '2026-10-22', html_url: 'https://github.com/o/r/pull/7' }];
    } else throw new Error(`Unexpected ${path}`);
    return { config, data: JSON.stringify(data), status, statusText: String(status), headers };
  };
  const service = new GitHubProvider(connection, 'test');
  await service.getProject('o/r');
  assert.deepEqual(await service.getProjectBranches(1, 1, 'release'), { items: [], hasMore: true });
  assert.equal((await service.getBranchCreationRef(1, 'tag', 'v1')).sha, sha);
  assert.equal((await service.createRemoteBranch(1, 'release/1', 'branch', 'main', sha)).recovered, false);
  assert.deepEqual(bodies[0], { ref: 'refs/heads/release/1', sha });
  const before = posts;
  await assert.rejects(service.createRemoteBranch(1, 'release/1', 'branch', 'main', sha), /已存在/);
  await assert.rejects(service.createRemoteBranch(1, 'release/2', 'branch', 'main', changed), /已变化/);
  lookupDenied = true;
  await assert.rejects(service.createRemoteBranch(1, 'release/2', 'branch', 'main', sha), /403/);
  lookupDenied = false; assert.equal(posts, before);
  lost = true;
  assert.equal((await service.createRemoteBranch(1, 'release/2', 'branch', 'main', sha)).recovered, true);
  assert.equal(posts, before + 1); lost = false;
  assert.equal((await service.getMergeRequestsTargetingBranch(1, 'main')).items[0].state, 'merged');
  const reviewers = await service.resolveReviewerIds(['reviewer']);
  const pr = await service.createMergeRequest({ projectId: 1, sourceBranch: 'release/1', targetBranch: 'main', title: 'Release', description: 'Actual changes', reviewerIds: reviewers.resolvedIds, squash: true, removeSourceBranch: true });
  assert.equal(pr.iid, 7); assert.equal(pr.warnings?.length, 1);
  assert.deepEqual(bodies.at(-1), { head: 'release/1', base: 'main', title: 'Release', body: 'Actual changes' });
  assert.equal(posts, before + 2);
  await assert.rejects(service.mergeReview(1, 7, sha, 2), /后续阶段/);
  const pending = new PendingReviewsProvider(async () => service, true);
  await pending.refresh();
  assert.equal(pending.summary, 'GitHub 待办尚未接入');
  pending.dispose();
  // Exercise the actual VS Code command through remote detection, scoped token and factory.
  const originalRepo = GitService.prototype.getRepoInfo;
  const originalPick = window.showQuickPick;
  const originalInput = window.showInputBox;
  GitService.prototype.getRepoInfo = async () => ({ rootPath: '/test', sourceBranch: 'work', remoteUrl: 'git@github.com:o/r.git', gitlabHost: 'github.com', projectPath: 'o/r' });
  let choices = ['分支', 'main']; let inputs = ['', '3'];
  (window as any).showQuickPick = async (items: any[]) => { const label = choices.shift(); return items.find(item => item.label === label); };
  (window as any).showInputBox = async () => inputs.shift();
  warningDialog.value = '确认创建';
  const scopedTokens = { getToken: async (resolved: any) => { assert.deepEqual(resolved, connection); return 'test'; }, promptForToken: async () => undefined };
  try {
    assert.equal(await handleCreateRemoteBranch(scopedTokens, 'release'), true);
    assert.equal(branches.get('release/3'), sha);
    choices = ['分支', 'main']; inputs = ['', '4']; warningDialog.value = undefined;
    const writes = posts;
    assert.equal(await handleCreateRemoteBranch(scopedTokens, 'release'), false);
    assert.equal(posts, writes);
  } finally {
    GitService.prototype.getRepoInfo = originalRepo;
    window.showQuickPick = originalPick;
    window.showInputBox = originalInput;
  }

  console.log('Provider routing, credentials, pagination, branch safety, PR partial success and capability tests passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'assert';
import axios from 'axios';
import { handleCheckReleaseReadiness, handleFilterBranchesByKeyword } from '../src/extension';
import { GitLabService } from '../src/gitlabService';
import { GitService } from '../src/gitService';
import { ReleaseMergeRequest } from '../src/releaseReadiness';
import { ReleaseReadinessProvider } from '../src/releaseReadinessView';
import { titleInput } from './vscodeMock';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    await Promise.resolve();
  }
  assert.fail('Expected request did not start');
}

async function runTests() {
  const urls: URL[] = [];
  let responseItems: unknown[] = [];
  axios.defaults.adapter = async config => {
    urls.push(new URL(config.url!));
    return { config, data: JSON.stringify(responseItems), status: 200, statusText: 'OK', headers: {} };
  };
  const service = new GitLabService('https://gitlab.example.com', 'test-token');
  for (const count of [0, 1, 99, 100]) {
    responseItems = Array.from({ length: count }, (_, i) => ({ name: `feature/v1/${i}` }));
    const before = urls.length;
    const page = await service.getProjectBranches('group/project', 2, 'PROJ & 1');
    assert.equal(urls.length, before + 1);
    assert.equal(page.items.length, count);
    assert.equal(page.hasMore, count === 100);
    assert.equal(urls.at(-1)?.searchParams.get('page'), '2');
    assert.equal(urls.at(-1)?.searchParams.get('per_page'), '100');
    assert.equal(urls.at(-1)?.searchParams.get('search'), 'PROJ & 1');
  }
  responseItems = [
    {
      name: 'feature/v1/PROJ-1',
      commit: { author_name: ' Alice ', committed_date: '2026-10-19T11:00:00+08:00' }
    },
    { name: 'main', commit: { author_name: 'Bob', committed_date: 'invalid-date' } },
    { name: 'release/v1' }
  ];
  const callsBeforeMetadata = urls.length;
  const metadataPage = await service.getProjectBranches(1);
  assert.equal(urls.length, callsBeforeMetadata + 1);
  assert.deepEqual(metadataPage.latestCommits, [
    { branch: 'feature/v1/PROJ-1', authorName: 'Alice', committedDate: '2026-10-19T11:00:00+08:00' },
    { branch: 'main', authorName: 'Bob', committedDate: 'invalid-date' },
    { branch: 'release/v1', authorName: '', committedDate: '' }
  ]);
  assert.deepEqual(metadataPage.items, ['feature/v1/PROJ-1', 'main', 'release/v1']);
  responseItems = [];
  await service.getMergeRequestsTargetingBranch(1, 'release/v1/hotfix', 3);
  assert.equal(urls.at(-1)?.searchParams.get('target_branch'), 'release/v1/hotfix');
  assert.equal(urls.at(-1)?.searchParams.get('page'), '3');
  assert.equal(urls.at(-1)?.searchParams.get('state'), 'all');
  assert.equal(urls.at(-1)?.searchParams.get('per_page'), '100');

  const tokenManager = { getToken: async () => 'test-token', promptForToken: async () => undefined };
  const tree = { description: undefined as string | undefined, reveal: async () => {} };
  let mainCalls = 0;
  const markerCalls: string[][] = [];
  let failMarkers = false;
  GitService.prototype.getRepoInfo = async () => ({
    rootPath: '/test/workspace', sourceBranch: 'dev', remoteUrl: 'https://gitlab.example.com/group/project.git',
    projectPath: 'group/project', gitlabHost: 'gitlab.example.com'
  });
  GitService.prototype.getBranchesMergedIntoMain = async (branches, fetchAll) => {
    markerCalls.push(branches);
    assert.equal(fetchAll, false);
    if (failMarkers) {
      throw new Error('Main scan failed');
    }
    return new Set(branches.filter(branch => branch.endsWith('PROJ-0')));
  };
  GitService.prototype.isBranchMergedIntoMain = async () => { mainCalls++; return false; };
  GitLabService.prototype.getProject = async () => ({ id: 1, name: 'project', web_url: 'https://gitlab.example.com/group/project' });
  GitLabService.prototype.getGitLabVersion = async () => ({ version: '18.0' });

  let total = 201;
  let failBranches = false;
  let failPage: number | undefined;
  const branchCalls: Array<{ page: number; search: string }> = [];
  let pendingBranches: ReturnType<typeof deferred<{ items: string[]; hasMore: boolean }>> | undefined;
  GitLabService.prototype.getProjectBranches = async (_project, page = 1, search = '') => {
    branchCalls.push({ page, search });
    if (pendingBranches) {
      return pendingBranches.promise;
    }
    if (failBranches || page === failPage) {
      throw new Error('Branches unavailable');
    }
    const items = Array.from({ length: total }, (_, i) => `feature/v1/PROJ-${i}`).slice((page - 1) * 100, page * 100);
    return { items, hasMore: items.length === 100 };
  };

  const provider = new ReleaseReadinessProvider();
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false });
  assert.equal(branchCalls.length, 3);
  assert.deepEqual(branchCalls.map(call => call.page), [1, 2, 3]);
  assert.equal(provider.getBranches().length, 201);
  assert.equal(mainCalls, 0);
  assert.equal(markerCalls.length, 1);
  assert.equal(markerCalls[0].length, 202);
  assert.equal(markerCalls[0][0], 'main');
  assert.equal(provider.isMergedIntoMain('feature/v1/PROJ-0'), true);
  assert.match(String(provider.getBranchItem('feature/v1/PROJ-0')?.description), /代码已合入 main/);
  assert.equal(provider.isMergedIntoMain('feature/v1/PROJ-1'), false);
  assert.equal(provider.getChildren().some(item => item.kind === 'loadMore'), false);
  assert.equal(tree.description, '201 个远程分支');
  provider.setBranchFilters(['release/']);
  assert.equal(provider.getChildren().some(item => item.kind === 'directory'), false);
  assert.equal(provider.getChildren().some(item => item.kind === 'loadMore'), false);
  provider.setBranchFilters(null);
  assert.equal(provider.isMergedIntoMain('feature/v1/PROJ-0'), true);

  failMarkers = true;
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false, refreshBranches: true });
  assert.equal(provider.getBranches().length, 201);
  assert.equal(provider.isMergedIntoMain('feature/v1/PROJ-0'), false);
  assert.equal(provider.branchPage.error, undefined);
  failMarkers = false;

  provider.resetBranchPages();
  failPage = 2;
  await assert.rejects(handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false }), /Branches unavailable/);
  assert.equal(provider.getBranches().length, 100);
  assert.equal(provider.branchPage.page, 1);
  assert.match(String(provider.getChildren().at(-1)?.label), /点击重试/);
  assert.equal(provider.getChildren().at(-1)?.command?.command, 'gitlabMr.retryBranches');
  failPage = undefined;
  const beforeRetry = branchCalls.length;
  const beforeRetryMarkers = markerCalls.length;
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false });
  assert.equal(provider.getBranches().length, 201);
  assert.deepEqual(branchCalls.slice(beforeRetry).map(call => call.page), [2, 3]);
  assert.equal(markerCalls.length, beforeRetryMarkers + 1);
  assert.equal(provider.isMergedIntoMain('feature/v1/PROJ-0'), true);
  assert.equal(provider.branchPage.hasMore, false);
  const completedCalls = branchCalls.length;
  const completedMarkers = markerCalls.length;
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false });
  assert.equal(branchCalls.length, completedCalls);
  assert.equal(markerCalls.length, completedMarkers);
  assert.equal(provider.getChildren().some(item => item.kind === 'loadMore'), false);
  assert.equal(mainCalls, 0);

  for (const count of [0, 1, 99, 100, 101]) {
    const boundaryProvider = new ReleaseReadinessProvider();
    total = count;
    const before = branchCalls.length;
    await handleCheckReleaseReadiness(tokenManager, boundaryProvider, tree, { selectBranch: false });
    assert.equal(branchCalls.length, before + Math.floor(count / 100) + 1);
    assert.equal(boundaryProvider.getBranches().length, count);
    assert.equal(boundaryProvider.branchPage.hasMore, false);
    assert.equal(boundaryProvider.getChildren().some(item => item.kind === 'loadMore'), false);
    boundaryProvider.dispose();
  }

  provider.resetBranchPages('old');
  pendingBranches = deferred();
  const oldRequest = handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false });
  await waitFor(() => branchCalls.at(-1)?.search === 'old');
  assert.equal(provider.getChildren().some(item => item.kind === 'loadMore'), false);
  assert.match(String(provider.getChildren().at(-1)?.label), /正在加载全部分支/);
  const beforeDuplicate = branchCalls.length;
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false });
  assert.equal(branchCalls.length, beforeDuplicate);
  const oldResponse = pendingBranches;
  pendingBranches = undefined;
  total = 201;
  titleInput.value = 'new';
  await handleFilterBranchesByKeyword(provider, () =>
    handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false })
  );
  assert.equal(branchCalls.at(-1)?.search, 'new');
  assert.deepEqual(branchCalls.slice(beforeDuplicate).map(call => call.page), [1, 2, 3]);
  assert.ok(branchCalls.slice(beforeDuplicate).every(call => call.search === 'new'));
  oldResponse.resolve({ items: ['old/response'], hasMore: true });
  await oldRequest;
  assert.equal(provider.getBranchKeyword(), 'new');
  assert.equal(provider.getBranches().length, 201);
  assert.equal(provider.getBranches().includes('old/response'), false);
  assert.equal(provider.branchPage.hasMore, false);
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { refreshBranches: true, selectBranch: false });
  assert.equal(branchCalls.at(-1)?.page, 3);
  assert.equal(branchCalls.at(-1)?.search, 'new');

  provider.resetBranchPages('');
  total = 0;
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false });
  assert.equal(provider.branchPage.hasMore, false);
  assert.equal(provider.getChildren()[0].kind, 'search');
  titleInput.value = '';
  await handleFilterBranchesByKeyword(provider);
  failBranches = true;
  await assert.rejects(handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false }), /Branches unavailable/);
  assert.equal(provider.getChildren()[0].kind, 'search');
  assert.equal(provider.getChildren().at(-1)?.command?.command, 'gitlabMr.retryBranches');
  failBranches = false;

  const release = 'release/v1';
  const markersBeforeRelease = markerCalls.length;
  provider.appendBranchPage(provider.branchPage, { items: [release], hasMore: false });
  const request = (iid: number, state: string, branch = 'feature/v1/PROJ-1'): ReleaseMergeRequest => ({
    iid, state, source_branch: branch, target_branch: release, title: 'Feature', web_url: `https://gitlab.example.com/mr/${iid}`
  });
  const mrCalls: number[] = [];
  const featureCalls: number[] = [];
  let failMr = false;
  let pendingMr: ReturnType<typeof deferred<{ items: ReleaseMergeRequest[]; hasMore: boolean }>> | undefined;
  GitLabService.prototype.getProjectBranches = async (_project, page = 1, search = '') => {
    assert.equal(search, '^feature/v1/');
    featureCalls.push(page);
    return { items: page === 1 ? ['feature/v1/PROJ-1', 'feature/v1/PROJ-2'] : ['feature/v1/PROJ-3'], hasMore: page === 1 };
  };
  GitLabService.prototype.getMergeRequestsTargetingBranch = async (_project, target, page = 1) => {
    assert.equal(target, release);
    mrCalls.push(page);
    if (pendingMr) {
      return pendingMr.promise;
    }
    if (failMr) {
      throw new Error('MR unavailable');
    }
    return {
      items: page === 1 ? [request(1, 'merged')] : [request(2, 'opened'), request(3, 'merged', 'feature/v1/deleted')],
      hasMore: page === 1
    };
  };
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectedBranch: release });
  assert.deepEqual(mrCalls, [1]);
  assert.deepEqual(featureCalls, [1]);
  assert.equal(mainCalls, 1);
  assert.equal(markerCalls.length, markersBeforeRelease);
  const releaseItem = provider.getBranchItem(release)!;
  let children = provider.getChildren(releaseItem);
  assert.equal(children.at(-1)?.command?.command, 'gitlabMr.loadMoreReleaseData');
  assert.ok(children.filter(item => item.status).every(item => item.status?.pending));
  assert.ok(children.filter(item => item.status).every(item => !item.contextValue?.match(/releaseFeature-(not-created|closed)/)));
  assert.equal(children.find(item => item.status?.branch === 'feature/v1/PROJ-2')?.command, undefined);
  assert.match(tree.description ?? '', /结果未完整/);

  failMr = true;
  await assert.rejects(handleCheckReleaseReadiness(tokenManager, provider, tree, { selectedBranch: release, loadMoreRelease: true }), /MR unavailable/);
  assert.equal(provider.releasePages.get(release)?.page, 1);
  assert.equal(provider.getChildren(releaseItem).filter(item => item.status).length, 2);
  failMr = false;
  pendingMr = deferred();
  const continuation = handleCheckReleaseReadiness(tokenManager, provider, tree, { selectedBranch: release, loadMoreRelease: true });
  await waitFor(() => mrCalls.length >= 3);
  const beforeMrDuplicate = mrCalls.length;
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectedBranch: release, loadMoreRelease: true });
  assert.equal(mrCalls.length, beforeMrDuplicate);
  pendingMr.resolve({ items: [request(2, 'opened'), request(3, 'merged', 'feature/v1/deleted')], hasMore: false });
  await continuation;
  pendingMr = undefined;
  children = provider.getChildren(releaseItem);
  assert.equal(mainCalls, 1);
  assert.equal(markerCalls.length, markersBeforeRelease);
  assert.equal(children.some(item => item.kind === 'loadMore'), false);
  assert.equal(children.find(item => item.status?.branch === 'feature/v1/PROJ-1')?.status?.state, 'open');
  assert.equal(children.find(item => item.status?.branch === 'feature/v1/PROJ-2')?.status?.state, 'not-created');
  assert.ok(children.some(item => item.status?.branch === 'feature/v1/PROJ-3'));
  assert.ok(children.some(item => item.status?.branch === 'feature/v1/deleted'));
  assert.ok(children.filter(item => item.status).every(item => !item.status?.pending));
  assert.equal(provider.releasePages.get(release)?.requests.length, 3);
  assert.equal(provider.getBranchKeyword(), '');

  // A completed stream must not be requested again while the other stream continues.
  const state = provider.startReleasePages(release);
  provider.appendReleasePage(release, state, { items: [], hasMore: false }, { items: [], hasMore: true });
  const beforeFeatureCalls = featureCalls.length;
  await handleCheckReleaseReadiness(tokenManager, provider, tree, { selectedBranch: release, loadMoreRelease: true });
  assert.equal(featureCalls.length, beforeFeatureCalls);
  assert.equal(mrCalls.at(-1), 2);

  // Resetting search invalidates an in-flight release page as well as branch pages.
  const staleState = provider.startReleasePages(release);
  pendingMr = deferred();
  const releaseResponse = pendingMr;
  const beforeStaleRequest = mrCalls.length;
  const staleLoad = handleCheckReleaseReadiness(tokenManager, provider, tree, { selectedBranch: release, loadMoreRelease: true });
  await waitFor(() => mrCalls.length > beforeStaleRequest);
  provider.resetBranchPages('different');
  releaseResponse.resolve({ items: [request(9, 'opened')], hasMore: false });
  await staleLoad;
  assert.equal(provider.releasePages.size, 0);
  assert.equal(staleState.page, 0);
  assert.equal(provider.getBranches().length, 0);

  GitLabService.prototype.getProjectBranches = async () => ({ items: ['feature/v1/PROJ-0'], hasMore: false });
  const markers = deferred<Set<string>>();
  let markerStarted = false;
  GitService.prototype.getBranchesMergedIntoMain = async () => {
    markerStarted = true;
    return markers.promise;
  };
  const staleMarkers = handleCheckReleaseReadiness(tokenManager, provider, tree, { selectBranch: false });
  await waitFor(() => markerStarted);
  provider.resetBranchPages('other');
  markers.resolve(new Set(['feature/v1/PROJ-0']));
  await staleMarkers;
  assert.equal(provider.isMergedIntoMain('feature/v1/PROJ-0'), false);
  provider.dispose();
  console.log('[PASS] loading: complete root branch list, root retry and search races, child-only pagination, partial MR states and independent streams');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

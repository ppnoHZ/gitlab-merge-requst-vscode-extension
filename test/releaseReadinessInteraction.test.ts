import assert from 'assert';
import * as vscode from 'vscode';
import { handleCheckReleaseReadiness, handleCopyBranchName, handleCreateMainMergeRequest, handleFilterBranchesByKeyword } from '../src/extension';
import { GitService } from '../src/gitService';
import { GitLabService } from '../src/gitlabService';
import { ReleaseReadinessProvider, ReleaseReadinessTreeItem } from '../src/releaseReadinessView';
import { ReleaseMergeRequest } from '../src/releaseReadiness';
import { clipboard, configuration, informationMessages, warnings, titleInput, openedUrls, targetPick } from './vscodeMock';
import { MergeRequestPayload } from '../src/types';

async function runTests(): Promise<void> {
  for (const branch of ['main', 'release/v1/hotfix', 'feature/v1/PROJ-1/deep/path']) {
    const branchItem = new ReleaseReadinessTreeItem(
      'branch', branch.split('/').at(-1)!, vscode.TreeItemCollapsibleState.None,
      undefined, undefined, undefined, branch
    );
    await handleCopyBranchName(branchItem);
    assert.equal(clipboard.text, branch);
    assert.equal(informationMessages.at(-1), `已复制分支名称: ${branch}`);
  }
  const copyFeatureItem = new ReleaseReadinessTreeItem(
    'feature', 'feature/v1/PROJ-2', vscode.TreeItemCollapsibleState.None,
    { branch: 'feature/v1/PROJ-2', state: 'merged' }, undefined, undefined, 'release/v1'
  );
  await handleCopyBranchName(copyFeatureItem);
  assert.equal(clipboard.text, 'feature/v1/PROJ-2');
  const clipboardBefore = clipboard.text;
  await assert.rejects(handleCopyBranchName(), /请选择/);
  for (const kind of ['directory', 'message', 'search', 'loadMore', 'issueLink'] as const) {
    await assert.rejects(handleCopyBranchName(new ReleaseReadinessTreeItem(
      kind, 'feature', vscode.TreeItemCollapsibleState.None,
      undefined, undefined, undefined, 'feature'
    )), /不能复制目录/);
  }
  assert.equal(clipboard.text, clipboardBefore);
  const messagesBefore = informationMessages.length;
  clipboard.error = new Error('Clipboard unavailable');
  await assert.rejects(handleCopyBranchName(copyFeatureItem), /Clipboard unavailable/);
  assert.equal(informationMessages.length, messagesBefore);
  clipboard.error = undefined;
  console.log('[PASS] copy branch name: full paths, main, feature source, invalid nodes, clipboard errors');

  const calls = { list: 0, all: 0, version: 0, project: 0, selected: [] as string[], mr: [] as string[] };
  const branches = ['main', 'feature/v1/PROJ-1', 'release/v1', 'dev'];
  let failSelected = false;
  let failMr = false;
  let mergedSelected = true;
  let mergeRequests: ReleaseMergeRequest[] = [];
  GitService.prototype.getRepoInfo = async () => ({
    rootPath: '/test/workspace', sourceBranch: 'dev',
    remoteUrl: 'https://gitlab.com/group/project.git',
    projectPath: 'group/project', gitlabHost: 'gitlab.com'
  });
  GitService.prototype.getBranchesMergedIntoMain = async () => {
    calls.all++;
    return new Set(['feature/v1/PROJ-1', 'dev']);
  };
  GitService.prototype.isBranchMergedIntoMain = async branch => {
    calls.selected.push(branch);
    if (failSelected) {
      throw new Error('Fetch failed');
    }
    return mergedSelected && branch !== 'main';
  };
  GitLabService.prototype.getProject = async () => {
    calls.project++;
    return { id: 1, name: 'project', web_url: 'https://gitlab.com/group/project' };
  };
  GitLabService.prototype.getGitLabVersion = async () => {
    calls.version++;
    return { version: '18.0' };
  };
  let featureBranches = branches.filter(branch => branch.startsWith('feature/'));
  GitLabService.prototype.getProjectBranches = async (_projectId, _page, search) => {
    if (search?.startsWith('^feature/')) {
      return { items: featureBranches, hasMore: false };
    }
    calls.list++;
    return { items: [...branches], hasMore: false };
  };
  GitLabService.prototype.getMergeRequestsTargetingBranch = async (projectId, target) => {
    if (failMr) {
      throw new Error('MR API failed');
    }
    calls.mr.push(target);
    return { items: mergeRequests, hasMore: false };
  };

  const tokenManager = { getToken: async () => 'test-token', promptForToken: async () => undefined };
  const provider = new ReleaseReadinessProvider();
  const reveals: Array<{ item: ReleaseReadinessTreeItem; options?: { select?: boolean; focus?: boolean; expand?: boolean | number } }> = [];
  const treeView = {
    description: undefined as string | undefined,
    reveal: async (
      item: ReleaseReadinessTreeItem,
      options?: { select?: boolean; focus?: boolean; expand?: boolean | number }
    ) => { reveals.push({ item, options }); }
  };
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectBranch: false });
  assert.equal(calls.list, 1);
  assert.equal(calls.all, 1);
  assert.equal(calls.version, 1);
  assert.equal(calls.project, 1);
  assert.deepEqual(calls.selected, []);
  assert.deepEqual(calls.mr, []);

  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'release/v1' });
  assert.deepEqual(calls.selected, ['release/v1']);
  assert.deepEqual(calls.mr, ['release/v1']);
  assert.equal(calls.list, 1);
  assert.equal(calls.all, 1);
  assert.equal(calls.version, 1);
  assert.equal(provider.releaseBranch, 'release/v1');
  assert.equal(reveals.length, 1);
  assert.equal(reveals[0].item.kind, 'branch');
  assert.equal(reveals[0].item.branchPath, 'release/v1');
  assert.equal(provider.getParent(reveals[0].item)?.branchPath, 'release');
  assert.deepEqual(reveals[0].options, { select: true, focus: true, expand: 1 });
  assert.match(String(provider.getChildren(reveals[0].item)[0].label), /全部合入 main/);
  assert.equal(provider.getChildren(reveals[0].item)[1].status?.state, 'not-created');
  assert.equal(calls.project, 2);
  const dev = provider.getChildren().find(item => item.branchPath === 'dev');
  assert.deepEqual(dev?.iconPath, new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')));

  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'dev' });
  assert.equal(provider.releaseBranch, undefined);
  assert.equal(provider.selectedBranch, 'dev');
  assert.equal(treeView.description, 'dev');
  assert.deepEqual(calls.selected, ['release/v1', 'dev']);
  assert.deepEqual(calls.mr, ['release/v1']);
  assert.equal(calls.list, 1);
  assert.equal(calls.all, 1);
  assert.equal(calls.project, 2);

  assert.match(String(provider.getChildren(reveals.at(-1)!.item)[0].label), /全部合入 main/);
  assert.equal(provider.getChildren(reveals[0].item)[1].status?.state, 'not-created');
  failSelected = true;
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'dev' });
  assert.match(warnings.at(-1) ?? '', /Fetch failed/);
  assert.match(String(provider.getChildren(reveals.at(-1)!.item)[0].label), /检查失败: Fetch failed/);
  assert.deepEqual(
    provider.getChildren().find(item => item.branchPath === 'dev')?.iconPath,
    new vscode.ThemeIcon('git-branch')
  );
  const featureRoot = provider.getChildren().find(item => item.label === 'feature');
  assert.ok(featureRoot);
  const featureVersion = provider.getChildren(featureRoot)[0];
  assert.deepEqual(
    provider.getChildren(featureVersion)[0].iconPath,
    new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
  );
  assert.equal(calls.list, 1);
  assert.equal(calls.all, 1);

  failSelected = false;
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, {
    selectedBranch: 'release/v1', selectBranch: false, refreshBranches: true
  });
  assert.equal(calls.list, 2);
  assert.equal(calls.all, 2);
  assert.equal(calls.version, 2);
  assert.equal(calls.project, 3);
  assert.deepEqual(calls.mr, ['release/v1', 'release/v1']);
  assert.deepEqual(calls.selected, ['release/v1', 'dev', 'dev', 'release/v1']);
  const refreshedDev = provider.getBranchItem('dev');
  assert.ok(refreshedDev);
  assert.deepEqual(provider.getChildren(refreshedDev), []);
  assert.deepEqual(provider.getBranches(), [...branches].sort());
  const snapshot = provider.getBranches();
  snapshot.push('invalid');
  assert.equal(provider.getBranches().includes('invalid'), false);

  const mergedRequest: ReleaseMergeRequest = {
    source_branch: 'feature/v1/PROJ-1', target_branch: 'release/v1',
    state: 'merged', iid: 1, title: 'Feature merged', web_url: 'https://gitlab.com/group/project/-/merge_requests/1'
  };
  mergeRequests = [mergedRequest];
  const revealsBeforeMerged = reveals.length;
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'release/v1' });
  assert.equal(reveals.length, revealsBeforeMerged + 1);
  assert.equal(provider.getChildren(reveals.at(-1)!.item)[1].status?.state, 'merged');
  assert.equal(provider.releaseBranch, 'release/v1');
  assert.equal(provider.selectedBranch, 'release/v1');
  assert.equal(treeView.description, 'v1 · 1/1 已合并');

  provider.setBranches([...branches, 'feature/v1/PROJ-2', 'feature/v1/PROJ-3', 'feature/v1/PROJ-4']);
  featureBranches = provider.getBranches().filter(branch => branch.startsWith('feature/'));
  mergeRequests = [
    mergedRequest,
    { ...mergedRequest, source_branch: 'feature/v1/PROJ-2', state: 'opened', iid: 2 },
    { ...mergedRequest, source_branch: 'feature/v1/PROJ-3', state: 'closed', iid: 3 }
  ];
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'release/v1' });
  assert.equal(reveals.length, revealsBeforeMerged + 2);
  const resultRoot = reveals.at(-1)!.item;
  const resultItems = provider.getChildren(resultRoot);
  assert.deepEqual(resultItems.slice(1).map(item => item.status?.state), ['merged', 'open', 'closed', 'not-created']);
  assert.equal(provider.getParent(resultItems[1]), resultRoot);
  assert.equal(resultItems[1].status?.state, 'merged');
  assert.equal(treeView.description, 'v1 · 1/4 已合并');

  provider.setBranches(['main', 'release/v1']);
  featureBranches = [];
  mergeRequests = [];
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'release/v1' });
  assert.match(String(provider.getChildren(reveals.at(-1)!.item)[1].label), /没有找到该版本的 feature 分支/);
  assert.equal(reveals.length, revealsBeforeMerged + 3);
  assert.equal(calls.list, 2);
  assert.equal(calls.all, 2);
  failMr = true;
  await assert.rejects(
    handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'release/v1' }),
    /MR API failed/
  );
  const failedResults = provider.getChildren(reveals.at(-1)!.item);
  assert.ok(failedResults.some(item => String(item.label).includes('MR 检查失败')));
  assert.equal(failedResults.at(-1)?.command?.command, 'gitlabMr.loadMoreReleaseData');
  failMr = false;
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'main' });
  assert.match(String(provider.getChildren(reveals.at(-1)!.item)[0].label), /当前分支为 main/);
  provider.setBranches([...branches]);
  mergedSelected = false;
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'dev' });
  assert.match(String(provider.getChildren(reveals.at(-1)!.item)[0].label), /尚有代码未合入 main/);
  mergedSelected = true;
  provider.setBranches(['main', 'release/v1', 'feature/v1/PROJ-1']);
  provider.selectedBranch = 'release/v1';
  const releaseItem = new ReleaseReadinessTreeItem(
    'branch', 'v1', vscode.TreeItemCollapsibleState.None,
    undefined, undefined, undefined, 'release/v1'
  );
  const featureItem = new ReleaseReadinessTreeItem(
    'feature', 'feature/v1/PROJ-1', vscode.TreeItemCollapsibleState.None,
    { branch: 'feature/v1/PROJ-1', state: 'not-created' }
  );
  const created: MergeRequestPayload[] = [];
  GitService.prototype.isGitRepo = async () => true;
  GitService.prototype.getBranches = async () => [
    'main', 'release/v2', 'release/v1', 'feature/v1/PROJ-1', 'dev', 'uat'
  ];
  GitService.prototype.getCommitsBetween = async (source, target) => {
    assert.ok(['release/v1', 'feature/v1/PROJ-1'].includes(source));
    assert.equal(target, targetPick.value);
    return [];
  };
  GitService.prototype.getChangedFiles = async () => [];
  GitLabService.prototype.createMergeRequest = async payload => {
    created.push(payload);
    return { id: 10, iid: 10, title: payload.title, web_url: 'https://gitlab.com/mr/10', state: 'opened' };
  };
  const reviewerLookups: string[] = [];
  GitLabService.prototype.getUserByUsername = async username => {
    reviewerLookups.push(username);
    if (username === 'unavailable') {
      throw new Error('User API failed');
    }
    return username === 'alice' ? { id: 12, username: 'alice', name: 'Alice' }
      : username === 'bob' ? { id: 34, username: 'bob', name: 'Bob' } : undefined;
  };
  GitService.prototype.isBranchMergedIntoMain = async () => false;
  targetPick.value = 'main';
  titleInput.value = 'Merge release to main';
  await handleCreateMainMergeRequest(tokenManager, provider, releaseItem);
  assert.equal(created.length, 1);
  assert.equal(created[0].sourceBranch, 'release/v1');
  assert.equal(created[0].targetBranch, 'main');
  assert.equal(created[0].title, titleInput.value);
  assert.equal(created[0].removeSourceBranch, true);
  assert.equal(created[0].reviewerIds, undefined);
  assert.deepEqual(reviewerLookups, []);
  assert.equal(openedUrls.at(-1), 'https://gitlab.com/mr/10');
  assert.equal(provider.selectedBranch, 'release/v1');
  assert.match(titleInput.titles.at(-1) ?? '', /MTP/);
  assert.ok(targetPick.items.find(item => item.label === 'dev')?.description?.includes('推荐'));
  assert.ok(targetPick.items.find(item => item.label === 'main')?.description?.includes('推荐'));
  assert.equal(targetPick.items.some(item => item.label === 'release/v1'), false);
  assert.deepEqual(targetPick.items.map(item => item.label), ['master', 'main', 'dev', 'uat']);

  titleInput.value = 'Merge feature to release';
  configuration.set('defaultReviewers', [' alice ', ' @bob ', 'alice']);
  targetPick.value = 'release/v1';
  await handleCreateMainMergeRequest(tokenManager, provider, featureItem);
  assert.equal(created[1].sourceBranch, 'feature/v1/PROJ-1');
  assert.equal(created[1].targetBranch, 'release/v1');
  assert.deepEqual(created[1].reviewerIds, [12, 34]);
  assert.deepEqual(reviewerLookups, ['alice', 'bob', 'alice']);
  assert.match(warnings.at(-1) ?? '', /MR !10 已创建.*12, 34.*不要重复创建/);
  assert.equal(targetPick.items[0].label, 'release/v1');
  assert.match(targetPick.items[0].description ?? '', /同版本 release/);
  assert.equal(targetPick.items.some(item => item.label === 'feature/v1/PROJ-1'), false);
  assert.deepEqual(targetPick.items.map(item => item.label), ['release/v1', 'release/v2']);
  assert.match(titleInput.titles.at(-1) ?? '', /feature-release/);

  targetPick.value = undefined;
  const titleCount = titleInput.titles.length;
  await handleCreateMainMergeRequest(tokenManager, provider, featureItem);
  assert.equal(created.length, 2);
  assert.equal(titleInput.titles.length, titleCount);

  configuration.set('hideNonConformingTargetBranches', false);
  await handleCreateMainMergeRequest(tokenManager, provider, featureItem);
  assert.deepEqual(targetPick.items.map(item => item.label), [
    'release/v1', 'release/v2', 'master', 'main', 'dev', 'uat'
  ]);
  assert.equal(created.length, 2);
  configuration.delete('hideNonConformingTargetBranches');
  const getBranches = GitService.prototype.getBranches;
  GitService.prototype.getBranches = async () => ['main', 'dev'];
  const picksBeforeEmpty = targetPick.items;
  await handleCreateMainMergeRequest(tokenManager, provider, featureItem);
  assert.match(warnings.at(-1) ?? '', /没有符合内置合并规则.*hideNonConformingTargetBranches/);
  assert.equal(targetPick.items, picksBeforeEmpty);
  assert.equal(created.length, 2);
  assert.equal(titleInput.titles.length, titleCount);
  GitService.prototype.getBranches = getBranches;

  targetPick.value = 'uat';
  titleInput.value = 'Merge release to uat';
  await handleCreateMainMergeRequest(tokenManager, provider, releaseItem);
  assert.equal(created.length, 3);
  assert.equal(created[2].sourceBranch, 'release/v1');
  assert.equal(created[2].targetBranch, 'uat');
  assert.deepEqual(created[2].reviewerIds, [12, 34]);
  assert.match(titleInput.titles.at(-1) ?? '', /release-uat/);

  configuration.set('defaultReviewers', ['alice', 'missing']);
  await assert.rejects(handleCreateMainMergeRequest(tokenManager, provider, releaseItem), /missing.*未创建 MR/);
  assert.equal(created.length, 3);
  configuration.set('defaultReviewers', ['unavailable']);
  await assert.rejects(handleCreateMainMergeRequest(tokenManager, provider, releaseItem), /Reviewer unavailable.*User API failed/);
  assert.equal(created.length, 3);
  configuration.set('defaultReviewers', [' @ ']);
  await assert.rejects(handleCreateMainMergeRequest(tokenManager, provider, releaseItem), /空用户名/);
  assert.equal(created.length, 3);
  configuration.set('defaultReviewers', 'gitlab_reviewer');
  await assert.rejects(handleCreateMainMergeRequest(tokenManager, provider, releaseItem), /用户名数组.*gitlab_reviewer/);
  assert.equal(created.length, 3);
  configuration.clear();

  titleInput.value = undefined;
  await handleCreateMainMergeRequest(tokenManager, provider, releaseItem);
  assert.equal(created.length, 3);
  GitService.prototype.isBranchMergedIntoMain = async () => true;
  await handleCreateMainMergeRequest(tokenManager, provider, releaseItem);
  assert.match(informationMessages.at(-1) ?? '', /无需创建 MR/);
  assert.equal(created.length, 3);

  GitService.prototype.isBranchMergedIntoMain = async () => { throw new Error('Fetch failed'); };
  await assert.rejects(handleCreateMainMergeRequest(tokenManager, provider, releaseItem), /Fetch failed/);
  assert.equal(created.length, 3);
  await handleCreateMainMergeRequest(tokenManager, provider);
  assert.match(warnings.at(-1) ?? '', /选择 main 以外的分支/);
  const mainItem = provider.getChildren().find(item => item.branchPath === 'main');
  await handleCreateMainMergeRequest(tokenManager, provider, mainItem);
  assert.match(warnings.at(-1) ?? '', /选择 main 以外的分支/);
  provider.setBranches(['release/v1']);
  const networkCallsBeforeFilter = JSON.stringify(calls);
  titleInput.value = '  PROJ-1  ';
  let remoteSearches = 0;
  await handleFilterBranchesByKeyword(provider, async () => { remoteSearches++; });
  assert.equal(provider.getBranchKeyword(), 'PROJ-1');
  assert.equal(remoteSearches, 1);
  assert.deepEqual(provider.getBranches(), []);
  titleInput.value = undefined;
  await handleFilterBranchesByKeyword(provider);
  assert.equal(provider.getBranchKeyword(), 'PROJ-1');
  assert.equal(titleInput.titles.at(-1), 'PROJ-1');
  titleInput.value = '';
  await handleFilterBranchesByKeyword(provider);
  assert.equal(provider.getBranchKeyword(), '');
  assert.equal(JSON.stringify(calls), networkCallsBeforeFilter);
  provider.dispose();
  console.log('[PASS] interactions: initial/full refresh, selection checks only current branch, release MR scope, preserved markers and failure handling');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

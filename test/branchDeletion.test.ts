import assert from 'assert';
import axios from 'axios';
import { readFileSync } from 'fs';
import * as vscode from 'vscode';
import { handleDeleteBranch } from '../src/extension';
import { GitService } from '../src/gitService';
import { GitLabService } from '../src/gitlabService';
import { ReleaseReadinessProvider, ReleaseReadinessTreeItem } from '../src/releaseReadinessView';
import { configuration, informationMessages, warningDialog } from './vscodeMock';

async function runTests(): Promise<void> {
  const branch = 'feature/v1/PROJ-1';
  const calls: Array<{ method: string; url: string }> = [];
  let metadata: unknown = { name: branch, protected: false, default: false, commit: { id: 'branch-sha' } };
  let mainMetadata = { name: 'main', commit: { id: 'main-sha' } };
  let deleteStatus = 204;
  let readStatus = 200;
  axios.defaults.adapter = async config => {
    calls.push({ method: config.method!, url: config.url! });
    const deleting = config.method === 'delete';
    return {
      config, status: deleting ? deleteStatus : readStatus, statusText: 'Test', headers: {},
      data: deleting ? '' : JSON.stringify(config.url?.endsWith('/main') ? mainMetadata : metadata)
    };
  };
  const service = new GitLabService('https://gitlab.example.com', 'test-token');
  const deleteBranch = () => service.deleteBranch('group/project', branch, 'branch-sha', 'main-sha');
  const deleted = () => calls.filter(call => call.method === 'delete').length;
  await deleteBranch();
  assert.equal(deleted(), 1);
  assert.equal(calls.at(-1)?.url,
    'https://gitlab.example.com/api/v4/projects/group%2Fproject/repository/branches/feature%2Fv1%2FPROJ-1');
  const beforeMain = calls.length;
  await assert.rejects(service.deleteBranch(1, 'main', 'branch-sha', 'main-sha'), /禁止删除/);
  await assert.rejects(service.deleteBranch(1, '', 'branch-sha', 'main-sha'), /禁止删除/);
  assert.equal(calls.length, beforeMain);
  for (const invalid of [
    { name: branch, protected: true, default: false, commit: { id: 'branch-sha' } },
    { name: branch, protected: false, default: true, commit: { id: 'branch-sha' } },
    { name: branch, protected: false, default: false, commit: { id: 'new-sha' } },
    { name: branch, protected: false, default: false },
    { name: branch },
    null
  ]) {
    metadata = invalid;
    await assert.rejects(deleteBranch(), /禁止删除|已更新|信息无效/);
    assert.equal(deleted(), 1);
  }
  metadata = { name: branch, protected: false, default: false, commit: { id: 'branch-sha' } };
  mainMetadata = { name: 'main', commit: { id: 'new-main-sha' } };
  await assert.rejects(deleteBranch(), /已更新/);
  assert.equal(deleted(), 1);
  mainMetadata.commit.id = 'main-sha';
  for (const status of [403, 404, 500]) {
    readStatus = status;
    await assert.rejects(deleteBranch(), new RegExp(String(status)));
    assert.equal(deleted(), 1);
  }
  readStatus = 200;
  deleteStatus = 403;
  await assert.rejects(deleteBranch(), /403/);
  deleteStatus = 204;
  const provider = new ReleaseReadinessProvider();
  provider.setBranches(['main', branch, 'release/v1']);
  provider.setMergedIntoMain([branch, 'main']);
  const item = provider.getBranchItem(branch)!;
  const tokenManager = { getToken: async () => 'test-token', promptForToken: async () => undefined };
  const run = (selected: ReleaseReadinessTreeItem | undefined = item) =>
    handleDeleteBranch(tokenManager, provider, selected);
  assert.equal(item.contextValue, 'remoteBranch');
  await assert.rejects(run(), /默认关闭/);
  configuration.set('allowBranchDeletion', true);
  assert.match(provider.getBranchItem(branch)?.contextValue ?? '', /-canDeleteBranch$/);
  assert.equal(provider.getBranchItem('main')?.contextValue, 'remoteBranch');
  assert.doesNotMatch(provider.getBranchItem('release/v1')?.contextValue ?? '', /canDeleteBranch/);
  assert.equal(provider.getChildren().find(child => child.kind === 'directory')?.contextValue, undefined);
  configuration.set('allowBranchDeletion', false);
  assert.equal(provider.getBranchItem(branch)?.contextValue, 'remoteBranch');
  configuration.set('allowBranchDeletion', 'true');
  await assert.rejects(run(), /默认关闭/);
  configuration.set('allowBranchDeletion', true);
  await assert.rejects(run(provider.getBranchItem('main')), /不能删除/);
  await assert.rejects(run(provider.getChildren().find(child => child.kind === 'directory')), /不能删除/);
  let checks = 0;
  let merged = true;
  let failCheck = false;
  let disableDuringCheck = false;
  GitService.prototype.getRepoInfo = async () => ({
    rootPath: '/test/workspace', sourceBranch: 'main',
    remoteUrl: 'https://gitlab.example.com/group/project.git',
    projectPath: 'group/project', gitlabHost: 'gitlab.example.com'
  });
  GitService.prototype.checkBranchForDeletion = async name => {
    assert.equal(name, branch);
    checks++;
    if (failCheck) {
      throw new Error('Fetch failed');
    }
    if (disableDuringCheck) {
      configuration.set('allowBranchDeletion', false);
    }
    return { merged, commit: 'branch-sha', mainCommit: 'main-sha' };
  };
  GitLabService.prototype.getProject = async () => ({
    id: 1, name: 'project', web_url: 'https://gitlab.example.com/group/project'
  });
  const beforeCancel = calls.length;
  assert.equal(await run(), false);
  assert.equal(warningDialog.modal, true);
  assert.equal(checks, 0);
  assert.equal(calls.length, beforeCancel);
  warningDialog.value = '删除远程分支';
  assert.equal(await handleDeleteBranch({
    getToken: async () => undefined,
    promptForToken: async () => undefined
  }, provider, item), false);
  assert.equal(checks, 0);
  merged = false;
  const beforeRejected = deleted();
  await assert.rejects(run(), /尚有代码未合入/);
  assert.equal(provider.isMergedIntoMain(branch), false);
  failCheck = true;
  await assert.rejects(run(), /Fetch failed/);
  assert.equal(deleted(), beforeRejected);
  failCheck = false;
  merged = true;
  disableDuringCheck = true;
  await assert.rejects(run(), /已关闭/);
  assert.equal(deleted(), beforeRejected);
  disableDuringCheck = false;
  configuration.set('allowBranchDeletion', true);
  deleteStatus = 403;
  await assert.rejects(run(), /403/);
  assert.equal(provider.getBranches().includes(branch), true);
  deleteStatus = 204;
  provider.setReadiness('release/v1', [{ branch, state: 'merged' }]);
  provider.startReleasePages('release/v1').branches = [branch];
  provider.setReadiness('release/v1', [{ branch, state: 'merged' }]);
  const release = provider.getBranchItem('release/v1')!;
  const feature = provider.getChildren(release).find(child => child.kind === 'feature')!;
  assert.match(feature.contextValue ?? '', /canDeleteBranch$/);
  const beforeSuccess = deleted();
  const oldBranchPage = provider.branchPage;
  assert.equal(await run(feature), true);
  assert.notEqual(provider.branchPage, oldBranchPage);
  provider.appendBranchPage(oldBranchPage, { items: [branch], hasMore: false });
  assert.equal(deleted(), beforeSuccess + 1);
  assert.equal(provider.getBranches().includes(branch), false);
  assert.equal(provider.isMergedIntoMain(branch), false);
  assert.equal(provider.getChildren(release).some(child => child.status?.branch === branch), false);
  assert.deepEqual(provider.releasePages.get('release/v1')?.branches, []);
  assert.match(informationMessages.at(-1) ?? '', /本地分支保持不变/);
  configuration.delete('allowBranchDeletion');
  const removedSelection = new ReleaseReadinessProvider();
  removedSelection.setBranches(['main', 'release/v1'], 'release/v1');
  removedSelection.setReadiness('release/v1', []);
  removedSelection.startReleasePages('release/v1');
  removedSelection.setMainCheck('release/v1', '最新代码已全部合入 main');
  removedSelection.removeBranch('release/v1');
  assert.equal(removedSelection.selectedBranch, undefined);
  assert.equal(removedSelection.releaseBranch, undefined);
  assert.equal(removedSelection.releasePages.has('release/v1'), false);
  assert.deepEqual(removedSelection.getBranches(), ['main']);
  removedSelection.dispose();
  assert.equal(configuration.has('removeSourceBranch'), false);
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(manifest.contributes.configuration.properties['gitlabMr.allowBranchDeletion'].default, false);
  assert.equal(manifest.contributes.configuration.properties['gitlabMr.removeSourceBranch'].default, true);
  const menus = manifest.contributes.menus['view/item/context'].filter(
    (entry: { command: string }) => entry.command === 'gitlabMr.deleteBranch'
  );
  assert.equal(menus.length, 2);
  assert.ok(menus.every((entry: { when: string }) =>
    entry.when.includes('config.gitlabMr.allowBranchDeletion') && entry.when.includes('-canDeleteBranch$')));
  provider.dispose();
  console.log('[PASS] branch deletion: opt-in, confirmation, fresh checks, protection, SHA changes, API errors, tree cleanup');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

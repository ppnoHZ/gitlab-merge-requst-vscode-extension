import assert from 'assert';
import * as vscode from 'vscode';
import { handleCheckReleaseReadiness } from '../src/extension';
import { GitService } from '../src/gitService';
import { GitLabService } from '../src/gitlabService';
import { ReleaseReadinessProvider } from '../src/releaseReadinessView';
import { warnings } from './vscodeMock';

async function runTests(): Promise<void> {
  const calls = { list: 0, all: 0, version: 0, project: 0, selected: [] as string[], mr: [] as string[] };
  const branches = ['main', 'feature/v1/PROJ-1', 'release/v1', 'dev'];
  let failSelected = false;
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
    return branch !== 'main';
  };
  GitLabService.prototype.getProject = async () => {
    calls.project++;
    return { id: 1, name: 'project', web_url: 'https://gitlab.com/group/project' };
  };
  GitLabService.prototype.getGitLabVersion = async () => {
    calls.version++;
    return { version: '18.0' };
  };
  GitLabService.prototype.getProjectBranches = async () => {
    calls.list++;
    return [...branches];
  };
  GitLabService.prototype.getMergeRequestsTargetingBranch = async (projectId, target) => {
    calls.mr.push(target);
    return [];
  };

  const tokenManager = { getToken: async () => 'test-token', promptForToken: async () => undefined };
  const provider = new ReleaseReadinessProvider();
  const treeView: { description?: string } = {};
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

  failSelected = true;
  await handleCheckReleaseReadiness(tokenManager, provider, treeView, { selectedBranch: 'dev' });
  assert.match(warnings.at(-1) ?? '', /Fetch failed/);
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
  assert.deepEqual(calls.selected, ['release/v1', 'dev', 'dev']);
  assert.deepEqual(provider.getBranches(), [...branches].sort());
  const snapshot = provider.getBranches();
  snapshot.push('invalid');
  assert.equal(provider.getBranches().includes('invalid'), false);
  provider.dispose();
  console.log('[PASS] interactions: initial/full refresh, selection checks only current branch, release MR scope, preserved markers and failure handling');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

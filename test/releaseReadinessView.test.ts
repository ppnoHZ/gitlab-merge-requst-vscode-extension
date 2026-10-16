import assert from 'assert';
import * as vscode from 'vscode';
import { commonBranchFilters, ReleaseReadinessProvider } from '../src/releaseReadinessView';
import { readFileSync } from 'fs';

const provider = new ReleaseReadinessProvider();
let changes = 0;
provider.onDidChangeTreeData(() => changes++);
assert.deepEqual(provider.getChildren(), []);
provider.setBranches([
  'release/2.8.0/hotfix',
  'release/2.8.0/patch/nested',
  'feature/2.8.0/PROJ-1/login',
  'feature/2.9.0/PROJ-2',
  'main',
  'main'
]);

const roots = provider.getChildren();
assert.deepEqual(roots.map(item => item.label), ['feature', 'main', 'release']);
assert.equal(roots[0].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
assert.equal(roots[1].collapsibleState, vscode.TreeItemCollapsibleState.None);
assert.equal(roots[1].command?.command, 'gitlabMr.checkReleaseReadiness');
assert.equal(roots[1].command?.arguments?.[0].branchPath, 'main');
assert.equal(roots[1].tooltip, 'main');
assert.deepEqual(provider.getChildren(roots[1]), []);

const versions = provider.getChildren(roots[0]);
assert.deepEqual(versions.map(item => item.label), ['2.8.0', '2.9.0']);
const issue = provider.getChildren(versions[0])[0];
assert.equal(issue.label, 'PROJ-1');
assert.equal(issue.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
const feature = provider.getChildren(issue)[0];
assert.equal(feature.label, 'login');
assert.equal(feature.branchPath, 'feature/2.8.0/PROJ-1/login');
assert.equal(feature.id, 'remote-branch:feature/2.8.0/PROJ-1/login');
assert.equal(feature.collapsibleState, vscode.TreeItemCollapsibleState.None);

const releaseVersion = provider.getChildren(roots[2])[0];
assert.deepEqual(provider.getChildren(releaseVersion).map(item => item.label), ['hotfix', 'patch']);
const patch = provider.getChildren(releaseVersion)[1];
assert.equal(provider.getChildren(patch)[0].branchPath, 'release/2.8.0/patch/nested');
assert.equal(patch.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

provider.setMergedIntoMain(['main', 'feature/2.8.0/PROJ-1/login']);
const marked = provider.getChildren(issue)[0];
assert.deepEqual(marked.iconPath, new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')));
assert.equal(marked.description, '代码已合入 main');
assert.match(String(marked.tooltip), /最新内容已全部合入远程 main/);
assert.deepEqual(provider.getChildren()[1].iconPath, new vscode.ThemeIcon('git-branch'));
assert.deepEqual(provider.getChildren()[0].iconPath, new vscode.ThemeIcon('folder'));
assert.deepEqual(provider.getChildren(releaseVersion)[0].iconPath, new vscode.ThemeIcon('git-branch'));

provider.setReadiness('release/2.8.0/hotfix', [
  { branch: 'feature/2.8.0/PROJ-1/login', state: 'not-created' },
  {
    branch: 'feature/2.8.0/PROJ-2',
    state: 'merged',
    mergeRequest: {
      source_branch: 'feature/2.8.0/PROJ-2',
      target_branch: 'release/2.8.0/hotfix',
      state: 'merged',
      iid: 1,
      title: 'Feature',
      web_url: 'https://gitlab.example.com/project/-/merge_requests/1'
    }
  }
]);
const checkedRoots = provider.getChildren();
assert.equal(checkedRoots[0].kind, 'readiness');
assert.deepEqual(checkedRoots.slice(1).map(item => item.label), ['feature', 'main', 'release']);
const groups = provider.getChildren(checkedRoots[0]);
assert.deepEqual(groups.map(item => item.label), ['已合并 (1)', '尚未创建 MR (1)']);
assert.equal(provider.getChildren(groups[0])[0].command?.command, 'gitlabMr.openReleaseMergeRequest');
assert.equal(provider.getChildren(groups[1])[0].command?.command, 'gitlabMr.createReleaseFeatureMergeRequest');
assert.deepEqual(
  provider.getChildren(groups[1])[0].iconPath,
  new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
);
provider.setMergedIntoMain([]);
assert.deepEqual(provider.getChildren(issue)[0].iconPath, new vscode.ThemeIcon('git-branch'));

provider.setBranches(['main', 'release/2.8.0/hotfix']);
assert.equal(provider.releaseBranch, 'release/2.8.0/hotfix');
assert.equal(provider.getChildren()[0].kind, 'readiness');

provider.setBranches(['main', 'release/2.8.0/hotfix'], 'main');
assert.equal(provider.releaseBranch, undefined);
assert.equal(provider.selectedBranch, 'main');
assert.equal(provider.getChildren()[0].description, '当前选择');
assert.equal(provider.getChildren().some(item => item.kind === 'readiness'), false);

provider.setBranches([]);
assert.equal(provider.selectedBranch, undefined);
assert.deepEqual(provider.getChildren(), []);
assert.equal(changes, 7);

provider.setReadiness('release/2.8.0', []);
assert.equal(provider.getChildren(provider.getChildren()[0])[0].kind, 'message');
provider.setBranches(['main']);
assert.equal(provider.releaseBranch, undefined);
assert.equal(provider.selectedBranch, undefined);
assert.deepEqual(provider.getChildren().map(item => item.label), ['main']);
provider.dispose();
console.log('[PASS] 远程分支树：默认全部分支、逐层折叠、分支选择和上线检查回归');

const filtered = new ReleaseReadinessProvider();
assert.equal(filtered.hasBranches, false);
assert.deepEqual(filtered.getBranchFilters(), commonBranchFilters);
const filterBranches = [
  'feature/v1/PROJ-1/deep/path', 'release/v1', 'bugfix/fix', 'hotfix/fix',
  'dev', 'uat', 'main', 'tst', 'pre', 'develop', 'dev/test', 'main-backup',
  'feature-old/task', 'archive/old', 'master'
];
filtered.setBranches(filterBranches);
assert.equal(filtered.hasBranches, true);
assert.deepEqual(
  filtered.getChildren().map(item => item.label),
  ['bugfix', 'dev', 'feature', 'hotfix', 'main', 'pre', 'release', 'tst', 'uat']
);
filtered.setBranchFilters(['feature/', 'main']);
assert.deepEqual(filtered.getChildren().map(item => item.label), ['feature', 'main']);
const featureRoot = filtered.getChildren()[0];
const versionNode = filtered.getChildren(featureRoot)[0];
const issueNode = filtered.getChildren(versionNode)[0];
const deepNode = filtered.getChildren(issueNode)[0];
assert.equal(filtered.getChildren(deepNode)[0].branchPath, 'feature/v1/PROJ-1/deep/path');
assert.equal(featureRoot.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
filtered.setMergedIntoMain(['feature/v1/PROJ-1/deep/path']);
assert.deepEqual(
  filtered.getChildren(deepNode)[0].iconPath,
  new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
);
filtered.setBranchFilters(['dev']);
assert.deepEqual(filtered.getChildren().map(item => item.label), ['dev']);
filtered.setBranches(filterBranches);
assert.deepEqual(filtered.getBranchFilters(), ['dev']);
assert.deepEqual(filtered.getChildren().map(item => item.label), ['dev']);

filtered.setBranchFilters(['absent/']);
const noMatch = filtered.getChildren();
assert.equal(noMatch.length, 1);
assert.equal(noMatch[0].kind, 'message');
assert.equal(noMatch[0].command?.command, 'gitlabMr.filterReleaseBranches');
assert.equal(filtered.hasBranches, true);
filtered.setBranchFilters([]);
assert.equal(filtered.getBranchFilters(), null);
assert.equal(filtered.getChildren().length, 14);
filtered.setBranchFilters(['dev']);
filtered.setReadiness('release/v1', [{ branch: 'feature/v1/PROJ-1', state: 'not-created' }]);
const retainedReadiness = filtered.getChildren()[0];
assert.equal(retainedReadiness.kind, 'readiness');
assert.equal(filtered.getChildren(filtered.getChildren(retainedReadiness)[0])[0].status?.branch, 'feature/v1/PROJ-1');
assert.equal(filtered.releaseBranch, 'release/v1');
filtered.setBranchFilters(null);
assert.equal(filtered.getChildren().some(item => item.label === 'archive'), true);
filtered.dispose();

const restored = new ReleaseReadinessProvider(['release/']);
restored.setBranches(filterBranches);
assert.deepEqual(restored.getChildren().map(item => item.label), ['release']);
const filterSnapshot = restored.getBranchFilters();
filterSnapshot?.push('main');
assert.deepEqual(restored.getBranchFilters(), ['release/']);
restored.dispose();
const restoredAll = new ReleaseReadinessProvider(null);
restoredAll.setBranches(['master', 'archive/old']);
assert.deepEqual(restoredAll.getChildren().map(item => item.label), ['archive', 'master']);
restoredAll.dispose();

const manifest = JSON.parse(readFileSync(`${__dirname}/../package.json`, 'utf8'));
assert.equal(
  manifest.contributes.commands.some((command: { command: string; icon?: string }) =>
    command.command === 'gitlabMr.filterReleaseBranches' && command.icon === '$(filter)'
  ),
  true
);
assert.equal(
  manifest.contributes.menus['view/title'].some((item: { command: string; when: string }) =>
    item.command === 'gitlabMr.filterReleaseBranches' && item.when === 'view == gitlabMr.releaseReadiness'
  ),
  true
);
console.log('[PASS] branch filters: defaults, multi-select, exact/prefix matching, restore all, empty results, saved state, MR and green markers');

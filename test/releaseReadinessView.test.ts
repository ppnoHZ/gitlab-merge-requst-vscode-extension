import assert from 'assert';
import * as vscode from 'vscode';
import { commonBranchFilters, ReleaseReadinessProvider } from '../src/releaseReadinessView';
import { readFileSync } from 'fs';

function branchRoots(provider: ReleaseReadinessProvider) {
  return provider.getChildren().filter(item => item.kind !== 'search');
}

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

const roots = branchRoots(provider);
const search = provider.getChildren()[0];
assert.equal(search.kind, 'search');
assert.equal(search.label, '搜索分支');
assert.equal(search.id, 'branch-search');
assert.equal(search.command?.command, 'gitlabMr.filterBranchesByKeyword');
assert.deepEqual(search.iconPath, new vscode.ThemeIcon('search'));
assert.equal(search.collapsibleState, vscode.TreeItemCollapsibleState.None);
assert.equal(search.description, undefined);
assert.equal(search.contextValue, undefined);
assert.equal(provider.getParent(search), undefined);
assert.deepEqual(provider.getChildren(search), []);
assert.deepEqual(roots.map(item => item.label), ['feature', 'main', 'release']);
assert.equal(roots[0].collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
assert.equal(roots[1].collapsibleState, vscode.TreeItemCollapsibleState.None);
assert.equal(roots[1].command?.command, 'gitlabMr.checkReleaseReadiness');
assert.equal(roots[1].command?.arguments?.[0].branchPath, 'main');
assert.equal(roots[1].tooltip, 'main');
assert.equal(roots[1].contextValue, 'remoteBranch');
assert.equal(roots[0].contextValue, undefined);
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
assert.equal(feature.contextValue, 'remoteBranch-canMergeToMain');

const releaseVersion = provider.getChildren(roots[2])[0];
assert.deepEqual(provider.getChildren(releaseVersion).map(item => item.label), ['hotfix', 'patch']);
const patch = provider.getChildren(releaseVersion)[1];
assert.equal(provider.getChildren(patch)[0].branchPath, 'release/2.8.0/patch/nested');
assert.equal(patch.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);

provider.setMergedIntoMain(['main', 'feature/2.8.0/PROJ-1/login']);
const marked = provider.getChildren(issue)[0];
assert.deepEqual(marked.iconPath, new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')));
assert.equal(marked.description, '代码已合入 main');
assert.equal(marked.contextValue, 'remoteBranch');
assert.match(String(marked.tooltip), /最新内容已全部合入远程 main/);
assert.deepEqual(branchRoots(provider)[1].iconPath, new vscode.ThemeIcon('git-branch'));
assert.deepEqual(branchRoots(provider)[0].iconPath, new vscode.ThemeIcon('folder'));
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
const checkedRoots = branchRoots(provider);
assert.deepEqual(checkedRoots.map(item => item.label), ['feature', 'main', 'release']);
const checkedBranch = provider.getBranchItem('release/2.8.0/hotfix');
assert.ok(checkedBranch);
assert.equal(checkedBranch.collapsibleState, vscode.TreeItemCollapsibleState.Collapsed);
const results = provider.getChildren(checkedBranch);
assert.deepEqual(results.map(item => item.status?.state), ['not-created', 'merged']);
assert.equal(provider.getParent(results[0]), checkedBranch);
assert.equal(results[0].branchPath, 'release/2.8.0/hotfix');
assert.equal(results[1].command?.command, 'gitlabMr.openReleaseMergeRequest');
assert.equal(results[1].contextValue, 'releaseFeature-merged-canMergeToMain');
assert.equal(results[0].contextValue, 'releaseFeature-not-created');
assert.equal(results[0].command?.command, 'gitlabMr.createReleaseFeatureMergeRequest');
assert.equal(results[0].command?.arguments?.[0], results[0]);
assert.match(String(results[1].description), /已合并/);
assert.deepEqual(
  results[0].iconPath,
  new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'))
);
provider.setMergedIntoMain([]);
assert.deepEqual(provider.getChildren(issue)[0].iconPath, new vscode.ThemeIcon('git-branch'));
assert.equal(provider.getChildren(checkedBranch)[0].contextValue, 'releaseFeature-not-created-canMergeToMain');

provider.setBranches(['main', 'release/2.8.0/hotfix']);
assert.equal(provider.releaseBranch, 'release/2.8.0/hotfix');
assert.equal(provider.getChildren(checkedBranch).length, 2);

provider.setBranches(['main', 'release/2.8.0/hotfix'], 'main');
assert.equal(provider.releaseBranch, undefined);
assert.equal(provider.selectedBranch, 'main');
assert.equal(branchRoots(provider)[0].description, '当前选择');
assert.equal(provider.getChildren(checkedBranch).length, 2);
provider.setBranches(['main', 'release/2.8.0/hotfix', 'release/2.8.0/patch/nested']);
provider.setReadiness('release/2.8.0/patch/nested', [
  { branch: 'feature/2.8.0/PROJ-1/login', state: 'not-created' }
]);
const secondBranch = provider.getBranchItem('release/2.8.0/patch/nested');
assert.ok(secondBranch);
const secondResult = provider.getChildren(secondBranch)[0];
assert.equal(secondResult.branchPath, 'release/2.8.0/patch/nested');
assert.notEqual(secondResult.id, results[0].id);
assert.equal(provider.getChildren(checkedBranch)[0].branchPath, 'release/2.8.0/hotfix');
assert.equal(provider.getChildren(checkedBranch).length, 2);

provider.setBranches([]);
assert.equal(provider.selectedBranch, undefined);
assert.deepEqual(provider.getChildren(), []);
assert.equal(changes, 9);

provider.setBranches(['release/2.8.0', 'main']);
provider.setReadiness('release/2.8.0', []);
const emptyBranch = provider.getBranchItem('release/2.8.0');
assert.ok(emptyBranch);
assert.match(String(provider.getChildren(emptyBranch)[0].label), /没有找到/);
provider.setBranches(['main']);
assert.equal(provider.releaseBranch, undefined);
assert.equal(provider.selectedBranch, undefined);
assert.deepEqual(branchRoots(provider).map(item => item.label), ['main']);
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
  branchRoots(filtered).map(item => item.label),
  ['bugfix', 'dev', 'feature', 'hotfix', 'main', 'pre', 'release', 'tst', 'uat']
);
filtered.setBranchFilters(['feature/', 'main']);
assert.deepEqual(branchRoots(filtered).map(item => item.label), ['feature', 'main']);
const featureRoot = branchRoots(filtered)[0];
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
assert.deepEqual(branchRoots(filtered).map(item => item.label), ['dev']);
filtered.setBranches(filterBranches);
assert.deepEqual(filtered.getBranchFilters(), ['dev']);
assert.deepEqual(branchRoots(filtered).map(item => item.label), ['dev']);

filtered.setBranchFilters(['absent/']);
const noMatch = branchRoots(filtered);
assert.equal(filtered.getChildren()[0].kind, 'search');
assert.equal(noMatch.length, 1);
assert.equal(noMatch[0].kind, 'message');
assert.equal(noMatch[0].command?.command, 'gitlabMr.filterReleaseBranches');
assert.equal(filtered.hasBranches, true);
filtered.setBranchFilters([]);
assert.equal(filtered.getBranchFilters(), null);
assert.equal(branchRoots(filtered).length, 14);
filtered.setBranchFilters(['dev']);
filtered.setReadiness('release/v1', [{ branch: 'feature/v1/PROJ-1', state: 'not-created' }]);
const retainedReadiness = branchRoots(filtered)[0];
assert.equal(retainedReadiness.branchPath, 'dev');
assert.equal(filtered.getBranchItem('release/v1'), undefined);
assert.equal(filtered.releaseBranch, 'release/v1');
filtered.setBranchFilters(null);
assert.equal(filtered.getChildren().some(item => item.label === 'archive'), true);
const restoredRelease = filtered.getBranchItem('release/v1');
assert.ok(restoredRelease);
assert.equal(filtered.getChildren(restoredRelease)[0].status?.branch, 'feature/v1/PROJ-1');
filtered.setMainCheck('uat', '最新代码已全部合入 main');
const checkedDev = filtered.getBranchItem('uat');
assert.ok(checkedDev);
assert.equal(filtered.getChildren(checkedDev)[0].label, '最新代码已全部合入 main');
assert.equal(filtered.getChildren(restoredRelease)[0].status?.branch, 'feature/v1/PROJ-1');
filtered.clearChecks();
assert.deepEqual(filtered.getChildren(checkedDev), []);
assert.deepEqual(filtered.getChildren(restoredRelease), []);
filtered.dispose();

const restored = new ReleaseReadinessProvider(['release/']);
restored.setBranches(filterBranches);
assert.deepEqual(branchRoots(restored).map(item => item.label), ['release']);
const filterSnapshot = restored.getBranchFilters();
filterSnapshot?.push('main');
assert.deepEqual(restored.getBranchFilters(), ['release/']);
restored.dispose();
const restoredAll = new ReleaseReadinessProvider(null);
restoredAll.setBranches(['master', 'archive/old']);
assert.deepEqual(branchRoots(restoredAll).map(item => item.label), ['archive', 'master']);
assert.equal(branchRoots(restoredAll)[1].contextValue, 'remoteBranch');
restoredAll.dispose();

const keywordFiltered = new ReleaseReadinessProvider(['feature/', 'release/']);
const keywordBranches = [
  'main', 'feature/v1/PROJ-1/deep/path', 'feature/v1/PROJ-2',
  'release/v1', 'release/v2', 'archive/PROJ-1'
];
keywordFiltered.setBranches(keywordBranches, 'release/v1');
keywordFiltered.setReadiness('release/v1', [
  { branch: 'feature/v1/PROJ-2', state: 'not-created' }
]);
keywordFiltered.setMainCheck('release/v1', '最新代码已全部合入 main');
keywordFiltered.setMergedIntoMain(['feature/v1/PROJ-1/deep/path']);
let keywordChanges = 0;
keywordFiltered.onDidChangeTreeData(() => keywordChanges++);
keywordFiltered.setBranchKeyword('  proj-1  ');
assert.equal(keywordChanges, 1);
assert.equal(keywordFiltered.getBranchKeyword(), 'proj-1');
assert.deepEqual(branchRoots(keywordFiltered).map(item => item.label), ['feature']);
assert.equal(keywordFiltered.getChildren()[0].id, 'branch-search');
assert.equal(keywordFiltered.getChildren()[0].description, undefined);
const keywordLeaf = keywordFiltered.getBranchItem('feature/v1/PROJ-1/deep/path');
assert.ok(keywordLeaf);
assert.deepEqual(keywordLeaf.iconPath, new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed')));
assert.equal(keywordFiltered.getParent(keywordLeaf)?.branchPath, 'feature/v1/PROJ-1/deep');
assert.equal(keywordFiltered.getBranchItem('feature/v1/PROJ-2'), undefined);
assert.equal(keywordFiltered.getBranchItem('archive/PROJ-1'), undefined);
assert.equal(keywordFiltered.getBranchItem('release/v1'), undefined);
assert.deepEqual(keywordFiltered.getBranches(), [...keywordBranches].sort());
assert.equal(keywordFiltered.selectedBranch, 'release/v1');
keywordFiltered.setBranchFilters(null);
assert.deepEqual(branchRoots(keywordFiltered).map(item => item.label), ['archive', 'feature']);
assert.equal(keywordFiltered.getBranchKeyword(), 'proj-1');
keywordFiltered.setBranchKeyword('v1');
assert.deepEqual(branchRoots(keywordFiltered).map(item => item.label), ['feature', 'release']);
const visibleRelease = keywordFiltered.getBranchItem('release/v1');
assert.ok(visibleRelease);
assert.equal(keywordFiltered.getChildren(visibleRelease).length, 2);
assert.equal(keywordFiltered.getChildren(visibleRelease)[1].status?.branch, 'feature/v1/PROJ-2');
keywordFiltered.clearChecks();
keywordFiltered.setBranches([...keywordBranches, 'feature/v1/PROJ-3']);
assert.equal(keywordFiltered.getBranchKeyword(), 'v1');
assert.ok(keywordFiltered.getBranchItem('feature/v1/PROJ-3'));
keywordFiltered.setBranchKeyword('absent');
assert.equal(keywordFiltered.getChildren()[0].kind, 'search');
assert.equal(keywordFiltered.getChildren()[0].command?.command, 'gitlabMr.filterBranchesByKeyword');
assert.equal(keywordFiltered.getChildren()[1].kind, 'message');
assert.equal(keywordFiltered.getChildren()[1].command?.command, 'gitlabMr.filterBranchesByKeyword');
keywordFiltered.setBranchKeyword('   ');
assert.equal(keywordFiltered.getBranchKeyword(), '');
assert.deepEqual(branchRoots(keywordFiltered).map(item => item.label), ['archive', 'feature', 'main', 'release']);
keywordFiltered.dispose();
const newSessionProvider = new ReleaseReadinessProvider();
assert.equal(newSessionProvider.getBranchKeyword(), '');
newSessionProvider.dispose();

const manifest = JSON.parse(readFileSync(`${__dirname}/../package.json`, 'utf8'));
assert.ok(manifest.activationEvents.includes('onCommand:gitlabMr.filterBranchesByKeyword'));
assert.ok(manifest.contributes.commands.some((command: { command: string; icon?: string }) =>
  command.command === 'gitlabMr.filterBranchesByKeyword' && command.icon === '$(search)'
));
assert.equal(manifest.contributes.menus['view/title'].some((item: { command: string; when: string }) =>
  item.command === 'gitlabMr.filterBranchesByKeyword' && item.when === 'view == gitlabMr.releaseReadiness'
), false);
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
assert.ok(manifest.activationEvents.includes('onCommand:gitlabMr.createMainMergeRequest'));
assert.ok(manifest.contributes.commands.some((command: { command: string; icon?: string }) =>
  command.command === 'gitlabMr.checkReleaseReadiness' && command.icon === '$(checklist)'
));
const checkMenus: Array<{ when: string; group: string }> =
  manifest.contributes.menus['view/item/context'].filter((item: { command: string }) =>
    item.command === 'gitlabMr.checkReleaseReadiness'
  );
assert.deepEqual(checkMenus.map(item => item.group), ['inline@1', 'check']);
for (const menu of checkMenus) {
  assert.equal(menu.when, 'view == gitlabMr.releaseReadiness && viewItem =~ /^remoteBranch/');
}
assert.ok(manifest.contributes.commands.some((command: { command: string }) =>
  command.command === 'gitlabMr.createMainMergeRequest'
));
const mainMenus: Array<{ when: string; group: string }> =
  manifest.contributes.menus['view/item/context'].filter((item: { command: string }) =>
    item.command === 'gitlabMr.createMainMergeRequest'
  );
assert.deepEqual(mainMenus.map(item => item.group), ['inline', 'main']);
for (const menu of mainMenus) {
  assert.equal(menu.when, 'view == gitlabMr.releaseReadiness && viewItem =~ /-canMergeToMain$/');
}
for (const state of ['open', 'merged', 'closed', 'not-created']) {
  const featureContext = `releaseFeature-${state}-canMergeToMain`;
  assert.match(featureContext, /-canMergeToMain$/);
  assert.match(featureContext, /releaseFeature-(not-created|closed)|releaseFeature-(open|merged|closed)/);
}
console.log('[PASS] branch filters: defaults, multi-select, exact/prefix matching, restore all, empty results, saved state, MR and green markers');

import assert from 'assert';
import { readFileSync } from 'fs';
import axios from 'axios';
import * as vscode from './vscodeMock';
import { handleCreateRemoteBranch } from '../src/branchCreation';
import { GitLabService } from '../src/gitlabService';
import { GitService } from '../src/gitService';
import { conflictGuide } from '../src/conflictWorkflow';
import { validateConflictTarget, conflictMergeOptions } from '../src/conflictRules';
import { developmentBranchName } from '@gitlab-workbench/core';

async function run() {
  let mainSha = 'a'.repeat(40); const tagSha = 'b'.repeat(40);
  const remote = new Map<string, string>(); let posts = 0; let lost = false; let targetError = false;
  const tokens = { getToken: async () => 'test-token', promptForToken: async () => undefined };
  const originalRepo = GitService.prototype.getRepoInfo;
  GitService.prototype.getRepoInfo = async () => ({ rootPath: '/test', sourceBranch: 'work', remoteUrl: 'https://gitlab.test/g/p.git', gitlabHost: 'gitlab.test', projectPath: 'g/p' });
  axios.defaults.adapter = async config => {
    const url = new URL(config.url!); const path = url.pathname;
    let data: unknown; let status = 200;
    const ref = (name: string, sha: string) => ({ name, commit: { id: sha, title: 'Baseline commit', committed_date: '2026-10-21T00:00:00Z' } });
    if (path === '/api/v4/user') data = { id: 1, name: 'User', username: 'user' };
    else if (path === '/api/v4/projects/g%2Fp') data = { id: 1, name: 'Project', web_url: 'https://gitlab.test/g/p', default_branch: 'main' };
    else if (path.endsWith('/merge_requests')) {
      const body = JSON.parse(config.data);
      assert.equal(body.remove_source_branch, true); assert.equal(body.squash, false);
      data = { iid: 1, web_url: 'https://gitlab.test/g/p/-/merge_requests/1' };
    } else if (config.method === 'post') {
      posts++; const body = JSON.parse(config.data); assert(/^[ab]{40}$/.test(body.ref));
      remote.set(body.branch, body.ref);
      if (lost) throw new Error('connection reset');
      data = ref(body.branch, body.ref);
    } else if (/repository\/(branches|tags)$/.test(path)) data = path.endsWith('tags') ? [ref('v1', tagSha)] : [ref('main', mainSha), ref('dev', mainSha), ...[...remote].map(([name, sha]) => ref(name, sha))];
    else {
      const match = path.match(/repository\/(branches|tags)\/(.+)$/)!;
      assert(match, path);
      const name = decodeURIComponent(match[2]); const sha = match[1] === 'tags' && name === 'v1' ? tagSha : ['main', 'dev'].includes(name) ? mainSha : remote.get(name);
      if (targetError && name === 'tst') { status = 403; data = { message: 'forbidden' }; }
      else if (sha) data = ref(name, sha); else { status = 404; data = { message: 'not found' }; }
    }
    return { config, data: JSON.stringify(data), headers: {}, status, statusText: String(status) };
  };
  const pick = vscode.window.showQuickPick;
  const input = vscode.window.showInputBox;
  const info = vscode.window.showInformationMessage;
  let picks: Array<string | undefined> = [];
  let inputs: Array<string | undefined> = [];
  (vscode.window as any).showQuickPick = async (items: any[]) => { const label = picks.shift(); return items.find(item => item.label === label); };
  (vscode.window as any).showInputBox = async () => inputs.shift();
  (vscode.window as any).showInformationMessage = async () => '复制名称';
  vscode.warningDialog.value = '确认创建';
  try {
    picks = ['分支', 'main']; inputs = ['', '2.8.0'];
    assert.equal(await handleCreateRemoteBranch(tokens, 'release'), true);
    assert.equal(remote.get('release/2.8.0'), mainSha); assert.equal(vscode.clipboard.text, 'release/2.8.0');
    assert(vscode.warnings.at(-1)?.includes(mainSha));
    picks = ['Tag（hotfix 建议选择线上版本）', 'v1']; inputs = ['', '2.7.1', 'PROJ-1', 'fix-login'];
    assert.equal(await handleCreateRemoteBranch(tokens, 'hotfix'), true);
    assert.equal(remote.get('hotfix/2.7.1/PROJ-1-fix-login'), tagSha);
    remote.set('hotfix/H20260706/FOC-0009', tagSha);
    remote.set('release/LI2500076', tagSha);
    picks = ['hotfix/H20260706/FOC-0009', 'dev']; inputs = ['H20260706'];
    assert.equal(await handleCreateRemoteBranch(tokens, 'conflict', 'dev'), true);
    assert.equal(remote.get('conflict/hotfix/H20260706/FOC-0009'), mainSha);
    assert(vscode.warnings.at(-1)?.includes('原始分支：hotfix/H20260706/FOC-0009'));
    picks = ['dev']; inputs = [];
    assert.equal(await handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), true);
    assert.equal(remote.get('conflict/release/LI2500076'), mainSha);
    const guide = vscode.openedDocuments.at(-1)!;
    assert.equal(guide.language, 'markdown');
    assert(guide.content.includes("git merge --no-commit --no-ff 'origin/release/LI2500076'"));
    assert(guide.content.includes('目标分支：`dev`'));
    assert(guide.content.includes('插件未自动关闭任何 MR'));
    const conflictPosts = posts;
    picks = ['dev']; inputs = [];
    await assert.rejects(handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), /可能正用于其他目标环境/);
    assert.equal(posts, conflictPosts);
    remote.delete('conflict/release/LI2500076');
    picks = [undefined]; inputs = [];
    assert.equal(await handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), false);
    assert.equal(posts, conflictPosts);
    picks = ['dev']; inputs = []; targetError = true;
    await assert.rejects(handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), /forbidden|403/);
    targetError = false;
    assert.equal(posts, conflictPosts);
    picks = ['dev']; inputs = [];
    vscode.warningDialog.onShow = () => { remote.set('release/LI2500076', 'c'.repeat(40)); };
    await assert.rejects(handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), /原始源分支提交已变化/);
    vscode.warningDialog.onShow = undefined; remote.set('release/LI2500076', tagSha);
    assert.equal(posts, conflictPosts);
    picks = ['dev']; inputs = [];
    vscode.warningDialog.onShow = () => { mainSha = 'c'.repeat(40); };
    await assert.rejects(handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), /基线提交已变化/);
    vscode.warningDialog.onShow = undefined; mainSha = 'a'.repeat(40);
    assert.equal(posts, conflictPosts);
    picks = ['dev']; inputs = []; vscode.warningDialog.value = undefined;
    assert.equal(await handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), false);
    assert.equal(posts, conflictPosts);
    vscode.warningDialog.value = '确认创建';
    const openDocument = vscode.workspace.openTextDocument;
    vscode.workspace.openTextDocument = async () => { throw new Error('editor unavailable'); };
    try {
      picks = ['dev']; inputs = [];
      assert.equal(await handleCreateRemoteBranch(tokens, 'conflict', 'release/LI2500076'), true);
      assert.equal(posts, conflictPosts + 1);
      assert(vscode.warnings.at(-1)?.includes('已创建'));
    } finally { vscode.workspace.openTextDocument = openDocument; }
    assert.throws(() => validateConflictTarget('release/LI2500076', 'main'), /仅支持/);
    assert.throws(() => validateConflictTarget('main', 'dev'));
    assert.throws(() => conflictGuide({ source: { name: 'release/LI2500076', sha: tagSha, title: '' }, target: { name: 'main', sha: mainSha, title: '' }, branch: 'conflict/release/LI2500076' }));
    assert.deepEqual(conflictMergeOptions('conflict/release/LI2500076', { squash: true, removeSourceBranch: false }), { squash: false, removeSourceBranch: true });
    assert.deepEqual(conflictMergeOptions('release/LI2500076', { squash: true, removeSourceBranch: false }), { squash: true, removeSourceBranch: false });
    await new GitLabService('https://gitlab.test', 'test-token').createMergeRequest({ projectId: 1, sourceBranch: 'conflict/release/LI2500076', targetBranch: 'dev', title: 'Conflict', description: '', removeSourceBranch: false, squash: true });
    const before = posts;
    picks = ['分支', 'main']; inputs = ['', '2.9.0']; vscode.warningDialog.value = undefined;
    assert.equal(await handleCreateRemoteBranch(tokens, 'release'), false); assert.equal(posts, before);
    vscode.warningDialog.value = '确认创建';
    picks = ['分支', 'main']; inputs = ['', '3.0.0'];
    vscode.warningDialog.onShow = () => { mainSha = 'c'.repeat(40); };
    await assert.rejects(handleCreateRemoteBranch(tokens, 'release'), /基线提交已变化/); assert.equal(posts, before);
    vscode.warningDialog.onShow = undefined; mainSha = 'a'.repeat(40);
    picks = ['分支', 'main']; inputs = ['', '2.8.0'];
    await assert.rejects(handleCreateRemoteBranch(tokens, 'release'), /同名分支已存在/); assert.equal(posts, before);
    const service = new GitLabService('https://gitlab.test', 'test-token');
    lost = true;
    const recovered = await service.createRemoteBranch(1, 'release/4.0.0', 'branch', 'main', mainSha);
    assert.equal(recovered.recovered, true); assert.equal(posts, before + 1);
    assert.equal(developmentBranchName({ kind: 'conflict', version: '', conflictSource: 'release/LI2500076', baseKind: 'branch', baseName: 'dev' }), 'conflict/release/LI2500076');
    assert.throws(() => developmentBranchName({ kind: 'conflict', version: '', conflictSource: '../main', baseKind: 'branch', baseName: 'dev' }));
    const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
    for (const suffix of ['Remote', 'Release', 'Hotfix', 'Conflict']) assert(manifest.contributes.commands.some((item: any) => item.command === `gitlabMr.create${suffix}Branch`));
    assert(manifest.contributes.menus['view/item/context'].some((item: any) => item.command === 'gitlabMr.createConflictBranch'));
  } finally {
    GitService.prototype.getRepoInfo = originalRepo;
    vscode.window.showQuickPick = pick; vscode.window.showInputBox = input; vscode.window.showInformationMessage = info;
    vscode.warningDialog.onShow = undefined;
  }
  console.log('[PASS] VS Code branch creation: release/hotfix/conflict, tags, confirmation, cancellation, changed baseline, duplicate names and uncertain recovery');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

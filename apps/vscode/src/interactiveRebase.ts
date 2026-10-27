import * as vscode from 'vscode';
import { GitService } from './gitService';
import { selectedWorkspaceRepository } from './repositoryContext';

const protectedBranches = /^(?:main|master|dev|tst|uat|pre|develop|release(?:\/.*)?)$/i;

export function validateRebaseBranch(branch: string): void {
  if (!branch || branch === 'HEAD') throw new Error('当前处于 detached HEAD，不能启动历史改写。');
  if (protectedBranches.test(branch)) throw new Error(`受保护分支 ${branch} 不允许修改 Commit 历史。请在 feature、bugfix、hotfix、conflict 或 revert 分支操作。`);
}

export function interactiveRebaseCommand(count: number): string {
  if (!Number.isSafeInteger(count) || count < 2 || count > 50) throw new Error('交互式 Rebase 的 Commit 数量必须在 2–50 之间。');
  return `git rebase -i HEAD~${count}`;
}

async function currentGit(): Promise<{ git: GitService; root: string; branch: string }> {
  const repository = await selectedWorkspaceRepository();
  if (!repository) throw new Error('当前工作区没有可用的 Git 仓库。');
  const git = new GitService(repository.folder.uri.fsPath);
  return { git, root: repository.folder.uri.fsPath, branch: await git.getCurrentBranch() };
}

function runInTerminal(root: string, command: string): void {
  const terminal = vscode.window.createTerminal({ name: 'Git 历史修改', cwd: root });
  terminal.show(true);
  terminal.sendText(command, true);
}

export async function startInteractiveRebase(): Promise<void> {
  const { git, root, branch } = await currentGit();
  validateRebaseBranch(branch);
  if (await git.isRebaseInProgress()) throw new Error('当前已有 Rebase 任务，请先执行 Continue 或 Abort。');
  const changes = await git.getWorkingTreeChanges();
  if (changes.length) throw new Error(`工作区存在 ${changes.length} 项未提交改动。请先提交、暂存到其他位置或清理后再修改历史。`);
  const commits = await git.getRecentCommitSummaries(30);
  if (commits.length < 2) throw new Error('当前分支没有足够的 Commit 可供交互式 Rebase。');
  const picked = await vscode.window.showQuickPick(commits.slice(1).map((commit, index) => ({
    label: `最近 ${index + 2} 个 Commit`,
    description: `从 ${commit.shortHash} ${commit.title} 开始改写`,
    count: index + 2
  })), { title: `修改 ${branch} 的 Commit 历史`, placeHolder: '选择需要进入交互式 Rebase 的最近 Commit 范围', ignoreFocusOut: true });
  if (!picked) return;
  const published = await git.hasRemoteTrackingBranch(branch);
  const warning = published
    ? `分支 ${branch} 已存在远端跟踪分支。Rebase 会改写 ${picked.count} 个本地 Commit；完成后普通 Push 将被拒绝，只能人工核对后使用 --force-with-lease。插件不会自动推送。`
    : `Rebase 会改写 ${branch} 最近 ${picked.count} 个 Commit。插件只在终端启动操作，不会自动推送。`;
  const confirm = await vscode.window.showWarningMessage(warning, { modal: true }, '打开交互式 Rebase');
  if (confirm !== '打开交互式 Rebase') return;
  runInTerminal(root, interactiveRebaseCommand(picked.count));
  vscode.window.showInformationMessage('已在集成终端启动交互式 Rebase。可使用 pick、reword、squash、fixup、drop 或调整顺序；遇到冲突后使用 Continue / Abort 命令。');
}

export async function continueInteractiveRebase(): Promise<void> {
  const { git, root } = await currentGit();
  if (!await git.isRebaseInProgress()) throw new Error('当前没有进行中的 Rebase。');
  const conflicts = await git.getUnmergedFiles();
  if (conflicts.length) throw new Error(`仍有 ${conflicts.length} 个未解决冲突：${conflicts.slice(0, 5).join('、')}${conflicts.length > 5 ? '…' : ''}`);
  runInTerminal(root, 'git rebase --continue');
}

export async function abortInteractiveRebase(): Promise<void> {
  const { git, root, branch } = await currentGit();
  if (!await git.isRebaseInProgress()) throw new Error('当前没有进行中的 Rebase。');
  const confirm = await vscode.window.showWarningMessage(`放弃 ${branch} 当前的 Rebase，并恢复到开始前的状态？`, { modal: true }, 'Abort Rebase');
  if (confirm === 'Abort Rebase') runInTerminal(root, 'git rebase --abort');
}

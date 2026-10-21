import * as vscode from 'vscode';
import { developmentBranchName, conflictBranchName, type DevelopmentBranchKind, type BaseKind, type BranchReference } from '@gitlab-workbench/core';
import { GitService } from './gitService';
import { GitLabService } from './gitlabService';
import { AuditApiError } from './audit';
import type { TokenManager } from './tokenManager';

export async function handleCreateRemoteBranch(tokens: Pick<TokenManager, 'getToken' | 'promptForToken'>, selectedKind?: DevelopmentBranchKind, suggestedBase?: string): Promise<boolean> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) { vscode.window.showWarningMessage('请先打开 GitLab 项目工作区'); return false; }
  const kind = selectedKind ?? (await vscode.window.showQuickPick([
    { label: '新建 release', choice: 'release' as const }, { label: '新建 hotfix', choice: 'hotfix' as const }, { label: '新建 conflict', choice: 'conflict' as const }
  ], { title: '新建远程分支', ignoreFocusOut: true }))?.choice;
  if (!kind) return false;
  const token = await tokens.getToken() || await tokens.promptForToken();
  if (!token) return false;
  const git = new GitService(folder.uri.fsPath);
  const repo = await git.getRepoInfo();
  let instance = vscode.workspace.getConfiguration('gitlabMr', folder.uri).get<string>('instanceUrl', 'https://gitlab.com').trim();
  if (instance === 'https://gitlab.com' && repo.gitlabHost !== 'gitlab.com') instance = `https://${repo.gitlabHost}`;
  const service = new GitLabService(instance, token);
  await service.getCurrentUser();
  const project = await service.getProject(repo.projectPath);
  const baseKind: BaseKind | undefined = kind === 'conflict' ? 'branch' : (await vscode.window.showQuickPick([
    { label: '分支', choice: 'branch' as const }, { label: 'Tag（hotfix 建议选择线上版本）', choice: 'tag' as const }
  ], { title: '选择基线类型', ignoreFocusOut: true }))?.choice;
  if (!baseKind) return false;
  const search = await vscode.window.showInputBox({ title: kind === 'conflict' ? '搜索需要合回的目标分支（conflict 从目标分支创建）' : '搜索基线（留空显示全部）', value: kind === 'conflict' ? suggestedBase : '', ignoreFocusOut: true });
  if (search === undefined) return false;
  let page = 1; let base: BranchReference | undefined;
  while (!base) {
    const result = await service.getBranchCreationRefs(project.id, baseKind, page, search.trim());
    const preferred = kind === 'conflict' ? suggestedBase : project.default_branch;
    if (page === 1 && baseKind === 'branch' && !search.trim() && preferred && !result.items.some(ref => ref.name === preferred)) result.items.unshift(await service.getBranchCreationRef(project.id, 'branch', preferred));
    const choices = result.items.map(ref => ({ label: ref.name, description: `${ref.sha.slice(0, 8)}${ref.name === preferred ? ' · 推荐基线' : ''}`, ref, more: false }));
    choices.sort((a, b) => Number(b.ref.name === preferred) - Number(a.ref.name === preferred));
    const chosen = await vscode.window.showQuickPick([...choices, ...(result.hasMore ? [{ label: '加载下一页', description: '', ref: undefined, more: true }] : [])], { title: `选择${kind === 'conflict' ? '目标分支基线' : '基线'}（第 ${page} 页）`, ignoreFocusOut: true });
    if (!chosen) return false;
    if (chosen.more) { page++; continue; }
    base = chosen.ref;
  }
  let name: string;
  let conflictSource: BranchReference | undefined;
  if (kind === 'conflict') {
    const original = await vscode.window.showInputBox({
      title: '原始 release/hotfix 分支（完整名称，自动添加 conflict/ 前缀）',
      placeHolder: 'hotfix/H20260706/FOC-0009 或 release/LI2500076',
      ignoreFocusOut: true,
      validateInput: value => { try { conflictBranchName(value); return undefined; } catch (error) { return (error as Error).message; } }
    });
    if (original === undefined) return false;
    name = conflictBranchName(original);
    conflictSource = await service.getBranchCreationRef(project.id, 'branch', original.trim());
  } else {
    const version = await vscode.window.showInputBox({ title: '版本号', value: base.name.match(/^release\/([^/]+)/)?.[1], ignoreFocusOut: true });
    if (version === undefined) return false;
    const issue = kind === 'hotfix' ? await vscode.window.showInputBox({ title: '工单号（例如 PROJ-123）', ignoreFocusOut: true }) : undefined;
    if (kind === 'hotfix' && issue === undefined) return false;
    const description = kind === 'hotfix' ? await vscode.window.showInputBox({ title: '英文短描述（可选，小写字母、数字和横线）', ignoreFocusOut: true }) : undefined;
    if (kind === 'hotfix' && description === undefined) return false;
    name = developmentBranchName({ kind, version, issue, description, baseKind, baseName: base.name });
  }
  try {
    await service.getBranchCreationRef(project.id, 'branch', name);
    throw new Error('同名分支已存在，请更换名称');
  } catch (error) { if (!(error instanceof AuditApiError && error.status === 404)) throw error; }
  const confirm = await vscode.window.showWarningMessage(`创建远程分支：${name}\n项目：${repo.projectPath}\n${conflictSource ? `原始分支：${conflictSource.name}\n原始提交：${conflictSource.sha}\n` : ''}基线${baseKind === 'tag' ? ' Tag' : '分支'}：${base.name}\n提交 SHA：${base.sha}\n${base.title}\n${base.committedDate ?? ''}\n仅创建远程分支，不自动切换本地分支或执行合并。`, { modal: true }, '确认创建');
  if (confirm !== '确认创建') return false;
  const result = await service.createRemoteBranch(project.id, name, baseKind, base.name, base.sha);
  const next = kind === 'conflict' ? `下一步：将原始分支 ${conflictSource?.name} 的代码合并到此 conflict 分支，处理冲突后向 ${base.name} 创建 MR。` : kind === 'hotfix' ? '下一步：修复后向主分支创建 MR，并同步维护中的 release。' : '可在上线总览查看此版本。';
  const action = await vscode.window.showInformationMessage(`${result.recovered ? '已核对远程分支与确认提交一致' : '创建成功'}：${name}\n${next}`, '打开分支', '复制名称');
  if (action === '复制名称') await vscode.env.clipboard.writeText(name);
  if (action === '打开分支') await vscode.env.openExternal(vscode.Uri.parse(`${project.web_url}/-/tree/${encodeURIComponent(name)}`));
  return true;
}

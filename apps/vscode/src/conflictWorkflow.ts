import * as vscode from 'vscode';
import { conflictBranchName, type BranchReference } from '@gitlab-workbench/core';
import { AuditApiError } from './audit';
import { GitLabService } from './gitlabService';
import type { ReviewMergeRequest, ReviewDetails } from './types';
import { conflictTargets, isConflictSource, validateConflictTarget, hasMergeConflicts, canCreateConflict, conflictResolutionHint } from './conflictRules';

export interface ConflictPlan {
  source: BranchReference;
  target: BranchReference;
  branch: string;
  originalMr?: { iid: number; webUrl: string };
}

export function conflictGuide(plan: ConflictPlan): string {
  validateConflictTarget(plan.source.name, plan.target.name);
  if (plan.branch !== conflictBranchName(plan.source.name)) throw new Error('conflict 分支名与原始源分支不一致');
  // Names have been validated by the naming/target rules; no user text is interpolated as shell code.
  return `# conflict 处理指南
${plan.originalMr ? `\n原 MR：!${plan.originalMr.iid} — ${plan.originalMr.webUrl}\n` : ''}

原始源分支：\`${plan.source.name}\`（预览 SHA：\`${plan.source.sha}\`）

目标测试分支：\`${plan.target.name}\`（创建基线 SHA：\`${plan.target.sha}\`）

临时分支：\`${plan.branch}\`

## 1. 关闭原冲突 MR

在 GitLab 核对原 MR 为 \`${plan.source.name} → ${plan.target.name}\` 且确有冲突，再关闭它并记录链接。插件未自动关闭任何 MR。

## 2. 在本地处理冲突

以下为 Git Bash / POSIX Shell 命令，请在对应仓库执行。先运行 \`git status\`，妥善保存未提交改动后再切换分支。远程 conflict 分支已从目标测试分支创建，不要从 release/hotfix 重新创建。

\`\`\`sh
git status
git fetch --no-tags origin 'refs/heads/${plan.branch}:refs/remotes/origin/${plan.branch}' 'refs/heads/${plan.source.name}:refs/remotes/origin/${plan.source.name}'
git switch --create '${plan.branch}' --track 'origin/${plan.branch}'
git merge --no-commit --no-ff 'origin/${plan.source.name}'
\`\`\`

若本地同名分支已存在，请核对其跟踪分支与提交，再手动切换；不要强制覆盖。本次 merge 使用 fetch 得到的最新原始源分支，SHA 可能与预览不同，应核对新增变更。

## 3. 人工解决、测试并推送

使用 VS Code 源代码管理 / 合并编辑器逐文件处理，确认没有未解决冲突（\`git diff --name-only --diff-filter=U\` 应为空），并执行相关测试。

逐个暂存已核对的文件（\`git add <文件路径>\`），再检查 \`git diff --cached\`。Commit Message 使用 \`conflict(<实际模块>): <真实Jira号> <解决了什么及原因>\`，不得编造 Jira 号。确认内容后执行：

\`\`\`sh
git commit
git push --set-upstream origin '${plan.branch}'
\`\`\`

如果 merge 提示已经是最新状态且无待提交内容，无需创建空提交；先核对是否仍需要该 conflict MR。放弃尚未完成的合并可执行 \`git merge --abort\`。

## 4. 重新创建 MR

- 源分支：\`${plan.branch}\`
- 目标分支：\`${plan.target.name}\`，必须与原冲突 MR 的目标一致。
- 标题：\`(conflict-${plan.target.name}) ${plan.branch} 合并到 ${plan.target.name}\`
- 合并后删除源分支：**YES**；Squash commits：**NO**。
- 填写变更模块、摘要、影响范围、风险评估、备注；在备注关联原 MR。
- 指定 Tech Leader 或其指定的高级工程师作为 Reviewer，通过 MR / Sonar / UT / 人工 Review 门禁后合并。

可从插件“创建 MR”入口选择上述源、目标。临时分支建议在 2 小时内完成处理，使用后立即清理；判断清理依据是目标测试分支的合并结果。

依据：《代码仓库与分支规范》第 3.6 节详细处理步骤。原文分支表与步骤对创建基线的描述不一致，本功能沿用详细步骤的 Target 基线。插件只创建远程分支和指南，未执行本地切换、合并、推送或 MR 关闭。
`;
}

export async function pickConflictPlan(service: GitLabService, projectId: number, selectedBranch?: string): Promise<ConflictPlan | undefined> {
  let source: BranchReference | undefined;
  if (selectedBranch && isConflictSource(selectedBranch)) {
    source = await service.getBranchCreationRef(projectId, 'branch', selectedBranch);
  } else {
    const search = await vscode.window.showInputBox({
      title: '搜索发生冲突的 release/hotfix 源分支（不是目标基线）',
      placeHolder: '例如 LI2500076 或 H20260706；留空分页浏览', ignoreFocusOut: true
    });
    if (search === undefined) return undefined;
    for (let page = 1; !source; page++) {
      const result = await service.getBranchCreationRefs(projectId, 'branch', page, search.trim());
      const choices = result.items.filter(ref => isConflictSource(ref.name)).map(ref => ({
        label: ref.name, description: ref.sha.slice(0, 8), ref, more: false
      }));
      if (!choices.length && !result.hasMore) {
        vscode.window.showWarningMessage('没有匹配的 release/hotfix 源分支，请调整搜索词后重试。');
        return undefined;
      }
      const chosen = await vscode.window.showQuickPick([
        ...choices, ...(result.hasMore ? [{ label: '加载下一页', description: '', ref: undefined, more: true }] : [])
      ], { title: `选择原冲突 MR 的源分支（第 ${page} 页）`, ignoreFocusOut: true });
      if (!chosen) return undefined;
      if (!chosen.more) source = chosen.ref;
    }
  }
  // Exact lookups avoid arbitrary branches or an incomplete paginated target list.
  const results = await Promise.allSettled(conflictTargets.map(name => service.getBranchCreationRef(projectId, 'branch', name)));
  const targets: BranchReference[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') targets.push(result.value);
    else if (!(result.reason instanceof AuditApiError && result.reason.status === 404)) throw result.reason;
  }
  if (!targets.length) {
    vscode.window.showWarningMessage('仓库不存在 dev、tst、uat、pre 目标测试分支，不能创建此类 conflict 分支。');
    return undefined;
  }
  targets.sort((a, b) => Number(b.name === selectedBranch) - Number(a.name === selectedBranch));
  const choice = await vscode.window.showQuickPick(targets.map(ref => ({
    label: ref.name, description: `${ref.sha.slice(0, 8)}${ref.name === selectedBranch ? ' · 当前选中的目标' : ''}`, ref
  })), { title: `选择 ${source.name} 原冲突 MR 的目标测试分支（从此创建基线）`, ignoreFocusOut: true });
  if (!choice) return undefined;
  validateConflictTarget(source.name, choice.ref.name);
  return { source, target: choice.ref, branch: conflictBranchName(source.name) };
}


/** Shared remote creation path used by branch management and MR-bound actions. */
export async function createConflictFromPlan(
  service: GitLabService,
  project: { id: number; label: string; webUrl: string },
  plan: ConflictPlan,
  beforeCreate?: () => Promise<void>
): Promise<boolean> {
  validateConflictTarget(plan.source.name, plan.target.name);
  if (plan.branch !== conflictBranchName(plan.source.name)) throw new Error('conflict 分支名与源分支不一致');
  try {
    await service.getBranchCreationRef(project.id, 'branch', plan.branch);
    throw new Error('同名 conflict 分支已存在，可能正用于其他目标环境；请核对其 MR 和处理进度，不要覆盖或重复创建。');
  } catch (error) { if (!(error instanceof AuditApiError && error.status === 404)) throw error; }
  const confirm = await vscode.window.showWarningMessage(
    `创建远程分支：${plan.branch}\n项目：${project.label}${plan.originalMr ? `\n原 MR：!${plan.originalMr.iid}` : ''}\n原始分支：${plan.source.name}\n原始提交：${plan.source.sha}\n目标分支基线：${plan.target.name}\n提交 SHA：${plan.target.sha}\n请确认原 MR 确有冲突。按规范第 3.6 节从目标测试分支创建。后续需关闭原冲突 MR，人工解决后重新提交 MR。\n仅创建分支和处理指南，不执行本地合并或关闭 MR。`,
    { modal: true }, '确认创建');
  if (confirm !== '确认创建') return false;
  await beforeCreate?.();
  const currentSource = await service.getBranchCreationRef(project.id, 'branch', plan.source.name);
  if (currentSource.sha !== plan.source.sha) throw new Error('原始源分支提交已变化，请重新预览确认');
  const result = await service.createRemoteBranch(project.id, plan.branch, 'branch', plan.target.name, plan.target.sha);
  // A guide/UI error must never report remote creation as failed or invite a duplicate POST.
  try {
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: conflictGuide(plan) });
    await vscode.window.showTextDocument(document, { preview: false });
    const action = await vscode.window.showInformationMessage(`${result.recovered ? '已核对远程分支' : '创建成功'}：${plan.branch}；请按处理指南解决冲突，再向 ${plan.target.name} 创建 MR。`, '打开分支', '复制名称');
    if (action === '复制名称') await vscode.env.clipboard.writeText(plan.branch);
    if (action === '打开分支') await vscode.env.openExternal(vscode.Uri.parse(`${project.webUrl}/-/tree/${encodeURIComponent(plan.branch)}`));
  } catch { vscode.window.showWarningMessage(`远程分支 ${plan.branch} 已创建，后续界面操作失败。请勿重复创建；将 ${plan.source.name} 合入该分支、处理冲突后向 ${plan.target.name} 创建 MR。`); }
  return true;
}

export async function createConflictFromMergeRequest(
  service: GitLabService, request: ReviewMergeRequest, requireActive: () => void
): Promise<boolean> {
  requireActive();
  const check = (current: ReviewDetails) => {
    if (current.id !== request.id || current.state !== 'opened' ||
      current.source_branch !== request.source_branch || current.target_branch !== request.target_branch) {
      throw new Error('MR 已关闭、合并或源/目标已变化，请刷新待办后重试。');
    }
    if (['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(current.detailed_merge_status ?? '')) {
      throw new Error('GitLab 正在重新计算 MR 合并状态，请稍后刷新重试。');
    }
    if (!hasMergeConflicts(current)) throw new Error('MR 当前没有确认的代码冲突，请刷新待办。');
    if (!canCreateConflict(current.source_branch, current.target_branch)) {
      throw new Error(conflictResolutionHint(current.source_branch, current.target_branch));
    }
    if (current.source_project_id !== current.target_project_id) {
      throw new Error('跨仓库 MR 暂不支持快速创建 conflict，请在 GitLab 核对源仓库后处理。');
    }
  };
  const details = await service.getReviewDetails(request.project_id, request.iid, true);
  check(details);
  const [project, source, target] = await Promise.all([
    service.getReviewProject(details.target_project_id),
    service.getBranchCreationRef(details.source_project_id, 'branch', details.source_branch),
    service.getBranchCreationRef(details.target_project_id, 'branch', details.target_branch)
  ]);
  requireActive();
  if (source.sha !== details.sha) throw new Error('源分支已更新，MR 版本尚未同步，请刷新后重试。');
  const plan: ConflictPlan = {
    source, target, branch: conflictBranchName(source.name),
    originalMr: { iid: details.iid, webUrl: details.web_url }
  };
  return createConflictFromPlan(service, { id: project.id, label: project.path_with_namespace, webUrl: project.web_url }, plan, async () => {
    requireActive();
    const current = await service.getReviewDetails(request.project_id, request.iid, true);
    requireActive();
    check(current);
    if (current.sha !== details.sha) throw new Error('MR 源分支提交已变化，请重新预览确认。');
  });
}

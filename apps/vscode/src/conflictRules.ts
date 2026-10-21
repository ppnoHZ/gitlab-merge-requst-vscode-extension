import { conflictBranchName } from '@gitlab-workbench/core';

export const conflictTargets = ['dev', 'tst', 'uat', 'pre'] as const;

export function isConflictSource(branch: string): boolean {
  try { conflictBranchName(branch); return true; } catch { return false; }
}

/** This is the documented release/hotfix → test-environment workflow only. */
export function validateConflictTarget(source: string, target: string): void {
  conflictBranchName(source);
  if (!(conflictTargets as readonly string[]).includes(target)) {
    throw new Error('release/hotfix 的 conflict 处理仅支持目标 dev、tst、uat、pre；合入 main 应在原始源分支解决冲突。main 基线回流的 conflict 命名尚待规范确认。');
  }
}

export function conflictMergeOptions(source: string, options: { removeSourceBranch?: boolean; squash?: boolean }) {
  return source.startsWith('conflict/')
    ? { removeSourceBranch: true, squash: false }
    : { removeSourceBranch: options.removeSourceBranch ?? true, squash: options.squash ?? false };
}

export function hasMergeConflicts(request: { has_conflicts?: boolean; detailed_merge_status?: string }): boolean {
  return request.has_conflicts === true || request.detailed_merge_status === 'conflict';
}

export function canCreateConflict(source: string, target: string): boolean {
  return isConflictSource(source) && (conflictTargets as readonly string[]).includes(target);
}

export function conflictResolutionHint(source: string, target: string): string {
  if (canCreateConflict(source, target)) return '可从此 MR 的目标测试分支快速创建 conflict 分支';
  if (source === 'main') return 'main 回流的 conflict 命名规则尚待确认，请按团队流程处理';
  if (source.startsWith('conflict/')) return '请在现有 conflict 分支处理冲突，继续当前 MR';
  return '此场景应在原始源分支合入目标分支、解决冲突后继续原 MR；release → main 由 Tech Leader 处理';
}

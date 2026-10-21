export type BranchKind = 'release' | 'hotfix';
export type BaseKind = 'branch' | 'tag';
export interface BranchDraft { kind: BranchKind; version: string; issue?: string; description?: string; baseKind: BaseKind; baseName: string }
export interface BranchReference { name: string; sha: string; title: string; committedDate?: string }
export interface BranchPreview { ticket: string; branch: string; base: BranchReference; baseKind: BaseKind; expiresAt: string }
export interface BranchCreated { branch: string; sha: string; webUrl: string; recovered: boolean; auditWarning?: boolean }
export function branchName(draft: Pick<BranchDraft, 'kind' | 'version' | 'issue' | 'description'>): string {
  if (!['release', 'hotfix'].includes(draft.kind)) throw new Error('仅支持 release 和 hotfix');
  const version = draft.version.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version) || version.includes('..') || version.endsWith('.') || version.endsWith('.lock')) throw new Error('版本号需使用字母、数字、点、横线或下划线，不能包含连续点或以点/.lock 结尾');
  if (draft.kind === 'release') return `release/${version}`;
  const issue = draft.issue?.trim() ?? '';
  const description = draft.description?.trim() ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(issue)) throw new Error('hotfix 需要有效工单号（字母、数字、横线或下划线）');
  if (description && !/^[a-z0-9][a-z0-9-]{0,79}$/.test(description)) throw new Error('描述请使用小写字母、数字和横线');
  return `hotfix/${version}/${issue}${description ? '-' + description : ''}`;
}

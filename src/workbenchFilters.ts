import * as vscode from 'vscode';

export type MainFilter = 'merged' | 'unmerged' | 'unknown';
export type RiskFilter = 'missing' | 'closed' | 'open' | 'failed';
export type UpdatedFilter = 'all' | '7d' | '30d' | 'stale90' | 'unknown';
export interface WorkbenchFilters {
  main: MainFilter[];
  risks: RiskFilter[];
  updated: UpdatedFilter;
}
export const mainLabels: Record<MainFilter, string> = { merged: '已合入 main', unmerged: '未合入 main', unknown: 'main 状态未知' };
export const riskLabels: Record<RiskFilter, string> = { missing: '缺失 MR', closed: 'MR 已关闭未合并', open: '仍有开放 MR', failed: '检查失败' };
export const updatedLabels: Record<UpdatedFilter, string> = { all: '全部时间', '7d': '最近 7 天', '30d': '最近 30 天', stale90: '超过 90 天未更新', unknown: '更新时间未知' };
export function normalizeFilters(value?: Partial<WorkbenchFilters>): WorkbenchFilters {
  return {
    main: Array.isArray(value?.main) ? [...new Set(value.main.filter(key => Object.hasOwn(mainLabels, key)))] : [],
    risks: Array.isArray(value?.risks) ? [...new Set(value.risks.filter(key => Object.hasOwn(riskLabels, key)))] : [],
    updated: value?.updated && Object.hasOwn(updatedLabels, value.updated) ? value.updated : 'all'
  };
}
export function hasFilters(filters: WorkbenchFilters): boolean {
  return !!(filters.main.length || filters.risks.length || filters.updated !== 'all');
}
export function matchesUpdated(date: string | undefined, filter: UpdatedFilter, now = Date.now()): boolean {
  if (filter === 'all') return true;
  const timestamp = date ? Date.parse(date) : NaN;
  const valid = Number.isFinite(timestamp) && timestamp <= now;
  if (filter === 'unknown') return !valid;
  if (!valid) return false;
  const age = now - timestamp;
  return filter === 'stale90' ? age > 90 * 86400000 : age <= (filter === '7d' ? 7 : 30) * 86400000;
}
export function filterDescription(filters: WorkbenchFilters): string {
  return [filters.main.map(key => mainLabels[key]).join(' / '), filters.risks.map(key => riskLabels[key]).join(' / '),
    filters.updated !== 'all' ? updatedLabels[filters.updated] : ''].filter(Boolean).join('；') || '无';
}

// A cancelled picker leaves all existing dimensions intact. Empty multi-selection means all.
export async function pickWorkbenchFilters(current: WorkbenchFilters, risks: boolean): Promise<WorkbenchFilters | undefined> {
  const dimension = await vscode.window.showQuickPick([
    { label: 'main 合入状态', key: 'main' },
    ...(risks ? [{ label: '上线风险', key: 'risks' }] : []),
    { label: '最近更新时间', key: 'updated' }
  ], { title: '筛选条件', placeHolder: '不同条件取交集；同一条件多选取并集' });
  if (!dimension) return undefined;
  if (dimension.key === 'updated') {
    const selection = await vscode.window.showQuickPick(
      (Object.keys(updatedLabels) as UpdatedFilter[]).map(key => ({ key, label: updatedLabels[key], description: current.updated === key ? '当前选择' : undefined })),
      { title: '最近更新时间', placeHolder: '按分支最新提交时间筛选；无有效时间的数据归为未知' });
    return selection ? { ...current, updated: selection.key } : undefined;
  }
  if (dimension.key === 'main') {
    const selection = await vscode.window.showQuickPick(
      (Object.keys(mainLabels) as MainFilter[]).map(key => ({ key, label: mainLabels[key], picked: current.main.includes(key) })),
      { title: 'main 合入状态', canPickMany: true, placeHolder: '多选；清空选择表示全部状态' });
    return selection === undefined ? undefined : { ...current, main: selection.map(item => item.key) };
  }
  const selection = await vscode.window.showQuickPick(
    (Object.keys(riskLabels) as RiskFilter[]).map(key => ({ key, label: riskLabels[key], picked: current.risks.includes(key) })),
    { title: '上线风险', canPickMany: true, placeHolder: '多选；清空选择表示全部风险' });
  return selection === undefined ? undefined : { ...current, risks: selection.map(item => item.key) };
}

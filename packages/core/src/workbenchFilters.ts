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

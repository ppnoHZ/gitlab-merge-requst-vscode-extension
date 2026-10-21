/** Web transport contracts; no VS Code dependencies. */
export interface WebGitLabUser { id: number; name: string; username: string }
export interface WebProject { id: number; name: string; path_with_namespace: string; web_url: string }
export interface WebStatus {
  status: 'ok';
  gitlab: { connected: boolean; configured: boolean; instance?: string; user?: WebGitLabUser };
  csrfToken?: string;
  branchCreationEnabled?: boolean;
}
export interface WebProjectPage { items: WebProject[]; hasMore: boolean }

import type { ReleaseOverviewEntry } from './releaseOverview';
import { summarizeRelease } from './releaseOverview';
import type { WorkbenchFilters, RiskFilter } from './workbenchFilters';
import { matchesUpdated } from './workbenchFilters';

export function filterWebReleases(entries: ReleaseOverviewEntry[], filters: WorkbenchFilters, now = Date.now()): ReleaseOverviewEntry[] {
  return entries.filter(entry => {
    const state = entry.mergedIntoMain === undefined ? 'unknown' : entry.mergedIntoMain ? 'merged' : 'unmerged';
    if (filters.main.length && !filters.main.includes(state)) return false;
    if (!matchesUpdated(entry.committedDate, filters.updated, now)) return false;
    const risks = new Set<RiskFilter>();
    if (entry.error || entry.mainError) risks.add('failed');
    if (!entry.error) {
      const counts = summarizeRelease(entry);
      if (counts['not-created']) risks.add('missing');
      if (counts.closed) risks.add('closed');
      if (counts.open) risks.add('open');
    }
    return !filters.risks.length || filters.risks.some(risk => risks.has(risk));
  });
}

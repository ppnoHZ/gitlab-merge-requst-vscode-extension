import { getReleaseFeatureStatuses, getReleaseVersion, ReleaseFeatureStatus, ReleaseMergeRequest } from './releaseReadiness';
import { GitLabBranchPage, GitLabPage } from './types';
import type { MainMergeResult } from './types';

export interface ReleaseOverviewEntry {
  branch: string;
  version: string;
  features: ReleaseFeatureStatus[];
  error?: string;
  mergedIntoMain?: boolean;
  mainError?: string;
  committedDate?: string;
}
export interface ReleaseOverviewSnapshot {
  project: string;
  updatedAt: string;
  entries: ReleaseOverviewEntry[];
}
export interface ReleaseOverviewSource {
  branches(page: number): Promise<GitLabBranchPage>;
  requests(branch: string, page: number): Promise<GitLabPage<ReleaseMergeRequest>>;
  mergedIntoMain(branches: string[]): Promise<MainMergeResult>;
}

async function allPages<T>(fetch: (page: number) => Promise<GitLabPage<T>>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const result = await fetch(page);
    items.push(...result.items);
    if (!result.hasMore) return items;
  }
}

export async function loadReleaseOverview(project: string, source: ReleaseOverviewSource): Promise<ReleaseOverviewSnapshot> {
  // Never derive absence of a branch/MR from an incomplete page.
  const dates = new Map<string, string>();
  const branches = [...new Set(await allPages(async page => {
    const result = await source.branches(page);
    for (const commit of result.latestCommits ?? []) dates.set(commit.branch, commit.committedDate);
    return result;
  }))];
  const releases = branches.filter(branch => getReleaseVersion(branch)).sort();
  const entries: ReleaseOverviewEntry[] = [];
  for (const branch of releases) {
    const entry: ReleaseOverviewEntry = { branch, version: getReleaseVersion(branch)!, features: [], committedDate: dates.get(branch) };
    try {
      const requests = await allPages(page => source.requests(branch, page));
      entry.features = getReleaseFeatureStatuses(branch, branches, requests);
    } catch (error) {
      entry.error = error instanceof Error ? error.message : String(error);
    }
    entries.push(entry);
  }
  if (entries.length) {
    try {
      if (!branches.includes('main')) throw new Error('远程仓库没有 main 分支');
      const merged = await source.mergedIntoMain(['main', ...releases]);
      for (const entry of entries) {
        const error = merged.errors?.get(entry.branch);
        if (error) entry.mainError = error;
        else entry.mergedIntoMain = merged.has(entry.branch);
      }
    } catch (error) {
      for (const entry of entries) entry.mainError = error instanceof Error ? error.message : String(error);
    }
  }
  return { project, entries, updatedAt: new Date().toISOString() };
}

export function summarizeRelease(entry: ReleaseOverviewEntry) {
  const counts = { merged: 0, open: 0, closed: 0, 'not-created': 0 };
  for (const feature of entry.features) counts[feature.state]++;
  return counts;
}

export const featureStateLabels = {
  merged: '已合并', open: 'MR 开放中', closed: 'MR 已关闭未合并', 'not-created': '缺失 MR'
};

// Plain-text fields in Markdown must not inject headings, links or table rows.
function text(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/[\\`*_[\]<>#|]/g, '\\$&');
}
export function releaseOverviewMarkdown(snapshot: ReleaseOverviewSnapshot): string {
  const lines = ['# 上线总览', '', `项目：${text(snapshot.project)}`, `更新时间：${snapshot.updatedAt}`, '',
    '仅汇总 feature → release 的 MR 状态及 release → main 的代码合入状态；未校验流水线、审批、部署或已合并后的新增提交。', ''];
  if (!snapshot.entries.length) lines.push('未发现 release/<版本> 分支。');
  for (const entry of snapshot.entries) {
    const counts = summarizeRelease(entry);
    lines.push(`## ${text(entry.version)} · ${text(entry.branch)}`, '',
      entry.error ? `MR 状态未知：${text(entry.error)}` : `已合并 ${counts.merged}/${entry.features.length}；开放中 ${counts.open}；已关闭 ${counts.closed}；缺失 MR ${counts['not-created']}`, '',
      `main：${entry.mergedIntoMain === undefined ? '状态未知' : entry.mergedIntoMain ? '已合入' : '尚未合入'}`);
    if (entry.mainError) lines.push(`main 检查失败：${text(entry.mainError)}`);
    if (!entry.error && !entry.features.length) lines.push('无同版本 feature 或历史 MR，无法据此判定可上线。');
    for (const feature of entry.features) {
      const mr = feature.mergeRequest;
      lines.push(`- ${text(feature.branch)} · ${featureStateLabels[feature.state]}${mr ? ` · !${mr.iid} ${text(mr.title)}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

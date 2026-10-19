import * as vscode from 'vscode';
import { getReleaseFeatureStatuses, ReleaseFeatureState, ReleaseFeatureStatus, ReleaseMergeRequest } from './releaseReadiness';
import { BranchLatestCommit, GitLabBranchPage, GitLabPage } from './types';
import { IssueLinkConfig, ResolvedIssueLink, resolveFeatureIssueLinks } from './issueLinks';
import { Logger } from './logger';

type ReleaseTreeItemKind = 'search' | 'loadMore' | 'directory' | 'branch' | 'feature' | 'issueLink' | 'message';

export interface BranchPageState {
  page: number;
  hasMore: boolean;
  loading: boolean;
  error?: string;
}

export interface ReleasePageState extends BranchPageState {
  branches: string[];
  requests: ReleaseMergeRequest[];
  moreBranches: boolean;
  moreRequests: boolean;
}

export class ReleaseReadinessTreeItem extends vscode.TreeItem {
  constructor(
    readonly kind: ReleaseTreeItemKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly status?: ReleaseFeatureStatus,
    readonly groupState?: ReleaseFeatureState,
    readonly issueLink?: ResolvedIssueLink,
    readonly branchPath?: string
  ) {
    super(label, collapsibleState);
  }
}

const stateInfo: Record<ReleaseFeatureState, { label: string; icon: string }> = {
  merged: { label: '已合并', icon: 'pass' },
  open: { label: 'MR 开放中', icon: 'eye' },
  closed: { label: 'MR 已关闭未合并', icon: 'close' },
  'not-created': { label: '尚未创建 MR', icon: 'circle-large-outline' }
};

export const commonBranchFilters = [
  'feature/', 'release/', 'dev', 'uat', 'main', 'bugfix/', 'hotfix/', 'tst', 'pre'
];

export function formatUpdateDuration(committedDate: string, now = Date.now()): string {
  const timestamp = Date.parse(committedDate);
  if (!Number.isFinite(timestamp)) {
    return '更新时间未知';
  }
  const elapsed = now - timestamp;
  if (elapsed < 0) {
    return '提交时间晚于当前时间';
  }
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return '刚刚更新';
  }
  if (minutes < 60) {
    return `${minutes}分钟前更新`;
  }
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}小时前更新` : `${Math.floor(hours / 24)}天前更新`;
}

export class ReleaseReadinessProvider implements vscode.TreeDataProvider<ReleaseReadinessTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ReleaseReadinessTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  releaseBranch: string | undefined;
  selectedBranch: string | undefined;
  private branches: string[] = [];
  private readonly latestCommits = new Map<string, BranchLatestCommit>();
  private durationTimer: ReturnType<typeof setInterval> | undefined;
  private readonly statuses = new Map<string, ReleaseFeatureStatus[] | string>();
  private readonly mainChecks = new Map<string, string>();
  private mergedIntoMain = new Set<string>();
  private readonly unknownMainChecks = new Map<string, string>();
  private branchFilters: string[] | null;
  private branchKeyword = '';
  branchPage: BranchPageState = { page: 0, hasMore: true, loading: false };
  readonly releasePages = new Map<string, ReleasePageState>();
  readonly checkingBranches = new Map<string, object>();
  private readonly parents = new WeakMap<ReleaseReadinessTreeItem, ReleaseReadinessTreeItem | undefined>();

  constructor(branchFilters: string[] | null = commonBranchFilters) {
    this.branchFilters = branchFilters === null || branchFilters.length === 0 ? null : [...branchFilters];
  }

  getBranchFilters(): string[] | null {
    return this.branchFilters === null ? null : [...this.branchFilters];
  }

  setBranchFilters(filters: string[] | null): void {
    this.branchFilters = filters === null || filters.length === 0 ? null : [...new Set(filters)];
    this.changeEmitter.fire(undefined);
  }

  getBranchKeyword(): string {
    return this.branchKeyword;
  }

  get hasBranches(): boolean {
    return this.branches.length > 0;
  }

  resetBranchPages(keyword = this.branchKeyword): void {
    this.branchKeyword = keyword.trim();
    this.branchPage = { page: 0, hasMore: true, loading: false };
    this.branches = [];
    this.latestCommits.clear();
    this.stopDurationTimer();
    this.mergedIntoMain.clear();
    this.unknownMainChecks.clear();
    this.clearChecks();
  }

  appendBranchPage(state: BranchPageState, page: GitLabBranchPage): void {
    if (state !== this.branchPage) {
      return;
    }
    state.page++;
    state.hasMore = page.hasMore;
    state.error = undefined;
    this.updateLatestCommits(page);
    this.setMainChecksUnknown(page.items, '正在加载分支，尚未检查 main 合入状态');
    this.setBranches([...this.branches, ...page.items]);
  }

  startReleasePages(branch: string): ReleasePageState {
    const state: ReleasePageState = {
      page: 0, hasMore: true, loading: false, branches: [], requests: [],
      moreBranches: true, moreRequests: true
    };
    this.releasePages.set(branch, state);
    this.setReadinessMessage(branch, '正在加载 MR 和同版本 feature 分支...');
    return state;
  }

  appendReleasePage(branch: string, state: ReleasePageState, branches: GitLabBranchPage, requests: GitLabPage<ReleaseMergeRequest>): void {
    if (this.releasePages.get(branch) !== state) {
      return;
    }
    state.page++;
    state.branches = [...new Set([...state.branches, ...branches.items])];
    state.requests = [...new Map([...state.requests, ...requests.items].map(request => [request.iid, request])).values()];
    state.moreBranches = branches.hasMore;
    state.moreRequests = requests.hasMore;
    state.hasMore = branches.hasMore || requests.hasMore;
    state.error = undefined;
    this.updateLatestCommits(branches);
    this.setReadiness(branch, getReleaseFeatureStatuses(branch, state.branches, state.requests)
      .map(status => ({ ...status, pending: state.moreRequests })), false);
  }

  refresh(): void {
    this.changeEmitter.fire(undefined);
  }

  private loadMoreItem(state: BranchPageState, branch: string): ReleaseReadinessTreeItem {
    const item = new ReleaseReadinessTreeItem(
      'loadMore',
      state.loading ? '正在加载...' : state.error ? `加载失败，点击重试: ${state.error}` : '加载更多（每页 100 条）',
      vscode.TreeItemCollapsibleState.None,
      undefined, undefined, undefined, branch
    );
    item.id = `load-more:${branch}`;
    item.iconPath = new vscode.ThemeIcon('more');
    if (!state.loading) {
      item.command = {
        command: 'gitlabMr.loadMoreReleaseData',
        title: '加载更多',
        arguments: [item]
      };
    }
    return item;
  }

  getBranches(): string[] {
    return [...this.branches];
  }

  getTreeItem(item: ReleaseReadinessTreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: ReleaseReadinessTreeItem): ReleaseReadinessTreeItem[] {
    const children = this.createChildren(parent);
    for (const child of children) {
      this.parents.set(child, parent);
    }
    return children;
  }

  getParent(item: ReleaseReadinessTreeItem): ReleaseReadinessTreeItem | undefined {
    return this.parents.get(item);
  }

  private createChildren(parent?: ReleaseReadinessTreeItem): ReleaseReadinessTreeItem[] {
    if (!parent) {
      const items = this.getBranchChildren();
      if (items.length === 0 && (this.hasBranches || this.branchPage.page > 0)) {
        const message = new ReleaseReadinessTreeItem(
          'message',
          '没有匹配的分支，点击调整过滤条件',
          vscode.TreeItemCollapsibleState.None
        );
        message.command = {
          command: this.branchKeyword ? 'gitlabMr.filterBranchesByKeyword' : 'gitlabMr.filterReleaseBranches',
          title: '过滤远程分支'
        };
        items.push(message);
      }
      if (this.hasBranches || this.branchPage.page > 0 || this.branchKeyword || this.branchPage.error) {
        const search = new ReleaseReadinessTreeItem(
          'search', '搜索分支', vscode.TreeItemCollapsibleState.None
        );
        search.id = 'branch-search';
        search.iconPath = new vscode.ThemeIcon('search');
        search.command = {
          command: 'gitlabMr.filterBranchesByKeyword',
          title: '搜索分支'
        };
        items.unshift(search);
      }
      if (this.branchPage.loading || this.branchPage.error) {
        const loading = new ReleaseReadinessTreeItem(
          'message',
          this.branchPage.loading ? '正在加载全部分支...' : `加载分支失败，点击重试: ${this.branchPage.error}`,
          vscode.TreeItemCollapsibleState.None
        );
        loading.id = 'branch-loading';
        if (!this.branchPage.loading) {
          loading.command = { command: 'gitlabMr.retryBranches', title: '重试加载分支' };
        }
        items.push(loading);
      }
      return items;
    }

    if (parent.kind === 'directory') {
      return this.getBranchChildren(parent.branchPath);
    }

    if (parent.kind === 'feature' && parent.status) {
      const configurations = vscode.workspace
        .getConfiguration('gitlabMr')
        .get<IssueLinkConfig[]>('issueLinks', []);
      return resolveFeatureIssueLinks(parent.status.branch, configurations).map(link => {
        const item = new ReleaseReadinessTreeItem(
          'issueLink',
          `${link.name}: ${link.id}`,
          vscode.TreeItemCollapsibleState.None,
          parent.status,
          undefined,
          link
        );
        item.iconPath = new vscode.ThemeIcon('link-external');
        item.tooltip = link.url;
        item.command = {
          command: 'gitlabMr.openConfiguredIssueLink',
          title: `打开 ${link.name}`,
          arguments: [link.url]
        };
        return item;
      });
    }

    if (parent.kind !== 'branch' || !parent.branchPath) {
      return [];
    }

    const result: ReleaseReadinessTreeItem[] = [];
    const mainCheck = this.mainChecks.get(parent.branchPath);
    if (mainCheck) {
      result.push(new ReleaseReadinessTreeItem('message', mainCheck, vscode.TreeItemCollapsibleState.None));
    }
    const check = this.statuses.get(parent.branchPath);
    const page = this.releasePages.get(parent.branchPath);
    const statuses = typeof check === 'string' ? undefined : check;
    if (typeof check === 'string') {
      result.push(new ReleaseReadinessTreeItem('message', check, vscode.TreeItemCollapsibleState.None));
    }
    if (page?.hasMore) {
      result.push(new ReleaseReadinessTreeItem(
        'message', '结果尚未完整：feature 或 MR 仍有未加载数据，请加载更多', vscode.TreeItemCollapsibleState.None
      ));
    }
    if (statuses?.length === 0 && !page?.hasMore) {
      result.push(new ReleaseReadinessTreeItem(
        'message', '没有找到该版本的 feature 分支', vscode.TreeItemCollapsibleState.None
      ));
    }
    const features = (statuses ?? [])
      .map(status => {
        const issueLinkConfigs = vscode.workspace
          .getConfiguration('gitlabMr')
          .get<IssueLinkConfig[]>('issueLinks', []);
        const issueLinks = resolveFeatureIssueLinks(status.branch, issueLinkConfigs);
        const item = new ReleaseReadinessTreeItem(
          'feature',
          status.branch,
          issueLinks.length > 0
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
          status,
          undefined,
          undefined,
          parent.branchPath
        );
        item.id = `release-feature:${parent.branchPath}:${status.branch}`;
        const descriptionParts = [
          status.pending ? 'MR 状态待确认（分页未完成）' : stateInfo[status.state].label,
          ...issueLinks.map(link => `${link.name}: ${link.id}`),
          status.mergeRequest ? `!${status.mergeRequest.iid} ${status.mergeRequest.title}` : undefined
        ].filter((part): part is string => Boolean(part));
        item.description = descriptionParts.length > 0 ? descriptionParts.join(' · ') : undefined;
        item.tooltip = `${status.branch} · ${status.pending ? 'MR 状态待确认' : stateInfo[status.state].label}`;
        item.iconPath = new vscode.ThemeIcon(status.pending ? 'question' : stateInfo[status.state].icon);
        item.contextValue = `releaseFeature-${status.pending ? 'pending' : status.state}`;

        if (issueLinks.length > 0) {
          item.tooltip = `${item.tooltip}\n展开查看工单链接`;
        } else if (status.mergeRequest) {
          item.command = {
            command: 'gitlabMr.openReleaseMergeRequest',
            title: '打开 Merge Request',
            arguments: [item]
          };
        } else if (!status.pending) {
          item.command = {
            command: 'gitlabMr.createReleaseFeatureMergeRequest',
            title: '创建 Merge Request',
            arguments: [item]
          };
        }
        this.markMergedIntoMain(item, status.branch);
        this.describeLatestCommit(item, status.branch);
        return item;
      });
    result.push(...features);
    if (page && (page.hasMore || page.error || page.loading)) {
      result.push(this.loadMoreItem(page, parent.branchPath));
    }
    return result;
  }

  private getBranchChildren(prefix = ''): ReleaseReadinessTreeItem[] {
    const pathPrefix = prefix ? `${prefix}/` : '';
    const children = new Map<string, boolean>();
    for (const branch of this.branches) {
      if (this.branchFilters !== null && !this.branchFilters.some(filter =>
        filter.endsWith('/') ? branch.startsWith(filter) : branch === filter
      )) {
        continue;
      }
      if (!branch.startsWith(pathPrefix)) {
        continue;
      }
      const remainder = branch.slice(pathPrefix.length);
      const segment = remainder.split('/')[0];
      children.set(segment, (children.get(segment) ?? false) || remainder.includes('/'));
    }

    return Array.from(children).sort(([a], [b]) => a.localeCompare(b)).map(([label, directory]) => {
      const branchPath = `${pathPrefix}${label}`;
      const item = new ReleaseReadinessTreeItem(
        directory ? 'directory' : 'branch',
        label,
        directory || this.mainChecks.has(branchPath) || this.statuses.has(branchPath)
          ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        undefined,
        undefined,
        undefined,
        branchPath
      );
      item.id = `remote-branch:${branchPath}`;
      item.tooltip = branchPath;
      item.iconPath = new vscode.ThemeIcon(directory ? 'folder' : 'git-branch');
      if (!directory) {
        item.contextValue = 'remoteBranch';
        item.description = branchPath === this.selectedBranch ? '当前选择' : undefined;
        item.command = {
          command: 'gitlabMr.checkReleaseReadiness',
          title: '选择远程分支',
          arguments: [item]
        };
        this.markMergedIntoMain(item, branchPath);
        this.describeLatestCommit(item, branchPath);
      }
      return item;
    });
  }

  private updateLatestCommits(page: GitLabBranchPage): void {
    for (const commit of page.latestCommits ?? []) {
      this.latestCommits.set(commit.branch, commit);
    }
    if (!this.durationTimer && this.latestCommits.size > 0) {
      this.durationTimer = setInterval(() => this.refresh(), 60_000);
      this.durationTimer.unref();
    }
  }

  private describeLatestCommit(item: ReleaseReadinessTreeItem, branch: string): void {
    const commit = this.latestCommits.get(branch);
    if (!commit) {
      return;
    }
    const author = commit.authorName || '作者未知';
    const date = new Date(commit.committedDate);
    const time = Number.isFinite(date.getTime())
      ? date.toLocaleString('zh-CN', { hour12: false })
      : '时间未知';
    const duration = Number.isFinite(date.getTime()) ? formatUpdateDuration(commit.committedDate) : undefined;
    item.description = [author, time, duration, item.description].filter(Boolean).join(' · ');
    item.tooltip = `${item.tooltip}\n最新提交作者: ${author}\n提交时间（本地时区）: ${time}`;
    if (Number.isFinite(date.getTime())) {
      item.tooltip += `\n原始提交时间: ${commit.committedDate}\n${duration}`;
    }
  }

  private markMergedIntoMain(item: ReleaseReadinessTreeItem, branch: string): void {
    const unknown = this.unknownMainChecks.get(branch);
    if (branch !== 'main' && unknown) {
      item.description = [item.description, 'main 合入状态未知'].filter(Boolean).join(' · ');
      item.tooltip = `${item.tooltip}\n${unknown}`;
      return;
    }
    if (branch !== 'main' && !this.mergedIntoMain.has(branch)) {
      item.contextValue = `${item.contextValue ?? 'remoteBranch'}-canMergeToMain`;
    }
    if (branch === 'main' || !this.mergedIntoMain.has(branch)) {
      return;
    }
    item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    item.description = [item.description, '代码已合入 main'].filter(Boolean).join(' · ');
    item.tooltip = `${item.tooltip}\n该分支最新内容已全部合入远程 main`;
    if (vscode.workspace.getConfiguration('gitlabMr', vscode.workspace.workspaceFolders?.[0]?.uri)
      .get<boolean>('allowBranchDeletion', false) === true) {
      item.contextValue = `${item.contextValue}-canDeleteBranch`;
    }
  }

  setMainChecksUnknown(branches: Iterable<string>, message: string): void {
    for (const branch of branches) {
      this.mergedIntoMain.delete(branch);
      this.unknownMainChecks.set(branch, message);
    }
    this.refresh();
  }

  setMergedIntoMain(branches: Iterable<string>, errors: Map<string, string> = new Map()): void {
    this.unknownMainChecks.clear();
    for (const [branch, error] of errors) this.unknownMainChecks.set(branch, error);
    this.mergedIntoMain = new Set(branches);
    this.changeEmitter.fire(undefined);
  }

  isMergedIntoMain(branch: string): boolean {
    return this.mergedIntoMain.has(branch);
  }

  setBranchMergedIntoMain(branch: string, merged: boolean): void {
    this.unknownMainChecks.delete(branch);
    if (merged) {
      this.mergedIntoMain.add(branch);
    } else {
      this.mergedIntoMain.delete(branch);
    }
    this.changeEmitter.fire(undefined);
  }

  setBranches(branches: string[], selectedBranch = this.selectedBranch): void {
    this.branches = Array.from(new Set(branches)).sort();
    this.selectedBranch = selectedBranch && this.branches.includes(selectedBranch) ? selectedBranch : undefined;
    if (this.releaseBranch !== this.selectedBranch) {
      this.releaseBranch = undefined;
    }
    for (const branch of this.statuses.keys()) {
      if (!this.branches.includes(branch)) {
        this.statuses.delete(branch);
      }
    }
    for (const branch of this.mainChecks.keys()) {
      if (!this.branches.includes(branch)) {
        this.mainChecks.delete(branch);
      }
    }
    this.changeEmitter.fire(undefined);
  }

  removeBranch(branch: string): void {
    // Invalidate in-flight reads so they cannot restore deleted branches.
    this.branchPage = { ...this.branchPage, loading: false };
    this.mergedIntoMain.delete(branch);
    this.latestCommits.delete(branch);
    this.releasePages.delete(branch);
    this.checkingBranches.delete(branch);
    for (const [target, statuses] of this.statuses) {
      if (Array.isArray(statuses)) {
        this.statuses.set(target, statuses.filter(status => status.branch !== branch));
      }
    }
    for (const page of this.releasePages.values()) {
      page.branches = page.branches.filter(name => name !== branch);
      page.requests = page.requests.filter(request => request.source_branch !== branch);
    }
    this.setBranches(this.branches.filter(name => name !== branch));
  }

  setReadiness(releaseBranch: string, statuses: ReleaseFeatureStatus[], selectBranch = true): void {
    if (selectBranch) {
      this.selectedBranch = releaseBranch;
      this.releaseBranch = releaseBranch;
    }
    this.statuses.set(releaseBranch, statuses);
    const configurations = vscode.workspace
      .getConfiguration('gitlabMr')
      .get<IssueLinkConfig[]>('issueLinks', []);
    Logger.info(
      `[上线检查工单规则] ${JSON.stringify(configurations.map(configuration => ({ name: configuration.name, pattern: configuration.pattern })))}`
    );
    for (const status of statuses) {
      const links = resolveFeatureIssueLinks(status.branch, configurations);
      Logger.info(
        `[上线检查工单链接] ${status.branch}: ${links.length ? links.map(link => `${link.name}=${link.id}`).join(', ') : '未匹配配置'}`
      );
    }
    this.changeEmitter.fire(undefined);
  }

  setReadinessMessage(branch: string, message: string): void {
    this.statuses.set(branch, message);
    this.changeEmitter.fire(undefined);
  }

  setMainCheck(branch: string, result: string): void {
    this.mainChecks.set(branch, result);
    this.changeEmitter.fire(undefined);
  }

  clearChecks(): void {
    this.mainChecks.clear();
    this.statuses.clear();
    this.releasePages.clear();
    this.checkingBranches.clear();
    this.releaseBranch = undefined;
    this.changeEmitter.fire(undefined);
  }

  getBranchItem(branch: string): ReleaseReadinessTreeItem | undefined {
    let parent: ReleaseReadinessTreeItem | undefined;
    let path = '';
    for (const segment of branch.split('/')) {
      path = path ? `${path}/${segment}` : segment;
      const child: ReleaseReadinessTreeItem | undefined =
        this.getChildren(parent).find(item => item.branchPath === path);
      if (!child) {
        return undefined;
      }
      parent = child;
    }
    return parent;
  }

  dispose(): void {
    this.stopDurationTimer();
    this.changeEmitter.dispose();
  }

  private stopDurationTimer(): void {
    if (this.durationTimer) {
      clearInterval(this.durationTimer);
      this.durationTimer = undefined;
    }
  }
}
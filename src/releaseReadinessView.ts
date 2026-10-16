import * as vscode from 'vscode';
import { ReleaseFeatureState, ReleaseFeatureStatus } from './releaseReadiness';
import { IssueLinkConfig, ResolvedIssueLink, resolveFeatureIssueLinks } from './issueLinks';
import { Logger } from './logger';

type ReleaseTreeItemKind = 'search' | 'directory' | 'branch' | 'feature' | 'issueLink' | 'message';

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

export class ReleaseReadinessProvider implements vscode.TreeDataProvider<ReleaseReadinessTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ReleaseReadinessTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  releaseBranch: string | undefined;
  selectedBranch: string | undefined;
  private branches: string[] = [];
  private readonly statuses = new Map<string, ReleaseFeatureStatus[] | string>();
  private readonly mainChecks = new Map<string, string>();
  private mergedIntoMain = new Set<string>();
  private branchFilters: string[] | null;
  private branchKeyword = '';
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

  setBranchKeyword(keyword: string): void {
    this.branchKeyword = keyword.trim();
    this.changeEmitter.fire(undefined);
  }

  get hasBranches(): boolean {
    return this.branches.length > 0;
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
      if (items.length === 0 && this.hasBranches) {
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
      if (this.hasBranches) {
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
    const statuses = typeof check === 'string' ? undefined : check;
    if (typeof check === 'string') {
      result.push(new ReleaseReadinessTreeItem('message', check, vscode.TreeItemCollapsibleState.None));
    }
    if (statuses?.length === 0) {
      result.push(new ReleaseReadinessTreeItem(
        'message', '没有找到该版本的 feature 分支', vscode.TreeItemCollapsibleState.None
      ));
    }
    return result.concat((statuses ?? [])
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
          stateInfo[status.state].label,
          ...issueLinks.map(link => `${link.name}: ${link.id}`),
          status.mergeRequest ? `!${status.mergeRequest.iid} ${status.mergeRequest.title}` : undefined
        ].filter((part): part is string => Boolean(part));
        item.description = descriptionParts.length > 0 ? descriptionParts.join(' · ') : undefined;
        item.tooltip = `${status.branch} · ${stateInfo[status.state].label}`;
        item.iconPath = new vscode.ThemeIcon(stateInfo[status.state].icon);
        item.contextValue = `releaseFeature-${status.state}`;

        if (issueLinks.length > 0) {
          item.tooltip = `${item.tooltip}\n展开查看工单链接`;
        } else if (status.mergeRequest) {
          item.command = {
            command: 'gitlabMr.openReleaseMergeRequest',
            title: '打开 Merge Request',
            arguments: [item]
          };
        } else {
          item.command = {
            command: 'gitlabMr.createReleaseFeatureMergeRequest',
            title: '创建 Merge Request',
            arguments: [item]
          };
        }
        this.markMergedIntoMain(item, status.branch);
        return item;
      }));
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
      if (!branch.toLowerCase().includes(this.branchKeyword.toLowerCase())) {
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
      }
      return item;
    });
  }

  private markMergedIntoMain(item: ReleaseReadinessTreeItem, branch: string): void {
    if (branch !== 'main' && !this.mergedIntoMain.has(branch) && this.branches.includes('main')) {
      item.contextValue = `${item.contextValue ?? 'remoteBranch'}-canMergeToMain`;
    }
    if (branch === 'main' || !this.mergedIntoMain.has(branch)) {
      return;
    }
    item.iconPath = new vscode.ThemeIcon('pass', new vscode.ThemeColor('testing.iconPassed'));
    item.description = [item.description, '代码已合入 main'].filter(Boolean).join(' · ');
    item.tooltip = `${item.tooltip}\n该分支最新内容已全部合入远程 main`;
  }

  setMergedIntoMain(branches: Iterable<string>): void {
    this.mergedIntoMain = new Set(branches);
    this.changeEmitter.fire(undefined);
  }

  isMergedIntoMain(branch: string): boolean {
    return this.mergedIntoMain.has(branch);
  }

  setBranchMergedIntoMain(branch: string, merged: boolean): void {
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

  setReadiness(releaseBranch: string, statuses: ReleaseFeatureStatus[]): void {
    this.selectedBranch = releaseBranch;
    this.releaseBranch = releaseBranch;
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
    this.changeEmitter.dispose();
  }
}
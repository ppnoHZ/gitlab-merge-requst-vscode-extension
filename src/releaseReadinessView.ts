import * as vscode from 'vscode';
import { ReleaseFeatureState, ReleaseFeatureStatus } from './releaseReadiness';
import { IssueLinkConfig, ResolvedIssueLink, resolveFeatureIssueLinks } from './issueLinks';
import { Logger } from './logger';

type ReleaseTreeItemKind = 'directory' | 'branch' | 'readiness' | 'group' | 'feature' | 'issueLink' | 'message';

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
  private statuses: ReleaseFeatureStatus[] = [];
  private mergedIntoMain = new Set<string>();
  private branchFilters: string[] | null;

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
    if (!parent) {
      const items = this.getBranchChildren();
      if (this.releaseBranch) {
        const readiness = new ReleaseReadinessTreeItem(
          'readiness',
          `上线检查: ${this.releaseBranch}`,
          vscode.TreeItemCollapsibleState.Expanded
        );
        readiness.id = 'release-readiness';
        readiness.iconPath = new vscode.ThemeIcon('checklist');
        items.unshift(readiness);
      }
      if (items.length === 0 && this.hasBranches) {
        const message = new ReleaseReadinessTreeItem(
          'message',
          '没有匹配的分支，点击调整过滤条件',
          vscode.TreeItemCollapsibleState.None
        );
        message.command = {
          command: 'gitlabMr.filterReleaseBranches',
          title: '过滤远程分支'
        };
        items.push(message);
      }
      return items;
    }

    if (parent.kind === 'directory') {
      return this.getBranchChildren(parent.branchPath);
    }

    if (parent.kind === 'readiness') {
      if (this.statuses.length === 0) {
        return [new ReleaseReadinessTreeItem(
          'message',
          '没有找到该版本的 feature 分支',
          vscode.TreeItemCollapsibleState.None
        )];
      }

      return (Object.keys(stateInfo) as ReleaseFeatureState[]).map(state => {
        const count = this.statuses.filter(status => status.state === state).length;
        const item = new ReleaseReadinessTreeItem(
          'group',
          `${stateInfo[state].label} (${count})`,
          vscode.TreeItemCollapsibleState.Expanded,
          undefined,
          state
        );
        item.iconPath = new vscode.ThemeIcon(stateInfo[state].icon);
        return item;
      }).filter(item => this.statuses.some(status => status.state === item.groupState));
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

    if (parent.kind !== 'group' || !parent.groupState) {
      return [];
    }

    return this.statuses
      .filter(status => status.state === parent.groupState)
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
          status
        );
        const descriptionParts = [
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
            arguments: [status]
          };
        } else {
          item.command = {
            command: 'gitlabMr.createReleaseFeatureMergeRequest',
            title: '创建 Merge Request',
            arguments: [status]
          };
        }
        this.markMergedIntoMain(item, status.branch);
        return item;
      });
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
        directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        undefined,
        undefined,
        undefined,
        branchPath
      );
      item.id = `remote-branch:${branchPath}`;
      item.tooltip = branchPath;
      item.iconPath = new vscode.ThemeIcon(directory ? 'folder' : 'git-branch');
      if (!directory) {
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
      this.statuses = [];
    }
    this.changeEmitter.fire(undefined);
  }

  setReadiness(releaseBranch: string, statuses: ReleaseFeatureStatus[]): void {
    this.selectedBranch = releaseBranch;
    this.releaseBranch = releaseBranch;
    this.statuses = statuses;
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

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
import * as vscode from 'vscode';
import { ReleaseFeatureState, ReleaseFeatureStatus } from './releaseReadiness';

type ReleaseTreeItemKind = 'group' | 'feature' | 'message';

export class ReleaseReadinessTreeItem extends vscode.TreeItem {
  constructor(
    readonly kind: ReleaseTreeItemKind,
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly status?: ReleaseFeatureStatus,
    readonly groupState?: ReleaseFeatureState
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

export class ReleaseReadinessProvider implements vscode.TreeDataProvider<ReleaseReadinessTreeItem> {
  private readonly changeEmitter = new vscode.EventEmitter<ReleaseReadinessTreeItem | undefined>();
  readonly onDidChangeTreeData = this.changeEmitter.event;
  releaseBranch: string | undefined;
  private statuses: ReleaseFeatureStatus[] = [];

  getTreeItem(item: ReleaseReadinessTreeItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: ReleaseReadinessTreeItem): ReleaseReadinessTreeItem[] {
    if (!parent) {
      if (!this.releaseBranch) {
        return [];
      }
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

    if (parent.kind !== 'group' || !parent.groupState) {
      return [];
    }

    return this.statuses
      .filter(status => status.state === parent.groupState)
      .map(status => {
        const item = new ReleaseReadinessTreeItem(
          'feature',
          status.branch,
          vscode.TreeItemCollapsibleState.None,
          status
        );
        item.description = status.mergeRequest
          ? `!${status.mergeRequest.iid} ${status.mergeRequest.title}`
          : undefined;
        item.tooltip = `${status.branch} · ${stateInfo[status.state].label}`;
        item.iconPath = new vscode.ThemeIcon(stateInfo[status.state].icon);
        item.contextValue = `releaseFeature-${status.state}`;

        if (status.mergeRequest) {
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
        return item;
      });
  }

  setReadiness(releaseBranch: string, statuses: ReleaseFeatureStatus[]): void {
    this.releaseBranch = releaseBranch;
    this.statuses = statuses;
    this.changeEmitter.fire(undefined);
  }

  dispose(): void {
    this.changeEmitter.dispose();
  }
}
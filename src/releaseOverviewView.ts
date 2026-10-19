import * as vscode from 'vscode';
import { ReleaseReadinessTreeItem } from './releaseReadinessView';
import { ReleaseOverviewEntry, ReleaseOverviewSnapshot, featureStateLabels, releaseOverviewMarkdown, summarizeRelease } from './releaseOverview';

export class ReleaseOverviewItem extends vscode.TreeItem {
  constructor(label: string, readonly children: ReleaseOverviewItem[] = []) {
    super(label, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
  }
}

export class ReleaseOverviewProvider implements vscode.TreeDataProvider<ReleaseOverviewItem> {
  private readonly emitter = new vscode.EventEmitter<ReleaseOverviewItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  snapshot?: ReleaseOverviewSnapshot;
  message = '点击刷新，加载当前项目的上线总览';
  loading = false;
  private generation = 0;

  constructor(private readonly load: () => Promise<ReleaseOverviewSnapshot | undefined>) {}
  invalidate(): void {
    this.generation++;
    this.loading = false;
    this.snapshot = undefined;
    this.message = '连接已变更，请刷新上线总览';
    this.emitter.fire(undefined);
  }
  async refresh(): Promise<void> {
    if (this.loading) return;
    const generation = ++this.generation;
    this.loading = true;
    this.snapshot = undefined;
    this.message = '正在加载全部分支、MR 和 main 合入状态…';
    this.emitter.fire(undefined);
    try {
      const snapshot = await this.load();
      if (generation !== this.generation) return;
      this.snapshot = snapshot;
      this.message = snapshot ? '未发现 release/<版本> 分支' : '请先打开 GitLab 项目并配置 Token，然后刷新';
    } catch (error) {
      if (generation !== this.generation) return;
      this.message = `加载失败，请刷新重试：${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.emitter.fire(undefined);
      }
    }
  }
  getTreeItem(item: ReleaseOverviewItem): vscode.TreeItem { return item; }
  getChildren(parent?: ReleaseOverviewItem): ReleaseOverviewItem[] {
    if (parent) return parent.children;
    if (!this.snapshot || !this.snapshot.entries.length) return [new ReleaseOverviewItem(this.message)];
    const versions = new Map<string, ReleaseOverviewEntry[]>();
    for (const entry of this.snapshot.entries) versions.set(entry.version, [...(versions.get(entry.version) ?? []), entry]);
    return [new ReleaseOverviewItem(`${this.snapshot.project} · ${new Date(this.snapshot.updatedAt).toLocaleString()}`),
      ...Array.from(versions, ([version, entries]) => new ReleaseOverviewItem(version, entries.map(entry => this.releaseItem(entry))))];
  }
  private releaseItem(entry: ReleaseOverviewEntry): ReleaseOverviewItem {
    const counts = summarizeRelease(entry);
    const children: ReleaseOverviewItem[] = [];
    const main = new ReleaseOverviewItem(entry.mergedIntoMain === undefined
      ? `main 状态未知：${entry.mainError ?? '未检查'}` : entry.mergedIntoMain ? '已合入 main' : '尚未合入 main');
    main.iconPath = new vscode.ThemeIcon(entry.mergedIntoMain ? 'pass' : 'warning');
    children.push(main);
    children.push(new ReleaseOverviewItem('未校验 CI、审批、部署及已合并后的新增提交'));
    const check = new ReleaseOverviewItem('检查此上线分支');
    check.command = { command: 'gitlabMr.checkReleaseReadiness', title: '检查上线分支', arguments: [{ branchPath: entry.branch }] };
    children.push(check);
    if (entry.error) children.push(new ReleaseOverviewItem(`MR 状态未知：${entry.error}`));
    else if (!entry.features.length) children.push(new ReleaseOverviewItem('无同版本 feature 或历史 MR，无法判定可上线'));
    else {
      for (const state of ['not-created', 'closed', 'open', 'merged'] as const) {
        const features = entry.features.filter(feature => feature.state === state);
        if (!features.length) continue;
        children.push(new ReleaseOverviewItem(`${featureStateLabels[state]} (${features.length})`, features.map(feature => {
          const mr = feature.mergeRequest;
          const item = new ReleaseOverviewItem(feature.branch);
          item.description = mr ? `!${mr.iid} ${mr.title}` : '需要创建 MR';
          item.tooltip = `${feature.branch} → ${entry.branch}\n${featureStateLabels[state]}`;
          if (mr && /^https?:\/\//i.test(mr.web_url)) {
            item.command = { command: 'vscode.open', title: '打开 MR', arguments: [vscode.Uri.parse(mr.web_url)] };
          } else if (!mr) {
            item.command = { command: 'gitlabMr.createReleaseFeatureMergeRequest', title: '创建 MR',
              arguments: [new ReleaseReadinessTreeItem('feature', feature.branch, vscode.TreeItemCollapsibleState.None, feature, undefined, undefined, entry.branch)] };
          }
          return item;
        })));
      }
    }
    const item = new ReleaseOverviewItem(entry.branch, children);
    item.description = entry.error ? '状态未知' : `已合并 ${counts.merged}/${entry.features.length} · 缺失 ${counts['not-created']} · 关闭 ${counts.closed}`;
    item.iconPath = new vscode.ThemeIcon(entry.error || entry.mainError ? 'question' : counts.open + counts.closed + counts['not-created'] ? 'warning' : 'git-branch');
    return item;
  }
  async export(): Promise<void> {
    if (!this.snapshot) { vscode.window.showWarningMessage('请先刷新并加载上线总览。'); return; }
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: releaseOverviewMarkdown(this.snapshot) });
    await vscode.window.showTextDocument(document);
  }
  dispose(): void { this.generation++; this.emitter.dispose(); }
}

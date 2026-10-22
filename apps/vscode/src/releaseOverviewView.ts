import * as vscode from 'vscode';
import { WorkbenchFilters, RiskFilter, normalizeFilters, matchesUpdated, hasFilters, filterDescription } from './workbenchFilters';
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
  private filters = normalizeFilters();
  getFilters(): WorkbenchFilters { return normalizeFilters(this.filters); }
  setFilters(filters: Partial<WorkbenchFilters>): void {
    this.filters = normalizeFilters(filters);
    this.emitter.fire(undefined);
  }
  get filterSummary(): string {
    return `已筛选 ${this.getVisibleEntries().length} / ${this.snapshot?.entries.length ?? 0} 个 release`;
  }
  get filterTooltip(): string { return filterDescription(this.filters); }
  get hasDisplayFilters(): boolean { return hasFilters(this.filters); }
  getVisibleEntries(now = Date.now()): ReleaseOverviewEntry[] {
    return (this.snapshot?.entries ?? []).filter(entry => {
      const main = entry.mergedIntoMain === undefined ? 'unknown' : entry.mergedIntoMain ? 'merged' : 'unmerged';
      if (this.filters.main.length && !this.filters.main.includes(main)) return false;
      if (!matchesUpdated(entry.committedDate, this.filters.updated, now)) return false;
      const risks = new Set<RiskFilter>();
      if (entry.error || entry.mainError) risks.add('failed');
      if (!entry.error) {
        const counts = summarizeRelease(entry);
        if (counts['not-created']) risks.add('missing');
        if (counts.closed) risks.add('closed');
        if (counts.open) risks.add('open');
      }
      return !this.filters.risks.length || this.filters.risks.some(risk => risks.has(risk));
    });
  }

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
    if (!this.snapshot || !this.snapshot.entries.length) return [new ReleaseOverviewItem(this.snapshot && (this.loading || this.message.startsWith('加载失败')) ? `${this.message} · 保留 ${this.snapshot.updatedAt} 的旧结果` : this.message)];
    const visible = this.getVisibleEntries();
    if (!visible.length) {
      const empty = new ReleaseOverviewItem('没有匹配的上线分支，点击清除筛选');
      empty.command = { command: 'gitlabMr.clearReleaseOverviewFilters', title: '清除筛选' };
      return [empty];
    }
    const versions = new Map<string, ReleaseOverviewEntry[]>();
    for (const entry of visible) versions.set(entry.version, [...(versions.get(entry.version) ?? []), entry]);
    return [...(this.loading || this.message.startsWith('加载失败') ? [new ReleaseOverviewItem(`${this.loading ? '正在更新' : this.message} · 以下为旧数据`)] : []), new ReleaseOverviewItem(`${this.snapshot.project} · ${new Date(this.snapshot.updatedAt).toLocaleString()}`),
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
  async export(scope: 'all' | 'filtered' = 'all'): Promise<void> {
    if (!this.snapshot) { vscode.window.showWarningMessage('请先刷新并加载上线总览。'); return; }
    const entries = scope === 'filtered' ? this.getVisibleEntries() : this.snapshot.entries;
    const scopeLabel = scope === 'filtered' ? `当前筛选（${entries.length}/${this.snapshot.entries.length} 个 release）；${this.filterTooltip}` : '全部';
    let content = releaseOverviewMarkdown({ ...this.snapshot, entries })
      .replace('# 上线总览\n', `# 上线总览\n\n导出范围：${scopeLabel}\n`);
    if (scope === 'filtered' && !entries.length) content = content.replace('未发现 release/<版本> 分支。', '当前筛选没有匹配的 release 分支。');
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content });
    await vscode.window.showTextDocument(document);
  }
  async promptExport(): Promise<void> {
    if (!this.snapshot) { await this.export(); return; }
    const selection = await vscode.window.showQuickPick([
      { label: '导出全部', scope: 'all' as const },
      { label: '导出当前筛选结果', scope: 'filtered' as const }
    ], { title: '导出上线变更清单', placeHolder: this.filterSummary });
    if (selection) await this.export(selection.scope);
  }
  dispose(): void { this.generation++; this.emitter.dispose(); }
}

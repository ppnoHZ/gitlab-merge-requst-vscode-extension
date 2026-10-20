import * as vscode from 'vscode';
import * as path from 'path';
import { homedir } from 'os';
import { Audit, AuditEvent, AuditFilter, AuditQuery, AuditStore } from './audit';
import { Logger } from './logger';

const phaseLabels: Record<AuditEvent['phase'] | 'unresolved', string> = {
  requested: '已请求', confirmed: '已确认', prepared: '准备执行', success: '已成功',
  failed: '已失败', unknown: '结果未知', cancelled: '已取消', blocked: '已阻止', unresolved: '结果待核实'
};

export class AuditItem extends vscode.TreeItem {
  constructor(label: string, readonly event?: AuditEvent) {
    super(label, vscode.TreeItemCollapsibleState.None);
  }
}

export class AuditView implements vscode.TreeDataProvider<AuditItem> {
  private emitter = new vscode.EventEmitter<AuditItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private result: AuditQuery | undefined;
  private error = '';
  private filter: AuditFilter = {};
  private page = 0;
  private generation = 0;
  private dirty = true;
  private subscription: { dispose(): void };

  constructor(private readonly store: AuditStore) {
    this.subscription = store.onChange(() => {
      this.dirty = true;
      this.emitter.fire(undefined);
    });
  }

  getTreeItem(item: AuditItem): vscode.TreeItem { return item; }

  async getChildren(): Promise<AuditItem[]> {
    if (this.dirty) { await this.refresh(); }
    const status = new AuditItem(this.store.healthy ? '审计存储可用' : '审计异常：敏感操作已暂停');
    status.description = `${this.result?.files ?? 0} 个日志文件 · ${this.result?.bytes ?? 0} 字节`;
    status.tooltip = `${this.store.directory}\n日志位于扩展运行主机，独立于 VS Code 目录。不会自动删除。`;
    status.iconPath = new vscode.ThemeIcon(this.store.healthy ? 'shield' : 'error');
    status.command = { command: 'gitlabMr.checkAuditHealth', title: '检查并恢复审计存储' };
    const items = [status];
    const location = new AuditItem('日志位置（扩展运行主机）');
    location.description = this.store.directory;
    location.tooltip = this.store.directory;
    items.push(location);
    if (this.error) {
      const error = new AuditItem(`历史读取失败: ${this.error}`);
      error.command = { command: 'gitlabMr.refreshAudit', title: '重新读取历史' };
      items.push(error);
      return items;
    }
    const summary = new AuditItem(
      `${this.result?.total ?? 0} 条匹配事件 · ${this.result?.unresolved ?? 0} 个执行后无结果的操作（待核实）`
    );
    summary.tooltip = JSON.stringify(this.filter, null, 2);
    summary.command = { command: 'gitlabMr.filterAudit', title: '筛选操作历史' };
    items.push(summary);
    for (const event of this.result?.events ?? []) {
      const item = new AuditItem(`${new Date(event.timestamp).toLocaleString('zh-CN')} ${event.action}`, event);
      item.description = `${phaseLabels[event.phase]} · ${event.context.project ?? ''} ${event.context.branch ?? (event.context.mr ? `!${event.context.mr}` : '')}`;
      item.tooltip = `${event.risk} · ${event.actor.osUser}@${event.actor.host}\n操作 ID: ${event.operationId}\n点击查看完整操作时间线`;
      item.iconPath = new vscode.ThemeIcon(event.risk === 'high' ? 'warning' : 'history');
      item.command = { command: 'gitlabMr.showAuditOperation', title: '查看操作时间线', arguments: [item] };
      items.push(item);
    }
    if ((this.result?.total ?? 0) > (this.page + 1) * 50) {
      const next = new AuditItem('下一页（每页 50 条）');
      next.command = { command: 'gitlabMr.nextAuditPage', title: '下一页' };
      items.push(next);
    }
    if (this.page > 0) {
      const previous = new AuditItem('上一页');
      previous.command = { command: 'gitlabMr.previousAuditPage', title: '上一页' };
      items.push(previous);
    }
    return items;
  }

  async refresh(): Promise<void> {
    const generation = ++this.generation;
    try {
      const result = await this.store.query(this.filter, this.page * 50, 50);
      if (generation === this.generation) { this.result = result; this.error = ''; }
    } catch (error) {
      if (generation === this.generation) {
        this.result = undefined;
        this.error = error instanceof Error ? error.message : String(error);
        Logger.error('读取审计历史失败', error);
      }
    }
    if (generation === this.generation) { this.dirty = false; }
  }

  async changePage(delta: number): Promise<void> {
    this.page = Math.max(0, this.page + delta);
    await this.refresh();
    this.emitter.fire(undefined);
  }

  async filterHistory(): Promise<void> {
    const field = await vscode.window.showQuickPick([
      { label: 'project', description: '项目 ID 或路径' }, { label: 'actor', description: '操作系统用户 / GitLab 用户' },
      { label: 'action', description: '操作类型，例如 branch.delete / mr.approve / mr.merge / mr.create' },
      { label: 'risk', description: 'normal / sensitive / high' },
      { label: 'phase', description: 'success / failed / unknown / blocked / cancelled / unresolved 等' },
      { label: 'search', description: '分支、MR、文件等关键词' },
      { label: 'from', description: '起始时间（含时区 ISO 8601）' },
      { label: 'to', description: '结束时间（含时区 ISO 8601）' },
      { label: 'reset', description: '清除全部筛选条件' }
    ], { title: '审计历史筛选（条件可叠加）' });
    if (!field) { return; }
    if (field.label === 'reset') {
      this.filter = {};
    } else {
      const key = field.label as keyof AuditFilter;
      const value = await vscode.window.showInputBox({
        title: `审计筛选: ${key}`, prompt: '留空清除此条件', value: this.filter[key] ?? '', ignoreFocusOut: true
      });
      if (value === undefined) { return; }
      let normalized = value.trim();
      if ((key === 'from' || key === 'to') && normalized) {
        if (!/(Z|[+-]\d{2}:\d{2})$/i.test(normalized) || !Number.isFinite(Date.parse(normalized))) {
          throw new Error('时间必须为含时区的 ISO 8601，例如 2026-10-19T00:00:00+08:00。');
        }
        normalized = new Date(normalized).toISOString();
      }
      if (key === 'risk' && normalized && !['normal', 'sensitive', 'high'].includes(normalized)) {
        throw new Error('风险等级只能是 normal、sensitive 或 high。');
      }
      if (key === 'phase' && normalized && !Object.hasOwn(phaseLabels, normalized)) {
        throw new Error('无效操作状态，请使用筛选菜单说明中的状态。');
      }
      const next = { ...this.filter, [key]: normalized || undefined };
      if (next.from && next.to && next.from > next.to) { throw new Error('起始时间不能晚于结束时间。'); }
      this.filter = next;
    }
    this.page = 0;
    await this.refresh();
    this.emitter.fire(undefined);
  }

  async showOperation(item: AuditItem): Promise<void> {
    if (!item.event) { throw new Error('请选择一条审计事件。'); }
    const result = await this.store.query({ operationId: item.event.operationId }, 0, 1000);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({
      language: 'json',
      content: JSON.stringify({
        directory: this.store.directory,
        notice: '仅覆盖本扩展的操作。GitLab 身份未记录时表示未核实，不代表匿名执行。打开 Diff 不等于完成审阅。',
        operationId: item.event.operationId,
        outcome: result.events.some(event => ['success', 'failed', 'unknown'].includes(event.phase))
          ? '见终态记录' : result.events.some(event => event.phase === 'prepared') ? '执行后无终态，结果待核实' : '尚未执行或见取消/阻止记录',
        events: [...result.events].reverse()
      }, null, 2)
    }), { preview: true });
  }

  async exportHistory(): Promise<void> {
    const format = await vscode.window.showQuickPick([
      { label: 'jsonl', description: '结构化事件、导出元数据与条数' },
      { label: 'csv', description: 'Excel 可读，已处理公式注入' }
    ], { title: '导出当前筛选范围的全部审计历史（不限当前页）' });
    if (!format) { return; }
    const destination = await vscode.window.showSaveDialog({
      title: '导出审计历史（不覆盖现有文件）',
      defaultUri: vscode.Uri.file(path.join(homedir(), `gitlab-audit-${Date.now()}.${format.label}`)),
      filters: { 'Audit': [format.label] }
    });
    if (!destination) { return; }
    if (destination.scheme !== 'file') {
      throw new Error('请选择扩展运行主机上的文件路径，其他 URI 不支持直接导出。');
    }
    const count = await this.store.exportTo(destination.fsPath, format.label === 'csv' ? 'csv' : 'jsonl', this.filter);
    vscode.window.showInformationMessage(`已导出 ${count} 条审计事件: ${destination.fsPath}`);
  }

  dispose(): void { this.subscription.dispose(); this.emitter.dispose(); }
}

export function registerAuditView(context: vscode.ExtensionContext, store: AuditStore): void {
  const provider = new AuditView(store);
  const tree = vscode.window.createTreeView('gitlabMr.auditHistory', { treeDataProvider: provider });
  const run = async (action: () => Promise<unknown>) => {
    try { await action(); } catch (error) {
      Logger.error('操作审计失败', error);
      vscode.window.showErrorMessage(`操作审计失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const commands: Array<[string, () => Promise<unknown>]> = [
    ['gitlabMr.refreshAudit', () => provider.changePage(0)],
    ['gitlabMr.nextAuditPage', () => provider.changePage(1)],
    ['gitlabMr.previousAuditPage', () => provider.changePage(-1)],
    ['gitlabMr.filterAudit', () => provider.filterHistory()],
    ['gitlabMr.exportAudit', () => provider.exportHistory()],
    ['gitlabMr.checkAuditHealth', async () => {
      await store.recover();
      await Audit.event('audit.integrity-check', { source: 'command' });
      vscode.window.showInformationMessage(`审计校验与持久化探测通过: ${store.directory}。不保证检测整段日志被删除。`);
      await provider.changePage(0);
    }]
  ];
  context.subscriptions.push(provider, tree,
    vscode.commands.registerCommand('gitlabMr.showAuditOperation',
      (item: AuditItem) => run(() => provider.showOperation(item))),
    ...commands.map(([name, handler]) => vscode.commands.registerCommand(name, () => run(handler))));
}

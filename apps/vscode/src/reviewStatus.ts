import * as vscode from 'vscode';
import type { RepositoryProvider } from './providers/repositoryProvider';
import type { ReviewMergeRequest } from './types';

export async function pendingApprovals(service: RepositoryProvider): Promise<ReviewMergeRequest[]> {
  const user = await service.getCurrentUser();
  const requests = await service.getReviewMergeRequests(user.id);
  const unique = [...new Map(requests.filter(item => item.state === 'opened').map(item => [`${item.project_id}:${item.iid}`, item])).values()];
  const pending: ReviewMergeRequest[] = [];
  for (let offset = 0; offset < unique.length; offset += 5) {
    const batch = unique.slice(offset, offset + 5);
    const approved = await Promise.all(batch.map(item => service.hasUserApprovedMergeRequest(item.project_id, item.iid, user.id)));
    batch.forEach((item, index) => { if (!approved[index]) pending.push(item); });
  }
  return pending;
}

export async function countPendingApprovals(service: RepositoryProvider): Promise<number> {
  return (await pendingApprovals(service)).length;
}

/** Independent polling never discards the currently opened review/diff in the tree. */
export class ReviewStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private busy = false;
  private disposed = false;
  private readonly seen = new Map<string, Set<string>>();
  private static readonly seenKey = 'gitlabMr.approvalNotifications.seen.v1';
  constructor(private readonly connect: () => Promise<RepositoryProvider | undefined>, private readonly state?: vscode.Memento) {
    this.item.command = 'gitlabMr.showApprovalInbox';
    this.item.name = '待我审批 MR';
    this.item.text = '$(git-pull-request) 待审批 …';
    this.item.show();
    void this.refresh();
  }
  private async notifyNew(service: RepositoryProvider, requests: ReviewMergeRequest[]): Promise<void> {
    const scope = service.auditContext?.instance ?? service.kind;
    const stored = this.state?.get<Record<string, string[]>>(ReviewStatus.seenKey, {}) ?? {};
    let seen = this.seen.get(scope);
    const initialized = seen !== undefined || Object.prototype.hasOwnProperty.call(stored, scope);
    if (!seen) {
      seen = new Set(stored[scope] ?? []);
      this.seen.set(scope, seen);
    }
    const keyed = requests.map(request => ({ request, key: `${request.project_id}:${request.iid}` }));
    const fresh = initialized ? keyed.filter(item => !seen!.has(item.key)) : [];
    keyed.forEach(item => seen!.add(item.key));
    if (seen.size > 500) seen = new Set([...seen].slice(-500));
    this.seen.set(scope, seen);
    if (this.state) await this.state.update(ReviewStatus.seenKey, { ...stored, [scope]: [...seen] });
    if (!fresh.length || !vscode.workspace.getConfiguration('gitlabMr').get<boolean>('notifyNewApprovals', true)) return;
    const single = fresh.length === 1 ? fresh[0].request : undefined;
    const message = single ? `有新的 MR !${single.iid} 需要你审批：${single.title}` : `有 ${fresh.length} 个新的 MR 需要你审批。`;
    void vscode.window.showInformationMessage(message, ...(single ? ['打开 MR', '查看待办'] : ['查看待办'])).then(async action => {
      if (action === '打开 MR' && single && /^https?:\/\//i.test(single.web_url)) await vscode.env.openExternal(vscode.Uri.parse(single.web_url));
      if (action === '查看待办') await vscode.commands.executeCommand('gitlabMr.showApprovalInbox');
    });
  }
  invalidate(): void {
    this.generation++;
    this.item.text = '$(git-pull-request) 待审批 …';
    this.item.backgroundColor = undefined;
    void this.refresh();
  }
  async refresh(): Promise<void> {
    if (this.busy || this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.busy = true;
    const generation = this.generation;
    try {
      const service = await this.connect();
      const requests = service?.capabilities.todos ? await pendingApprovals(service) : undefined;
      const count = requests?.length;
      if (generation !== this.generation || this.disposed) return;
      this.item.text = count === undefined ? '$(git-pull-request) 待审批 —' : `$(git-pull-request) 待审批 ${count}`;
      this.item.tooltip = count === undefined ? (service ? '当前平台尚未接入审批待办' : '请先配置当前实例 Token') : `${count} 个指定你为 Reviewer 且尚未批准的开放 MR；点击查看。更新于 ${new Date().toLocaleTimeString()}`;
      this.item.backgroundColor = count ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
      if (service && requests) await this.notifyNew(service, requests);
    } catch {
      if (generation !== this.generation || this.disposed) return;
      this.item.text = '$(warning) 待审批 ?';
      this.item.tooltip = '审批数量查询失败，点击刷新；未知不代表没有待审批 MR。';
      this.item.backgroundColor = undefined;
    } finally {
      this.busy = false;
      if (!this.disposed) {
        const configured = vscode.workspace.getConfiguration('gitlabMr').get<number>('approvalRefreshSeconds', 60);
        const seconds = Number.isFinite(configured) ? Math.max(30, Math.min(600, configured)) : 60;
        this.timer = setTimeout(() => void this.refresh(), generation === this.generation ? seconds * 1000 : 0);
      }
    }
  }
  dispose(): void { this.disposed = true; this.generation++; if (this.timer) clearTimeout(this.timer); this.item.dispose(); }
}

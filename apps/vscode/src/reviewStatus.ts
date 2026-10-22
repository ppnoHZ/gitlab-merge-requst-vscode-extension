import * as vscode from 'vscode';
import type { RepositoryProvider } from './providers/repositoryProvider';

export async function countPendingApprovals(service: RepositoryProvider): Promise<number> {
  const user = await service.getCurrentUser();
  const requests = await service.getReviewMergeRequests(user.id);
  const unique = [...new Map(requests.filter(item => item.state === 'opened').map(item => [`${item.project_id}:${item.iid}`, item])).values()];
  let count = 0;
  for (let offset = 0; offset < unique.length; offset += 5) {
    const approved = await Promise.all(unique.slice(offset, offset + 5).map(item => service.hasUserApprovedMergeRequest(item.project_id, item.iid, user.id)));
    count += approved.filter(value => !value).length;
  }
  return count;
}

/** Independent polling never discards the currently opened review/diff in the tree. */
export class ReviewStatus implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private busy = false;
  private disposed = false;
  constructor(private readonly connect: () => Promise<RepositoryProvider | undefined>) {
    this.item.command = 'gitlabMr.showApprovalInbox';
    this.item.name = '待我审批 MR';
    this.item.text = '$(git-pull-request) 待审批 …';
    this.item.show();
    void this.refresh();
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
      const count = service?.capabilities.todos ? await countPendingApprovals(service) : undefined;
      if (generation !== this.generation || this.disposed) return;
      this.item.text = count === undefined ? '$(git-pull-request) 待审批 —' : `$(git-pull-request) 待审批 ${count}`;
      this.item.tooltip = count === undefined ? (service ? '当前平台尚未接入审批待办' : '请先配置当前实例 Token') : `${count} 个指定你为 Reviewer 且尚未批准的开放 MR；点击查看。更新于 ${new Date().toLocaleTimeString()}`;
      this.item.backgroundColor = count ? new vscode.ThemeColor('statusBarItem.warningBackground') : undefined;
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

import * as vscode from 'vscode';
import { GitLabService } from './gitlabService';
import { ReviewChangedFile, ReviewDetails, ReviewMergeRequest } from './types';

export interface ReviewFile {
  change: ReviewChangedFile;
  left: vscode.Uri;
  right: vscode.Uri;
  title: string;
}

interface ReviewSnapshot {
  details: ReviewDetails;
  files: ReviewFile[];
  complete: boolean;
}

export class MergeRequestReview implements vscode.TextDocumentContentProvider {
  static readonly scheme = 'gitlab-mr-review';
  private generation = 0;
  private serial = 0;
  private snapshots = new Map<ReviewMergeRequest, ReviewSnapshot>();
  private loads = new Map<ReviewMergeRequest, Promise<ReviewSnapshot>>();
  private approving = new Set<ReviewMergeRequest>();
  private contents = new Map<string, () => Promise<string>>();
  private text = new Map<string, Promise<string>>();

  reset(): void {
    this.generation++;
    this.snapshots.clear();
    this.loads.clear();
    this.contents.clear();
    this.text.clear();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const read = this.contents.get(uri.toString());
    if (!read) {
      throw new Error('此 Diff 已失效，请重新加载待审批 MR 的变更。');
    }
    const generation = this.generation;
    let content = this.text.get(uri.toString());
    if (!content) {
      content = read();
      this.text.set(uri.toString(), content);
    }
    let text: string;
    try {
      text = await content;
    } catch (error) {
      this.text.delete(uri.toString());
      throw error;
    }
    if (generation !== this.generation) {
      throw new Error('GitLab 连接或审阅列表已更新，请重新打开 Diff。');
    }
    return text;
  }

  private uri(path: string, read: () => Promise<string>): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: MergeRequestReview.scheme,
      path: `/${++this.serial}/${path}`
    });
    this.contents.set(uri.toString(), read);
    return uri;
  }

  load(request: ReviewMergeRequest, service: GitLabService): Promise<ReviewSnapshot> {
    const cached = this.snapshots.get(request);
    if (cached) {
      return Promise.resolve(cached);
    }
    const existing = this.loads.get(request);
    if (existing) {
      return existing;
    }
    const generation = this.generation;
    const pending = this.loadSnapshot(request, service, generation).finally(() => {
      if (generation === this.generation) {
        this.loads.delete(request);
      }
    });
    this.loads.set(request, pending);
    return pending;
  }

  private async loadSnapshot(
    request: ReviewMergeRequest, service: GitLabService, generation: number
  ): Promise<ReviewSnapshot> {
    const details = await service.getReviewDetails(request.project_id, request.iid);
    if (details.state !== 'opened') {
      throw new Error('MR 已关闭或合并，请刷新待审批列表。');
    }
    const version = await service.getReviewDiffVersion(request.project_id, request.iid, details.diff_refs);
    if (generation !== this.generation) {
      throw new Error('审阅列表已更新，请重新选择 MR。');
    }
    const size = Number(version.real_size);
    const complete = !version.overflow && Number.isSafeInteger(size) && size >= 0 && size === version.diffs.length;
    const files = version.diffs.map(change => ({
      change,
      left: this.uri(change.old_path, () => change.new_file ? Promise.resolve('')
        : service.getReviewFileContent(details.target_project_id, change.old_path, details.diff_refs.base_sha)),
      right: this.uri(change.new_path, () => change.deleted_file ? Promise.resolve('')
        : service.getReviewFileContent(details.source_project_id, change.new_path, details.diff_refs.head_sha)),
      title: `!${request.iid} ${change.new_path} (${details.diff_refs.head_sha.slice(0, 8)})`
    }));
    const snapshot = { details, files, complete };
    this.snapshots.set(request, snapshot);
    return snapshot;
  }

  async openFile(file: ReviewFile): Promise<void> {
    // Read both sides first so a failed/binary download never looks like an empty diff.
    await Promise.all([
      this.provideTextDocumentContent(file.left),
      this.provideTextDocumentContent(file.right)
    ]);
    await vscode.commands.executeCommand('vscode.diff', file.left, file.right, file.title, { preview: true });
  }

  async approve(request: ReviewMergeRequest, service: GitLabService, userId: number): Promise<boolean> {
    if (this.approving.has(request)) {
      throw new Error('该 MR 正在批准中，请勿重复操作。');
    }
    const snapshot = this.snapshots.get(request);
    if (!snapshot) {
      throw new Error('请先展开 MR 并查看变更，再批准所审阅的版本。');
    }
    if (!snapshot.complete) {
      throw new Error('GitLab 返回的变更列表不完整，请在浏览器中完成审阅和批准。');
    }
    const generation = this.generation;
    this.approving.add(request);
    try {
      const answer = await vscode.window.showWarningMessage(
        `批准 MR !${request.iid}「${request.title}」？\nProject ${request.project_id}\n审阅版本: ${snapshot.details.diff_refs.head_sha}\n请确认已审阅该版本的所有变更。此操作仅批准，不合并。`,
        { modal: true }, 'Approve（批准）'
      );
      if (answer !== 'Approve（批准）') {
        return false;
      }
      if (generation !== this.generation) {
        throw new Error('审阅列表或 GitLab 连接已更新，已取消批准，请重新查看变更。');
      }
      const current = await service.getReviewDetails(request.project_id, request.iid);
      if (current.state !== 'opened' || !current.reviewers.some(user => user.id === userId)) {
        throw new Error('MR 已关闭、合并或你已不再是 Reviewer，请刷新。');
      }
      if (current.diff_refs.head_sha !== snapshot.details.diff_refs.head_sha ||
        current.diff_refs.base_sha !== snapshot.details.diff_refs.base_sha ||
        current.diff_refs.start_sha !== snapshot.details.diff_refs.start_sha) {
        this.snapshots.delete(request);
        throw new Error('MR 代码已更新，未批准。请刷新并重新审阅最新变更。');
      }
      if (generation !== this.generation) {
        throw new Error('审阅列表或 GitLab 连接已更新，已取消批准。');
      }
      try {
        await service.approveReview(request.project_id, request.iid, snapshot.details.diff_refs.head_sha, userId);
      } catch (error) {
        throw new Error(`批准未确认: ${error instanceof Error ? error.message : String(error)}。请刷新确认状态；权限、409 版本冲突或需重新认证时，请在 GitLab 页面处理，不要盲目重复提交。`);
      }
      return true;
    } finally {
      this.approving.delete(request);
    }
  }

  dispose(): void {
    this.reset();
  }
}

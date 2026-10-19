import * as vscode from 'vscode';
import { GitLabService } from './gitlabService';
import { Logger } from './logger';
import { ReviewMergeRequest, ReviewProject } from './types';
import { MergeRequestReview, ReviewFile } from './mergeRequestReview';

export class PendingReviewItem extends vscode.TreeItem {
  constructor(
    readonly kind: 'project' | 'request' | 'file' | 'message',
    label: string,
    collapsibleState = vscode.TreeItemCollapsibleState.None,
    readonly project?: ReviewProject,
    readonly request?: ReviewMergeRequest,
    readonly projectId = project?.id,
    readonly file?: ReviewFile
  ) {
    super(label, collapsibleState);
  }
}

export class PendingReviewsProvider implements vscode.TreeDataProvider<PendingReviewItem> {
  private readonly emitter = new vscode.EventEmitter<PendingReviewItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: PendingReviewItem[] = [];
  private children = new Map<number, PendingReviewItem[]>();
  private generation = 0;
  private loading = false;
  private service: GitLabService | undefined;
  private userId: number | undefined;
  private activeRequests = new Set<PendingReviewItem>();
  private files = new Map<PendingReviewItem, PendingReviewItem[]>();
  private loadingChanges = new Set<PendingReviewItem>();
  private parents = new WeakMap<PendingReviewItem, PendingReviewItem | undefined>();
  readonly review = new MergeRequestReview();
  loaded = false;
  summary = '';

  constructor(private readonly connect: (prompt: boolean) => Promise<GitLabService | undefined>) {}

  getTreeItem(item: PendingReviewItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: PendingReviewItem): PendingReviewItem[] {
    const children = parent?.kind === 'request'
      ? this.files.get(parent) ?? [this.changesMessage(parent, '点击加载变更文件')]
      : parent?.kind === 'project' && parent.projectId !== undefined
        ? this.children.get(parent.projectId) ?? []
        : parent ? [] : this.roots;
    for (const child of children) {
      this.parents.set(child, parent);
    }
    return children;
  }

  getParent(item: PendingReviewItem): PendingReviewItem | undefined {
    return this.parents.get(item);
  }

  reset(): void {
    this.generation++;
    this.loading = false;
    this.loaded = false;
    this.summary = '';
    this.roots = [];
    this.children.clear();
    this.clearReview();
    this.emitter.fire(undefined);
  }

  private clearReview(): void {
    this.service = undefined;
    this.userId = undefined;
    this.activeRequests.clear();
    this.files.clear();
    this.parents = new WeakMap();
    this.loadingChanges.clear();
    this.review.reset();
  }

  private changesMessage(parent: PendingReviewItem, label: string): PendingReviewItem {
    const item = this.message(label);
    item.command = {
      command: 'gitlabMr.showPendingReviewChanges', title: '加载 MR 变更', arguments: [parent]
    };
    return item;
  }

  private requireRequest(item: PendingReviewItem): { request: ReviewMergeRequest; service: GitLabService; userId: number } {
    if (item.kind !== 'request' || !item.request || !this.activeRequests.has(item) || !this.service || !this.userId) {
      throw new Error('此 MR 列表已失效，请刷新后重新选择。');
    }
    return { request: item.request, service: this.service, userId: this.userId };
  }

  async loadChanges(item: PendingReviewItem): Promise<void> {
    const { request, service } = this.requireRequest(item);
    if (this.loadingChanges.has(item) || this.files.get(item)?.some(child => child.kind === 'file')) {
      return;
    }
    const generation = this.generation;
    this.loadingChanges.add(item);
    this.files.set(item, [this.message('正在加载变更文件...')]);
    this.emitter.fire(item);
    try {
      const snapshot = await this.review.load(request, service);
      if (generation !== this.generation) {
        return;
      }
      const files = snapshot.files.map(file => {
        const change = file.change;
        const child = new PendingReviewItem('file', change.renamed_file
          ? `${change.old_path} → ${change.new_path}` : change.new_path,
        vscode.TreeItemCollapsibleState.None, item.project, request, item.projectId, file);
        child.id = `${item.id}:file:${change.new_path}`;
        child.description = change.new_file ? '新增' : change.deleted_file ? '删除' : change.renamed_file ? '重命名' : '修改';
        child.tooltip = `${child.label}\n版本: ${snapshot.details.diff_refs.head_sha}\n点击查看只读双栏 Diff`;
        child.iconPath = new vscode.ThemeIcon('diff');
        child.command = { command: 'gitlabMr.openReviewDiff', title: '查看文件 Diff', arguments: [child] };
        return child;
      });
      if (!snapshot.complete) {
        files.unshift(this.message('变更列表被 GitLab 截断，无法在此批准，请在浏览器查看完整变更'));
        vscode.window.showWarningMessage('MR 变更列表不完整，Approve 已阻止，请在 GitLab 中完成审阅。');
      }
      this.files.set(item, files.length ? files : [this.message('此版本没有文件变更')]);
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      this.files.set(item, [this.changesMessage(item, `加载变更失败，点击重试: ${error instanceof Error ? error.message : String(error)}`)]);
      throw error;
    } finally {
      if (generation === this.generation) {
        this.loadingChanges.delete(item);
        this.emitter.fire(item);
      }
    }
  }

  async openDiff(item: PendingReviewItem): Promise<void> {
    if (!item.file || ![...this.files.values()].some(files => files.includes(item))) {
      throw new Error('此文件 Diff 已失效，请重新加载 MR 变更。');
    }
    await this.review.openFile(item.file);
  }

  async approve(item: PendingReviewItem): Promise<boolean> {
    const { request, service, userId } = this.requireRequest(item);
    return this.review.approve(request, service, userId);
  }

  private message(label: string, retry = false): PendingReviewItem {
    const item = new PendingReviewItem('message', label);
    if (retry) {
      item.command = { command: 'gitlabMr.refreshPendingReviews', title: '刷新待我审批' };
      item.iconPath = new vscode.ThemeIcon('warning');
    }
    return item;
  }

  async refresh(prompt = true): Promise<void> {
    if (this.loading) {
      return;
    }
    const generation = ++this.generation;
    this.loading = true;
    this.loaded = false;
    this.summary = '正在加载...';
    this.roots = [this.message('正在加载待我审批的 MR...')];
    this.children.clear();
    this.clearReview();
    this.emitter.fire(undefined);
    try {
      const service = await this.connect(prompt);
      if (generation !== this.generation) {
        return;
      }
      if (!service) {
        this.roots = [this.message('请配置 GitLab Token，点击加载待我审批的 MR', true)];
        this.summary = '未配置 Token';
        return;
      }
      const user = await service.getCurrentUser();
      if (!Number.isSafeInteger(user.id) || user.id <= 0) {
        throw new Error('GitLab 当前用户响应缺少有效 ID。');
      }
      const requests = await service.getReviewMergeRequests(user.id);
      if (generation !== this.generation) {
        return;
      }
      this.service = service;
      this.userId = user.id;
      const projects = new Map<number, Promise<ReviewProject>>();
      const groups = new Map<number, { project?: ReviewProject; items: PendingReviewItem[] }>();
      let pending = 0;
      let failed = 0;
      for (let offset = 0; offset < requests.length; offset += 5) {
        if (generation !== this.generation) {
          return;
        }
        await Promise.all(requests.slice(offset, offset + 5).map(async request => {
          try {
            if (await service.hasUserApprovedMergeRequest(request.project_id, request.iid, user.id)) {
              return;
            }
            let projectPromise = projects.get(request.project_id);
            if (!projectPromise) {
              projectPromise = service.getReviewProject(request.project_id);
              projects.set(request.project_id, projectPromise);
            }
            const project = await projectPromise;
            const group = groups.get(project.id) ?? { project, items: [] };
            group.project = project;
            const item = new PendingReviewItem('request', `!${request.iid} ${request.title}`,
              vscode.TreeItemCollapsibleState.Collapsed, project, request);
            item.id = `pending-review:${project.id}:${request.iid}`;
            item.contextValue = 'pendingReviewRequest';
            item.description = [request.author?.name, request.draft ? '草稿' : undefined].filter(Boolean).join(' · ');
            item.tooltip = `${request.title}\n${project.path_with_namespace} !${request.iid}\n${request.source_branch} → ${request.target_branch}\n作者: ${request.author?.name ?? '未知'}\n指定我为 Reviewer，尚未批准`;
            item.iconPath = new vscode.ThemeIcon('git-pull-request');
            item.command = { command: 'gitlabMr.showPendingReviewChanges', title: '查看 MR 变更文件', arguments: [item] };
            group.items.push(item);
            groups.set(project.id, group);
            pending++;
          } catch (error) {
            failed++;
            Logger.error(`查询待审批 MR 失败: Project ${request.project_id} !${request.iid}`, error);
            const group = groups.get(request.project_id) ?? { items: [] };
            group.items.push(this.message(
              `!${request.iid} ${request.title} 查询失败: ${error instanceof Error ? error.message : String(error)}`, true
            ));
            groups.set(request.project_id, group);
          }
        }));
      }
      if (generation !== this.generation) {
        return;
      }
      this.roots = [];
      for (const [id, group] of [...groups].sort(([, a], [, b]) =>
        (a.project?.path_with_namespace ?? '').localeCompare(b.project?.path_with_namespace ?? ''))) {
        const item = new PendingReviewItem('project', group.project?.path_with_namespace ?? `Project ${id}（查询未完成）`,
          vscode.TreeItemCollapsibleState.Collapsed, group.project, undefined, id);
        item.id = `pending-review-project:${id}`;
        const count = group.items.filter(child => child.kind === 'request').length;
        item.description = `${count} 个待审批${group.items.some(child => child.kind === 'message') ? ' · 部分查询失败' : ''}`;
        item.iconPath = new vscode.ThemeIcon('repo');
        this.roots.push(item);
        this.children.set(id, group.items);
        for (const child of group.items) {
          if (child.kind === 'request') {
            this.activeRequests.add(child);
          }
        }
      }
      this.loaded = true;
      this.summary = `${pending} 个待审批 · ${groups.size} 个项目${failed ? ` · ${failed} 个查询失败` : ''}`;
      if (failed) {
        this.roots.unshift(this.message('部分 MR 查询失败，点击重试；结果不完整', true));
        vscode.window.showWarningMessage('待我审批列表部分查询失败，无法确认的 MR 不计入待审批数量，请刷新重试。');
      } else if (!pending) {
        this.roots = [this.message('当前没有指定你为 Reviewer 且尚未批准的开放 MR')];
      }
    } catch (error) {
      if (generation !== this.generation) {
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      Logger.error('加载待我审批 MR 失败', error);
      this.summary = '加载失败';
      this.roots = [this.message(`加载失败，点击重试: ${message}`, true)];
      vscode.window.showErrorMessage(`加载待我审批 MR 失败: ${message}`);
    } finally {
      if (generation === this.generation) {
        this.loading = false;
        this.emitter.fire(undefined);
      }
    }
  }

  dispose(): void {
    this.reset();
    this.emitter.dispose();
  }
}

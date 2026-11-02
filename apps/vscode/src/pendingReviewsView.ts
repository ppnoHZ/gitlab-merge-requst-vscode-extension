import * as vscode from 'vscode';
import type { RepositoryProvider } from './providers/repositoryProvider';
import { Logger } from './logger';
import { ReviewMergeRequest, ReviewProject } from './types';
import { MergeRequestReview, ReviewFile } from './mergeRequestReview';
import { hasMergeConflicts, conflictCreationBlockReason, conflictResolutionHint } from './conflictRules';
import { createConflictFromMergeRequest } from './conflictWorkflow';

type TodoCategory = 'review' | 'authored';

export class PendingReviewItem extends vscode.TreeItem {
  constructor(
    readonly kind: 'category' | 'project' | 'request' | 'file' | 'message' | 'action',
    label: string,
    collapsibleState = vscode.TreeItemCollapsibleState.None,
    readonly project?: ReviewProject,
    readonly request?: ReviewMergeRequest,
    readonly projectId = project?.id,
    readonly file?: ReviewFile,
    readonly category: TodoCategory = 'review'
  ) {
    super(label, collapsibleState);
  }
}

export class PendingReviewsProvider implements vscode.TreeDataProvider<PendingReviewItem> {
  private readonly emitter = new vscode.EventEmitter<PendingReviewItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private roots: PendingReviewItem[] = [];
  private children = new Map<string, PendingReviewItem[]>();
  private generation = 0;
  private loading = false;
  private service: RepositoryProvider | undefined;
  private userId: number | undefined;
  private activeRequests = new Set<PendingReviewItem>();
  private files = new Map<PendingReviewItem, PendingReviewItem[]>();
  private loadingChanges = new Set<PendingReviewItem>();
  private parents = new WeakMap<PendingReviewItem, PendingReviewItem | undefined>();
  readonly review = new MergeRequestReview();
  loaded = false;
  summary = '';
  private updatedAt?: string;
  private stale = false;

  constructor(private readonly connect: (prompt: boolean) => Promise<RepositoryProvider | undefined>, private readonly includeAuthored = false) {}

  getTreeItem(item: PendingReviewItem): vscode.TreeItem {
    return item;
  }

  getChildren(parent?: PendingReviewItem): PendingReviewItem[] {
    let children = parent?.kind === 'request'
      ? this.files.get(parent) ?? [this.changesMessage(parent, '点击加载变更文件')]
      : (parent?.kind === 'project' || parent?.kind === 'category') && parent.id !== undefined
        ? this.children.get(parent.id) ?? []
        : parent ? [] : (this.updatedAt && (this.loading || this.stale)
          ? [this.message(`${this.loading ? '正在更新' : this.summary} · 以下为 ${this.updatedAt} 的旧数据，操作前需刷新`, this.stale), ...this.roots]
          : this.roots);
    if (parent?.kind === 'request' && parent.request && hasMergeConflicts(parent.request)) {
      const reason = conflictCreationBlockReason(parent.request);
      const action = new PendingReviewItem('action', reason ? '查看冲突处理方式（此场景不创建 conflict）' : '创建 conflict 分支…');
      action.id = `${parent.id}:conflict-action`;
      action.iconPath = new vscode.ThemeIcon(reason ? 'info' : 'git-branch');
      action.tooltip = reason ?? `从 ${parent.request.target_branch} 创建 conflict/${parent.request.source_branch}`;
      action.command = { command: 'gitlabMr.createConflictFromMergeRequest', title: '处理冲突 / 创建 conflict 分支', arguments: [parent] };
      children = [action, ...children];
    }
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
    this.updatedAt = undefined;
    this.stale = false;
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

  private requireRequest(item: PendingReviewItem): { request: ReviewMergeRequest; service: RepositoryProvider; userId: number } {
    if (this.loading || this.stale) throw new Error('列表正在刷新或显示旧数据，请成功刷新后再操作 MR。');
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
        files.unshift(this.message('变更列表被 GitLab 截断，无法在此批准或合并，请在浏览器查看完整变更'));
        vscode.window.showWarningMessage('MR 变更列表不完整，Approve 和 Merge 已阻止，请在 GitLab 中完成审阅。');
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
    if (item.category !== 'review') throw new Error('请从“待我审批”选择需要批准的 MR。');
    const { request, service, userId } = this.requireRequest(item);
    return this.review.approve(request, service, userId);
  }

  async merge(item: PendingReviewItem): Promise<boolean> {
    if (item.category !== 'review') throw new Error('请从“待我审批”完成审阅后合并 MR。');
    const { request, service, userId } = this.requireRequest(item);
    return this.review.merge(request, service, userId);
  }

  async pickConflictedRequest(): Promise<PendingReviewItem | undefined> {
    const requests = new Map<string, PendingReviewItem>();
    for (const item of this.activeRequests) {
      if (item.request && hasMergeConflicts(item.request)) requests.set(`${item.request.project_id}:${item.request.iid}`, item);
    }
    if (!requests.size) {
      vscode.window.showInformationMessage('当前待办中没有已确认有冲突的 MR；若 GitLab 状态仍在计算，请刷新后重试。');
      return undefined;
    }
    const picked = await vscode.window.showQuickPick([...requests.values()].map(item => ({
      label: `!${item.request!.iid} ${item.request!.title}`,
      description: item.project?.path_with_namespace,
      detail: `${item.request!.source_branch} → ${item.request!.target_branch} · ${conflictCreationBlockReason(item.request!) ?? '可创建 conflict 分支'}`,
      item
    })), { title: '选择有冲突的待办 MR', ignoreFocusOut: true });
    return picked?.item;
  }

  async createConflict(item: PendingReviewItem, start?: Parameters<typeof createConflictFromMergeRequest>[3]): Promise<boolean> {
    const { request, service } = this.requireRequest(item);
    const reason = conflictCreationBlockReason(request);
    if (reason) {
      const action = await vscode.window.showInformationMessage(`MR !${request.iid}：${request.source_branch} → ${request.target_branch}\n${reason}`, '打开 MR');
      if (action === '打开 MR') await vscode.env.openExternal(vscode.Uri.parse(request.web_url));
      return false;
    }
    return createConflictFromMergeRequest(service, request, () => { this.requireRequest(item); }, start);
  }

  private message(label: string, retry = false): PendingReviewItem {
    const item = new PendingReviewItem('message', label);
    if (retry) {
      item.command = { command: 'gitlabMr.refreshPendingReviews', title: '刷新我的待办' };
      item.iconPath = new vscode.ThemeIcon('warning');
    }
    return item;
  }

  async refresh(prompt = true): Promise<void> {
    if (this.loading) return;
    const generation = ++this.generation;
    const viewName = this.includeAuthored ? '我的待办' : '待我审批';
    const previousRoots = this.roots;
    const previousChildren = new Map(this.children);
    const previousFiles = new Map(this.files);
    const previousRequests = new Map<string, PendingReviewItem>();
    const previousProjects = new Map<string, PendingReviewItem>();
    for (const item of [...previousRoots, ...[...previousChildren.values()].flat()]) {
      if (item.id && item.kind === 'request') previousRequests.set(item.id, item);
      if (item.id && item.kind === 'project') previousProjects.set(item.id, item);
    }
    const reusedRequests = new Set<PendingReviewItem>();
    const cachedRequests = new Set<PendingReviewItem>();
    const hadData = this.updatedAt !== undefined;
    this.loading = true;
    this.loaded = false;
    this.summary = hadData ? '正在更新（保留旧内容）...' : '正在加载...';
    if (!hadData) this.roots = [this.message(`正在加载${viewName}的 MR...`)];
    this.emitter.fire(undefined);
    try {
      const service = await this.connect(prompt);
      if (generation !== this.generation) return;
      if (!service) {
        this.children.clear(); this.clearReview(); this.updatedAt = undefined;
        this.roots = [this.message(`请配置 GitLab Token，点击加载${viewName}的 MR`, true)];
        this.summary = '未配置 Token';
        return;
      }
      if (!service.capabilities.todos) {
        this.children.clear(); this.clearReview(); this.updatedAt = undefined;
        this.roots = [this.message('GitHub 待办、审批与合并尚未接入，请在浏览器查看 PR。')];
        this.summary = 'GitHub 待办尚未接入';
        this.loaded = true;
        return;
      }
      const user = await service.getCurrentUser();
      if (!Number.isSafeInteger(user.id) || user.id <= 0) throw new Error('GitLab 当前用户响应缺少有效 ID。');
      const categories: TodoCategory[] = this.includeAuthored ? ['authored', 'review'] : ['review'];
      const lists = await Promise.allSettled(categories.map(category => category === 'authored'
        ? service.getAuthoredMergeRequests(user.id) : service.getReviewMergeRequests(user.id)));
      if (generation !== this.generation) return;
      if (lists.every(result => result.status === 'rejected')) {
        throw new Error(lists.map(result => result.status === 'rejected' ? String(result.reason) : '').join('; '));
      }
      const projects = new Map<number, Promise<ReviewProject>>();
      const states = new Map<number, Promise<ReviewMergeRequest>>();
      const groups = new Map<string, { category: TodoCategory; projectId: number; project?: ReviewProject; items: PendingReviewItem[] }>();
      const categoryErrors = new Map<TodoCategory, string>();
      const counts = { authored: 0, review: 0 };
      const tasks: Array<{ request: ReviewMergeRequest; category: TodoCategory }> = [];
      lists.forEach((result, index) => {
        const category = categories[index];
        if (result.status === 'rejected') categoryErrors.set(category, String(result.reason));
        else tasks.push(...result.value.map(request => ({ request, category })));
      });
      for (const { request, category } of tasks) {
        const groupKey = `${category}:${request.project_id}`;
        if (!groups.has(groupKey)) groups.set(groupKey, { category, projectId: request.project_id, items: [] });
      }
      let failed = categoryErrors.size;
      for (let offset = 0; offset < tasks.length; offset += 5) {
        if (generation !== this.generation) return;
        await Promise.all(tasks.slice(offset, offset + 5).map(async ({ request: listedRequest, category }) => {
          let request = listedRequest;
          const key = `${category}:${request.project_id}`;
          const group = () => groups.get(key) ?? { category, projectId: request.project_id, items: [] as PendingReviewItem[] };
          try {
            if (category === 'review' && await service.hasUserApprovedMergeRequest(request.project_id, request.iid, user.id)) return;
            let statusUnknown = false;
            // Older GitLab list endpoints may omit merge metadata. Keep the MR visible if its detail query fails.
            if (this.includeAuthored && request.has_conflicts === undefined && request.detailed_merge_status === undefined) {
              let state = states.get(request.id);
              if (!state) {
                state = service.getMergeRequestConflictState(request.project_id, request.iid);
                states.set(request.id, state);
              }
              try { request = { ...request, ...await state }; }
              catch (error) {
                statusUnknown = true;
                Logger.warn(`MR !${request.iid} 冲突状态查询失败`, error);
              }
            }
            if (request.state !== 'opened') return;
            let projectPromise = projects.get(request.project_id);
            if (!projectPromise) {
              projectPromise = service.getReviewProject(request.project_id);
              projects.set(request.project_id, projectPromise);
            }
            const project = await projectPromise;
            const currentGroup = group();
            currentGroup.project = project;
            const conflicted = hasMergeConflicts(request);
            const canCreate = conflicted && !conflictCreationBlockReason(request);
            let item = new PendingReviewItem('request', `!${request.iid} ${request.title}`,
              vscode.TreeItemCollapsibleState.Collapsed, project, request, project.id, undefined, category);
            item.id = `${category === 'review' ? 'pending-review' : 'authored-mr'}:${project.id}:${request.iid}`;
            item.contextValue = `${category === 'review' ? 'pendingReviewRequest' : 'authoredMergeRequest'}${conflicted ? '-conflict' : ''}${canCreate ? '-canCreateConflict' : ''}`;
            const author = request.author?.name || request.author?.username || '未知';
            const username = request.author?.username ? ` (@${request.author.username})` : '';
            const checking = ['checking', 'unchecked', 'preparing', 'approvals_syncing'].includes(request.detailed_merge_status ?? '');
            const status = conflicted ? '有冲突' : statusUnknown ? '冲突状态查询失败' : checking ? '合并状态计算中'
              : request.has_conflicts === undefined && request.detailed_merge_status === undefined ? '冲突状态未知' : undefined;
            item.description = [status, `${request.source_branch} → ${request.target_branch}`, `提交人: ${author}${username}`, request.draft ? '草稿' : undefined].filter(Boolean).join(' · ');
            const role = category === 'authored' ? '我提交的开放 MR' : '指定我为 Reviewer，尚未批准';
            const hint = conflicted ? `\n有代码冲突：${conflictCreationBlockReason(request) ?? conflictResolutionHint(request.source_branch, request.target_branch)}` : status ? `\n${status}，请刷新重试` : '';
            item.tooltip = `${request.title}\n${project.path_with_namespace}\nMR: !${request.iid} · ID: ${request.id}\n${request.source_branch} → ${request.target_branch}\nSource: ${request.source_branch}\nTarget: ${request.target_branch}\n提交人: ${author}${username}\n${role}${hint}`;
            item.iconPath = conflicted ? new vscode.ThemeIcon('git-pull-request', new vscode.ThemeColor('errorForeground')) : new vscode.ThemeIcon('git-pull-request');
            item.command = { command: 'gitlabMr.showPendingReviewChanges', title: '查看 MR 变更文件', arguments: [item] };
            const previous = previousRequests.get(item.id);
            if (previous && JSON.stringify([previous.request, previous.description, previous.contextValue]) ===
              JSON.stringify([request, item.description, item.contextValue])) {
              item = previous;
              reusedRequests.add(item);
            }
            currentGroup.items.push(item);
            groups.set(key, currentGroup);
            counts[category]++;
          } catch (error) {
            failed++;
            Logger.error(`查询${viewName} MR 失败: Project ${request.project_id} !${request.iid}`, error);
            const currentGroup = group();
            const retry = this.message(`!${request.iid} ${request.title} 查询失败，点击单独重试此项目: ${error instanceof Error ? error.message : String(error)}`);
            retry.id = `${category === 'review' ? 'pending-review' : 'authored-mr'}:${request.project_id}:${request.iid}:error`;
            retry.command = { command: 'gitlabMr.retryPendingProject', title: '重试此项目', arguments: [request.project_id] };
            currentGroup.items.push(retry);
            groups.set(key, currentGroup);
          }
        }));
      }
      if (generation !== this.generation) return;
      for (const [groupKey, group] of groups) if (!group.items.length) groups.delete(groupKey);
      this.children.clear();
      this.clearReview();
      this.service = service;
      this.userId = user.id;
      this.stale = false;
      this.updatedAt = new Date().toLocaleTimeString();
      this.roots = [];
      const categoryItems = new Map<TodoCategory, PendingReviewItem[]>();
      for (const category of categories) categoryItems.set(category, []);
      for (const [, group] of [...groups].sort(([, a], [, b]) =>
        (a.project?.path_with_namespace ?? '').localeCompare(b.project?.path_with_namespace ?? ''))) {
        const id = group.projectId;
        const projectItemId = `${group.category === 'review' ? 'pending-review-project' : 'authored-mr-project'}:${id}`;
        const oldProject = previousProjects.get(projectItemId);
        const item = new PendingReviewItem('project', group.project?.path_with_namespace ?? String(oldProject?.label ?? `Project ${id}（查询未完成）`),
          vscode.TreeItemCollapsibleState.Collapsed, group.project, undefined, id, undefined, group.category);
        item.id = projectItemId;
        if (group.items.some(child => child.kind === 'message')) {
          const failedIds = new Set(group.items.flatMap(child => child.kind === 'message' && child.id?.endsWith(':error')
            ? [child.id.slice(0, -':error'.length)] : []));
          for (const old of previousChildren.get(projectItemId) ?? []) {
            if (old.kind === 'request' && old.id && failedIds.has(old.id)) {
              group.items.push(old); cachedRequests.add(old);
            }
          }
        }
        const count = group.items.filter(child => child.kind === 'request').length;
        item.description = `${count} 个${group.category === 'review' ? '待审批' : '我提交的 MR'}${group.items.some(child => child.kind === 'message') ? ' · 部分查询失败' : ''}`;
        item.iconPath = new vscode.ThemeIcon('repo');
        categoryItems.get(group.category)!.push(item);
        this.children.set(item.id, group.items);
        for (const child of group.items) {
          if (child.kind === 'request' && !cachedRequests.has(child)) this.activeRequests.add(child);
          if (reusedRequests.has(child) || cachedRequests.has(child)) {
            const oldFiles = previousFiles.get(child);
            if (oldFiles) this.files.set(child, oldFiles);
          }
        }
      }
      if (this.includeAuthored) {
        for (const category of categories) {
          const item = new PendingReviewItem('category', category === 'authored' ? '我提交的 MR' : '待我审批',
            vscode.TreeItemCollapsibleState.Expanded, undefined, undefined, undefined, undefined, category);
          item.id = `todo-category:${category}`;
          item.description = `${counts[category]} 个开放 MR${categoryErrors.has(category) ? ' · 加载失败' : ''}`;
          item.iconPath = new vscode.ThemeIcon(category === 'authored' ? 'git-pull-request' : 'checklist');
          this.roots.push(item);
          const error = categoryErrors.get(category);
          const items = categoryItems.get(category)!;
          if (error) {
            const old = previousChildren.get(item.id) ?? [];
            this.children.set(item.id, [this.message(`加载失败，点击重试: ${error}`, true), ...old]);
            for (const project of old.filter(child => child.kind === 'project' && child.id)) {
              const children = previousChildren.get(project.id!);
              if (children) {
                this.children.set(project.id!, children);
                for (const child of children) {
                  const oldFiles = previousFiles.get(child);
                  if (oldFiles) this.files.set(child, oldFiles);
                }
              }
            }
          } else this.children.set(item.id, items.length ? items : [this.message(category === 'authored' ? '当前没有你提交的开放 MR' : '当前没有指定你为 Reviewer 且尚未批准的开放 MR')]);
        }
      } else this.roots = categoryItems.get('review')!;
      this.loaded = true;
      this.summary = this.includeAuthored ? `${counts.authored} 个我提交的 · ${counts.review} 个待审批${failed ? ` · ${failed} 个查询失败` : ''}`
        : `${counts.review} 个待审批 · ${groups.size} 个项目${failed ? ` · ${failed} 个查询失败` : ''}`;
      if (failed) {
        this.roots.unshift(this.message('部分 MR 查询失败，点击重试；结果不完整', true));
        if (prompt) vscode.window.showWarningMessage(`${viewName}列表部分查询失败，无法确认的 MR 不计入数量，请刷新重试。`);
      } else if (!this.includeAuthored && !counts.review) this.roots = [this.message('当前没有指定你为 Reviewer 且尚未批准的开放 MR')];
    } catch (error) {
      if (generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      Logger.error(`加载${viewName} MR 失败`, error);
      this.stale = hadData;
      this.summary = hadData ? `更新失败 · 旧数据 ${this.updatedAt}` : '加载失败';
      this.roots = hadData ? previousRoots : [this.message(`加载失败，点击重试: ${message}`, true)];
      if (hadData) this.summary += ` · ${message}`;
      if (prompt) vscode.window.showErrorMessage(`加载${viewName} MR 失败: ${message}`);
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

import axios from 'axios';
import { Audit, AuditApiError, type AuditContext } from '../audit';
import { debugLog } from '../diagnosticLogging';
import type { BaseKind, BranchReference } from '@gitlab-workbench/core';
import type { GitLabUser, GitLabBranchPage, GitLabPage, MergeRequestPayload, ReviewProject, ReviewMergeRequest, ReviewDetails, ReviewDiffRefs, ReviewDiffVersion } from '../types';
import type { ReleaseMergeRequest } from '../releaseReadiness';
import type { RepositoryProvider, ProviderConnection, ProviderProject, ProviderMergeRequestResult } from './repositoryProvider';

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuditApiError('GitHub 返回的数据格式无效');
  return value as Record<string, any>;
}
function sha(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/i.test(value)) throw new AuditApiError('GitHub 提交 SHA 无效');
  return value;
}
function positiveId(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new AuditApiError('GitHub ID 无效');
  return value as number;
}
function webUrl(value: unknown): string {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) throw new AuditApiError('GitHub 页面地址无效');
  return value;
}
function repoPath(value: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value) || value.split('/').some(part => part === '.' || part === '..')) throw new Error('GitHub 仓库需使用 owner/repository 格式');
  return value.split('/').map(encodeURIComponent).join('/');
}
function branchRefName(value: string): void {
  if (!value || value.startsWith('-') || value.includes('..') || value.includes('@{') || /[\x00-\x20\x7f~^:?*\[\\]/.test(value) || value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock'))) throw new Error('分支或 Tag 名称无效');
}

/** GitHub REST adapter. Review/merge writes are deliberately capability-gated until their own contracts are implemented. */
export class GitHubProvider implements RepositoryProvider {
  readonly kind = 'github' as const;
  readonly capabilities = { todos: false, review: false, merge: false, deleteBranch: false };
  private actor: Pick<AuditContext, 'userId' | 'username'> = {};
  private readonly projects = new Map<number, ReviewProject & ProviderProject>();
  private readonly users = new Map<number, GitLabUser>();
  private static readonly creating = new Set<string>();
  constructor(readonly connection: ProviderConnection, private readonly token: string, private readonly readSignal?: AbortSignal) {}
  get auditContext(): AuditContext { return { instance: this.connection.instanceUrl, ...this.actor, source: 'api' }; }

  private async request<T>(path: string, method = 'GET', body?: unknown): Promise<{ data: T; hasMore: boolean }> {
    let response;
    try {
      response = await axios.request({ url: `${this.connection.apiUrl}${path}`, method, data: body,
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'vscode-code-workbench' },
        signal: method === 'GET' ? this.readSignal : undefined,
        timeout: 20000, maxRedirects: 0, responseType: 'json', validateStatus: () => true });
    } catch { throw new AuditApiError('连接 GitHub 失败；写入结果可能尚未确认，请核对远程状态后再操作'); }
    debugLog(`[GitHub API] ${response.status} ${method} ${path}`);
    let data = response.data;
    if (typeof data === 'string') {
      try { data = JSON.parse(data); } catch { data = undefined; }
    }
    if (response.status < 200 || response.status >= 300) {
      const message = typeof data?.message === 'string' ? `: ${data.message.slice(0, 300)}` : '';
      throw new AuditApiError(`GitHub API 错误 [${response.status}]${message}`, response.status);
    }
    if (!data || typeof data !== 'object') throw new AuditApiError('GitHub 返回了无效响应；如为写操作请先核对远程结果');
    return { data: data as T, hasMore: /rel="next"/.test(String(response.headers.link ?? '')) };
  }

  private user(value: unknown): GitLabUser {
    const item = object(value);
    if (typeof item.login !== 'string' || !item.login) throw new AuditApiError('GitHub 用户名无效');
    const user = { id: positiveId(item.id), username: item.login, name: typeof item.name === 'string' ? item.name : item.login };
    this.users.set(user.id, user);
    return user;
  }
  async getCurrentUser(): Promise<GitLabUser> {
    this.actor = {};
    const user = this.user((await this.request('/user')).data);
    this.actor = { userId: user.id, username: user.username };
    return user;
  }
  private project(value: unknown): ReviewProject & ProviderProject {
    const item = object(value);
    if (typeof item.full_name !== 'string' || typeof item.name !== 'string' || typeof item.default_branch !== 'string') throw new AuditApiError('GitHub 仓库信息无效');
    repoPath(item.full_name);
    const project = { id: positiveId(item.id), name: item.name, path_with_namespace: item.full_name, web_url: webUrl(item.html_url), default_branch: item.default_branch };
    this.projects.set(project.id, project);
    return project;
  }
  async getProject(path: string): Promise<ReviewProject & ProviderProject> {
    return this.project((await this.request(`/repos/${repoPath(path)}`)).data);
  }
  async getReviewProject(id: number): Promise<ReviewProject> {
    positiveId(id);
    if (this.projects.has(id)) return this.projects.get(id)!;
    const project = this.project((await this.request(`/repositories/${id}`)).data);
    if (project.id !== id) throw new AuditApiError('GitHub 仓库 ID 不一致');
    return project;
  }
  private async path(project: string | number): Promise<string> {
    return `/repos/${repoPath(typeof project === 'string' ? project : (await this.getReviewProject(project)).path_with_namespace)}`;
  }
  async getProjectBranches(project: string | number, page = 1, search = ''): Promise<GitLabBranchPage> {
    const { data, hasMore } = await this.request<unknown[]>(`${await this.path(project)}/branches?per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new AuditApiError('GitHub 分支列表无效');
    const names = data.map(value => { const item = object(value); if (typeof item.name !== 'string') throw new AuditApiError('GitHub 分支名称无效'); return item.name; });
    // GitHub does not implement GitLab's branch search parameter. Filter each page, preserving its continuation.
    return { items: names.filter(name => matchesBranchSearch(name, search)), hasMore };
  }
  async getBranchCreationRefs(project: number, kind: BaseKind, page = 1, search = ''): Promise<{ items: BranchReference[]; hasMore: boolean }> {
    const { data, hasMore } = await this.request<unknown[]>(`${await this.path(project)}/${kind === 'tag' ? 'tags' : 'branches'}?per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new AuditApiError('GitHub 基线列表无效');
    const items = data.map(value => {
      const item = object(value);
      if (typeof item.name !== 'string') throw new AuditApiError('GitHub 基线名称无效');
      return { name: item.name, sha: sha(item.commit?.sha), title: '' };
    });
    return { items: items.filter(item => matchesBranchSearch(item.name, search)), hasMore };
  }
  async getBranchCreationRef(project: number, kind: BaseKind, name: string): Promise<BranchReference> {
    branchRefName(name);
    const base = await this.path(project);
    let commit;
    if (kind === 'branch') {
      const value = object((await this.request(`${base}/branches/${encodeURIComponent(name)}`)).data);
      if (value.name !== name) throw new AuditApiError('GitHub 基线名称不匹配');
      commit = object(value.commit);
    } else {
      const ref = object((await this.request(`${base}/git/ref/tags/${encodeURIComponent(name)}`)).data);
      if (ref.ref !== `refs/tags/${name}`) throw new AuditApiError('GitHub Tag 名称不匹配');
      let target = object(ref.object);
      for (let depth = 0; target.type === 'tag' && depth < 10; depth++) {
        const tag = object((await this.request(`${base}/git/tags/${sha(target.sha)}`)).data);
        target = object(tag.object);
      }
      if (target.type !== 'commit') throw new AuditApiError('GitHub Tag 未指向有效提交');
      const expected = sha(target.sha);
      commit = object((await this.request(`${base}/commits/${expected}`)).data);
      if (commit.sha !== expected) throw new AuditApiError('GitHub Tag 提交不匹配');
    }
    return { name, sha: sha(commit.sha), title: typeof commit.commit?.message === 'string' ? commit.commit.message.split('\n')[0] : '',
      committedDate: typeof commit.commit?.committer?.date === 'string' ? commit.commit.committer.date : undefined };
  }
  async createRemoteBranch(project: number, name: string, kind: BaseKind, base: string, expectedSha: string): Promise<{ ref: BranchReference; recovered: boolean }> {
    branchRefName(name); sha(expectedSha); positiveId(project);
    if (!/^(release|hotfix|conflict)\//.test(name) || !['branch', 'tag'].includes(kind)) throw new Error('分支创建参数无效');
    const key = `${this.connection.apiUrl}:${project}:${name}`;
    if (GitHubProvider.creating.has(key)) throw new Error('此分支正在创建，请等待结果');
    GitHubProvider.creating.add(key);
    try {
      return await Audit.sensitive('branch.create', 'high', { ...this.auditContext, project, branch: name, sourceBranch: base, baseSha: expectedSha }, async () => {
        const current = await this.getBranchCreationRef(project, kind, base);
        if (current.sha !== expectedSha) throw new Error('基线提交已变化，请重新预览确认');
        try { await this.getBranchCreationRef(project, 'branch', name); }
        catch (error) {
          if (!(error instanceof AuditApiError && error.status === 404)) throw error;
          try {
            const result = object((await this.request(`${await this.path(project)}/git/refs`, 'POST', { ref: `refs/heads/${name}`, sha: expectedSha })).data);
            if (result.ref !== `refs/heads/${name}` || result.object?.type !== 'commit' || result.object.sha !== expectedSha) throw new AuditApiError('创建响应不匹配，结果尚未确认');
            return { ref: { name, sha: expectedSha, title: current.title }, recovered: false };
          } catch (error) {
            if (!(error instanceof AuditApiError) || (error.status && error.status < 500 && error.status !== 408)) throw error;
            try {
              const ref = await this.getBranchCreationRef(project, 'branch', name);
              if (ref.sha === expectedSha) return { ref, recovered: true };
            } catch { /* Never repeat an uncertain POST. */ }
            throw new AuditApiError('GitHub 分支创建结果尚未确认，请查询同名分支后再操作，不要重复提交');
          }
        }
        throw new Error('同名分支已存在，请更换名称');
      });
    } finally { GitHubProvider.creating.delete(key); }
  }
  async getMergeRequestsTargetingBranch(project: string | number, target: string, page = 1): Promise<GitLabPage<ReleaseMergeRequest>> {
    const query = new URLSearchParams({ state: 'all', base: target, sort: 'updated', direction: 'desc', per_page: '100', page: String(page) });
    const { data, hasMore } = await this.request<unknown[]>(`${await this.path(project)}/pulls?${query}`);
    if (!Array.isArray(data)) throw new AuditApiError('GitHub PR 列表无效');
    return { items: data.map(value => {
      const item = object(value);
      if (typeof item.head?.ref !== 'string' || typeof item.base?.ref !== 'string' || typeof item.title !== 'string' || !['open', 'closed'].includes(item.state)) throw new AuditApiError('GitHub PR 数据无效');
      return { iid: positiveId(item.number), title: item.title, web_url: webUrl(item.html_url), source_branch: item.head.ref, target_branch: item.base.ref,
        state: item.merged_at ? 'merged' : item.state === 'open' ? 'opened' : 'closed', updated_at: item.updated_at };
    }), hasMore };
  }
  async resolveReviewerIds(usernames: string[]): Promise<{ resolvedIds: number[]; notFoundUsers: string[] }> {
    const resolvedIds: number[] = []; const notFoundUsers: string[] = [];
    for (const name of usernames) {
      const login = name.trim().replace(/^@/, '');
      if (!/^[A-Za-z0-9-]+$/.test(login)) throw new Error('GitHub Reviewer 需填写有效用户名');
      try {
        const user = this.user((await this.request(`/users/${encodeURIComponent(login)}`)).data);
        if (user.username.toLowerCase() !== login.toLowerCase()) throw new Error('GitHub Reviewer 用户名不匹配');
        if (!resolvedIds.includes(user.id)) resolvedIds.push(user.id);
      } catch (error) {
        if (error instanceof AuditApiError && error.status === 404) notFoundUsers.push(login);
        else throw error;
      }
    }
    return { resolvedIds, notFoundUsers };
  }
  async createMergeRequest(payload: MergeRequestPayload): Promise<ProviderMergeRequestResult> {
    branchRefName(payload.sourceBranch); branchRefName(payload.targetBranch);
    if (!payload.title.trim() || payload.sourceBranch === payload.targetBranch) throw new Error('PR 标题或源/目标无效');
    const reviewers = (payload.reviewerIds ?? []).map(id => {
      const user = this.users.get(id); if (!user) throw new Error('请先解析 GitHub Reviewer 用户名，再创建 PR'); return user;
    });
    const path = await this.path(payload.projectId);
    const result = await Audit.sensitive('mr.create', 'sensitive', { ...this.auditContext, project: payload.projectId,
      sourceBranch: payload.sourceBranch, targetBranch: payload.targetBranch, reviewers: payload.reviewerIds }, async () => {
      const value = object((await this.request(`${path}/pulls`, 'POST', { head: payload.sourceBranch, base: payload.targetBranch, title: payload.title, body: payload.description })).data);
      if (value.head?.ref !== payload.sourceBranch || value.base?.ref !== payload.targetBranch || typeof value.title !== 'string') throw new AuditApiError('GitHub 创建 PR 响应不匹配，请核对远程结果，不要重复提交');
      return { id: positiveId(value.id), iid: positiveId(value.number), title: value.title, web_url: webUrl(value.html_url), state: 'opened', reviewers: [] as GitLabUser[], warnings: [] as string[] };
    }, value => ({ mr: value.iid }));
    if (reviewers.length) {
      try {
        await Audit.sensitive('mr.assign-reviewers', 'sensitive', { ...this.auditContext, project: payload.projectId, mr: result.iid, reviewers: payload.reviewerIds }, async () => {
          const response = object((await this.request(`${path}/pulls/${result.iid}/requested_reviewers`, 'POST', { reviewers: reviewers.map(user => user.username) })).data);
          if (!Array.isArray(response.requested_reviewers)) throw new Error('GitHub 未确认 Reviewer');
          result.reviewers = response.requested_reviewers.map((user: unknown) => this.user(user));
          if (reviewers.some(user => !result.reviewers.some(actual => actual.id === user.id))) throw new Error('GitHub 未确认全部 Reviewer');
        });
      } catch {
        result.warnings.push(`PR #${result.iid} 已创建，但 Reviewer 分配未完成或结果未确认，请打开 PR 核对，不要重复创建。`);
      }
    }
    return result;
  }
  private unsupported(feature: string): never { throw new Error(`GitHub 的${feature}将在后续阶段接入，请先在浏览器中操作。`); }
  async getGitLabVersion(): Promise<{ version: string }> { return { version: 'GitHub REST 2022-11-28' }; }
  async deleteBranch(_p: string | number, _b: string, _s: string, _m: string): Promise<void> { this.unsupported('远程分支删除'); }
  async getReviewMergeRequests(_u: number): Promise<ReviewMergeRequest[]> { return this.unsupported('待办'); }
  async getAuthoredMergeRequests(_u: number): Promise<ReviewMergeRequest[]> { return this.unsupported('待办'); }
  async getMergeRequestConflictState(_p: number, _i: number): Promise<ReviewMergeRequest> { return this.unsupported('冲突状态查询'); }
  async hasUserApprovedMergeRequest(_p: number, _i: number, _u: number): Promise<boolean> { return this.unsupported('审批状态查询'); }
  async getReviewDetails(_p: number, _i: number, _r?: boolean): Promise<ReviewDetails> { return this.unsupported('审阅'); }
  async getReviewDiffVersion(_p: number, _i: number, _r: ReviewDiffRefs): Promise<ReviewDiffVersion> { return this.unsupported('PR Diff'); }
  async getReviewFileContent(_p: number, _f: string, _s: string): Promise<string> { return this.unsupported('PR 文件'); }
  async approveReview(_p: number, _i: number, _s: string, _u: number): Promise<void> { this.unsupported('审批'); }
  async mergeReview(_p: number, _i: number, _s: string, _u: number): Promise<void> { this.unsupported('合并'); }
}

/** GitLab search uses optional ^/$ anchors; treat the interior as literal text. */
export function matchesBranchSearch(name: string, search: string): boolean {
  const start = search.startsWith('^'); const end = search.endsWith('$');
  const term = search.slice(start ? 1 : 0, end ? -1 : undefined).toLowerCase();
  const value = name.toLowerCase();
  if (start && end) return value === term;
  if (start) return value.startsWith(term);
  if (end) return value.endsWith(term);
  return value.includes(term);
}

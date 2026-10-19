import axios from 'axios';
import * as https from 'https';
import { URL } from 'url';
import { GitLabBranchPage, GitLabPage, GitLabUser, MergeRequestPayload, MergeRequestResult, ReviewDetails, ReviewDiffRefs, ReviewDiffVersion, ReviewMergeRequest, ReviewProject } from './types';
import { Logger } from './logger';
import { ReleaseMergeRequest } from './releaseReadiness';

interface GitLabProject {
  id: number;
  name: string;
  web_url: string;
  path_with_namespace?: string;
}

interface GitLabBranch {
  name: string;
  protected: boolean;
  default: boolean;
  commit: { id: string };
}

export class GitLabService {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(instanceUrl: string, token: string) {
    // 去除末尾斜杠
    const sanitized = instanceUrl.replace(/\/+$/, '');
    this.baseUrl = `${sanitized}/api/v4`;
    this.token = token;
    Logger.info(`GitLabService 初始化完成，API Endpoint: ${this.baseUrl}`);
  }

  /**
   * 通用 HTTP 请求方法，内置处理私有部署/证书容错
   */
  private request(path: string, options: { method: 'DELETE' }): Promise<void>;
  private request<T>(path: string, options?: { method?: string; body?: any }): Promise<T>;
  private async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T | void> {
    const fullUrl = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const urlObj = new URL(fullUrl);
    const isHttps = urlObj.protocol === 'https:';
    const method = options.method || 'GET';

    Logger.info(`[GitLab API 发送] ${method} ${fullUrl}`);
    if (options.body) {
      Logger.info(`[GitLab API 请求参数]`, options.body);
    }

    let response;
    try {
      response = await axios.request<string>({
        url: fullUrl,
        method,
        data: options.body,
        headers: {
          'PRIVATE-TOKEN': this.token,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          'User-Agent': 'vscode-gitlab-auto-mr'
        },
        httpsAgent: isHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined,
        responseType: 'text',
        transformResponse: [(data: string) => data],
        validateStatus: () => true
      });
    } catch (error) {
      Logger.error(`[GitLab 网络错误] 无法连接到 ${fullUrl}`, error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`连接 GitLab 失败: ${message}`);
    }

    const responseBody = typeof response.data === 'string'
      ? response.data
      : JSON.stringify(response.data ?? '');
    const status = response.status;
    Logger.info(
      `[GitLab API 响应] status=${status}, content-type=${response.headers['content-type'] ?? 'unknown'}, content-length=${response.headers['content-length'] ?? 'unknown'}, body-bytes=${Buffer.byteLength(responseBody, 'utf8')}`
    );

    if (status >= 200 && status < 300) {
      Logger.info(`[GitLab API 成功 ${status}] ${method} ${path}`);
      if (method === 'DELETE' && status === 204) {
        return;
      }
      if (!responseBody.trim()) {
        throw new Error(`GitLab API 返回空响应 [${status}]: ${method} ${path}`);
      }
      try {
        return JSON.parse(responseBody) as T;
      } catch {
        throw new Error(`GitLab API 返回无效 JSON [${status}]: ${method} ${path}`);
      }
    }

    let errorMsg = `GitLab API 错误 [${status}]`;
    try {
      const parsed = JSON.parse(responseBody);
      if (parsed.message) {
        errorMsg += `: ${typeof parsed.message === 'string' ? parsed.message : JSON.stringify(parsed.message)}`;
      } else if (parsed.error) {
        errorMsg += `: ${parsed.error}`;
      }
    } catch {
      errorMsg += `: ${responseBody}`;
    }
    Logger.error(`[GitLab API 失败 ${status}] ${method} ${path}\n响应体: ${responseBody}`);
    throw new Error(errorMsg);
  }

  /**
   * 验证 Token 并获取当前登录用户信息
   */
  async getCurrentUser(): Promise<GitLabUser> {
    return this.request<GitLabUser>('/user');
  }

  async getReviewMergeRequests(userId: number): Promise<ReviewMergeRequest[]> {
    const query = new URLSearchParams({
      scope: 'all', state: 'opened', reviewer_id: String(userId),
      order_by: 'updated_at', sort: 'desc'
    });
    const requests = await this.getAllPages<ReviewMergeRequest>(`/merge_requests?${query}`);
    if (!requests.every(request =>
      Number.isSafeInteger(request.id) && Number.isSafeInteger(request.iid) &&
      Number.isSafeInteger(request.project_id) && typeof request.title === 'string' &&
      typeof request.web_url === 'string' && /^https?:\/\//i.test(request.web_url)
    )) {
      throw new Error('GitLab 待审批 MR 列表格式无效。');
    }
    return [...new Map(requests.filter(request => request.state === 'opened')
      .map(request => [request.id, request])).values()];
  }

  async hasUserApprovedMergeRequest(projectId: number, iid: number, userId: number): Promise<boolean> {
    const response = await this.request<{ approved_by?: Array<{ user?: { id?: number } }> }>(
      `/projects/${projectId}/merge_requests/${iid}/approvals`
    );
    if (!Array.isArray(response?.approved_by) ||
      !response.approved_by.every(approval => Number.isSafeInteger(approval.user?.id))) {
      throw new Error(`MR !${iid} 审批状态响应缺少有效 approved_by，无法确认是否待审批。`);
    }
    return response.approved_by.some(approval => approval.user?.id === userId);
  }

  async getReviewProject(projectId: number): Promise<ReviewProject> {
    const project = await this.request<ReviewProject>(`/projects/${projectId}`);
    if (project?.id !== projectId || typeof project.path_with_namespace !== 'string' ||
      !project.path_with_namespace.trim()) {
      throw new Error(`项目 ${projectId} 详情响应无效。`);
    }
    return project;
  }

  async getReviewDetails(projectId: number, iid: number): Promise<ReviewDetails> {
    const details = await this.request<ReviewDetails>(`/projects/${projectId}/merge_requests/${iid}`);
    const validSha = (sha: unknown) => typeof sha === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha);
    if (details?.project_id !== projectId || details.iid !== iid ||
      !validSha(details.sha) || !validSha(details.diff_refs?.head_sha) ||
      !validSha(details.diff_refs?.base_sha) || !validSha(details.diff_refs?.start_sha) ||
      details.sha !== details.diff_refs.head_sha ||
      !Number.isSafeInteger(details.source_project_id) || details.source_project_id <= 0 ||
      details.target_project_id !== projectId ||
      !Array.isArray(details.reviewers) || !details.reviewers.every(user => Number.isSafeInteger(user?.id))) {
      throw new Error(`MR !${iid} 代码版本尚未就绪或项目/Reviewer 信息无效，请刷新后重试。`);
    }
    return details;
  }

  async getReviewDiffVersion(projectId: number, iid: number, refs: ReviewDiffRefs): Promise<ReviewDiffVersion> {
    const path = `/projects/${projectId}/merge_requests/${iid}/versions`;
    const versions = await this.getAllPages<Omit<ReviewDiffVersion, 'diffs'>>(path);
    const match = versions.find(version => version.head_commit_sha === refs.head_sha &&
      version.base_commit_sha === refs.base_sha && version.start_commit_sha === refs.start_sha);
    if (!match || !Number.isSafeInteger(match.id)) {
      throw new Error(`MR !${iid} 没有匹配的 Diff 版本，请稍后刷新重试。`);
    }
    const version = await this.request<ReviewDiffVersion>(`${path}/${match.id}`);
    if (version?.id !== match.id || version.head_commit_sha !== refs.head_sha ||
      version.base_commit_sha !== refs.base_sha || version.start_commit_sha !== refs.start_sha ||
      (version.state !== undefined && version.state !== 'collected') || !Array.isArray(version.diffs) ||
      !version.diffs.every(file => typeof file.old_path === 'string' && file.old_path.length > 0 &&
        typeof file.new_path === 'string' && file.new_path.length > 0 &&
        typeof file.new_file === 'boolean' && typeof file.deleted_file === 'boolean' &&
        typeof file.renamed_file === 'boolean')) {
      throw new Error(`MR !${iid} Diff 版本无效或尚未生成完成。`);
    }
    return version;
  }

  async getReviewFileContent(projectId: number, filePath: string, sha: string): Promise<string> {
    const query = new URLSearchParams({ ref: sha });
    const file = await this.request<{ encoding?: string; content?: string }>(
      `/projects/${projectId}/repository/files/${encodeURIComponent(filePath)}?${query}`
    );
    if (file?.encoding !== 'base64' || typeof file.content !== 'string') {
      throw new Error(`无法读取文件内容: ${filePath}`);
    }
    const encoded = file.content.replace(/\s/g, '');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) {
      throw new Error(`文件 ${filePath} 的 Base64 内容无效，无法可靠展示 Diff。`);
    }
    if (bytes.includes(0)) {
      throw new Error(`文件 ${filePath} 为二进制文件，请在 GitLab 中查看。`);
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`文件 ${filePath} 不是有效 UTF-8 文本，请在 GitLab 中查看。`);
    }
  }

  async approveReview(projectId: number, iid: number, sha: string, userId: number): Promise<void> {
    const result = await this.request<{ approved_by?: Array<{ user?: { id?: number } }> }>(
      `/projects/${projectId}/merge_requests/${iid}/approve`,
      { method: 'POST', body: { sha } }
    );
    if (!Array.isArray(result?.approved_by) || !result.approved_by.some(entry => entry.user?.id === userId)) {
      throw new Error(`GitLab 未确认你对 MR !${iid} 的批准，请刷新审批状态，不要直接重复提交。`);
    }
  }

  async getGitLabVersion(): Promise<{ version: string; revision?: string }> {
    const version = await this.request<unknown>('/version');
    if (typeof version !== 'object' || version === null || typeof (version as { version?: unknown }).version !== 'string') {
      throw new Error('GitLab 版本接口没有返回有效版本信息。');
    }
    return version as { version: string; revision?: string };
  }

  /**
   * 根据项目路径查询项目详情（包括项目 ID）
   */
  async getProject(projectPath: string): Promise<{ id: number; name: string; web_url: string }> {
    const encoded = encodeURIComponent(projectPath);
    let directResponse: unknown;
    let directLookupError: Error | undefined;
    try {
      directResponse = await this.request<unknown>(`/projects/${encoded}`);
      if (typeof directResponse === 'object' && directResponse !== null && !Array.isArray(directResponse)) {
        const project = directResponse as Partial<GitLabProject>;
        if (Number.isSafeInteger(project.id) && project.id! > 0) {
          return project as GitLabProject;
        }
      }
      const responseShape = typeof directResponse === 'string'
        ? `string(length=${directResponse.length})`
        : typeof directResponse === 'object' && directResponse !== null
          ? `object(keys=${Object.keys(directResponse).join(',')})`
          : typeof directResponse;
      Logger.warn(`项目详情响应不含有效 ID (${responseShape})，尝试搜索可见项目: ${projectPath}`);
    } catch (error) {
      directLookupError = error instanceof Error ? error : new Error(String(error));
      Logger.warn(`项目详情查询失败，尝试搜索可见项目: ${projectPath}`, directLookupError.message);
    }

    const projectName = projectPath.split('/').pop() || projectPath;
    const query = new URLSearchParams({ search: projectName, simple: 'true' }).toString();
    try {
      const projects = await this.getAllPages<GitLabProject>(`/projects?${query}`);
      const match = projects.find(project =>
        project.path_with_namespace?.toLowerCase() === projectPath.toLowerCase() &&
        Number.isSafeInteger(project.id) && project.id > 0
      );
      if (match) {
        Logger.info(`通过项目搜索获取项目 ID: ${match.id}`);
        return match;
      }
      throw new Error(`搜索结果中没有路径完全匹配的可见项目: ${projectPath}`);
    } catch (error) {
      const searchError = error instanceof Error ? error.message : String(error);
      throw new Error(
        `无法获取项目 ID (${projectPath})。详情接口: ${directLookupError?.message ?? '响应缺少有效 ID'}；项目搜索: ${searchError}`
      );
    }
  }

  private async getAllPages<T>(path: string): Promise<T[]> {
    const results: T[] = [];
    for (let page = 1; ; page++) {
      const separator = path.includes('?') ? '&' : '?';
      const pageResults = await this.request<T[]>(`${path}${separator}per_page=100&page=${page}`);
      results.push(...pageResults);
      if (pageResults.length < 100) {
        return results;
      }
    }
  }

  async getProjectBranches(projectId: string | number, page = 1, search = ''): Promise<GitLabBranchPage> {
    const encodedId = encodeURIComponent(String(projectId));
    const query = new URLSearchParams({ per_page: '100', page: String(page) });
    if (search) {
      query.set('search', search);
    }
    const branches = await this.request<Array<{
      name: string;
      commit?: { author_name?: string; committed_date?: string };
    }>>(
      `/projects/${encodedId}/repository/branches?${query}`
    );
    const latestCommits = branches.map(branch => ({
      branch: branch.name,
      authorName: typeof branch.commit?.author_name === 'string' ? branch.commit.author_name.trim() : '',
      committedDate: typeof branch.commit?.committed_date === 'string' ? branch.commit.committed_date : ''
    }));
    const incomplete = latestCommits.filter(commit =>
      !commit.authorName || !commit.committedDate || !Number.isFinite(Date.parse(commit.committedDate))
    );
    if (incomplete.length > 0) {
      Logger.warn(`GitLab 分支最新提交信息缺失或无效: ${incomplete.map(commit => commit.branch).join(', ')}`);
    }
    return { items: branches.map(branch => branch.name), hasMore: branches.length === 100, latestCommits };
  }

  async deleteBranch(
    projectId: string | number,
    branch: string,
    expectedCommit: string,
    expectedMainCommit: string
  ): Promise<void> {
    if (!branch || branch === 'main') {
      throw new Error('禁止删除 main 或无效分支。');
    }
    const basePath = `/projects/${encodeURIComponent(String(projectId))}/repository/branches`;
    const branchPath = `${basePath}/${encodeURIComponent(branch)}`;
    const [current, main] = await Promise.all([
      this.request<GitLabBranch>(branchPath),
      this.request<GitLabBranch>(`${basePath}/main`)
    ]);
    if (current?.name !== branch || typeof current.protected !== 'boolean' ||
      typeof current.default !== 'boolean' || main?.name !== 'main' ||
      !expectedCommit || !expectedMainCommit) {
      throw new Error('GitLab 分支信息无效，无法安全删除。');
    }
    if (current.protected || current.default) {
      throw new Error('禁止删除默认分支或受保护分支。');
    }
    if (current.commit?.id !== expectedCommit || main.commit?.id !== expectedMainCommit) {
      throw new Error('分支或 main 在检查期间已更新，已取消删除，请刷新后重试。');
    }
    await this.request(branchPath, { method: 'DELETE' });
  }

  async getMergeRequestsTargetingBranch(
    projectId: string | number,
    targetBranch: string,
    page = 1
  ): Promise<GitLabPage<ReleaseMergeRequest>> {
    const encodedId = encodeURIComponent(String(projectId));
    const query = new URLSearchParams({
      state: 'all',
      target_branch: targetBranch,
      order_by: 'updated_at',
      sort: 'desc',
      per_page: '100',
      page: String(page)
    }).toString();
    const requests = await this.request<ReleaseMergeRequest[]>(
      `/projects/${encodedId}/merge_requests?${query}`
    );
    return { items: requests, hasMore: requests.length === 100 };
  }

  /**
   * 根据用户名精确查询用户信息
   */
  async getUserByUsername(username: string): Promise<GitLabUser | undefined> {
    const trimmed = username.trim().replace(/^@/, '').trim();
    const users = await this.request<GitLabUser[]>(`/users?username=${encodeURIComponent(trimmed)}`);
    const match = users.find(u => u.username.toLowerCase() === trimmed.toLowerCase());
    Logger.info('[Reviewer 账号解析]', {
      username: trimmed,
      candidates: users.map(user => ({ id: user.id, username: user.username, state: user.state })),
      matchedId: match?.id
    });
    return match;
  }

  /**
   * 将用户名数组解析为对应的 GitLab User ID 列表
   */
  async resolveReviewerIds(usernames: string[]): Promise<{ resolvedIds: number[]; notFoundUsers: string[] }> {
    const resolvedIds: number[] = [];
    const notFoundUsers: string[] = [];

    for (const name of usernames) {
      const cleanName = name.trim().replace(/^@/, '').trim();
      if (!cleanName) {
        throw new Error('gitlabMr.defaultReviewers 包含空用户名，请使用 GitLab 用户名。');
      }
      try {
        const user = await this.getUserByUsername(cleanName);
        if (user && Number.isSafeInteger(user.id) && user.id > 0) {
          if (!resolvedIds.includes(user.id)) {
            resolvedIds.push(user.id);
          }
        } else {
          notFoundUsers.push(cleanName);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`查询 Reviewer ${cleanName} 失败: ${message}`);
      }
    }

    return { resolvedIds, notFoundUsers };
  }

  /**
   * 创建 Merge Request
   */
  async createMergeRequest(payload: MergeRequestPayload): Promise<MergeRequestResult> {
    const projectIdEncoded = typeof payload.projectId === 'string'
      ? encodeURIComponent(payload.projectId)
      : payload.projectId;

    const body: Record<string, any> = {
      source_branch: payload.sourceBranch,
      target_branch: payload.targetBranch,
      title: payload.title,
      description: payload.description,
      remove_source_branch: payload.removeSourceBranch ?? true,
      squash: payload.squash ?? false
    };

    if (payload.reviewerIds && payload.reviewerIds.length > 0) {
      body.reviewer_ids = payload.reviewerIds;
    }

    Logger.info('[Reviewer 创建请求]', {
      projectId: payload.projectId,
      sourceBranch: payload.sourceBranch,
      targetBranch: payload.targetBranch,
      reviewer_ids: payload.reviewerIds ?? []
    });
    const mr = await this.request<MergeRequestResult>(`/projects/${projectIdEncoded}/merge_requests`, {
      method: 'POST',
      body
    });
    Logger.info('[Reviewer 创建响应]', {
      iid: mr.iid,
      web_url: mr.web_url,
      reviewersFieldPresent: Array.isArray(mr.reviewers),
      reviewers: mr.reviewers?.map(user => ({ id: user.id, username: user.username, state: user.state }))
    });
    return mr;
  }
}

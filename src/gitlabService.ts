import axios from 'axios';
import * as https from 'https';
import { URL } from 'url';
import { GitLabPage, GitLabUser, MergeRequestPayload, MergeRequestResult } from './types';
import { Logger } from './logger';
import { ReleaseMergeRequest } from './releaseReadiness';

interface GitLabProject {
  id: number;
  name: string;
  web_url: string;
  path_with_namespace?: string;
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
  private async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
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

  async getProjectBranches(projectId: string | number, page = 1, search = ''): Promise<GitLabPage<string>> {
    const encodedId = encodeURIComponent(String(projectId));
    const query = new URLSearchParams({ per_page: '100', page: String(page) });
    if (search) {
      query.set('search', search);
    }
    const branches = await this.request<Array<{ name: string }>>(
      `/projects/${encodedId}/repository/branches?${query}`
    );
    return { items: branches.map(branch => branch.name), hasMore: branches.length === 100 };
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

import type { GitLabBranchPage, GitLabPage, ReleaseMergeRequest, WebGitLabUser, WebProject, WebProjectPage } from '@gitlab-workbench/core';

export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export interface OAuthTokens { access_token: string; refresh_token?: string; expires_in?: number }
export class WebGitLabClient {
  constructor(readonly baseUrl: string, private readonly token: string) {}
  private async request(path: string): Promise<{ data: unknown; headers: Headers }> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/api/v4${path}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(20000)
      });
    } catch { throw new ApiError(502, '无法连接 GitLab，请检查网络、实例地址和证书信任配置'); }
    if (!response.ok) {
      if (response.status === 401) throw new ApiError(401, 'GitLab 授权已失效，请重新登录');
      if (response.status === 403) throw new ApiError(403, '当前 GitLab 账号没有此操作权限');
      if (response.status === 404) throw new ApiError(404, 'GitLab 项目或分支不存在，或当前账号无权访问');
      if (response.status === 429) throw new ApiError(429, 'GitLab 请求过于频繁，请稍后重试');
      throw new ApiError(502, 'GitLab 服务返回异常，请稍后重试');
    }
    try { return { data: await response.json(), headers: response.headers }; }
    catch { throw new ApiError(502, 'GitLab 返回了无效的数据'); }
  }
  async user(): Promise<WebGitLabUser> {
    const { data } = await this.request('/user');
    const user = data as WebGitLabUser;
    if (!Number.isSafeInteger(user?.id) || typeof user.name !== 'string' || typeof user.username !== 'string') throw new ApiError(502, 'GitLab 用户数据无效');
    return { id: user.id, name: user.name, username: user.username };
  }
  async projects(page: number, search: string): Promise<WebProjectPage> {
    const query = new URLSearchParams({ membership: 'true', simple: 'true', order_by: 'last_activity_at', per_page: '50', page: String(page), search });
    const { data, headers } = await this.request(`/projects?${query}`);
    if (!Array.isArray(data)) throw new ApiError(502, 'GitLab 项目列表无效');
    return { items: data.map(project), hasMore: hasMore(headers, page, data.length, 50) };
  }
  async project(id: number): Promise<WebProject & { http_url_to_repo: string }> {
    const { data } = await this.request(`/projects/${id}`);
    const result = project(data);
    const url = (data as { http_url_to_repo?: unknown }).http_url_to_repo;
    if (typeof url !== 'string') throw new ApiError(502, 'GitLab 仓库地址无效');
    return { ...result, http_url_to_repo: url };
  }
  async branches(id: number, page: number): Promise<GitLabBranchPage> {
    const { data, headers } = await this.request(`/projects/${id}/repository/branches?per_page=100&page=${page}`);
    if (!Array.isArray(data) || data.some(branch => typeof branch?.name !== 'string')) throw new ApiError(502, 'GitLab 分支列表无效');
    return {
      items: data.map(branch => branch.name), hasMore: hasMore(headers, page, data.length, 100),
      latestCommits: data.map(branch => ({ branch: branch.name, authorName: typeof branch.commit?.author_name === 'string' ? branch.commit.author_name : '', committedDate: typeof branch.commit?.committed_date === 'string' ? branch.commit.committed_date : '' }))
    };
  }
  async requests(id: number, branch: string, page: number): Promise<GitLabPage<ReleaseMergeRequest>> {
    const query = new URLSearchParams({ state: 'all', target_branch: branch, order_by: 'updated_at', sort: 'desc', per_page: '100', page: String(page) });
    const { data, headers } = await this.request(`/projects/${id}/merge_requests?${query}`);
    if (!Array.isArray(data) || data.some(item => !Number.isSafeInteger(item?.iid) || ['source_branch', 'target_branch', 'state', 'title', 'web_url'].some(key => typeof item[key] !== 'string'))) throw new ApiError(502, 'GitLab MR 列表无效');
    return { items: data.map(item => ({ source_branch: item.source_branch, target_branch: item.target_branch, state: item.state, iid: item.iid, title: item.title, web_url: item.web_url, updated_at: typeof item.updated_at === 'string' ? item.updated_at : undefined })), hasMore: hasMore(headers, page, data.length, 100) };
  }
}
function project(value: unknown): WebProject {
  const item = value as WebProject;
  if (!Number.isSafeInteger(item?.id) || ['name', 'path_with_namespace', 'web_url'].some(key => typeof (item as unknown as Record<string, unknown>)[key] !== 'string')) throw new ApiError(502, 'GitLab 项目数据无效');
  return { id: item.id, name: item.name, path_with_namespace: item.path_with_namespace, web_url: item.web_url };
}
function hasMore(headers: Headers, page: number, count: number, size: number): boolean {
  const next = headers.get('x-next-page');
  const more = next === null ? count === size : next !== '';
  if (next && Number(next) !== page + 1) throw new ApiError(502, 'GitLab 分页信息无效');
  if (more && page >= 500) throw new ApiError(422, '项目数据超过单次加载上限，请缩小项目范围');
  return more;
}

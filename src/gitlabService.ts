import * as https from 'https';
import * as http from 'http';
import { URL } from 'url';
import { GitLabUser, MergeRequestPayload, MergeRequestResult } from './types';

export class GitLabService {
  private readonly baseUrl: string;
  private readonly token: string;

  constructor(instanceUrl: string, token: string) {
    // 去除末尾斜杠
    const sanitized = instanceUrl.replace(/\/+$/, '');
    this.baseUrl = `${sanitized}/api/v4`;
    this.token = token;
  }

  /**
   * 通用 HTTP 请求方法，内置处理私有部署/证书容错
   */
  private async request<T>(path: string, options: { method?: string; body?: any } = {}): Promise<T> {
    const fullUrl = `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const urlObj = new URL(fullUrl);
    const isHttps = urlObj.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    const postData = options.body ? JSON.stringify(options.body) : undefined;

    const requestOptions: https.RequestOptions = {
      protocol: urlObj.protocol,
      hostname: urlObj.hostname,
      port: urlObj.port || (isHttps ? 443 : 80),
      path: `${urlObj.pathname}${urlObj.search}`,
      method: options.method || 'GET',
      headers: {
        'PRIVATE-TOKEN': this.token,
        'Content-Type': 'application/json',
        'User-Agent': 'vscode-gitlab-auto-mr'
      },
      // 私有内网有时会有自签证书，为了避免内网阻断设置 rejectUnauthorized 为 false
      rejectUnauthorized: false
    };

    if (postData) {
      (requestOptions.headers as any)['Content-Length'] = Buffer.byteLength(postData);
    }

    return new Promise<T>((resolve, reject) => {
      const req = httpModule.request(requestOptions, res => {
        let responseBody = '';
        res.setEncoding('utf8');

        res.on('data', chunk => {
          responseBody += chunk;
        });

        res.on('end', () => {
          const status = res.statusCode || 0;
          if (status >= 200 && status < 300) {
            try {
              const data = responseBody ? JSON.parse(responseBody) : {};
              resolve(data as T);
            } catch (err) {
              resolve(responseBody as unknown as T);
            }
          } else {
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
            reject(new Error(errorMsg));
          }
        });
      });

      req.on('error', err => {
        reject(new Error(`连接 GitLab 失败: ${err.message}`));
      });

      if (postData) {
        req.write(postData);
      }
      req.end();
    });
  }

  /**
   * 验证 Token 并获取当前登录用户信息
   */
  async getCurrentUser(): Promise<GitLabUser> {
    return this.request<GitLabUser>('/user');
  }

  /**
   * 根据项目路径查询项目详情（包括项目 ID）
   */
  async getProject(projectPath: string): Promise<{ id: number; name: string; web_url: string }> {
    const encoded = encodeURIComponent(projectPath);
    return this.request<{ id: number; name: string; web_url: string }>(`/projects/${encoded}`);
  }

  /**
   * 根据用户名精确查询用户信息
   */
  async getUserByUsername(username: string): Promise<GitLabUser | undefined> {
    const trimmed = username.replace(/^@/, '').trim();
    const users = await this.request<GitLabUser[]>(`/users?username=${encodeURIComponent(trimmed)}`);
    return users.find(u => u.username.toLowerCase() === trimmed.toLowerCase());
  }

  /**
   * 将用户名数组解析为对应的 GitLab User ID 列表
   */
  async resolveReviewerIds(usernames: string[]): Promise<{ resolvedIds: number[]; notFoundUsers: string[] }> {
    const resolvedIds: number[] = [];
    const notFoundUsers: string[] = [];

    for (const name of usernames) {
      if (!name || !name.trim()) continue;
      const cleanName = name.replace(/^@/, '').trim();
      try {
        const user = await this.getUserByUsername(cleanName);
        if (user && user.id) {
          resolvedIds.push(user.id);
        } else {
          notFoundUsers.push(cleanName);
        }
      } catch {
        notFoundUsers.push(cleanName);
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

    return this.request<MergeRequestResult>(`/projects/${projectIdEncoded}/merge_requests`, {
      method: 'POST',
      body
    });
  }
}

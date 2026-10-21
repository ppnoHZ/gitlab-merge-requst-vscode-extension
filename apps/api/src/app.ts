import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { loadReleaseOverview, type MainMergeResult, type ReleaseOverviewSnapshot, type WebStatus } from '@gitlab-workbench/core';
import type { GitLabConfig } from './config';
import { OAuthSessions, type Session } from './auth';
import { ApiError, WebGitLabClient } from './gitlab';
import { RepositoryChecks } from './repository';
import { BranchCreation, type BranchAudit } from './branchCreation';

export interface AppOptions {
  config?: GitLabConfig;
  branchAudit?: BranchAudit;
  checkRepository?: (session: string, project: number, remote: string, token: string, branches: string[]) => Promise<MainMergeResult>;
}
export function createApp(options: AppOptions = {}) {
  const { config } = options;
  const repositories = config ? new RepositoryChecks(config.url) : undefined;
  const auth = config ? new OAuthSessions(config, session => repositories?.removeSession(session)) : undefined;
  const branchCreation = new BranchCreation(options.branchAudit);
  const checks = new Map<string, Promise<ReleaseOverviewSnapshot>>();
  const app = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    void handle(request, response).catch(error => {
      if (error instanceof ApiError && error.status === 401) auth?.logout(request, response);
      response.statusCode = error instanceof ApiError ? error.status : 500;
      response.end(JSON.stringify({ error: error instanceof ApiError ? error.message : '服务处理失败，请重试' }));
    });
  });
  app.on('close', () => { void repositories?.dispose(); });
  function json(response: ServerResponse, value: unknown): void { response.end(JSON.stringify(value)); }
  async function requireSession(request: IncomingMessage, response: ServerResponse): Promise<Session> {
    if (!auth) throw new ApiError(503, '尚未配置 GitLab OAuth，请管理员配置环境变量');
    const session = await auth.get(request, response);
    if (!session) throw new ApiError(401, '请先使用 GitLab 登录');
    return session;
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://internal');
    const path = url.pathname;
    if (request.method === 'GET' && path === '/api/health') return json(response, { status: 'ok', service: 'gitlab-workbench-api' });
    if (request.method === 'GET' && path === '/api/auth/login') {
      if (!auth) throw new ApiError(503, '尚未配置 GitLab OAuth，请管理员配置环境变量');
      return auth.login(response);
    }
    if (request.method === 'GET' && path === '/api/auth/callback') {
      if (!auth) throw new ApiError(503, '尚未配置 GitLab OAuth');
      return auth.callback(request, response, url);
    }
    if (request.method === 'GET' && path === '/api/status') {
      const session = await auth?.get(request, response);
      const status: WebStatus = { status: 'ok', gitlab: { configured: !!config, connected: !!session,
        ...(config ? { instance: config.url } : {}), ...(session ? { user: session.user } : {}) },
        branchCreationEnabled: config?.allowBranchCreation === true, ...(session ? { csrfToken: session.csrf } : {}) };
      return json(response, status);
    }
    if (request.method === 'POST' && path === '/api/auth/logout') {
      const session = await requireSession(request, response);
      if (request.headers.origin !== config!.webOrigin || request.headers['x-csrf-token'] !== session.csrf) throw new ApiError(403, '请求校验失败，请刷新页面后重试');
      auth!.logout(request, response);
      return json(response, { status: 'ok' });
    }
    if (request.method === 'GET' && path === '/api/projects') {
      const session = await requireSession(request, response);
      const page = Number(url.searchParams.get('page') ?? 1);
      if (!Number.isSafeInteger(page) || page < 1 || page > 500) throw new ApiError(400, '项目页码无效');
      const search = (url.searchParams.get('search') ?? '').trim();
      if (search.length > 200) throw new ApiError(400, '项目搜索词过长');
      return json(response, await new WebGitLabClient(config!.url, session.token).projects(page, search));
    }
    const refs = path.match(/^\/api\/projects\/([1-9]\d*)\/refs$/);
    if (request.method === 'GET' && refs) {
      const session = await requireSession(request, response);
      const id = Number(refs[1]);
      const kind = url.searchParams.get('kind') ?? 'branch';
      const page = Number(url.searchParams.get('page') ?? 1);
      const search = url.searchParams.get('search') ?? '';
      if (!Number.isSafeInteger(id) || !['branch', 'tag'].includes(kind) || !Number.isInteger(page) || page < 1 || page > 500 || search.length > 200) throw new ApiError(400, '基线查询参数无效');
      const client = new WebGitLabClient(config!.url, session.token);
      const project = await client.project(id);
      const result = await client.references(id, kind as 'branch' | 'tag', page, search);
      if (kind === 'branch' && page === 1 && !search && project.default_branch && !result.items.some(item => item.name === project.default_branch)) {
        result.items.unshift(await client.reference(id, 'branch', project.default_branch));
      }
      return json(response, { ...result, defaultBranch: project.default_branch });
    }
    const create = path.match(/^\/api\/projects\/([1-9]\d*)\/branches(\/preview)?$/);
    if (request.method === 'POST' && create) {
      const session = await requireSession(request, response);
      if (!config?.allowBranchCreation) throw new ApiError(403, '分支创建未启用，请管理员配置写权限后重新登录');
      if (request.headers.origin !== config.webOrigin || request.headers['x-csrf-token'] !== session.csrf) throw new ApiError(403, '请求校验失败，请刷新后重试');
      const id = Number(create[1]);
      if (!Number.isSafeInteger(id)) throw new ApiError(400, '项目编号无效');
      if (!request.headers['content-type']?.startsWith('application/json')) throw new ApiError(415, '请使用 JSON 请求');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 16384) throw new ApiError(413, '请求体过大');
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { throw new ApiError(400, 'JSON 请求无效'); }
      const client = new WebGitLabClient(config.url, session.token);
      if (create[2]) return json(response, await branchCreation.preview(session, client, id, body));
      const ticket = (body as { ticket?: unknown })?.ticket;
      if (typeof ticket !== 'string' || ticket.length > 100) throw new ApiError(400, '确认标识无效');
      return json(response, await branchCreation.create(session, client, id, ticket));
    }
    const overview = path.match(/^\/api\/projects\/([1-9]\d*)\/overview$/);
    if (request.method === 'GET' && overview) {
      const session = await requireSession(request, response);
      const id = Number(overview[1]);
      if (!Number.isSafeInteger(id)) throw new ApiError(400, '项目编号无效');
      const client = new WebGitLabClient(config!.url, session.token);
      // Verify permissions on every request, including before returning any shared in-flight task.
      const project = await client.project(id);
      const key = `${session.id}:${id}`;
      let task = checks.get(key);
      if (!task) {
        let unauthorized = false;
        task = loadReleaseOverview(project.path_with_namespace, {
          branches: page => client.branches(id, page),
          requests: async (branch, page) => {
            try { return await client.requests(id, branch, page); }
            catch (error) { if (error instanceof ApiError && error.status === 401) unauthorized = true; throw error; }
          },
          mergedIntoMain: branches => unauthorized ? Promise.reject(new ApiError(401, 'GitLab 授权已失效，请重新登录')) : options.checkRepository
            ? options.checkRepository(session.id, id, project.http_url_to_repo, session.token, branches)
            : repositories!.check(session.id, id, project.http_url_to_repo, session.token, branches)
        }).then(snapshot => {
          // Core retains per-release failures. An expired authorization must also invalidate the session.
          if (unauthorized) throw new ApiError(401, 'GitLab 授权已失效，请重新登录');
          return snapshot;
        }).finally(() => checks.delete(key));
        checks.set(key, task);
      }
      return json(response, await task);
    }
    response.statusCode = 404;
    json(response, { error: 'Not found' });
  }
  return app;
}

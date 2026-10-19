import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebGitLabUser } from '@gitlab-workbench/core';
import type { GitLabConfig } from './config';
import { ApiError, WebGitLabClient, type OAuthTokens } from './gitlab';

interface Pending { state: string; verifier: string; expires: number }
export interface Session {
  id: string; token: string; refreshToken?: string; tokenExpires: number; expires: number;
  user: WebGitLabUser; csrf: string; refreshing?: Promise<void>;
}
const sessionCookie = 'workbench_session';
const pendingCookie = 'workbench_oauth';
const random = () => randomBytes(32).toString('base64url');
function cookie(request: IncomingMessage, name: string): string | undefined {
  return request.headers.cookie?.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))?.slice(name.length + 1);
}
export class OAuthSessions {
  private readonly pending = new Map<string, Pending>();
  private readonly sessions = new Map<string, Session>();
  constructor(readonly config: GitLabConfig, private readonly onEnd: (session: string) => void = () => {}) {}
  private setCookie(response: ServerResponse, name: string, value: string, maxAge: number): void {
    const existing = response.getHeader('Set-Cookie');
    const valueString = `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${this.config.secureCookies ? '; Secure' : ''}`;
    response.setHeader('Set-Cookie', [...(Array.isArray(existing) ? existing : existing ? [String(existing)] : []), valueString]);
  }
  private prune(): void {
    for (const [id, pending] of this.pending) if (pending.expires < Date.now()) this.pending.delete(id);
    for (const [id, session] of this.sessions) if (session.expires < Date.now()) this.end(id);
    while (this.pending.size > 1000) this.pending.delete(this.pending.keys().next().value!);
    while (this.sessions.size > 1000) this.end(this.sessions.keys().next().value!);
  }
  private end(id: string): void { if (this.sessions.delete(id)) this.onEnd(id); }
  login(response: ServerResponse): void {
    this.prune();
    const id = random();
    const state = random();
    const verifier = random();
    if (this.pending.size >= 1000) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(id, { state, verifier, expires: Date.now() + 5 * 60000 });
    this.setCookie(response, pendingCookie, id, 300);
    const query = new URLSearchParams({ client_id: this.config.clientId, redirect_uri: this.config.redirectUri, response_type: 'code',
      scope: 'read_user read_api read_repository', state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') });
    response.writeHead(302, { Location: `${this.config.url}/oauth/authorize?${query}` });
    response.end();
  }
  async callback(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> {
    this.prune();
    const pendingId = cookie(request, pendingCookie);
    const pending = pendingId ? this.pending.get(pendingId) : undefined;
    if (pendingId) this.pending.delete(pendingId);
    this.setCookie(response, pendingCookie, '', 0);
    if (!pending || pending.state !== url.searchParams.get('state') || pending.expires < Date.now()) throw new ApiError(400, '登录校验已失效，请重新发起 GitLab 登录');
    if (url.searchParams.has('error')) throw new ApiError(400, 'GitLab 授权已取消，请重新登录');
    const code = url.searchParams.get('code');
    if (!code) throw new ApiError(400, 'GitLab 未返回授权码');
    const tokens = await this.exchange({ grant_type: 'authorization_code', code, code_verifier: pending.verifier });
    const user = await new WebGitLabClient(this.config.url, tokens.access_token).user();
    const old = cookie(request, sessionCookie);
    if (old) this.end(old);
    const id = random();
    if (this.sessions.size >= 1000) this.end(this.sessions.keys().next().value!);
    this.sessions.set(id, { id, token: tokens.access_token, refreshToken: tokens.refresh_token,
      tokenExpires: Date.now() + (tokens.expires_in ?? 7200) * 1000, expires: Date.now() + 8 * 3600000, user, csrf: random() });
    this.setCookie(response, sessionCookie, id, 8 * 3600);
    response.writeHead(302, { Location: `${this.config.webOrigin}/` });
    response.end();
  }
  async get(request: IncomingMessage, response: ServerResponse): Promise<Session | undefined> {
    this.prune();
    const id = cookie(request, sessionCookie);
    const session = id ? this.sessions.get(id) : undefined;
    if (!session) return undefined;
    if (session.tokenExpires <= Date.now() + 30000) {
      if (!session.refreshToken) { this.logout(request, response); throw new ApiError(401, 'GitLab 授权已过期，请重新登录'); }
      if (!session.refreshing) {
        session.refreshing = this.exchange({ grant_type: 'refresh_token', refresh_token: session.refreshToken }).then(tokens => {
          session.token = tokens.access_token;
          session.refreshToken = tokens.refresh_token ?? session.refreshToken;
          session.tokenExpires = Date.now() + (tokens.expires_in ?? 7200) * 1000;
        }).finally(() => { session.refreshing = undefined; });
      }
      try { await session.refreshing; }
      catch { this.logout(request, response); throw new ApiError(401, 'GitLab 授权已失效，请重新登录'); }
    }
    return session;
  }
  logout(request: IncomingMessage, response: ServerResponse): void {
    const id = cookie(request, sessionCookie);
    if (id) this.end(id);
    this.setCookie(response, sessionCookie, '', 0);
  }
  private async exchange(fields: Record<string, string>): Promise<OAuthTokens> {
    let response: Response;
    try {
      response = await fetch(`${this.config.url}/oauth/token`, { method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body: new URLSearchParams({ client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: this.config.redirectUri, ...fields }),
        signal: AbortSignal.timeout(20000), redirect: 'error' });
    } catch { throw new ApiError(502, '无法连接 GitLab 授权服务'); }
    if (!response.ok) throw new ApiError(401, 'GitLab 授权失败，请检查 OAuth 配置或重新登录');
    let tokens: OAuthTokens;
    try { tokens = await response.json() as OAuthTokens; }
    catch { throw new ApiError(502, 'GitLab 授权响应无效'); }
    if (typeof tokens.access_token !== 'string' || !tokens.access_token || (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== 'string') || (tokens.expires_in !== undefined && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))) throw new ApiError(502, 'GitLab 授权响应无效');
    return tokens;
  }
}

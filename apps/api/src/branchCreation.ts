import { randomBytes } from 'node:crypto';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { branchName, type BranchDraft, type BranchPreview, type BranchCreated } from '@gitlab-workbench/core';
import { ApiError, WebGitLabClient } from './gitlab';
import type { Session } from './auth';

export type BranchAudit = (event: Record<string, unknown>) => Promise<void>;
export const fileBranchAudit: BranchAudit = async event => {
  const directory = process.env.WORKBENCH_DATA_DIR ?? join(process.cwd(), '.data');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(join(directory, 'branch-creations.jsonl'), 'a', 0o600);
  try {
    await file.writeFile(JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n');
    await file.sync();
  } finally { await file.close(); }
};
interface Ticket { projectPath: string; session: string; project: number; draft: BranchDraft; preview: BranchPreview; expires: number; result?: BranchCreated; task?: Promise<BranchCreated>; attempted?: boolean }
export class BranchCreation {
  private readonly tickets = new Map<string, Ticket>();
  constructor(private readonly audit: BranchAudit = fileBranchAudit) {}
  async preview(session: Session, client: WebGitLabClient, project: number, input: unknown): Promise<BranchPreview> {
    const draft = input as BranchDraft;
    if (!draft || typeof draft.version !== 'string' || !['branch', 'tag'].includes(draft.baseKind) || typeof draft.baseName !== 'string' || !draft.baseName || draft.baseName.length > 255 || (draft.issue !== undefined && typeof draft.issue !== 'string') || (draft.description !== undefined && typeof draft.description !== 'string')) throw new ApiError(400, '分支创建参数无效');
    let name: string;
    try { name = branchName(draft); } catch (error) { throw new ApiError(400, (error as Error).message); }
    const info = await client.project(project);
    await this.absent(client, project, name);
    const base = await client.reference(project, draft.baseKind, draft.baseName);
    const ticket = randomBytes(32).toString('base64url');
    const expires = Date.now() + 5 * 60000;
    const preview = { ticket, branch: name, base, baseKind: draft.baseKind, expiresAt: new Date(expires).toISOString() };
    for (const [id, value] of this.tickets) if (value.expires < Date.now()) this.tickets.delete(id);
    if (this.tickets.size >= 1000) throw new ApiError(429, '待确认操作过多，请稍后重试');
    this.tickets.set(ticket, { projectPath: info.path_with_namespace, session: session.id, project, draft: { ...draft }, preview, expires });
    return preview;
  }
  async create(session: Session, client: WebGitLabClient, project: number, ticket: string): Promise<BranchCreated> {
    const value = this.tickets.get(ticket);
    if (!value || value.session !== session.id || value.project !== project || value.expires < Date.now()) throw new ApiError(409, '确认已失效，请重新预览分支');
    await client.project(project);
    if (value.result) return value.result;
    if (value.task) return value.task;
    value.task = this.execute(session, client, project, value).then(result => { value.result = result; return result; }).finally(() => { value.task = undefined; });
    return value.task;
  }
  private async absent(client: WebGitLabClient, project: number, branch: string): Promise<void> {
    try { await client.reference(project, 'branch', branch); }
    catch (error) { if (error instanceof ApiError && error.status === 404) return; throw error; }
    throw new ApiError(409, '同名分支已存在，请更换名称');
  }
  private async execute(session: Session, client: WebGitLabClient, project: number, value: Ticket): Promise<BranchCreated> {
    const { branch, base } = value.preview;
    const current = await client.reference(project, value.draft.baseKind, value.draft.baseName);
    if (current.sha !== base.sha) throw new ApiError(409, '基线提交已变化，请重新预览并确认');
    const metadata = { actor: session.user.id, username: session.user.username, instance: client.baseUrl, project, branch, baseKind: value.draft.baseKind, base: base.name, sha: base.sha };
    const audit = async (outcome: string) => this.audit({ ...metadata, outcome });
    if (value.attempted) {
      try {
        const existing = await client.reference(project, 'branch', branch);
        if (existing.sha !== base.sha) throw new ApiError(409, '远程同名分支指向其他提交，请人工核对');
        const result: BranchCreated = { branch, sha: base.sha, webUrl: `${client.baseUrl}/${value.projectPath}/-/tree/${encodeURIComponent(branch)}`, recovered: true };
        try { await audit('recovered'); } catch { result.auditWarning = true; }
        return result;
      } catch (error) { if (error instanceof ApiError && error.status === 404) throw new ApiError(502, '尚未确认远程创建结果，请稍后使用同一次确认查询'); throw error; }
    }
    await this.absent(client, project, branch);
    try { await audit('requested'); } catch { throw new ApiError(503, '创建审计不可写，操作未执行，请管理员检查存储'); }
    value.attempted = true;
    let recovered = false;
    try { await client.createBranch(project, branch, base.sha); }
    catch (error) {
      // After an uncertain POST, reconcile using a read before permitting any retry.
      if (!(error instanceof ApiError) || error.status >= 500) {
        try {
          const existing = await client.reference(project, 'branch', branch);
          if (existing.sha === base.sha) recovered = true;
        } catch { /* Preserve uncertainty; never blindly retry the POST. */ }
        if (!recovered) {
          await audit('uncertain').catch(() => {});
          throw new ApiError(502, '创建结果未确认，请使用同一次确认重试查询；不要重复新建');
        }
      } else { await audit('failed').catch(() => {}); throw error; }
    }
    const result: BranchCreated = { branch, sha: base.sha, webUrl: `${client.baseUrl}/${value.projectPath}/-/tree/${encodeURIComponent(branch)}`, recovered };
    try { await audit(recovered ? 'recovered' : 'created'); } catch { result.auditWarning = true; }
    return result;
  }
}

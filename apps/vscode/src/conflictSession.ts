import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { AuditApiError } from './audit';
import { GitLabService, type ConflictResolution } from './gitlabService';
import { TemplateEngine } from './templateEngine';
import type { RepositoryProvider, ProviderConnection } from './providers/repositoryProvider';
import type { ConflictPlan } from './conflictWorkflow';
import { conflictGuide } from './conflictWorkflow';
import { TokenManager } from './tokenManager';

type Stage = 'preparing' | 'waitingPush' | 'mrCreating' | 'replacementCreated' | 'mr';
type LegacyStage = 'planned' | 'closed' | 'creating' | 'remote' | 'local' | 'resolving' | 'pushed';
export interface ConflictSession {
  id: string; connection: ProviderConnection; project: { id: number; label: string; webUrl: string };
  plan: ConflictPlan; reviewers: number[]; stage: Stage | LegacyStage; created: string;
  mr?: { iid: number; web_url: string }; pushedSha?: string; originalAlreadyClosed?: boolean;
  root?: string; remote?: string; local?: string; isolated?: boolean;
}
const key = 'gitlabMr.conflictSessions.v1';
const labels: Record<Stage, string> = {
  preparing: '待创建 conflict 分支', waitingPush: '等待人工解决并推送', mrCreating: '核对替代 MR',
  replacementCreated: '替代 MR 已创建，待关闭原 MR', mr: '替代 MR 审核中'
};

export class ConflictSessions {
  private busy = false;
  constructor(private readonly state: vscode.Memento, private readonly tokens: TokenManager) {}
  private all(): ConflictSession[] { return this.state.get<ConflictSession[]>(key, []); }
  private async save(session: ConflictSession, stage: Stage = this.normalize(session)): Promise<void> {
    session.stage = stage;
    await this.state.update(key, [...this.all().filter(item => item.id !== session.id), session]);
  }
  private normalize(session: ConflictSession): Stage {
    if (session.mr) return session.stage === 'replacementCreated' ? 'replacementCreated' : 'mr';
    if (session.stage === 'mrCreating') return 'mrCreating';
    if (session.stage === 'preparing' || ['planned', 'closed', 'creating'].includes(session.stage)) return 'preparing';
    return 'waitingPush';
  }
  private async exclusive(action: () => Promise<boolean>): Promise<boolean> {
    if (this.busy) throw new Error('冲突任务正在执行，请等待完成。');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }

  async start(service: RepositoryProvider, plan: ConflictPlan, project: ConflictSession['project'], reviewers: number[]): Promise<boolean> {
    return this.exclusive(async () => {
      if (!(service instanceof GitLabService) || !plan.originalMr) throw new Error('冲突处理任务目前仅支持 GitLab 同仓库 MR。');
      const existing = this.all().find(item => item.connection.instanceUrl === service.auditContext.instance && item.project.id === project.id && item.plan.branch === plan.branch);
      if (existing) {
        if (existing.plan.originalMr?.iid !== plan.originalMr.iid || existing.plan.target.name !== plan.target.name) throw new Error('同名 conflict 正被另一处理任务占用，请先完成原任务。');
        return this.advance(existing, service);
      }
      try { await service.getBranchCreationRef(project.id, 'branch', plan.branch); throw new Error('同名 conflict 分支已存在且没有任务关联，请核对后再处理。'); }
      catch (error) { if (!(error instanceof AuditApiError && error.status === 404)) throw error; }
      const confirm = await vscode.window.showWarningMessage(
        `处理 !${plan.originalMr.iid}：${plan.source.name} → ${plan.target.name}\n将从 Target 创建 ${plan.branch}。请使用正常 Git 流程人工解决并推送；插件确认远程结果后创建替代 MR，成功后才关闭原 MR。`,
        { modal: true }, '创建任务');
      if (confirm !== '创建任务') return false;
      const session: ConflictSession = {
        id: randomUUID(), connection: { kind: 'gitlab', instanceUrl: service.auditContext.instance!, apiUrl: `${service.auditContext.instance}/api/v4` },
        project, plan, reviewers, stage: 'preparing', created: new Date().toISOString()
      };
      await this.save(session, 'preparing');
      return this.advance(session, service);
    });
  }

  async resume(): Promise<boolean> {
    return this.exclusive(async () => {
      const tasks = this.all();
      if (!tasks.length) { vscode.window.showInformationMessage('当前没有进行中的 conflict 处理任务。'); return false; }
      const selected = await vscode.window.showQuickPick(tasks.map(session => {
        const stage = this.normalize(session);
        return { label: session.plan.branch, description: `${labels[stage]} · ${session.plan.source.name} → ${session.plan.target.name}`, session };
      }), { title: '继续 conflict 处理任务', ignoreFocusOut: true });
      if (!selected) return false;
      const token = await this.tokens.getToken(selected.session.connection) || await this.tokens.promptForToken(selected.session.connection);
      if (!token) return false;
      return this.advance(selected.session, new GitLabService(selected.session.connection.instanceUrl, token));
    });
  }

  private async validatePinnedBranches(s: ConflictSession, service: GitLabService): Promise<void> {
    const p = s.plan;
    const [source, target] = await Promise.all([
      service.getBranchCreationRef(s.project.id, 'branch', p.source.name),
      service.getBranchCreationRef(s.project.id, 'branch', p.target.name)
    ]);
    if (source.sha !== p.source.sha) throw new Error('原 Source 已更新。为避免遗漏新提交，当前任务已暂停，请重新从冲突 MR 创建任务。');
    if (target.sha !== p.target.sha) throw new Error('Target 已更新。请先评估新基线，当前 conflict 分支不会自动合并或覆盖。');
  }

  private async validateOriginal(s: ConflictSession, service: GitLabService): Promise<void> {
    const original = s.plan.originalMr!;
    const details = await service.getReviewDetails(s.project.id, original.iid, true);
    if (details.source_project_id !== s.project.id || details.target_project_id !== s.project.id ||
      details.source_branch !== s.plan.source.name || details.target_branch !== s.plan.target.name || details.sha !== s.plan.source.sha) {
      throw new Error('原 MR 的项目、分支或提交已变化，请刷新后重新创建 conflict 任务。');
    }
    if (details.state === 'closed') {
      s.originalAlreadyClosed = true;
      return;
    }
    if (details.state !== 'opened' || !(details.has_conflicts || details.detailed_merge_status === 'conflict')) {
      throw new Error('原 MR 已关闭、合并或不再有确认的冲突，请刷新待办。');
    }
  }

  private async showInstructions(s: ConflictSession): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: conflictGuide(s.plan) });
    await vscode.window.showTextDocument(document, { preview: false });
    const action = await vscode.window.showInformationMessage(
      `等待推送：请在本地解决 ${s.plan.branch}，完成测试后推送，再执行“继续 conflict 处理”。`, '复制分支名称', '打开远程分支');
    if (action === '复制分支名称') await vscode.env.clipboard.writeText(s.plan.branch);
    if (action === '打开远程分支') await vscode.env.openExternal(vscode.Uri.parse(`${s.project.webUrl}/-/tree/${encodeURIComponent(s.plan.branch)}`));
  }

  private async findReplacement(s: ConflictSession, service: GitLabService, expectedSha: string): Promise<ConflictSession['mr']> {
    for (let page = 1; ; page++) {
      const result = await service.getMergeRequestsTargetingBranch(s.project.id, s.plan.target.name, page);
      for (const item of result.items.filter(value => value.source_branch === s.plan.branch && ['opened', 'merged'].includes(value.state))) {
        const details = await service.getReviewDetails(s.project.id, item.iid);
        if (details.source_project_id === s.project.id && details.target_project_id === s.project.id &&
          details.source_branch === s.plan.branch && details.target_branch === s.plan.target.name && details.sha === expectedSha) {
          return { iid: item.iid, web_url: item.web_url };
        }
        if (details.state === 'opened') throw new Error('已有同源、同目标 MR，但提交版本不同，请在 GitLab 核对。');
      }
      if (!result.hasMore) return undefined;
    }
  }

  private description(s: ConflictSession, resolution: ConflictResolution): string {
    return `${TemplateEngine.generateDescription(s.plan.branch, s.plan.target.name, resolution.commits, resolution.files)}\n\n原冲突 MR：${s.plan.originalMr!.webUrl}\n`;
  }

  private async advance(s: ConflictSession, service: GitLabService): Promise<boolean> {
    let stage = this.normalize(s);
    if (s.stage !== stage) await this.save(s, stage);
    const p = s.plan;

    if (stage === 'preparing') {
      await this.validateOriginal(s, service);
      await this.validatePinnedBranches(s, service);
      let exists = false;
      try {
        const branch = await service.getBranchCreationRef(s.project.id, 'branch', p.branch);
        if (branch.sha !== p.target.sha) throw new Error('远程 conflict 分支与任务 Target 基线不一致，不能接管。');
        exists = true;
      } catch (error) { if (!(error instanceof AuditApiError && error.status === 404)) throw error; }
      if (!exists) await service.createRemoteBranch(s.project.id, p.branch, 'branch', p.target.name, p.target.sha);
      await this.save(s, 'waitingPush');
      await this.showInstructions(s);
      return true;
    }

    if (stage === 'waitingPush') {
      await this.validateOriginal(s, service);
      await this.validatePinnedBranches(s, service);
      const branch = await service.getBranchCreationRef(s.project.id, 'branch', p.branch);
      if (branch.sha === p.target.sha) { await this.showInstructions(s); return false; }
      const resolution = await service.getConflictResolution(s.project.id, p.branch, p.target.sha, p.source.sha);
      if (resolution.headSha !== branch.sha) throw new Error('远程 conflict 分支在检查期间发生变化，请重新继续任务。');
      s.pushedSha = resolution.headSha;
      const existing = await this.findReplacement(s, service, resolution.headSha);
      if (existing) { s.mr = existing; await this.save(s, 'replacementCreated'); stage = 'replacementCreated'; }
      else {
        const description = this.description(s, resolution);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: description, language: 'markdown' }), { preview: true });
        const title = await vscode.window.showInputBox({ title: '确认替代 MR 标题', value: `(conflict-${p.target.name}) ${p.branch} 合并到 ${p.target.name}`, ignoreFocusOut: true });
        if (!title?.trim()) return false;
        if (await vscode.window.showWarningMessage(
          `远程提交已确认包含原 Source 和 Target。创建替代 MR 后才关闭原 MR !${p.originalMr!.iid}。\nReviewer：${s.reviewers.join(', ') || '无，请在新 MR 补充审核人'}`,
          { modal: true }, '创建替代 MR') !== '创建替代 MR') return false;
        await this.validateOriginal(s, service);
        if ((await service.getBranchCreationRef(s.project.id, 'branch', p.branch)).sha !== resolution.headSha) throw new Error('确认期间远程 conflict 已变化，请重新核对。');
        await this.save(s, 'mrCreating');
        const mr = await service.createMergeRequest({ projectId: s.project.id, sourceBranch: p.branch, targetBranch: p.target.name,
          title: title.trim(), description, reviewerIds: s.reviewers, removeSourceBranch: true, squash: false });
        s.mr = { iid: mr.iid, web_url: mr.web_url }; await this.save(s, 'replacementCreated'); stage = 'replacementCreated';
      }
    }

    if (stage === 'mrCreating') {
      const branch = await service.getBranchCreationRef(s.project.id, 'branch', p.branch);
      const existing = await this.findReplacement(s, service, branch.sha);
      if (existing) { s.pushedSha = branch.sha; s.mr = existing; await this.save(s, 'replacementCreated'); stage = 'replacementCreated'; }
      else {
        const choice = await vscode.window.showWarningMessage('上次创建替代 MR 的结果未确认。请先在 GitLab 核对；确认不存在后才能重新创建。', { modal: true }, '打开项目', '已核对不存在');
        if (choice === '打开项目') await vscode.env.openExternal(vscode.Uri.parse(s.project.webUrl));
        if (choice !== '已核对不存在') return false;
        await this.save(s, 'waitingPush');
        return this.advance(s, service);
      }
    }

    if (stage === 'replacementCreated') {
      if (!s.originalAlreadyClosed) await service.closeConflictOriginal(s.project.id, p.originalMr!.iid, p.source.name, p.target.name, p.source.sha);
      await this.save(s, 'mr'); stage = 'mr';
    }

    if (stage === 'mr' && s.mr) {
      const details = await service.getReviewDetails(s.project.id, s.mr.iid);
      if (details.state === 'merged') {
        if (await vscode.window.showWarningMessage('替代 MR 已合并。核对并清理远程 conflict 分支、归档任务？', { modal: true }, '清理并归档') === '清理并归档') {
          await service.cleanupConflictBranch(s.project.id, p.branch, p.target.name, s.mr.iid, s.pushedSha!);
          await this.state.update(key, this.all().filter(item => item.id !== s.id));
        }
      } else await vscode.env.openExternal(vscode.Uri.parse(s.mr.web_url));
    }
    return true;
  }
}

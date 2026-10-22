import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import * as path from 'path';
import { existsSync } from 'fs';
import { Audit, AuditApiError } from './audit';
import { GitLabService } from './gitlabService';
import { GitService } from './gitService';
import { TemplateEngine } from './templateEngine';
import type { RepositoryProvider, ProviderConnection } from './providers/repositoryProvider';
import type { ConflictPlan } from './conflictWorkflow';
import { TokenManager } from './tokenManager';
import { conflictGit, ensureIdle, mergeConflictSource, unresolved } from './conflictLocal';

type Stage = 'planned' | 'closed' | 'creating' | 'remote' | 'local' | 'resolving' | 'pushed' | 'mrCreating' | 'mr';
export interface ConflictSession {
  id: string; connection: ProviderConnection; project: { id: number; label: string; webUrl: string };
  plan: ConflictPlan; reviewers: number[]; stage: Stage; root: string; remote: string;
  local: string; isolated: boolean; created: string; mr?: { iid: number; web_url: string }; pushedSha?: string;
}
const key = 'gitlabMr.conflictSessions.v1';
const labels: Record<Stage, string> = { planned: '待关闭原 MR', closed: '待创建远程分支', creating: '核对远程分支', remote: '待准备工作区', local: '待合入 Source', resolving: '解决冲突 / 提交推送', pushed: '待创建替代 MR', mrCreating: '核对替代 MR', mr: '等待审核合并 / 清理' };

export class ConflictSessions {
  private busy = false;
  constructor(private readonly state: vscode.Memento, private readonly tokens: TokenManager) {}
  private all(): ConflictSession[] { return this.state.get<ConflictSession[]>(key, []); }
  private async save(session: ConflictSession, stage = session.stage): Promise<void> {
    session.stage = stage;
    const sessions = this.all().filter(item => item.id !== session.id);
    await this.state.update(key, [...sessions, session]);
  }
  private async exclusive(action: () => Promise<boolean>): Promise<boolean> {
    if (this.busy) throw new Error('冲突任务正在执行，请等待完成。');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  async start(service: RepositoryProvider, plan: ConflictPlan, project: ConflictSession['project'], reviewers: number[]): Promise<boolean> {
    return this.exclusive(async () => {
      if (!(service instanceof GitLabService) || !plan.originalMr) throw new Error('完整冲突向导目前仅支持 GitLab 同仓库 MR。');
      const existing = this.all().find(item => item.connection.instanceUrl === service.auditContext.instance && item.project.id === project.id && item.plan.branch === plan.branch);
      if (existing) {
        if (existing.plan.originalMr?.iid !== plan.originalMr.iid || existing.plan.target.name !== plan.target.name) throw new Error('同名 conflict 正被另一处理任务占用，请先完成原任务。');
        return this.advance(existing, service);
      }
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) throw new Error('请先打开对应仓库，再启动本地冲突处理。');
      const git = new GitService(folder.uri.fsPath);
      const repo = await git.getRepoInfo();
      if (repo.projectPath !== project.label || repo.gitlabHost !== new URL(service.auditContext.instance!).hostname) throw new Error('当前工作区不是该 MR 对应的仓库，请打开正确仓库。');
      const mode = await vscode.window.showQuickPick(['独立 worktree（推荐）', '当前工作区'], { title: '冲突处理位置', ignoreFocusOut: true });
      if (!mode) return false;
      const isolated = mode.startsWith('独立');
      if (!isolated) await ensureIdle(repo.rootPath);
      const refs = await conflictGit(repo.rootPath, ['ls-remote', '--heads', 'origin', `refs/heads/${plan.source.name}`, `refs/heads/${plan.target.name}`]);
      const remoteRefs = new Map(refs.split('\n').filter(Boolean).map(line => { const [sha, ref] = line.split(/\s+/); return [ref, sha]; }));
      if (remoteRefs.get(`refs/heads/${plan.source.name}`) !== plan.source.sha || remoteRefs.get(`refs/heads/${plan.target.name}`) !== plan.target.sha) throw new Error('本地 origin 的 Source/Target 与 MR 预览版本不一致，请刷新后核对仓库。');
      const localBranches = await conflictGit(repo.rootPath, ['for-each-ref', '--format=%(refname)', `refs/heads/${plan.branch}`]);
      if (localBranches.split('\n').includes(`refs/heads/${plan.branch}`)) throw new Error('本地同名 conflict 已存在且没有任务关联，请核对后再开始。');
      try { await service.getBranchCreationRef(project.id, 'branch', plan.branch); throw new Error('远程同名分支已存在且没有任务关联，请人工核对，不能接管。'); }
      catch (error) { if (!(error instanceof AuditApiError && error.status === 404)) throw error; }
      const confirm = await vscode.window.showWarningMessage(`处理 !${plan.originalMr.iid}：${plan.source.name} → ${plan.target.name}\n关闭原 MR，从目标创建 ${plan.branch}，准备本地合并。冲突由你解决，提交推送和新 MR 将单独确认。`, { modal: true }, '开始处理');
      if (confirm !== '开始处理') return false;
      const id = randomUUID();
      const session: ConflictSession = { id, connection: { kind: 'gitlab', instanceUrl: service.auditContext.instance!, apiUrl: `${service.auditContext.instance}/api/v4` },
        project, plan, reviewers, stage: 'planned', root: repo.rootPath, remote: repo.remoteUrl,
        local: isolated ? path.join(path.dirname(repo.rootPath), `${path.basename(repo.rootPath)}-conflict-${id.slice(0, 8)}`) : repo.rootPath,
        isolated, created: new Date().toISOString() };
      await this.save(session);
      return this.advance(session, service);
    });
  }
  async resume(): Promise<boolean> {
    return this.exclusive(async () => {
      const selected = await vscode.window.showQuickPick(this.all().map(session => ({ label: session.plan.branch, description: `${session.project.label} → ${session.plan.target.name} · ${labels[session.stage]}`, session })), { title: '继续 conflict 处理任务', ignoreFocusOut: true });
      if (!selected) return false;
      const session = selected.session;
      const token = await this.tokens.getToken(session.connection) || await this.tokens.promptForToken(session.connection);
      if (!token) return false;
      return this.advance(session, new GitLabService(session.connection.instanceUrl, token));
    });
  }
  private async advance(s: ConflictSession, service: GitLabService): Promise<boolean> {
    const { plan: p, project } = s;
    if (await conflictGit(s.root, ['remote', 'get-url', 'origin']) !== s.remote) throw new Error('仓库 origin 已变化，任务暂停。');
    if (s.stage === 'planned' || s.stage === 'closed') {
      const source = await service.getBranchCreationRef(project.id, 'branch', p.source.name);
      const target = await service.getBranchCreationRef(project.id, 'branch', p.target.name);
      if (source.sha !== p.source.sha || target.sha !== p.target.sha) {
        const action = await vscode.window.showWarningMessage(`任务基线已更新：\nSource ${source.sha}\nTarget ${target.sha}\n采用最新提交重新准备？`, { modal: true }, '采用最新基线');
        if (action !== '采用最新基线') return false;
        p.source = source; p.target = target; await this.save(s);
      }
    }
    if (s.stage === 'planned') {
      await service.closeConflictOriginal(project.id, p.originalMr!.iid, p.source.name, p.target.name, p.source.sha);
      await this.save(s, 'closed');
    }
    if (s.stage === 'closed') {
      const source = await service.getBranchCreationRef(project.id, 'branch', p.source.name);
      const target = await service.getBranchCreationRef(project.id, 'branch', p.target.name);
      if (source.sha !== p.source.sha || target.sha !== p.target.sha) throw new Error('关闭原 MR 后基线已变化，任务暂停；请人工核对原 MR 和新的基线。');
      await this.save(s, 'creating');
    }
    if (s.stage === 'creating') {
      let exists = false;
      try {
        const remote = await service.getBranchCreationRef(project.id, 'branch', p.branch);
        if (remote.sha !== p.target.sha) throw new Error('同名 conflict 提交与任务基线不一致，不能接管。');
        exists = true;
      } catch (error) { if (!(error instanceof AuditApiError && error.status === 404)) throw error; }
      if (!exists) await service.createRemoteBranch(project.id, p.branch, 'branch', p.target.name, p.target.sha);
      await this.save(s, 'remote');
    }
    if (s.stage === 'remote') {
      await Audit.sensitive('conflict.prepare-local', 'high', { ...service.auditContext, project: project.id, branch: p.branch }, async () => {
        await conflictGit(s.root, ['fetch', '--no-tags', 'origin', `refs/heads/${p.branch}:refs/remotes/origin/${p.branch}`, `refs/heads/${p.source.name}:refs/remotes/origin/${p.source.name}`]);
        if (await conflictGit(s.root, ['rev-parse', `refs/remotes/origin/${p.source.name}`]) !== p.source.sha) throw new Error('Source 已更新，请核对新提交后重新安排任务。');
        if (s.isolated && existsSync(s.local)) {
          if (await conflictGit(s.local, ['rev-parse', '--show-toplevel']) !== s.local) throw new Error('worktree 路径被占用。');
        } else if (s.isolated) {
          await conflictGit(s.root, ['worktree', 'add', '-b', p.branch, s.local, `refs/remotes/origin/${p.branch}`]);
        } else {
          await ensureIdle(s.root);
          if (await conflictGit(s.root, ['branch', '--show-current']) !== p.branch) await conflictGit(s.root, ['switch', '--create', p.branch, '--track', `origin/${p.branch}`]);
        }
        await this.assertLocal(s);
        if (await conflictGit(s.local, ['rev-parse', 'HEAD']) !== p.target.sha) throw new Error('本地分支偏离预期基线，任务暂停。');
        await ensureIdle(s.local);
      });
      await this.save(s, 'local');
    }
    if (['local', 'resolving', 'pushed'].includes(s.stage)) await this.assertLocal(s);
    if (s.stage === 'local') {
      await ensureIdle(s.local);
      if (await conflictGit(s.local, ['rev-parse', 'HEAD']) !== p.target.sha) throw new Error('本地基线已变化，请核对任务。');
      // Record intent first: interrupted merge resumes without repeating it.
      await this.save(s, 'resolving');
      await Audit.sensitive('conflict.merge-local', 'high', { ...service.auditContext, project: project.id, branch: p.branch }, () => mergeConflictSource(s.local, p.source.sha));
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(s.local), { forceNewWindow: s.isolated });
      vscode.window.showInformationMessage('已准备冲突工作区。请在源代码管理中逐文件解决并暂存，运行测试后执行“继续 conflict 处理”。');
      return true;
    }
    if (s.stage === 'resolving') {
      const files = await unresolved(s.local);
      if (files.length) {
        const file = await vscode.window.showQuickPick(files, { title: `剩余 ${files.length} 个冲突文件` });
        if (file) {
          const uri = vscode.Uri.file(path.join(s.local, file));
          try { await vscode.commands.executeCommand('git.openMergeEditor', uri); }
          catch { await vscode.commands.executeCommand('vscode.open', uri); }
        }
        return false;
      }
      // Must contain the pinned source either in the merge in progress or in committed history.
      let mergeHead: string | undefined;
      try { mergeHead = await conflictGit(s.local, ['rev-parse', '--verify', 'MERGE_HEAD']); } catch { /* no merge in progress */ }
      if (mergeHead && mergeHead !== p.source.sha) throw new Error('正在合并的 Source 不属于本任务。');
      if (!mergeHead) {
        try { await conflictGit(s.local, ['merge-base', '--is-ancestor', p.source.sha, 'HEAD']); }
        catch {
          await ensureIdle(s.local);
          if (await conflictGit(s.local, ['rev-parse', 'HEAD']) !== p.target.sha) throw new Error('本地提交未包含原 Source，请核对任务版本。');
          if (await vscode.window.showWarningMessage('上次合并尚未开始或已被放弃，重新准备合并？', { modal: true }, '重新准备') !== '重新准备') return false;
          await this.save(s, 'local');
          return this.advance(s, service);
        }
      }
      const status = await conflictGit(s.local, ['status', '--porcelain']);
      if (status.split('\n').filter(Boolean).some(line => line.startsWith('??') || line[1] !== ' ')) throw new Error('存在未暂存改动，请逐文件核对并暂存后继续。');
      if (status || mergeHead) {
        const reviewedTree = await conflictGit(s.local, ['write-tree']);
        const reviewedHead = await conflictGit(s.local, ['rev-parse', 'HEAD']);
        const diff = await conflictGit(s.local, ['diff', '--cached']);
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: diff, language: 'diff' }), { preview: true });
        const message = await vscode.window.showInputBox({ title: '确认冲突提交信息（请填写真实工单与模块）', placeHolder: 'conflict(module): PROJ-123 解决冲突原因', ignoreFocusOut: true });
        if (!message?.trim()) return false;
        if (await vscode.window.showWarningMessage('确认已核对暂存差异、完成相关测试，提交并推送 conflict 分支？', { modal: true }, '提交并推送') !== '提交并推送') return false;
        await this.assertLocal(s);
        if (await conflictGit(s.local, ['write-tree']) !== reviewedTree || await conflictGit(s.local, ['rev-parse', 'HEAD']) !== reviewedHead) throw new Error('预览后暂存内容或提交已变化，请重新核对。');
        await Audit.sensitive('conflict.commit', 'high', { ...service.auditContext, project: project.id, branch: p.branch }, () => conflictGit(s.local, ['commit', '-m', message.trim()]));
      } else if (await vscode.window.showWarningMessage('确认已完成测试，推送当前 conflict 提交？', { modal: true }, '推送') !== '推送') return false;
      await ensureIdle(s.local);
      await this.assertLocal(s);
      await conflictGit(s.local, ['merge-base', '--is-ancestor', p.target.sha, 'HEAD']);
      s.pushedSha = await conflictGit(s.local, ['rev-parse', 'HEAD']);
      await this.save(s);
      await Audit.sensitive('conflict.push', 'high', { ...service.auditContext, project: project.id, branch: p.branch }, () => conflictGit(s.local, ['push', 'origin', `HEAD:refs/heads/${p.branch}`]));
      if ((await service.getBranchCreationRef(project.id, 'branch', p.branch)).sha !== s.pushedSha) throw new Error('远程提交尚未确认，请核对后继续。');
      await this.save(s, 'pushed');
    }
    if (s.stage === 'pushed' || s.stage === 'mrCreating') {
      const wasCreating = s.stage === 'mrCreating';
      // Always reconcile before POST, including after a lost creation response.
      for (let page = 1; ; page++) {
        const result = await service.getMergeRequestsTargetingBranch(project.id, p.target.name, page);
        for (const existing of result.items.filter(item => item.source_branch === p.branch && ['opened', 'merged'].includes(item.state))) {
          const details = await service.getReviewDetails(project.id, existing.iid);
          if (details.source_project_id !== project.id || details.target_project_id !== project.id || details.source_branch !== p.branch || details.target_branch !== p.target.name) continue;
          if (details.sha !== s.pushedSha) {
            if (details.state === 'opened') throw new Error('已有同源、同目标 MR，但提交版本不同，请人工核对。');
            continue;
          }
          s.mr = { iid: existing.iid, web_url: existing.web_url }; await this.save(s, 'mr'); break;
        }
        if (s.mr || !result.hasMore) break;
      }
      if (!s.mr) {
        if (wasCreating) {
          const choice = await vscode.window.showWarningMessage('上次创建 MR 结果未确认，当前查询未找到替代 MR。请先在 GitLab 核对。确认不存在后才可重试。', { modal: true }, '打开项目', '已核对不存在，重试');
          if (choice === '打开项目') await vscode.env.openExternal(vscode.Uri.parse(project.webUrl));
          if (choice !== '已核对不存在，重试') return false;
          await this.save(s, 'pushed');
        }
        await this.assertLocal(s);
        const remote = await service.getBranchCreationRef(project.id, 'branch', p.branch);
        if (remote.sha !== s.pushedSha) throw new Error('远程 conflict 已变化，请核对后继续。');
        await conflictGit(s.local, ['fetch', '--no-tags', 'origin', `refs/heads/${p.target.name}:refs/remotes/origin/${p.target.name}`]);
        if (await conflictGit(s.local, ['rev-parse', 'HEAD']) !== s.pushedSha) throw new Error('本地提交已变化，请先核对已推送的任务版本。');
        const targetSha = await conflictGit(s.local, ['rev-parse', `refs/remotes/origin/${p.target.name}`]);
        const git = new GitService(s.local);
        const description = TemplateEngine.generateDescription(p.branch, p.target.name, await git.getCommitsBetween(s.pushedSha!, targetSha), await git.getChangedFiles(s.pushedSha!, targetSha)) + `\n\n原冲突 MR：${p.originalMr!.webUrl}\n`;
        await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: description, language: 'markdown' }), { preview: true });
        const title = await vscode.window.showInputBox({ title: '确认替代 MR 标题', value: `(conflict-${p.target.name}) ${p.branch} 合并到 ${p.target.name}`, ignoreFocusOut: true });
        if (!title?.trim()) return false;
        if (await vscode.window.showWarningMessage(`创建 ${p.branch} → ${p.target.name}\n沿用原 MR Reviewer：${s.reviewers.join(', ') || '无，请在新 MR 补充审核人'}\n合并后删除源分支，不 Squash。`, { modal: true }, '创建 MR') !== '创建 MR') return false;
        if ((await service.getBranchCreationRef(project.id, 'branch', p.branch)).sha !== s.pushedSha) throw new Error('确认期间远程 conflict 已变化，请重新核对。');
        await this.save(s, 'mrCreating');
        const mr = await service.createMergeRequest({ projectId: project.id, sourceBranch: p.branch, targetBranch: p.target.name, title, description, reviewerIds: s.reviewers, removeSourceBranch: true, squash: false });
        s.mr = { iid: mr.iid, web_url: mr.web_url }; await this.save(s, 'mr');
      }
    }
    if (s.mr) {
      const details = await service.getReviewDetails(project.id, s.mr.iid);
      if (details.state === 'merged') {
        if (await vscode.window.showWarningMessage('替代 MR 已合并到原 Target。核对并清理远程 conflict 分支，归档任务？本地 worktree 保留。', { modal: true }, '清理并归档') === '清理并归档') {
          await service.cleanupConflictBranch(project.id, p.branch, p.target.name, s.mr.iid, s.pushedSha!);
          await this.state.update(key, this.all().filter(item => item.id !== s.id));
        }
      } else await vscode.env.openExternal(vscode.Uri.parse(s.mr.web_url));
    }
    return true;
  }
  private async assertLocal(s: ConflictSession): Promise<void> {
    if (await conflictGit(s.local, ['branch', '--show-current']) !== s.plan.branch || await conflictGit(s.local, ['remote', 'get-url', 'origin']) !== s.remote) throw new Error('本地分支或 origin 与任务不一致。');
  }
}

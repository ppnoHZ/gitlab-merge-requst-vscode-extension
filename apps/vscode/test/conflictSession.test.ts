import assert from 'assert';
import * as vscode from './vscodeMock';
import { ConflictSessions, ConflictSession } from '../src/conflictSession';
import { GitLabService } from '../src/gitlabService';
import { AuditApiError } from '../src/audit';

async function run() {
  const sourceSha = 'a'.repeat(40), targetSha = 'b'.repeat(40), resolvedSha = 'c'.repeat(40);
  const stored = new Map<string, any>();
  const state = { get: (key: string, fallback: any) => structuredClone(stored.get(key) ?? fallback), update: async (key: string, value: any) => { stored.set(key, structuredClone(value)); } } as any;
  const session = () => stored.get('gitlabMr.conflictSessions.v1')[0] as ConflictSession;
  const tokens = { getToken: async () => 'test', promptForToken: async () => undefined } as any;
  const names = ['getBranchCreationRef', 'createRemoteBranch', 'closeConflictOriginal', 'getMergeRequestsTargetingBranch',
    'createMergeRequest', 'getReviewDetails', 'cleanupConflictBranch', 'getConflictResolution'] as const;
  const originals = names.map(name => GitLabService.prototype[name]);
  const originalPick = vscode.window.showQuickPick, originalWarning = vscode.window.showWarningMessage, originalInput = vscode.window.showInputBox;
  let branchSha: string | undefined, originalClosed = false, closeFails = false, creates = 0, closeAttempts = 0;
  let merged = false, cleaned = false, description = '';
  try {
    (GitLabService.prototype as any).getBranchCreationRef = async (_project: number, _kind: string, name: string) => {
      if (name === 'release/1') return { name, sha: sourceSha, title: '' };
      if (name === 'tst') return { name, sha: targetSha, title: '' };
      if (name === 'conflict/release/1' && branchSha) return { name, sha: branchSha, title: '' };
      throw new AuditApiError('not found', 404);
    };
    (GitLabService.prototype as any).createRemoteBranch = async () => {
      branchSha = targetSha; return { ref: { name: 'conflict/release/1', sha: targetSha, title: '' }, recovered: false };
    };
    (GitLabService.prototype as any).getConflictResolution = async () => ({
      headSha: resolvedSha,
      commits: [{ hash: resolvedSha, shortHash: resolvedSha.slice(0, 8), title: 'resolve conflict', author: 'Test', date: '2026-10-24' }],
      files: ['M\tfile.txt']
    });
    (GitLabService.prototype as any).getMergeRequestsTargetingBranch = async () => ({
      items: creates ? [{ iid: 9, source_branch: 'conflict/release/1', target_branch: 'tst', state: merged ? 'merged' : 'opened', web_url: 'https://gitlab.test/g/p/-/merge_requests/9' }] : [], hasMore: false
    });
    (GitLabService.prototype as any).createMergeRequest = async (payload: any) => {
      assert.equal(originalClosed, false, '原 MR 必须在替代 MR 创建成功后才关闭');
      creates++; description = payload.description;
      assert.equal(payload.targetBranch, 'tst'); assert.equal(payload.squash, false); assert.equal(payload.removeSourceBranch, true);
      return { iid: 9, web_url: 'https://gitlab.test/g/p/-/merge_requests/9' };
    };
    (GitLabService.prototype as any).closeConflictOriginal = async () => {
      closeAttempts++; if (closeFails) throw new Error('close failed'); originalClosed = true;
    };
    (GitLabService.prototype as any).getReviewDetails = async (_project: number, iid: number) => iid === 1 ? {
      project_id: 1, iid: 1, state: originalClosed ? 'closed' : 'opened', source_project_id: 1, target_project_id: 1,
      source_branch: 'release/1', target_branch: 'tst', sha: sourceSha, has_conflicts: true, detailed_merge_status: 'conflict', reviewers: [],
      diff_refs: { head_sha: sourceSha, base_sha: targetSha, start_sha: targetSha }
    } : {
      project_id: 1, iid: 9, state: merged ? 'merged' : 'opened', source_project_id: 1, target_project_id: 1,
      source_branch: 'conflict/release/1', target_branch: 'tst', sha: resolvedSha, reviewers: [],
      diff_refs: { head_sha: resolvedSha, base_sha: targetSha, start_sha: targetSha }
    };
    (GitLabService.prototype as any).cleanupConflictBranch = async () => { cleaned = true; };
    (vscode.window as any).showQuickPick = async (items: any[]) => items[0];
    (vscode.window as any).showWarningMessage = async (_message: string, _options: any, ...items: string[]) => items[0];
    (vscode.window as any).showInputBox = async (options: any) => options.value;

    const service = new GitLabService('https://gitlab.test', 'test');
    const controller = new ConflictSessions(state, tokens);
    assert.equal(await controller.start(service, {
      source: { name: 'release/1', sha: sourceSha, title: '' }, target: { name: 'tst', sha: targetSha, title: '' },
      branch: 'conflict/release/1', originalMr: { iid: 1, webUrl: 'https://gitlab.test/g/p/-/merge_requests/1' }
    }, { id: 1, label: 'g/p', webUrl: 'https://gitlab.test/g/p' }, [2]), true);
    assert.equal(session().stage, 'waitingPush'); assert.equal(originalClosed, false); assert.equal(creates, 0);
    assert.equal(await new ConflictSessions(state, tokens).resume(), false, '未推送时只显示处理指引');

    branchSha = resolvedSha; closeFails = true;
    await assert.rejects(new ConflictSessions(state, tokens).resume(), /close failed/);
    assert.equal(session().stage, 'replacementCreated'); assert.equal(creates, 1); assert.equal(originalClosed, false);
    assert(description.includes('原冲突 MR：https://gitlab.test/g/p/-/merge_requests/1'));
    assert(description.includes('file.txt')); assert(description.includes('分支信息'));

    closeFails = false;
    await new ConflictSessions(state, tokens).resume();
    assert.equal(session().stage, 'mr'); assert.equal(creates, 1); assert.equal(originalClosed, true); assert.equal(closeAttempts, 2);

    const saved = session(); saved.stage = 'mrCreating'; saved.mr = undefined; originalClosed = false;
    await state.update('gitlabMr.conflictSessions.v1', [saved]);
    await new ConflictSessions(state, tokens).resume();
    assert.equal(creates, 1, '结果未知时应从已有替代 MR 恢复，不能重复创建'); assert.equal(session().stage, 'mr');

    merged = true; await new ConflictSessions(state, tokens).resume(); assert.equal(cleaned, true);
    assert.deepEqual(stored.get('gitlabMr.conflictSessions.v1'), []);
    console.log('[PASS] conflict sessions: remote-only flow, delayed original close, recovery, description and archive');
  } finally {
    names.forEach((name, index) => { (GitLabService.prototype as any)[name] = originals[index]; });
    vscode.window.showQuickPick = originalPick; vscode.window.showWarningMessage = originalWarning; vscode.window.showInputBox = originalInput;
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'assert';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import * as vscode from './vscodeMock';
import { ConflictSessions, ConflictSession } from '../src/conflictSession';
import { conflictGit, ensureIdle } from '../src/conflictLocal';
import { GitService } from '../src/gitService';
import { GitLabService } from '../src/gitlabService';
import { AuditApiError } from '../src/audit';

async function run() {
  const directory = mkdtempSync(path.join(tmpdir(), 'conflict-session-'));
  const remote = path.join(directory, 'remote.git'); const root = path.join(directory, 'repo');
  const git = (args: string[]) => conflictGit(root, args);
  const stored = new Map<string, any>();
  const state = { get: (key: string, fallback: any) => structuredClone(stored.get(key) ?? fallback), update: async (key: string, value: any) => { stored.set(key, structuredClone(value)); } } as any;
  const session = () => stored.get('gitlabMr.conflictSessions.v1')[0] as ConflictSession;
  const tokens = { getToken: async () => 'test', promptForToken: async () => undefined } as any;
  const originalRepo = GitService.prototype.getRepoInfo;
  const originalPick = vscode.window.showQuickPick; const originalWarning = vscode.window.showWarningMessage; const originalInput = vscode.window.showInputBox;
  const names = ['getBranchCreationRef', 'createRemoteBranch', 'closeConflictOriginal', 'getMergeRequestsTargetingBranch', 'createMergeRequest', 'getReviewDetails', 'cleanupConflictBranch'] as const;
  const originals = names.map(name => GitLabService.prototype[name]);
  let closes = 0; let creates = 0; let description = ''; let failCreation = true; let merged = false; let cleaned = false;
  try {
    await conflictGit(directory, ['init', '--bare', remote]);
    await conflictGit(directory, ['clone', remote, root]);
    await git(['config', 'user.name', 'Test']); await git(['config', 'user.email', 'test@example.test']);
    await git(['checkout', '-b', 'main']); writeFileSync(path.join(root, 'file.txt'), 'base\n'); await git(['add', '.']); await git(['commit', '-m', 'base']);
    await git(['checkout', '-b', 'release/1']); writeFileSync(path.join(root, 'file.txt'), 'source\n'); await git(['commit', '-am', 'source change']); const sourceSha = await git(['rev-parse', 'HEAD']);
    await git(['checkout', '-b', 'tst', 'main']); writeFileSync(path.join(root, 'file.txt'), 'target\n'); await git(['commit', '-am', 'target change']); const targetSha = await git(['rev-parse', 'HEAD']);
    await git(['push', 'origin', 'main', 'release/1', 'tst']); await git(['checkout', 'main']);
    writeFileSync(path.join(root, 'uncommitted.txt'), 'keep my work');
    await assert.rejects(ensureIdle(root), /未提交/);
    GitService.prototype.getRepoInfo = async () => ({ rootPath: root, remoteUrl: remote, sourceBranch: 'main', gitlabHost: 'gitlab.test', projectPath: 'g/p' });
    (GitLabService.prototype as any).getBranchCreationRef = async (_project: number, _kind: string, name: string) => {
      try { return { name, sha: await conflictGit(remote, ['rev-parse', '--verify', `refs/heads/${name}`]), title: '' }; }
      catch { throw new AuditApiError('not found', 404); }
    };
    (GitLabService.prototype as any).closeConflictOriginal = async () => { closes++; };
    (GitLabService.prototype as any).createRemoteBranch = async (_p: number, name: string, _kind: string, _base: string, sha: string) => {
      if (failCreation) { failCreation = false; throw new Error('temporary network failure'); }
      await conflictGit(remote, ['update-ref', `refs/heads/${name}`, sha]);
      return { ref: { name, sha, title: '' }, recovered: false };
    };
    (GitLabService.prototype as any).getMergeRequestsTargetingBranch = async () => ({ items: creates ? [{ iid: 9, source_branch: 'conflict/release/1', target_branch: 'tst', state: 'opened', web_url: 'https://gitlab.test/g/p/9' }] : [], hasMore: false });
    (GitLabService.prototype as any).createMergeRequest = async (payload: any) => { creates++; description = payload.description; assert.equal(payload.targetBranch, 'tst'); assert.equal(payload.squash, false); assert.equal(payload.removeSourceBranch, true); return { iid: 9, web_url: 'https://gitlab.test/g/p/9' }; };
    (GitLabService.prototype as any).getReviewDetails = async () => ({ state: merged ? 'merged' : 'opened', source_project_id: 1, target_project_id: 1, source_branch: 'conflict/release/1', target_branch: 'tst', sha: session().pushedSha });
    (GitLabService.prototype as any).cleanupConflictBranch = async () => { cleaned = true; };
    (vscode.window as any).showQuickPick = async (items: any[]) => items[0];
    (vscode.window as any).showWarningMessage = async (_m: string, _options: any, ...items: string[]) => items[0];
    (vscode.window as any).showInputBox = async (options: any) => options.value ?? 'conflict(test): TEST-1 resolve conflict';
    const service = new GitLabService('https://gitlab.test', 'test');
    const controller = new ConflictSessions(state, tokens);
    await assert.rejects(controller.start(service, { source: { name: 'release/1', sha: sourceSha, title: '' }, target: { name: 'tst', sha: targetSha, title: '' }, branch: 'conflict/release/1', originalMr: { iid: 1, webUrl: 'https://gitlab.test/g/p/1' } }, { id: 1, label: 'g/p', webUrl: 'https://gitlab.test/g/p' }, [2]), /network/);
    assert.equal(session().stage, 'creating'); assert.equal(closes, 1);
    assert.equal(await new ConflictSessions(state, tokens).resume(), true);
    assert.equal(session().stage, 'resolving'); assert.equal(closes, 1);
    assert.equal(await git(['branch', '--show-current']), 'main');
    assert.equal(await new ConflictSessions(state, tokens).resume(), false); // unresolved files cannot be pushed
    assert.equal(creates, 0);
    const local = session().local;
    writeFileSync(path.join(local, 'file.txt'), 'resolved source and target\n'); await conflictGit(local, ['add', 'file.txt']);
    await new ConflictSessions(state, tokens).resume();
    assert.equal(session().stage, 'mr'); assert.equal(creates, 1);
    assert(description.includes('原冲突 MR：https://gitlab.test/g/p/1'));
    assert(description.includes('file.txt')); assert(description.includes('分支信息'));
    assert.equal(await conflictGit(remote, ['rev-parse', 'refs/heads/tst']), targetSha);
    assert.equal(await conflictGit(remote, ['rev-parse', 'refs/heads/release/1']), sourceSha);
    await new ConflictSessions(state, tokens).resume(); assert.equal(creates, 1);
    const saved = session(); saved.stage = 'mrCreating'; saved.mr = undefined;
    await new ConflictSessions(state, tokens).resume(); assert.equal(creates, 1); // lost response recovered from existing MR
    assert.equal(session().stage, 'mr');
    merged = true; await new ConflictSessions(state, tokens).resume(); assert(cleaned);
    assert.deepEqual(stored.get('gitlabMr.conflictSessions.v1'), []);
    console.log('Conflict sessions: persistent recovery, isolated real Git merge, unresolved blocking, commit/push, replacement MR and archive passed');
  } finally {
    GitService.prototype.getRepoInfo = originalRepo;
    names.forEach((name, index) => { (GitLabService.prototype as any)[name] = originals[index]; });
    vscode.window.showQuickPick = originalPick; vscode.window.showWarningMessage = originalWarning; vscode.window.showInputBox = originalInput;
    rmSync(directory, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });

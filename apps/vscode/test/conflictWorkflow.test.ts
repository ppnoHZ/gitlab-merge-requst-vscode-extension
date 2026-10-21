import assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { conflictGuide, pickConflictPlan } from '../src/conflictWorkflow';
import { GitLabService } from '../src/gitlabService';
import { AuditApiError } from '../src/audit';
import * as vscode from './vscodeMock';

async function run() {
  // A source search page may contain no supported branches while later pages do.
  const service = new GitLabService('https://gitlab.test', 'test-token');
  const originalList = service.getBranchCreationRefs;
  const originalRef = service.getBranchCreationRef;
  const originalPick = vscode.window.showQuickPick;
  const originalInput = vscode.window.showInputBox;
  const source = { name: 'release/LI2500076', sha: 'a'.repeat(40), title: '' };
  const target = { name: 'dev', sha: 'b'.repeat(40), title: '' };
  const pages: number[] = [];
  service.getBranchCreationRefs = async (_id, _kind, page) => {
    pages.push(page!);
    return page === 1 ? { items: [{ ...source, name: 'feature/LI2500076/FOC-1' }], hasMore: true } : { items: [source], hasMore: false };
  };
  service.getBranchCreationRef = async (_id, _kind, name) => ({ ...target, name });
  const choices = ['加载下一页', source.name, 'uat'];
  (vscode.window as any).showQuickPick = async (items: Array<{ label: string }>) => {
    // Neither production nor arbitrary branch names can become a conflict target.
    assert(items.every(item => item.label !== 'main'));
    const choice = choices.shift();
    return items.find(item => item.label === choice);
  };
  (vscode.window as any).showInputBox = async () => '';
  try {
    const plan = await pickConflictPlan(service, 1);
    assert.deepEqual(pages, [1, 2]);
    assert.equal(plan?.source.name, source.name);
    assert.equal(plan?.target.name, 'uat');
    service.getBranchCreationRef = async (_id, _kind, name) => {
      if (name === source.name) return source;
      throw new AuditApiError('not found', 404);
    };
    assert.equal(await pickConflictPlan(service, 1, source.name), undefined);
    assert(vscode.warnings.at(-1)?.includes('不存在 dev、tst、uat、pre'));
    service.getBranchCreationRef = async (_id, _kind, name) => ({ ...target, name });
    (vscode.window as any).showInputBox = async () => undefined;
    assert.equal(await pickConflictPlan(service, 1), undefined);
  } finally {
    service.getBranchCreationRefs = originalList; service.getBranchCreationRef = originalRef;
    vscode.window.showQuickPick = originalPick; vscode.window.showInputBox = originalInput;
  }

  // Exercise the actual generated commands against a local bare remote with conflicting changes.
  const dir = mkdtempSync(join(tmpdir(), 'conflict-guide-git-'));
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(dir, 'init', '--bare', 'remote.git');
    git(dir, 'clone', join(dir, 'remote.git'), 'seed');
    const seed = join(dir, 'seed');
    git(seed, 'config', 'user.name', 'Test'); git(seed, 'config', 'user.email', 'test@example.test');
    git(seed, 'checkout', '-b', 'main');
    writeFileSync(join(seed, 'shared.txt'), 'base\n');
    git(seed, 'add', 'shared.txt'); git(seed, 'commit', '-m', 'initial');
    git(seed, 'checkout', '-b', source.name);
    writeFileSync(join(seed, 'shared.txt'), 'release change\n');
    git(seed, 'commit', '-am', 'release change');
    const sourceSha = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'checkout', '-b', 'dev', 'main');
    writeFileSync(join(seed, 'shared.txt'), 'environment change\n');
    git(seed, 'commit', '-am', 'environment change');
    const targetSha = git(seed, 'rev-parse', 'HEAD');
    const branch = `conflict/${source.name}`;
    git(seed, 'branch', branch, targetSha);
    git(seed, 'push', 'origin', 'main', source.name, 'dev', branch);
    git(dir, 'clone', '--branch', 'main', join(dir, 'remote.git'), 'work');
    const work = join(dir, 'work');
    git(work, 'config', 'user.name', 'Test'); git(work, 'config', 'user.email', 'test@example.test');
    const guide = conflictGuide({ source: { ...source, sha: sourceSha }, target: { ...target, sha: targetSha }, branch });
    const commands = guide.match(/```sh\n([\s\S]*?)\n```/)![1];
    assert.throws(() => execFileSync('bash', ['-e', '-c', commands], { cwd: work, stdio: 'pipe' }), (error: any) => error.status === 1);
    assert.equal(git(work, 'branch', '--show-current'), branch);
    assert.equal(git(work, 'rev-parse', 'HEAD'), targetSha);
    assert.equal(git(work, 'rev-parse', 'MERGE_HEAD'), sourceSha);
    assert.equal(git(work, 'diff', '--name-only', '--diff-filter=U'), 'shared.txt');
    // The guide prepares only the conflict branch; production, source, and target remain untouched remotely.
    assert.equal(git(seed, 'ls-remote', 'origin', 'refs/heads/dev').split(/\s/)[0], targetSha);
    assert.equal(git(seed, 'ls-remote', 'origin', `refs/heads/${source.name}`).split(/\s/)[0], sourceSha);
    writeFileSync(join(work, 'shared.txt'), 'resolved change\n');
    git(work, 'add', 'shared.txt');
    git(work, 'commit', '-m', 'conflict(test): FOC-1 reconcile environment and release');
    git(work, 'push', '--set-upstream', 'origin', branch);
    const resolved = git(work, 'rev-parse', 'HEAD');
    assert.equal(git(seed, 'ls-remote', 'origin', `refs/heads/${branch}`).split(/\s/)[0], resolved);
    assert.equal(git(seed, 'ls-remote', 'origin', 'refs/heads/dev').split(/\s/)[0], targetSha);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log('[PASS] conflict workflow: paginated source selection and generated Git guide resolves on target baseline without writing source/target branches');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

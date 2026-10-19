import assert from 'assert';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { GitService } from '../src/gitService';

async function runTests(): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), 'gitlab-main-merge-test-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const checkout = path.join(root, 'checkout');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    mkdirSync(seed);
    git(root, 'init', '--bare', remote);
    git(seed, 'init', '-b', 'main');
    git(seed, 'config', 'user.name', 'Merge Test');
    git(seed, 'config', 'user.email', 'merge-test@example.com');
    const commitFile = (file: string, content: string) => {
      writeFileSync(path.join(seed, file), content);
      git(seed, 'add', file);
      git(seed, 'commit', '-m', `Update ${file}`);
    };
    commitFile('base.txt', 'base\n');
    const base = git(seed, 'rev-parse', 'HEAD');

    git(seed, 'switch', '-c', 'feature/normal');
    commitFile('normal.txt', 'normal\n');
    git(seed, 'switch', 'main');
    git(seed, 'merge', '--no-ff', 'feature/normal', '-m', 'Merge normally');

    git(seed, 'switch', '-c', 'feature/squash', base);
    commitFile('squash.txt', 'first\n');
    commitFile('squash.txt', 'squashed contents\n');
    git(seed, 'switch', 'main');
    git(seed, 'merge', '--squash', 'feature/squash');
    git(seed, 'commit', '-m', 'Squash merge');

    git(seed, 'switch', '-c', 'feature/rebase', base);
    commitFile('rebased.txt', 'rebased contents\n');
    const originalRebaseCommit = git(seed, 'rev-parse', 'HEAD');
    git(seed, 'switch', 'main');
    git(seed, 'cherry-pick', originalRebaseCommit);
    assert.notEqual(git(seed, 'rev-parse', 'HEAD'), originalRebaseCommit);

    git(seed, 'switch', '-c', 'bugfix/pending', base);
    commitFile('pending.txt', 'not merged\n');
    git(seed, 'switch', '-c', 'release/conflict', base);
    commitFile('base.txt', 'branch change\n');
    git(seed, 'switch', 'main');
    commitFile('base.txt', 'main change\n');
    commitFile('main-only.txt', 'unrelated later main changes\n');
    git(seed, 'branch', 'same-as-main');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', 'origin', '--all');
    git(root, 'clone', '-b', 'main', remote, checkout);

    const service = new GitService(checkout);
    const commands: string[][] = [];
    const instrumented = service as unknown as { runGit(args: string[], conflict?: boolean): Promise<string> };
    const runGit = instrumented.runGit.bind(service);
    instrumented.runGit = (args, conflict) => { commands.push(args); return runGit(args, conflict); };
    const branches = [
      'main', 'feature/normal', 'feature/squash', 'feature/rebase',
      'bugfix/pending', 'release/conflict', 'same-as-main'
    ];
    writeFileSync(path.join(checkout, 'base.txt'), 'local uncommitted change\n');
    writeFileSync(path.join(checkout, 'untracked.txt'), 'untracked\n');
    const statusBefore = git(checkout, 'status', '--porcelain');
    const headBefore = git(checkout, 'rev-parse', 'HEAD');
    const merged = await service.getBranchesMergedIntoMain(branches);
    assert.deepEqual(
      [...merged].sort(),
      ['feature/normal', 'feature/rebase', 'feature/squash', 'same-as-main']
    );
    assert.equal(git(checkout, 'status', '--porcelain'), statusBefore);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), headBefore);
    assert.equal(readFileSync(path.join(checkout, 'base.txt'), 'utf8'), 'local uncommitted change\n');

    assert.equal(commands.filter(args => args[0] === 'merge-tree').length, 4,
      'ordinary merges and identical tips should bypass merge simulation');
    commands.length = 0;
    await Promise.all([
      service.getBranchesMergedIntoMain(branches),
      service.getBranchesMergedIntoMain([...branches].reverse())
    ]);
    assert.equal(commands.filter(args => args[0] === 'fetch').length, 1, 'coalesce simultaneous identical checks');
    assert.equal(commands.filter(args => args[0] === 'merge-tree').length, 0, 'unchanged SHAs reuse comparisons');
    commitFile('main-later.txt', 'main advanced after cache\n');
    git(seed, 'push', 'origin', 'main');
    commands.length = 0;
    assert.equal((await service.getBranchesMergedIntoMain(branches)).has('feature/squash'), true);
    assert.equal(commands.filter(args => args[0] === 'merge-tree').length, 4, 'new main SHA invalidates comparisons');

    git(seed, 'switch', 'feature/squash');
    commitFile('squash-new.txt', 'new changes after merge\n');
    git(seed, 'push', 'origin', 'feature/squash');
    const unrelatedBefore = git(checkout, 'rev-parse', 'refs/remotes/origin/feature/normal');
    git(seed, 'switch', 'feature/normal');
    commitFile('normal-new.txt', 'unrelated branch change\n');
    git(seed, 'push', 'origin', 'feature/normal');
    assert.equal(await service.isBranchMergedIntoMain('feature/squash'), false);
    assert.equal(git(checkout, 'rev-parse', 'refs/remotes/origin/feature/normal'), unrelatedBefore);
    assert.equal(await service.isBranchMergedIntoMain('feature/rebase'), true);
    assert.deepEqual(await service.checkBranchForDeletion('feature/rebase'), {
      merged: true,
      commit: originalRebaseCommit,
      mainCommit: git(seed, 'rev-parse', 'main')
    });
    assert.equal((await service.checkBranchForDeletion('feature/squash')).merged, false);
    assert.equal((await service.checkBranchForDeletion('release/conflict')).merged, false);
    assert.equal(await service.isBranchMergedIntoMain('main'), false);
    assert.equal(git(checkout, 'status', '--porcelain'), statusBefore);
    assert.equal(git(checkout, 'rev-parse', 'HEAD'), headBefore);
    const refreshed = await service.getBranchesMergedIntoMain(branches);
    assert.equal(refreshed.has('feature/squash'), false);
    assert.equal(refreshed.has('feature/rebase'), true);
    assert.equal(refreshed.has('main'), false);
    assert.equal(refreshed.has('feature/normal'), false);
    await assert.rejects(service.getBranchesMergedIntoMain(['feature/normal']), /没有 main/);
    const partial = await service.getBranchesMergedIntoMain(['main', 'missing', 'feature/rebase']);
    assert.equal(partial.has('feature/rebase'), true);
    assert.match(partial.errors?.get('missing') ?? '', /获取远程分支引用失败/);
    assert.equal(partial.has('missing'), false);
    await assert.rejects(service.checkBranchForDeletion('missing'));
    // Exercise isolated failures and the worker bound without relying on wall-clock timings.
    const faultService = new GitService(path.join(root, 'fault-check'));
    const faultRunner = faultService as unknown as { runGit(args: string[]): Promise<string> };
    let active = 0;
    let peak = 0;
    let failComparison = true;
    let failedAttempts = 0;
    faultRunner.runGit = async args => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'rev-parse') return 'main-tree';
      if (args[0] === 'for-each-ref') {
        return args.some(arg => arg.startsWith('--merged=')) ? ''
          : ['main main-sha', ...Array.from({ length: 9 }, (_, i) => `branch-${i} sha-${i}`)].join('\n');
      }
      assert.equal(args[0], 'merge-tree');
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      if (args.at(-1) === 'sha-0') {
        failedAttempts++;
        if (failComparison) throw new Error('Object temporarily unavailable');
      }
      return 'main-tree';
    };
    const faultBranches = ['main', ...Array.from({ length: 9 }, (_, i) => `branch-${i}`)];
    const faultResult = await faultService.getBranchesMergedIntoMain(faultBranches);
    assert.equal(faultResult.size, 8);
    assert.equal(faultResult.errors?.get('branch-0'), 'Object temporarily unavailable');
    assert(peak > 1 && peak <= 4, `expected bounded concurrency, got ${peak}`);
    failComparison = false;
    assert.equal((await faultService.getBranchesMergedIntoMain(faultBranches)).size, 9);
    assert.equal(failedAttempts, 2, 'failed comparisons must be retried, not cached as unmerged');

    git(checkout, 'remote', 'remove', 'origin');
    await assert.rejects(service.getBranchesMergedIntoMain(branches), /origin/);
    console.log('[PASS] main merge checks: normal/squash/rebase, pending/conflicts, fresh remote refs, unchanged worktree, errors');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

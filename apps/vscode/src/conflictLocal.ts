import { execFile } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';

export function conflictGit(root: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error) reject(new Error(stderr.trim() || error.message)); else resolve(stdout.trim());
  }));
}
export async function ensureIdle(root: string): Promise<void> {
  for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD']) {
    const file = await conflictGit(root, ['rev-parse', '--git-path', name]);
    if (existsSync(path.resolve(root, file))) throw new Error('仓库存在未完成的合并、rebase 或 cherry-pick，请先完成或放弃。');
  }
  if (await conflictGit(root, ['status', '--porcelain'])) throw new Error('工作区有未提交改动，请先保存或选择独立 worktree。');
}
export async function unresolved(root: string): Promise<string[]> {
  const output = await conflictGit(root, ['diff', '--name-only', '--diff-filter=U', '-z']);
  return output.split('\0').filter(Boolean);
}
export async function mergeConflictSource(root: string, sourceSha: string): Promise<void> {
  if (!/^[a-f0-9]{40,64}$/i.test(sourceSha)) throw new Error('源提交无效');
  try { await conflictGit(root, ['merge', '--no-commit', '--no-ff', sourceSha]); }
  catch (error) { if (!(await unresolved(root)).length) throw error; }
}

import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import type { MainMergeResult } from '@gitlab-workbench/core';

/** Independent server-side Git adapter. It does not import the extension's Git/API services. */
export class RepositoryChecks {
  private readonly root = join(tmpdir(), `gitlab-workbench-${randomBytes(12).toString('hex')}`);
  private readonly comparisons = new Map<string, boolean>();
  private readonly tasks = new Map<string, Promise<MainMergeResult>>();
  constructor(private readonly instanceUrl: string) {}
  removeSession(id: string): void {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) return;
    const running = [...this.tasks].filter(([key]) => key.startsWith(`${id}:`)).map(([, task]) => task);
    void Promise.allSettled(running).then(() => rm(join(this.root, id), { recursive: true, force: true })).catch(() => {});
  }
  async dispose(): Promise<void> {
    await Promise.allSettled(this.tasks.values());
    await rm(this.root, { recursive: true, force: true });
  }
  check(session: string, project: number, remote: string, token: string, branches: string[]): Promise<MainMergeResult> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session) || !Number.isSafeInteger(project) || project <= 0) throw new Error('仓库缓存标识无效');
    const remoteUrl = new URL(remote);
    const instance = new URL(this.instanceUrl);
    if (remoteUrl.origin !== instance.origin || remoteUrl.username || remoteUrl.password || remoteUrl.search || remoteUrl.hash || !remoteUrl.pathname.startsWith(`${instance.pathname.replace(/\/$/, '')}/`)) throw new Error('GitLab 返回的仓库地址与配置实例不一致');
    const key = `${session}:${project}`;
    const current = this.tasks.get(key);
    if (current) return current;
    const task = this.run(session, project, remoteUrl.href, token, branches).finally(() => this.tasks.delete(key));
    this.tasks.set(key, task);
    return task;
  }
  private async run(session: string, project: number, remote: string, token: string, branches: string[]): Promise<MainMergeResult> {
    const directory = join(this.root, session, String(project));
    await mkdir(directory, { recursive: true, mode: 0o700 });
    // The helper contains no credentials. Git receives the OAuth token only in its child environment.
    const askpass = join(directory, 'askpass.cjs');
    await writeFile(askpass, '#!/usr/bin/env node\nprocess.stdout.write(/username/i.test(process.argv[2] || "") ? "oauth2" : process.env.WORKBENCH_GIT_TOKEN || "");\n', { mode: 0o700 });
    const git = (args: string[], conflict = false): Promise<string> => new Promise((resolve, reject) => {
      execFile('git', ['-c', 'credential.helper=', '-c', 'http.followRedirects=false', ...args], {
        cwd: directory, timeout: 120000, maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: '0', WORKBENCH_GIT_TOKEN: token }
      }, (error, stdout) => {
        if (error) {
          if (conflict && error.code === 1) return resolve('');
          return reject(new Error('Git 仓库检查失败，请确认 Git 可用、仓库读取权限和网络连接'));
        }
        resolve(stdout.trim());
      });
    });
    await git(['init', '--bare', '--quiet', '.']);
    await git(['config', 'remote.origin.url', remote]);
    await git(['fetch', '--quiet', '--no-tags', '--prune', 'origin', '+refs/heads/*:refs/heads/*']);
    const refs = await git(['for-each-ref', '--format=%(refname:strip=2) %(objectname)', 'refs/heads/']);
    const commits = new Map(refs.split('\n').map(line => line.split(' ') as [string, string]));
    const main = commits.get('main');
    if (!main) throw new Error('远程仓库没有 main 分支');
    const mainTree = await git(['rev-parse', `${main}^{tree}`]);
    const ancestors = new Set((await git(['for-each-ref', `--merged=${main}`, '--format=%(objectname)', 'refs/heads/'])).split('\n'));
    const merged: MainMergeResult = new Set();
    merged.errors = new Map();
    const pending = [...new Set(branches)].filter(branch => branch !== 'main');
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
      while (cursor < pending.length) {
        const branch = pending[cursor++];
        try {
          const commit = commits.get(branch);
          if (!commit) throw new Error('分支已变更或删除，请刷新后重试');
          if (ancestors.has(commit)) { merged.add(branch); continue; }
          const key = `${main}:${commit}`;
          let result = this.comparisons.get(key);
          if (result === undefined) {
            result = await git(['merge-tree', '--write-tree', '--no-messages', main, commit], true) === mainTree;
            this.comparisons.set(key, result);
            if (this.comparisons.size > 4096) this.comparisons.delete(this.comparisons.keys().next().value!);
          }
          if (result) merged.add(branch);
        } catch (error) { merged.errors!.set(branch, error instanceof Error ? error.message : 'Git 检查失败'); }
      }
    }));
    return merged;
  }
}

import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitCommitInfo, GitRepoInfo } from './types';
import { Logger } from './logger';

export class GitService {
  constructor(private readonly workspaceRoot: string) {}

  private runGit(args: string[], mergeConflictExpected = false): Promise<string> {
    return new Promise((resolve, reject) => {
      Logger.info(`[执行 Git 命令] git ${args.join(' ')} (cwd: ${this.workspaceRoot})`);
      execFile('git', args, { cwd: this.workspaceRoot }, (error, stdout, stderr) => {
        if (error) {
          if (mergeConflictExpected && error.code === 1) {
            Logger.info('[main 合并检查] 存在合并冲突，不标记为已合入 main');
            return resolve('');
          }
          const errMsg = stderr.trim() || error.message;
          Logger.warn(`[Git 命令返回异常] git ${args.join(' ')}: ${errMsg}`);
          return reject(new Error(errMsg));
        }
        resolve(stdout.trim());
      });
    });
  }

  /**
   * 检查是否是有效的 Git 仓库
   */
  async isGitRepo(): Promise<boolean> {
    try {
      const res = await this.runGit(['rev-parse', '--is-inside-work-tree']);
      return res === 'true';
    } catch {
      return false;
    }
  }

  /**
   * 获取当前分支名称
   */
  async getCurrentBranch(): Promise<string> {
    const branch = await this.runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch === 'HEAD') {
      throw new Error('当前处于 Detached HEAD 状态，请先切换到具体分支。');
    }
    return branch;
  }

  /**
   * 获取远程分支列表（用于选择 target branch）
   */
  async getRemoteBranches(): Promise<string[]> {
    try {
      const output = await this.runGit(['branch', '-r', '--no-color']);
      const branches = output
        .split('\n')
        .map(b => b.trim())
        .filter(b => b && !b.includes('->')) // 过滤 HEAD -> origin/master
        .map(b => b.replace(/^origin\//, ''))
        .filter((val, index, self) => self.indexOf(val) === index);
      return branches;
    } catch {
      return ['master', 'main'];
    }
  }

  async getBranches(): Promise<string[]> {
    const output = await this.runGit(['branch', '--all', '--format=%(refname:short)']);
    return Array.from(new Set(
      output
        .split('\n')
        .map(branch => branch.trim().replace(/^origin\//, ''))
        .filter(branch => branch && branch !== 'HEAD')
    ));
  }

  async isBranchMergedIntoMain(branch: string): Promise<boolean> {
    const merged = await this.getBranchesMergedIntoMain(['main', branch], false);
    return merged.has(branch);
  }

  async checkBranchForDeletion(branch: string): Promise<{ merged: boolean; commit: string; mainCommit: string }> {
    const result = await this.checkBranchesMergedIntoMain(['main', branch], false);
    const commit = result.commits.get(branch);
    const mainCommit = result.commits.get('main');
    if (!commit || !mainCommit) {
      throw new Error('无法获取用于删除检查的分支提交。');
    }
    return { merged: result.merged.has(branch), commit, mainCommit };
  }

  async getBranchesMergedIntoMain(branchNames: string[], fetchAll = true): Promise<Set<string>> {
    return (await this.checkBranchesMergedIntoMain(branchNames, fetchAll)).merged;
  }

  private async checkBranchesMergedIntoMain(
    branchNames: string[],
    fetchAll: boolean
  ): Promise<{ merged: Set<string>; commits: Map<string, string> }> {
    if (!branchNames.includes('main')) {
      throw new Error('远程仓库没有 main 分支，无法检查代码是否已合入 main。');
    }

    const refspecs = fetchAll
      ? ['+refs/heads/*:refs/remotes/origin/*']
      : Array.from(new Set(branchNames)).map(branch => `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
    await this.runGit(['fetch', '--no-tags', '--refmap=', 'origin', ...refspecs]);
    const output = await this.runGit([
      'for-each-ref', '--format=%(refname:strip=3) %(objectname)', 'refs/remotes/origin/'
    ]);
    const commits = new Map(output.split('\n').filter(Boolean).map(line => {
      const [branch, commit] = line.split(' ');
      return [branch, commit];
    }));
    const mainCommit = commits.get('main');
    if (!mainCommit) {
      throw new Error('获取远程 main 引用失败，无法检查合并状态。');
    }
    const mainTree = await this.runGit(['rev-parse', `${mainCommit}^{tree}`]);
    const mergedBranches = new Set<string>();
    for (const branch of branchNames) {
      if (branch === 'main') {
        continue;
      }
      const commit = commits.get(branch);
      if (!commit) {
        throw new Error(`获取远程分支引用失败: ${branch}，请刷新后重试。`);
      }
      // Compare the simulated merge tree, so squash/rebase and later main-only changes are supported.
      const mergedTree = await this.runGit([
        'merge-tree', '--write-tree', '--no-messages', mainCommit, commit
      ], true);
      if (mergedTree === mainTree) {
        mergedBranches.add(branch);
      }
    }
    return { merged: mergedBranches, commits };
  }

  /**
   * 获取远程 origin 的 URL
   */
  async getRemoteUrl(): Promise<string> {
    try {
      return await this.runGit(['config', '--get', 'remote.origin.url']);
    } catch {
      throw new Error('未检测到 remote.origin.url，请先关联远程仓库。');
    }
  }

  /**
   * 解析 GitLab Remote URL，提取 host 与 projectPath (如 group/repo)
   */
  parseGitLabRemote(remoteUrl: string): { host: string; projectPath: string } {
    const trimmed = remoteUrl.trim();
    // 1. SSH URL: git@gitlab.com:group/project.git
    // 2. SSH with protocol: ssh://git@gitlab.com:2222/group/project.git
    // 3. HTTP(S) URL: https://gitlab.com/group/project.git (可能带有用户名 token)
    let host = '';
    let projectPath = '';

    const scpMatch = trimmed.match(/^git@([^:]+):(.+?)(\.git)?$/);
    if (scpMatch) {
      host = scpMatch[1];
      projectPath = scpMatch[2];
    } else {
      try {
        const urlObj = new URL(trimmed);
        host = urlObj.hostname;
        let pathname = urlObj.pathname;
        if (pathname.startsWith('/')) {
          pathname = pathname.substring(1);
        }
        if (pathname.endsWith('.git')) {
          pathname = pathname.substring(0, pathname.length - 4);
        }
        projectPath = pathname;
      } catch (err) {
        // Fallback 正则
        const fallbackMatch = trimmed.match(/(?:https?:\/\/|ssh:\/\/git@)([^/:]+)[:/](.+?)(\.git)?$/);
        if (fallbackMatch) {
          host = fallbackMatch[1];
          projectPath = fallbackMatch[2];
        } else {
          throw new Error(`无法解析 Git Remote URL: ${trimmed}`);
        }
      }
    }

    // 移除尾部 .git
    if (projectPath.endsWith('.git')) {
      projectPath = projectPath.slice(0, -4);
    }

    return { host, projectPath };
  }

  /**
   * 获取 Git 仓库基本信息
   */
  async getRepoInfo(): Promise<GitRepoInfo> {
    const isGit = await this.isGitRepo();
    if (!isGit) {
      throw new Error('当前工作目录不是 Git 仓库。');
    }
    const sourceBranch = await this.getCurrentBranch();
    const remoteUrl = await this.getRemoteUrl();
    const { host, projectPath } = this.parseGitLabRemote(remoteUrl);

    return {
      rootPath: this.workspaceRoot,
      sourceBranch,
      remoteUrl,
      projectPath,
      gitlabHost: host
    };
  }

  private async resolveBranchRef(branch: string): Promise<string> {
    for (const ref of [branch, `origin/${branch}`]) {
      try {
        await this.runGit(['rev-parse', '--verify', ref]);
        return ref;
      } catch {
        // Try the next local/remote reference.
      }
    }
    throw new Error(`找不到分支引用: ${branch}`);
  }

  /**
   * 获取 sourceBranch 相对于 targetBranch 的 Commits 历史
   */
  async getCommitsBetween(sourceBranch: string, targetBranch: string): Promise<GitCommitInfo[]> {
    try {
      const sourceRef = await this.resolveBranchRef(sourceBranch);
      const targetRef = await this.resolveBranchRef(targetBranch);

      // 获取格式化 commits: %H|%h|%s|%an|%ad
      const format = '%H|%h|%s|%an|%ad';
      const output = await this.runGit([
        'log',
        `${targetRef}..${sourceRef}`,
        `--pretty=format:${format}`,
        '--date=short',
        '--no-merges'
      ]);

      if (!output.trim()) {
        // 如果没有 commits，尝试获取最近 1 条 commit 作为兜底
        const lastCommit = await this.runGit([
          'log',
          '-1',
          `--pretty=format:${format}`,
          '--date=short'
        ]);
        if (lastCommit.trim()) {
          const [hash, shortHash, title, author, date] = lastCommit.trim().split('|');
          return [{ hash, shortHash, title, author, date }];
        }
        return [];
      }

      const lines = output.split('\n');
      return lines.map(line => {
        const [hash, shortHash, title, author, date] = line.split('|');
        return {
          hash: hash || '',
          shortHash: shortHash || '',
          title: title || '',
          author: author || '',
          date: date || ''
        };
      });
    } catch (error) {
      Logger.warn(`无法获取 ${sourceBranch} 相对 ${targetBranch} 的提交记录`, error);
      return [];
    }
  }

  /**
   * 获取变动文件清单状态 (如 M  file.ts, A  file2.ts)
   */
  async getChangedFiles(sourceBranch: string, targetBranch: string): Promise<string[]> {
    try {
      const sourceRef = await this.resolveBranchRef(sourceBranch);
      const targetRef = await this.resolveBranchRef(targetBranch);
      const output = await this.runGit(['diff', '--name-status', `${targetRef}...${sourceRef}`]);
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

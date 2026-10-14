import { execFile } from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { GitCommitInfo, GitRepoInfo } from './types';

export class GitService {
  constructor(private readonly workspaceRoot: string) {}

  private runGit(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd: this.workspaceRoot }, (error, stdout, stderr) => {
        if (error) {
          return reject(new Error(stderr.trim() || error.message));
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

  /**
   * 获取 sourceBranch 相对于 targetBranch 的 Commits 历史
   */
  async getCommitsBetween(sourceBranch: string, targetBranch: string): Promise<GitCommitInfo[]> {
    try {
      // 优先与 origin/targetBranch 对比，如果没有则与本地 targetBranch 对比
      let baseRef = `origin/${targetBranch}`;
      try {
        await this.runGit(['rev-parse', '--verify', baseRef]);
      } catch {
        baseRef = targetBranch;
      }

      // 获取格式化 commits: %H|%h|%s|%an|%ad
      const format = '%H|%h|%s|%an|%ad';
      const output = await this.runGit([
        'log',
        `${baseRef}..${sourceBranch}`,
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
    } catch (e: any) {
      // 如果对比失败，回退到当前分支的最近 5 条 commit
      try {
        const output = await this.runGit([
          'log',
          '-5',
          '--pretty=format:%H|%h|%s|%an|%ad',
          '--date=short',
          '--no-merges'
        ]);
        return output
          .split('\n')
          .filter(Boolean)
          .map(line => {
            const [hash, shortHash, title, author, date] = line.split('|');
            return { hash, shortHash, title, author, date };
          });
      } catch {
        return [];
      }
    }
  }

  /**
   * 获取变动文件清单状态 (如 M  file.ts, A  file2.ts)
   */
  async getChangedFiles(sourceBranch: string, targetBranch: string): Promise<string[]> {
    try {
      let baseRef = `origin/${targetBranch}`;
      try {
        await this.runGit(['rev-parse', '--verify', baseRef]);
      } catch {
        baseRef = targetBranch;
      }
      const output = await this.runGit(['diff', '--name-status', `${baseRef}...${sourceBranch}`]);
      return output.split('\n').filter(Boolean);
    } catch {
      return [];
    }
  }
}

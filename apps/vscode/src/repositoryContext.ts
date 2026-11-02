import * as vscode from 'vscode';
import { GitService } from './gitService';
import type { GitRepoInfo } from './types';

const selectedKey = 'gitlabMr.selectedRepository';
let selectedPath: string | undefined;

export interface WorkspaceRepository {
  folder: vscode.WorkspaceFolder;
  repo: GitRepoInfo;
}

export class RepositoryContext {
  constructor(private readonly state: vscode.Memento) {
    selectedPath = state.get<string>(selectedKey);
  }

  async repositories(): Promise<WorkspaceRepository[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const results = await Promise.allSettled(folders.map(async folder => {
      const git = new GitService(folder.uri.fsPath);
      if (!await git.isGitRepo()) return undefined;
      return { folder, repo: await git.getRepoInfo() };
    }));
    return results.flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
  }

  async current(promptWhenMultiple = false): Promise<WorkspaceRepository | undefined> {
    const repositories = await this.repositories();
    if (!repositories.length) return undefined;
    const saved = this.state.get<string>(selectedKey);
    selectedPath = selectedPath ?? saved;
    let selected = repositories.find(item => item.folder.uri.fsPath === saved);
    if (!selected && repositories.length === 1) selected = repositories[0];
    if (!selected || promptWhenMultiple) {
      const picked = await vscode.window.showQuickPick(repositories.map(item => ({
        label: item.repo.projectPath,
        description: item.repo.gitlabHost,
        detail: item.folder.uri.fsPath,
        repository: item
      })), { title: '选择 GitLab 仓库', placeHolder: '后续分支和 MR 操作使用此仓库', ignoreFocusOut: true });
      if (!picked) return selected;
      selected = picked.repository;
    }
    await this.state.update(selectedKey, selected.folder.uri.fsPath);
    selectedPath = selected.folder.uri.fsPath;
    return selected;
  }

  async select(): Promise<WorkspaceRepository | undefined> {
    return this.current(true);
  }
}

export async function selectedWorkspaceRepository(): Promise<WorkspaceRepository | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const preferred = folders.find(item => item.uri.fsPath === selectedPath);
  const ordered = preferred ? [preferred, ...folders.filter(item => item !== preferred)] : folders;
  for (const folder of ordered) {
    try {
      const git = new GitService(folder.uri.fsPath);
      if (!await git.isGitRepo()) continue;
      selectedPath = folder.uri.fsPath;
      return { folder, repo: await git.getRepoInfo() };
    } catch { /* One broken repository must not block the remaining workspace folders. */ }
  }
  return undefined;
}

import { handleCreateRemoteBranch } from './branchCreation';
import { conflictMergeOptions } from './conflictRules';
import * as vscode from 'vscode';
import { randomUUID } from 'crypto';
import { GitService, MainMergeResult } from './gitService';
import { GitLabService } from './gitlabService';
import { TemplateEngine } from './templateEngine';
import { TokenManager } from './tokenManager';
import { Logger } from './logger';
import { debugLog } from './diagnosticLogging';
import { getReleaseFeatureStatuses, getReleaseVersion } from './releaseReadiness';
import { commonBranchFilters, upgradeDefaultBranchFilters, ReleaseReadinessProvider, ReleaseReadinessTreeItem } from './releaseReadinessView';
import { ReleaseFeatureStatus, ReleaseMergeRequest } from './releaseReadiness';
import { PendingReviewItem, PendingReviewsProvider } from './pendingReviewsView';
import { Audit, AuditStore } from './audit';
import { registerAuditView } from './auditView';
import { loadReleaseOverview } from './releaseOverview';
import { ReleaseOverviewProvider } from './releaseOverviewView';
import { WorkbenchFilters, pickWorkbenchFilters } from './workbenchFilters';

let statusBarItem: vscode.StatusBarItem;

export async function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('GitLab Auto MR 插件已成功激活。');
  const auditStore = new AuditStore(undefined, context.extension.packageJSON.version);
  Audit.configure(auditStore);
  registerAuditView(context, auditStore);
  try {
    await auditStore.recover();
  } catch (error) {
    Logger.error('审计存储初始化失败', error);
    vscode.window.showErrorMessage('审计存储不可用，敏感操作已暂停。请在「操作审计」检查目录权限或日志完整性。');
  }
  const registerCommand = <Args extends unknown[]>(name: string, handler: (...args: Args) => unknown) =>
    vscode.commands.registerCommand(name, async (...args: Args) => {
      try {
        // Command entry records describe intent, not a claim that the action succeeded.
        await auditStore.append(randomUUID(), `command.${name.replace('gitlabMr.', '')}`, 'normal', 'requested',
          { source: 'command' });
        return await handler(...args);
      } catch (error) {
        Logger.error(`命令执行失败: ${name}`, error);
        vscode.window.showErrorMessage(`操作失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
    for (const key of ['instanceUrl', 'accessToken', 'allowBranchDeletion', 'hideNonConformingTargetBranches',
      'defaultReviewers', 'removeSourceBranch', 'squash', 'defaultTargetBranch']) {
      if (event.affectsConfiguration(`gitlabMr.${key}`)) {
        void Audit.event('config.observed', { setting: key, source: 'configuration' }, 'sensitive').catch(error => {
          Logger.error('关键配置变更审计失败', error);
          vscode.window.showErrorMessage('关键配置已经变更，但审计记录写入失败；后续敏感操作已暂停。');
        });
      }
    }
  }));

  const tokenManager = new TokenManager(context);
  const overview = new ReleaseOverviewProvider(async () => {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) return undefined;
    const token = await tokenManager.getToken();
    if (!token) return undefined;
    const git = new GitService(workspace.uri.fsPath);
    const repo = await git.getRepoInfo();
    let instanceUrl = vscode.workspace.getConfiguration('gitlabMr', workspace.uri)
      .get<string>('instanceUrl', 'https://gitlab.com').trim();
    if (instanceUrl === 'https://gitlab.com' && repo.gitlabHost !== 'gitlab.com') {
      instanceUrl = `https://${repo.gitlabHost}`;
    }
    const service = new GitLabService(instanceUrl, token);
    const project = await service.getProject(repo.projectPath);
    return loadReleaseOverview(repo.projectPath, {
      branches: page => service.getProjectBranches(project.id, page),
      requests: (branch, page) => service.getMergeRequestsTargetingBranch(project.id, branch, page),
      mergedIntoMain: branches => git.getBranchesMergedIntoMain(branches, false)
    });
  });
  const overviewFilterKey = 'gitlabMr.releaseOverviewFilters';
  overview.setFilters(context.workspaceState.get<WorkbenchFilters>(overviewFilterKey, { main: [], risks: [], updated: 'all' }));
  const overviewTree = vscode.window.createTreeView('gitlabMr.releaseOverview', {
    treeDataProvider: overview, showCollapseAll: true
  });
  const refreshOverview = () => overview.refresh();
  context.subscriptions.push(overview, overviewTree,
    registerCommand('gitlabMr.refreshReleaseOverview', refreshOverview),
    registerCommand('gitlabMr.exportReleaseOverview', () => overview.promptExport()),
    registerCommand('gitlabMr.filterReleaseOverview', async () => {
      const filters = await pickWorkbenchFilters(overview.getFilters(), true);
      if (filters) {
        await context.workspaceState.update(overviewFilterKey, filters);
        overview.setFilters(filters);
      }
    }),
    registerCommand('gitlabMr.clearReleaseOverviewFilters', async () => {
      await context.workspaceState.update(overviewFilterKey, undefined);
      overview.setFilters({});
    }),
    overview.onDidChangeTreeData(() => {
      overviewTree.description = overview.snapshot ? overview.filterSummary : undefined;
      overviewTree.title = overview.hasDisplayFilters ? `上线总览 · ${overview.filterTooltip}` : '上线总览';
    }),
    overviewTree.onDidChangeVisibility(event => {
      if (event.visible && !overview.snapshot) void refreshOverview();
    }),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('gitlabMr.instanceUrl') || event.affectsConfiguration('gitlabMr.accessToken')) {
        overview.invalidate();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => overview.invalidate()),
    context.secrets.onDidChange(event => {
      if (event.key === 'gitlabMr.personalAccessToken') overview.invalidate();
    })
  );
  if (overviewTree.visible) void refreshOverview();
  const pendingReviews = new PendingReviewsProvider(async prompt => {
    let token = await tokenManager.getToken();
    if (!token && prompt) {
      token = await tokenManager.promptForToken();
    }
    if (!token) {
      return undefined;
    }
    const workspace = vscode.workspace.workspaceFolders?.[0];
    let instanceUrl = vscode.workspace.getConfiguration('gitlabMr', workspace?.uri)
      .get<string>('instanceUrl', 'https://gitlab.com').trim();
    if (instanceUrl === 'https://gitlab.com' && workspace) {
      const git = new GitService(workspace.uri.fsPath);
      if (await git.isGitRepo()) {
        const { host } = git.parseGitLabRemote(await git.getRemoteUrl());
        instanceUrl = `https://${host}`;
      }
    }
    return new GitLabService(instanceUrl, token);
  }, true);
  const pendingTreeView = vscode.window.createTreeView('gitlabMr.pendingReviews', {
    treeDataProvider: pendingReviews,
    showCollapseAll: true
  });
  const refreshPendingReviews = async (prompt = true) => {
    await pendingReviews.refresh(prompt);
    pendingTreeView.description = pendingReviews.summary;
  };
  const refreshPendingReviewsCmd = registerCommand('gitlabMr.refreshPendingReviews', () =>
    refreshPendingReviews()
  );
  const runReviewAction = async (title: string, action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      Logger.error(title, error);
      vscode.window.showErrorMessage(`${title}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const loadReviewChanges = (item?: PendingReviewItem, reveal = true) => runReviewAction('加载 MR 变更失败', async () => {
    if (!item) {
      throw new Error('请选择待办 MR。');
    }
    await pendingReviews.loadChanges(item);
    await Audit.event('review.load-changes', { project: item.request?.project_id, mr: item.request?.iid, source: 'command' });
    if (reveal) {
      await pendingTreeView.reveal(item, { expand: 1, select: true });
    }
  });
  const showReviewChangesCmd = registerCommand('gitlabMr.showPendingReviewChanges', loadReviewChanges);
  const openReviewDiffCmd = registerCommand('gitlabMr.openReviewDiff', (item?: PendingReviewItem) =>
    runReviewAction('打开 MR 文件 Diff 失败', async () => {
      if (!item) {
        throw new Error('请选择 MR 变更文件。');
      }
      await pendingReviews.openDiff(item);
    })
  );
  const approveReviewCmd = registerCommand('gitlabMr.approvePendingReview', (item?: PendingReviewItem) =>
    runReviewAction('批准 MR 失败', async () => {
      if (!item) {
        throw new Error('请选择待办 MR。');
      }
      if (await pendingReviews.approve(item)) {
        vscode.window.showInformationMessage(`已批准 MR !${item.request?.iid}，未执行合并。`);
        await refreshPendingReviews(false);
      }
    })
  );
  const mergeReviewCmd = registerCommand('gitlabMr.mergePendingReview', (item?: PendingReviewItem) =>
    runReviewAction('合并 MR 失败', async () => {
      if (!item) {
        throw new Error('请选择待办 MR。');
      }
      if (await pendingReviews.merge(item)) {
        vscode.window.showInformationMessage(`MR !${item.request?.iid} 已合并。`);
        await refreshPendingReviews(false);
      }
    })
  );
  const createConflictFromMrCmd = registerCommand('gitlabMr.createConflictFromMergeRequest', (item?: PendingReviewItem) =>
    runReviewAction('从 MR 创建 conflict 分支失败', async () => {
      if (!item) {
        if (!pendingReviews.loaded) await refreshPendingReviews();
        if (!pendingReviews.loaded) return;
        item = await pendingReviews.pickConflictedRequest();
      }
      if (!item) return;
      if (await pendingReviews.createConflict(item)) {
        await refreshPendingReviews(false);
        overview.invalidate();
      }
    })
  );
  const openPendingReviewCmd = registerCommand('gitlabMr.openPendingReview', async (item?: PendingReviewItem) => {
    try {
      const url = item?.request?.web_url;
      if (!url || !/^https?:\/\//i.test(url)) {
        throw new Error('请选择有效的待办 MR。');
      }
      if (!await vscode.env.openExternal(vscode.Uri.parse(url))) {
        throw new Error('无法打开浏览器中的 MR 页面。');
      }
      await Audit.event('review.open-browser', { project: item?.request?.project_id, mr: item?.request?.iid, source: 'command' });
    } catch (error) {
      Logger.error('打开待审批 MR 失败', error);
      vscode.window.showErrorMessage(`打开待审批 MR 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const pendingVisibility = pendingTreeView.onDidChangeVisibility(event => {
    if (event.visible && !pendingReviews.loaded) {
      void refreshPendingReviews(false);
    }
  });
  const pendingConnectionChanged = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('gitlabMr.instanceUrl') || event.affectsConfiguration('gitlabMr.accessToken')) {
      pendingReviews.reset();
      pendingTreeView.description = undefined;
      if (pendingTreeView.visible) {
        void refreshPendingReviews(false);
      }
    }
  });
  context.subscriptions.push(
    pendingReviews, pendingTreeView, refreshPendingReviewsCmd, openPendingReviewCmd,
    showReviewChangesCmd, openReviewDiffCmd, approveReviewCmd, mergeReviewCmd, createConflictFromMrCmd,
    vscode.workspace.registerTextDocumentContentProvider('gitlab-mr-review', pendingReviews.review),
    pendingTreeView.onDidExpandElement(event => {
      if (event.element.kind === 'request') {
        void loadReviewChanges(event.element, false);
      }
    }),
    pendingVisibility, pendingConnectionChanged,
    context.secrets.onDidChange(event => {
      if (event.key === 'gitlabMr.personalAccessToken') {
        void Audit.event('token.observed', { source: 'configuration' }, 'sensitive').catch(error => {
          Logger.error('凭据变更审计失败', error);
          vscode.window.showErrorMessage('凭据已经变更，但审计写入失败；敏感操作已暂停。');
        });
        pendingReviews.reset();
        pendingTreeView.description = undefined;
        if (pendingTreeView.visible) {
          void refreshPendingReviews(false);
        }
      }
    })
  );
  if (pendingTreeView.visible) {
    void refreshPendingReviews(false);
  }
  const branchFilterStateKey = 'gitlabMr.releaseBranchFilters';
  let savedBranchFilters = context.workspaceState.get<string[] | null>(branchFilterStateKey, commonBranchFilters);
  const defaultsVersionKey = 'gitlabMr.branchFilterDefaultsVersion';
  if (context.workspaceState.get<number>(defaultsVersionKey, 0) < 1) {
    savedBranchFilters = upgradeDefaultBranchFilters(savedBranchFilters);
    await context.workspaceState.update(branchFilterStateKey, savedBranchFilters);
    await context.workspaceState.update(defaultsVersionKey, 1);
  }
  const releaseProvider = new ReleaseReadinessProvider(savedBranchFilters);
  const releaseTreeView = vscode.window.createTreeView('gitlabMr.releaseReadiness', {
    treeDataProvider: releaseProvider,
    showCollapseAll: true
  });
  const branchStatusFilterKey = 'gitlabMr.branchStatusFilters';
  releaseProvider.setFilters(context.workspaceState.get<WorkbenchFilters>(branchStatusFilterKey, { main: [], risks: [], updated: 'all' }));
  context.subscriptions.push(
    registerCommand('gitlabMr.filterBranchStatus', async () => {
      const filters = await pickWorkbenchFilters(releaseProvider.getFilters(), false);
      if (filters) {
        await context.workspaceState.update(branchStatusFilterKey, filters);
        releaseProvider.setFilters(filters);
      }
    }),
    registerCommand('gitlabMr.clearBranchStatusFilters', async () => {
      await context.workspaceState.update(branchStatusFilterKey, undefined);
      releaseProvider.setFilters({});
    }),
    releaseProvider.onDidChangeTreeData(() => {
      releaseTreeView.description = releaseProvider.hasDisplayFilters
        ? releaseProvider.filterSummary : `${releaseProvider.getBranches().length} 个远程分支`;
      releaseTreeView.title = releaseProvider.hasDisplayFilters ? `分支管理 · ${releaseProvider.filterTooltip}` : '分支管理';
    })
  );
  for (const kind of [undefined, 'release', 'hotfix', 'conflict'] as const) {
    const name = kind ? `gitlabMr.create${kind[0].toUpperCase()}${kind.slice(1)}Branch` : 'gitlabMr.createRemoteBranch';
    context.subscriptions.push(registerCommand(name, async (item?: ReleaseReadinessTreeItem) => {
      if (await handleCreateRemoteBranch(tokenManager, kind, item?.branchPath)) {
        try {
          await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, { selectBranch: false, refreshBranches: true });
        } catch (error) {
          Logger.warn('远程分支已创建，但刷新分支列表失败', error);
          vscode.window.showWarningMessage('远程分支已创建，但列表刷新失败，请手动刷新，不要重复创建。');
        }
        overview.invalidate();
        if (overviewTree.visible) void refreshOverview();
      }
    }));
  }
  const filterBranchesByKeywordCmd = registerCommand('gitlabMr.filterBranchesByKeyword', async () => {
    try {
      await handleFilterBranchesByKeyword(releaseProvider, async () => {
        await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, { selectBranch: false });
      });
    } catch (error) {
      Logger.error('搜索远程分支失败', error);
      vscode.window.showErrorMessage(`搜索远程分支失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const retryBranchesCmd = registerCommand('gitlabMr.retryBranches', async () => {
    try {
      await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, { selectBranch: false });
    } catch (error) {
      Logger.error('加载分支失败', error);
      vscode.window.showErrorMessage(`加载分支失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  const loadMoreReleaseCmd = registerCommand('gitlabMr.loadMoreReleaseData', async (item: ReleaseReadinessTreeItem) => {
    try {
      await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, { selectedBranch: item.branchPath, loadMoreRelease: true });
    } catch (error) {
      Logger.error('加载更多上线检查数据失败', error);
      vscode.window.showErrorMessage(`加载更多上线检查数据失败: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

  const filterReleaseBranchesCmd = registerCommand('gitlabMr.filterReleaseBranches', async () => {
    const currentFilters = releaseProvider.getBranchFilters();
    const choices = Array.from(new Set([...commonBranchFilters, ...(currentFilters ?? [])]));
    const selection = await vscode.window.showQuickPick(
      choices.map(label => ({
        label,
        description: label.endsWith('/') ? '匹配该目录下的所有分支' : '精确匹配分支名称',
        picked: currentFilters?.includes(label) ?? false
      })),
      {
        title: '过滤远程分支',
        placeHolder: '多选常用分支；取消全部勾选并确认可恢复显示全部',
        canPickMany: true,
        ignoreFocusOut: true
      }
    );
    if (selection === undefined) {
      return;
    }
    const filters = selection.length > 0 ? selection.map(item => item.label) : null;
    try {
      await context.workspaceState.update(branchFilterStateKey, filters);
      releaseProvider.setBranchFilters(filters);
    } catch (error) {
      Logger.error('保存分支过滤条件失败', error);
      vscode.window.showErrorMessage(
        `保存分支过滤条件失败: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  });

  // 1. 打开可视化设置面板
  const openSettingsCmd = registerCommand('gitlabMr.openSettings', () => {
    debugLog('打开 GitLab MR 设置面板');
    vscode.commands.executeCommand('workbench.action.openSettings', '@id:gitlabMr.');
  });

  const configureInstanceUrlCmd = registerCommand('gitlabMr.configureInstanceUrl', () => {
    debugLog('打开 GitLab 实例地址设置项');
    vscode.commands.executeCommand('workbench.action.openSettings', '@id:gitlabMr.instanceUrl');
  });

  // 2. 注册查看控制台日志命令
  const showLogsCmd = registerCommand('gitlabMr.showLogs', () => {
    Logger.show(true);
  });

  // 3. 注册设置 Token 命令
  const setTokenCmd = registerCommand('gitlabMr.setToken', async () => {
    debugLog('触发设置 Token 操作');
    await tokenManager.promptForToken();
  });

  // 4. 注册创建 Merge Request 命令
  const createMrCmd = registerCommand('gitlabMr.createMergeRequest', async () => {
    try {
      await handleCreateMergeRequest(tokenManager);
    } catch (error: any) {
      Logger.error('创建 GitLab Merge Request 过程中发生异常', error);
      vscode.window
        .showErrorMessage(`创建 GitLab Merge Request 失败: ${error.message}`, '查看详细日志', '打开设置')
        .then(selection => {
          if (selection === '查看详细日志') {
            Logger.show();
          } else if (selection === '打开设置') {
            vscode.commands.executeCommand('workbench.action.openSettings', 'gitlabMr');
          }
        });
    }
  });

  const checkReleaseCmd = registerCommand('gitlabMr.checkReleaseReadiness', async (item?: ReleaseReadinessTreeItem) => {
    try {
      await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, {
        selectedBranch: item?.branchPath
      });
      await vscode.commands.executeCommand('gitlabMr.releaseReadiness.focus');
    } catch (error: any) {
      Logger.error('检查上线分支状态时发生异常', error);
      vscode.window
        .showErrorMessage(`检查上线分支失败: ${error.message}`, '查看详细日志')
        .then(selection => {
          if (selection === '查看详细日志') {
            Logger.show();
          }
        });
    }
  });

  const refreshReleaseCmd = registerCommand('gitlabMr.refreshReleaseReadiness', async () => {
    try {
      await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, {
        selectedBranch: releaseProvider.selectedBranch,
        selectBranch: false,
        refreshBranches: true
      });
    } catch (error: any) {
      Logger.error('刷新上线分支状态时发生异常', error);
      vscode.window.showErrorMessage(`刷新上线检查失败: ${error.message}`, '查看详细日志')
        .then(selection => selection === '查看详细日志' && Logger.show());
    }
  });

  const createReleaseFeatureCmd = registerCommand(
    'gitlabMr.createReleaseFeatureMergeRequest',
    async (input: ReleaseReadinessTreeItem | ReleaseFeatureStatus) => {
      const status = input instanceof ReleaseReadinessTreeItem ? input.status : input;
      const targetBranch = input instanceof ReleaseReadinessTreeItem ? input.branchPath : releaseProvider.releaseBranch;
      if (!status || !targetBranch || status.pending) {
        vscode.window.showWarningMessage('请等待 MR 分页加载完成后再为该功能分支创建 MR。');
        return;
      }
      try {
        await handleCreateMergeRequest(tokenManager, {
          sourceBranch: status.branch,
          targetBranch
        });
        await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, {
          selectedBranch: targetBranch,
          selectBranch: false
        });
      } catch (error: any) {
        Logger.error('从分支管理视图创建 MR 失败', error);
        vscode.window.showErrorMessage(`创建 Merge Request 失败: ${error.message}`, '查看详细日志')
          .then(selection => selection === '查看详细日志' && Logger.show());
      }
    }
  );

  const createMainMrCmd = registerCommand(
    'gitlabMr.createMainMergeRequest',
    async (item?: ReleaseReadinessTreeItem) => {
      try {
        await handleCreateMainMergeRequest(tokenManager, releaseProvider, item);
      } catch (error) {
        Logger.error('从分支创建 MR 失败', error);
        vscode.window.showErrorMessage(
          `创建 Merge Request 失败: ${error instanceof Error ? error.message : String(error)}`,
          '查看详细日志'
        ).then(selection => selection === '查看详细日志' && Logger.show());
      }
    }
  );

  const openReleaseMrCmd = registerCommand(
    'gitlabMr.openReleaseMergeRequest',
    async (input: ReleaseReadinessTreeItem | ReleaseFeatureStatus) => {
      const status = input instanceof ReleaseReadinessTreeItem ? input.status : input;
      const url = status?.mergeRequest?.web_url;
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  );

  const openConfiguredIssueLinkCmd = registerCommand(
    'gitlabMr.openConfiguredIssueLink',
    async (url: string) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  );

  const copyBranchNameCmd = registerCommand(
    'gitlabMr.copyBranchName',
    async (item?: ReleaseReadinessTreeItem) => {
      try {
        await handleCopyBranchName(item);
      } catch (error) {
        Logger.error('复制分支名称失败', error);
        vscode.window.showErrorMessage(
          `复制分支名称失败: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  const deleteBranchCmd = registerCommand(
    'gitlabMr.deleteBranch',
    async (item?: ReleaseReadinessTreeItem) => {
      try {
        if (await handleDeleteBranch(tokenManager, releaseProvider, item)) {
          releaseTreeView.description = releaseProvider.hasDisplayFilters ? releaseProvider.filterSummary : `${releaseProvider.getBranches().length} 个远程分支`;
        }
      } catch (error) {
        Logger.error('删除远程分支失败', error);
        vscode.window.showErrorMessage(
          `删除远程分支失败: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );
  const deletionConfigChanged = vscode.workspace.onDidChangeConfiguration(event => {
    if (event.affectsConfiguration('gitlabMr.allowBranchDeletion')) {
      releaseProvider.refresh();
    }
  });

  // 5. 注册状态栏按钮
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'gitlabMr.createMergeRequest';
  statusBarItem.text = '$(git-pull-request) GitLab MR';
  statusBarItem.tooltip = '一键创建 GitLab Merge Request (点击执行)';
  statusBarItem.show();

  context.subscriptions.push(
    openSettingsCmd,
    configureInstanceUrlCmd,
    showLogsCmd,
    setTokenCmd,
    createMrCmd,
    checkReleaseCmd,
    refreshReleaseCmd,
    filterReleaseBranchesCmd,
    filterBranchesByKeywordCmd,
    retryBranchesCmd,
    loadMoreReleaseCmd,
    createReleaseFeatureCmd,
    createMainMrCmd,
    openReleaseMrCmd,
    openConfiguredIssueLinkCmd,
    copyBranchNameCmd,
    deleteBranchCmd,
    deletionConfigChanged,
    releaseProvider,
    releaseTreeView,
    statusBarItem
  );

  let loadingRemoteBranches = false;
  const loadRemoteBranches = async () => {
    if (loadingRemoteBranches) {
      return;
    }
    loadingRemoteBranches = true;
    try {
      await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, {
        selectBranch: false,
        promptForToken: false
      });
    } catch (error) {
      Logger.error('加载远程分支失败', error);
      vscode.window.showErrorMessage(
        `加载远程分支失败: ${error instanceof Error ? error.message : String(error)}`
      );
    } finally {
      loadingRemoteBranches = false;
    }
  };
  context.subscriptions.push(releaseTreeView.onDidChangeVisibility(event => {
    if (event.visible && releaseProvider.branchPage.page === 0) {
      void loadRemoteBranches();
    }
  }));
  if (releaseTreeView.visible) {
    void loadRemoteBranches();
  }
}

export async function handleFilterBranchesByKeyword(
  provider: ReleaseReadinessProvider,
  loadBranches?: () => Promise<void>
): Promise<void> {
  const keyword = await vscode.window.showInputBox({
    title: '二次过滤分支（关键词）',
    prompt: '搜索 GitLab 远程分支并加载全部匹配结果；常用分支过滤继续生效，清空后确认可取消搜索',
    value: provider.getBranchKeyword(),
    ignoreFocusOut: true
  });
  if (keyword !== undefined) {
    provider.resetBranchPages(keyword);
    await loadBranches?.();
  }
}

export async function handleCreateMainMergeRequest(
  tokenManager: Pick<TokenManager, 'getToken' | 'promptForToken'>,
  provider: ReleaseReadinessProvider,
  item?: ReleaseReadinessTreeItem
) {
  const branch = item?.kind === 'branch' ? item.branchPath
    : item?.kind === 'feature' ? item.status?.branch : undefined;
  if (!branch || branch === 'main') {
    vscode.window.showWarningMessage('请在分支管理视图中选择 main 以外的分支。');
    return;
  }
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    vscode.window.showWarningMessage('请先打开 GitLab 项目的工作区。');
    return;
  }
  const merged = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在检查 ${branch} 是否已合入 main...`,
      cancellable: false
    },
    () => new GitService(workspace.uri.fsPath).isBranchMergedIntoMain(branch)
  );
  provider.setBranchMergedIntoMain(branch, merged);
  if (merged) {
    vscode.window.showInformationMessage(`${branch} 的最新代码已全部合入 main，无需创建 MR。`);
    return;
  }
  await handleCreateMergeRequest(tokenManager, { sourceBranch: branch });
}

export async function handleCopyBranchName(item?: ReleaseReadinessTreeItem): Promise<void> {
  const branch = item?.kind === 'branch' ? item.branchPath
    : item?.kind === 'feature' ? item.status?.branch : undefined;
  if (!branch) {
    throw new Error('请选择远程分支或 feature 分支结果，不能复制目录。');
  }
  await vscode.env.clipboard.writeText(branch);
  await Audit.event('branch.copy', { branch, source: 'command' });
  vscode.window.showInformationMessage(`已复制分支名称: ${branch}`);
}

export async function handleDeleteBranch(
  tokenManager: Pick<TokenManager, 'getToken' | 'promptForToken'>,
  provider: ReleaseReadinessProvider,
  item?: ReleaseReadinessTreeItem
): Promise<boolean> {
  return Audit.operation('branch.delete', 'high', {
    branch: item?.kind === 'branch' ? item.branchPath : item?.status?.branch, source: 'command'
  }, () => deleteBranchAudited(tokenManager, provider, item));
}

async function deleteBranchAudited(
  tokenManager: Pick<TokenManager, 'getToken' | 'promptForToken'>,
  provider: ReleaseReadinessProvider,
  item?: ReleaseReadinessTreeItem
): Promise<boolean> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  const deletionAllowed = () => vscode.workspace.getConfiguration('gitlabMr', workspace?.uri)
    .get<boolean>('allowBranchDeletion', false) === true;
  if (!deletionAllowed()) {
    throw new Error('分支删除功能默认关闭，请先启用 gitlabMr.allowBranchDeletion。');
  }
  const branch = item?.kind === 'branch' ? item.branchPath
    : item?.kind === 'feature' ? item.status?.branch : undefined;
  if (!branch || branch === 'main') {
    throw new Error('请选择 main 以外的远程分支，不能删除目录或 main。');
  }
  if (!workspace) {
    throw new Error('请先打开 GitLab 项目的工作区。');
  }
  const confirmation = await vscode.window.showWarningMessage(
    `确定删除 GitLab 远程分支 ${branch}？仅在最新代码已全部合入 main 时执行；本地分支不会删除。`,
    { modal: true },
    '删除远程分支'
  );
  if (confirmation !== '删除远程分支') {
    return false;
  }
  await Audit.note('confirmed', { branch });
  const token = await tokenManager.getToken() || await tokenManager.promptForToken();
  if (!token) {
    return false;
  }
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在检查并删除远程分支 ${branch}...`,
      cancellable: false
    },
    async () => {
      const gitService = new GitService(workspace.uri.fsPath);
      const repoInfo = await gitService.getRepoInfo();
      let instanceUrl = vscode.workspace.getConfiguration('gitlabMr', workspace.uri)
        .get<string>('instanceUrl', 'https://gitlab.com').trim();
      if (instanceUrl === 'https://gitlab.com' && repoInfo.gitlabHost !== 'gitlab.com') {
        instanceUrl = `https://${repoInfo.gitlabHost}`;
      }
      const service = new GitLabService(instanceUrl, token);
      const project = await service.getProject(repoInfo.projectPath);
      await Audit.note('confirmed', { ...service.auditContext, project: project.id, branch });
      // Never authorize deletion from the cached tree marker.
      provider.setBranchMergedIntoMain(branch, false);
      const { merged, commit, mainCommit } = await gitService.checkBranchForDeletion(branch);
      provider.setBranchMergedIntoMain(branch, merged);
      if (!merged) {
        throw new Error(`${branch} 尚有代码未合入 main（或存在合并冲突），禁止删除。`);
      }
      if (!deletionAllowed()) {
        throw new Error('分支删除功能已关闭，已取消删除。');
      }
      await service.deleteBranch(project.id, branch, commit, mainCommit);
    }
  );
  provider.removeBranch(branch);
  Logger.info(`已删除 GitLab 远程分支: ${branch}`);
  vscode.window.showInformationMessage(`已删除远程分支 ${branch}，本地分支保持不变。`);
  return true;
}

async function handleCreateMergeRequest(
  tokenManager: Pick<TokenManager, 'getToken' | 'promptForToken'>,
  presetBranches?: { sourceBranch: string; targetBranch?: string }
) {
  return Audit.operation('mr.create', 'sensitive', { ...presetBranches, source: 'command' },
    () => createMergeRequestAudited(tokenManager, presetBranches));
}

async function createMergeRequestAudited(
  tokenManager: Pick<TokenManager, 'getToken' | 'promptForToken'>,
  presetBranches?: { sourceBranch: string; targetBranch?: string }
) {
  debugLog('===== 开始执行创建 Merge Request 流程 =====');

  // 1. 获取工作区目录
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    Logger.warn('工作区未打开任何文件夹');
    vscode.window.showWarningMessage('请先在 VS Code 中打开一个 Git 项目工作区。');
    await Audit.note('blocked');
    return false;
  }
  const rootPath = workspaceFolders[0].uri.fsPath;
  debugLog(`当前工作区路径: ${rootPath}`);
  const gitService = new GitService(rootPath);

  // 2. 检查 Git 仓库状态
  const isGit = await gitService.isGitRepo();
  if (!isGit) {
    Logger.warn(`工作区 ${rootPath} 不是有效的 Git 仓库`);
    vscode.window.showWarningMessage('当前工作区不是有效的 Git 仓库。');
    await Audit.note('blocked');
    return false;
  }

  const repoInfo = await gitService.getRepoInfo();
  const currentBranch = repoInfo.sourceBranch;
  debugLog(`检测到当前分支: ${currentBranch}, 远程仓库 URL: ${repoInfo.remoteUrl}, 解析项目路径: ${repoInfo.projectPath}`);

  // 3. 读取配置项
  const config = vscode.workspace.getConfiguration('gitlabMr', workspaceFolders[0].uri);
  let instanceUrl = config.get<string>('instanceUrl', 'https://gitlab.com').trim();
  const defaultTarget = config.get<string>('defaultTargetBranch', 'master');
  const hideNonConformingTargets = config.get<boolean>('hideNonConformingTargetBranches', true);
  const titleTemplate = config.get<string>(
    'titleTemplate',
    'Merge ${sourceBranch} into ${targetBranch}: ${latestCommitTitle}'
  );
  const defaultReviewers = config.get<string[]>('defaultReviewers', []);
  const reviewerConfig = config.inspect<string[]>('defaultReviewers');
  debugLog('[Reviewer 配置] gitlabMr.defaultReviewers', {
    effective: defaultReviewers,
    default: reviewerConfig?.defaultValue,
    user: reviewerConfig?.globalValue,
    workspace: reviewerConfig?.workspaceValue,
    workspaceFolder: reviewerConfig?.workspaceFolderValue
  });
  if (!Array.isArray(defaultReviewers) || !defaultReviewers.every(name => typeof name === 'string')) {
    throw new Error('gitlabMr.defaultReviewers 必须是用户名数组，例如 ["gitlab_reviewer"]，不能是单个字符串。');
  }
  if (defaultReviewers.length === 0) {
    Logger.warn('[Reviewer 配置] 生效配置为空，本次创建 MR 不会指定 Reviewer。请检查 gitlabMr.defaultReviewers 的用户、工作区及文件夹设置。');
  }
  let removeSourceBranch = config.get<boolean>('removeSourceBranch', true);
  let squash = config.get<boolean>('squash', false);
  const autoOpenInBrowser = config.get<boolean>('autoOpenInBrowser', true);

  // 自动探测 GitLab 地址：若配置仍为默认 gitlab.com，但 remote 探测出私有域名
  if (
    instanceUrl === 'https://gitlab.com' &&
    repoInfo.gitlabHost &&
    repoInfo.gitlabHost !== 'gitlab.com'
  ) {
    instanceUrl = `https://${repoInfo.gitlabHost}`;
    debugLog(`已自动从 remote origin 探测到私有 GitLab 实例地址: ${instanceUrl}`);
  } else {
    debugLog(`使用 GitLab 实例地址: ${instanceUrl}`);
  }

  // 4. 获取 Access Token
  let token = await tokenManager.getToken();
  if (!token) {
    Logger.warn('未检测到有效 Access Token，提示用户配置');
    const action = await vscode.window.showInformationMessage(
      '未检测到 GitLab Access Token，请先配置。',
      '打开可视化设置',
      '快速输入 Token'
    );
    if (action === '打开可视化设置') {
      vscode.commands.executeCommand('workbench.action.openSettings', 'gitlabMr.accessToken');
      return false;
    } else if (action === '快速输入 Token') {
      token = await tokenManager.promptForToken();
    }
    if (!token) {
      debugLog('用户取消了 Token 输入');
      return false;
    }
  }

  // 5. 选择源分支，默认聚焦当前分支；上线检查可传入固定分支
  let branches: string[] = [];
  if (!presetBranches?.targetBranch) {
    branches = await gitService.getBranches();
    if (!branches.includes(currentBranch)) {
      branches.unshift(currentBranch);
    }
    debugLog(`检测到本地及远程分支: ${branches.join(', ')}`);
  }

  const sourceBranch = presetBranches?.sourceBranch ?? await selectBranch(
    branches,
    currentBranch,
    `选择 MR 源分支 (默认当前分支: ${currentBranch})`,
    '选择源分支'
  );
  if (!sourceBranch) {
    debugLog('用户取消了选择源分支');
    return false;
  }
  debugLog(`用户选择 MR 源分支: ${sourceBranch}`);

  // 6. 选择目标分支 (Target Branch)

  const branchPicks = TemplateEngine.recommendTargetBranches(
    sourceBranch, branches, defaultTarget, hideNonConformingTargets
  )
    .map(({ branch, reason }) => ({
      label: branch,
      description: [reason, branch === defaultTarget ? '配置的默认目标' : undefined].filter(Boolean).join(' · ')
    }));
  if (!presetBranches?.targetBranch && branchPicks.length === 0) {
    const message = hideNonConformingTargets
      ? `源分支 ${sourceBranch} 没有符合内置合并规则的目标分支。请检查分支列表，或关闭 gitlabMr.hideNonConformingTargetBranches 后重试。`
      : `源分支 ${sourceBranch} 没有可选的目标分支，请检查分支列表和默认目标配置。`;
    Logger.warn(message);
    vscode.window.showWarningMessage(message);
    await Audit.note('blocked', { sourceBranch });
    return false;
  }
  const selectedTarget = presetBranches?.targetBranch ?? (await vscode.window.showQuickPick(branchPicks, {
    placeHolder: hideNonConformingTargets
      ? '选择合并目标分支（仅展示符合内置合并规则的分支）'
      : '选择合并目标分支（推荐分支优先，其余分支仍可选择）',
    title: `当前源分支: ${sourceBranch}`
  }))?.label;

  if (!selectedTarget) {
    debugLog('用户取消了选择目标分支');
    return false;
  }
  ({ removeSourceBranch, squash } = conflictMergeOptions(sourceBranch, { removeSourceBranch, squash }));
  debugLog(`用户选择合并目标分支: ${selectedTarget}`);

  // 7. 收集 Commit 历史和变更文件
  const commits = await gitService.getCommitsBetween(sourceBranch, selectedTarget);
  const changedFiles = await gitService.getChangedFiles(sourceBranch, selectedTarget);
  debugLog(`比对结果: 包含 ${commits.length} 个 Commits, ${changedFiles.length} 个变动文件`);

  // 8. 生成 Title & Description
  const defaultTitle = TemplateEngine.generateTitle(
    titleTemplate,
    sourceBranch,
    selectedTarget,
    commits
  );
  const generatedDescription = TemplateEngine.generateDescription(
    sourceBranch,
    selectedTarget,
    commits,
    changedFiles
  );
  debugLog(`自动生成的 MR Title: "${defaultTitle}"`);

  // 9. 允许用户预览或修改 Title（按回车直接使用自动生成的 Title）
  let promptText = '基于分支规范自动生成，支持直接回车确认或进行微调';
  if (defaultTitle.includes('<Jira号>') || defaultTitle.includes('<JIRA号>')) {
    promptText = '提示：未在分支/提交中识别到 Jira 单号，请补充标题中的 <Jira号> 后回车';
  } else if (defaultTitle.includes('<CRQ>')) {
    promptText = '提示：未在分支/提交中识别到变更单号，请补充标题中的 <CRQ> 后回车';
  }

  if (sourceBranch.startsWith('conflict/')) promptText += '；conflict MR 固定：合并后删除源分支、不 Squash';
  const finalTitle = await vscode.window.showInputBox({
    title: '确认 Merge Request 标题',
    prompt: promptText,
    value: defaultTitle,
    ignoreFocusOut: true,
    validateInput: val => (val && val.trim() ? null : '标题不能为空')
  });

  if (!finalTitle) {
    debugLog('用户取消了标题确认');
    return false;
  }
  await Audit.note('confirmed', { instance: instanceUrl, project: repoInfo.projectPath,
    sourceBranch, targetBranch: selectedTarget, removeSourceBranch, squash });
  debugLog(`最终确认的 MR Title: "${finalTitle.trim()}"`);

  // 10. 弹出进度条并在后台执行 GitLab API 请求
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在创建 GitLab Merge Request...',
      cancellable: false
    },
    async progress => {
      progress.report({ message: '正在连接 GitLab 服务...' });
      const gitlabService = new GitLabService(instanceUrl, token!);

      // 获取项目信息
      progress.report({ message: `正在定位项目: ${repoInfo.projectPath}...` });
      let projectId: string | number = repoInfo.projectPath;
      try {
        const project = await gitlabService.getProject(repoInfo.projectPath);
        if (project && project.id) {
          projectId = project.id;
          debugLog(`根据路径 ${repoInfo.projectPath} 成功获取项目 ID: ${projectId}`);
        }
      } catch (err: any) {
        Logger.warn(`按路径查询项目失败，尝试直接使用 URL 编码路径: ${repoInfo.projectPath}`, err.message);
      }

      // 解析 Reviewer IDs
      let reviewerIds: number[] = [];
      if (defaultReviewers && defaultReviewers.length > 0) {
        progress.report({ message: '正在匹配 Reviewer 账号...' });
        debugLog(`配置中的 Reviewer 用户名: ${defaultReviewers.join(', ')}`);
        const { resolvedIds, notFoundUsers } = await gitlabService.resolveReviewerIds(
          defaultReviewers
        );
        reviewerIds = resolvedIds;
        debugLog(`成功匹配到 Reviewer IDs: ${reviewerIds.join(', ')}`);
        if (notFoundUsers.length > 0) {
          Logger.warn(`未匹配到的 Reviewer 用户: ${notFoundUsers.join(', ')}`);
          throw new Error(
            `未能在 GitLab 找到以下 Reviewer 用户: ${notFoundUsers.join(', ')}。未创建 MR，请检查 gitlabMr.defaultReviewers 配置后重试。`
          );
        }
      }

      // 创建 MR
      progress.report({ message: '正在提交 Merge Request...' });
      const mr = await gitlabService.createMergeRequest({
        projectId,
        sourceBranch,
        targetBranch: selectedTarget,
        title: finalTitle.trim(),
        description: generatedDescription,
        reviewerIds: reviewerIds.length > 0 ? reviewerIds : undefined,
        removeSourceBranch,
        squash
      });

      Logger.info(`Merge Request 创建成功! IID: !${mr.iid}, Web URL: ${mr.web_url}`);
      if (reviewerIds.length > 0) {
        const missingIds = reviewerIds.filter(id => !mr.reviewers?.some(user => user.id === id));
        if (missingIds.length > 0) {
          const message = `MR !${mr.iid} 已创建，但 GitLab 创建响应未确认以下 Reviewer ID: ${missingIds.join(', ')}。请打开该 MR 核对审核人，不要重复创建；查看 GitLab MR 日志以排查。`;
          Logger.warn(message);
          vscode.window.showWarningMessage(message);
        }
      }

      // 创建成功后通知
      const successMessage = `GitLab MR 创建成功: !${mr.iid} ${mr.title}`;
      const openBtn = '在浏览器打开';
      const copyBtn = '复制链接';
      const viewLogsBtn = '查看日志';

      if (autoOpenInBrowser && mr.web_url) {
        vscode.env.openExternal(vscode.Uri.parse(mr.web_url));
      }

      vscode.window
        .showInformationMessage(successMessage, openBtn, copyBtn, viewLogsBtn)
        .then(selection => {
          if (selection === openBtn && mr.web_url) {
            vscode.env.openExternal(vscode.Uri.parse(mr.web_url));
          } else if (selection === copyBtn && mr.web_url) {
            vscode.env.clipboard.writeText(mr.web_url);
            vscode.window.showInformationMessage('MR 链接已复制到剪贴板！');
          } else if (selection === viewLogsBtn) {
            Logger.show();
          }
        });
    }
  );
}

async function selectBranch(
  branches: string[],
  defaultBranch: string,
  placeHolder: string,
  title: string
): Promise<string | undefined> {
  const picker = vscode.window.createQuickPick<vscode.QuickPickItem>();
  const items = branches.map(branch => ({
    label: branch,
    description: branch === defaultBranch ? '当前分支' : undefined
  }));
  const defaultItem = items.find(item => item.label === defaultBranch);

  picker.items = items;
  picker.activeItems = defaultItem ? [defaultItem] : [];
  picker.placeholder = placeHolder;
  picker.title = title;
  picker.ignoreFocusOut = true;

  return new Promise(resolve => {
    picker.onDidAccept(() => {
      resolve(picker.selectedItems[0]?.label ?? picker.activeItems[0]?.label);
      picker.dispose();
    });
    picker.onDidHide(() => {
      resolve(undefined);
      picker.dispose();
    });
    picker.show();
  });
}

export async function handleCheckReleaseReadiness(
  tokenManager: Pick<TokenManager, 'getToken' | 'promptForToken'>,
  provider: ReleaseReadinessProvider,
  treeView: Pick<vscode.TreeView<ReleaseReadinessTreeItem>, 'description' | 'reveal'>,
  options: {
    selectedBranch?: string; selectBranch?: boolean; promptForToken?: boolean; refreshBranches?: boolean;
    loadMoreRelease?: boolean
  } = {}
) {
  if (options.refreshBranches) {
    provider.resetBranchPages();
  }
  const branchState = provider.branchPage;
  const keyword = provider.getBranchKeyword();
  let checkedBranch = !options.loadMoreRelease ? options.selectedBranch : undefined;
  const checkId = {};
  const loadingBranches = !options.loadMoreRelease && branchState.hasMore;
  const releaseBranchToLoad = options.loadMoreRelease ? options.selectedBranch : undefined;
  const releaseState = releaseBranchToLoad ? provider.releasePages.get(releaseBranchToLoad) : undefined;
  if ((loadingBranches && (branchState.loading || !branchState.hasMore)) ||
    (options.loadMoreRelease && (!releaseState || releaseState.loading || !releaseState.hasMore)) ||
    (options.selectedBranch && provider.releasePages.get(options.selectedBranch)?.loading) ||
    (releaseBranchToLoad && provider.checkingBranches.has(releaseBranchToLoad)) ||
    (checkedBranch && provider.checkingBranches.has(checkedBranch))) {
    return;
  }
  if (checkedBranch) {
    provider.checkingBranches.set(checkedBranch, checkId);
  }
  if (loadingBranches) {
    branchState.loading = true;
  }
  if (releaseState) {
    releaseState.loading = true;
  }
  provider.refresh();
  try {
    const workspace = vscode.workspace.workspaceFolders?.[0];
    if (!workspace) {
      if (options.promptForToken !== false) {
        vscode.window.showWarningMessage('请先打开 GitLab 项目的工作区。');
      }
      return;
    }

    let token = await tokenManager.getToken();
    if (!token && options.promptForToken === false) {
      return;
    }

    const gitService = new GitService(workspace.uri.fsPath);
    const repoInfo = await gitService.getRepoInfo();
    const config = vscode.workspace.getConfiguration('gitlabMr');
    let instanceUrl = config.get<string>('instanceUrl', 'https://gitlab.com').trim();
    if (instanceUrl === 'https://gitlab.com' && repoInfo.gitlabHost !== 'gitlab.com') {
      instanceUrl = `https://${repoInfo.gitlabHost}`;
    }

    if (!token) {
      const action = await vscode.window.showInformationMessage(
        '未检测到 GitLab Access Token，请先配置。',
        '打开可视化设置',
        '快速输入 Token'
      );
      if (action === '打开可视化设置') {
        await vscode.commands.executeCommand('workbench.action.openSettings', 'gitlabMr.accessToken');
        return;
      }
      if (action === '快速输入 Token') {
        token = await tokenManager.promptForToken();
      }
      if (!token) {
        return;
      }
    }

    const gitlabService = new GitLabService(instanceUrl, token);
    if (loadingBranches && branchState.page === 0) {
      try {
        const gitlabVersion = await gitlabService.getGitLabVersion();
        debugLog(`GitLab 实例软件版本: ${gitlabVersion.version}${gitlabVersion.revision ? ` (${gitlabVersion.revision})` : ''}`);
      } catch (error: any) {
        debugLog('无法读取 GitLab 实例软件版本（该接口可能受权限限制）', error.message);
      }
    }
    let projectId: number | undefined;
    if (loadingBranches) {
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: '正在获取 GitLab 分支列表...',
            cancellable: false
          },
          async () => {
            const project = await gitlabService.getProject(repoInfo.projectPath);
            projectId = project.id;
            while (branchState.hasMore && provider.branchPage === branchState) {
              const page = await gitlabService.getProjectBranches(projectId, branchState.page + 1, keyword);
              if (provider.branchPage !== branchState) {
                return;
              }
              provider.appendBranchPage(branchState, page);
            }
          }
        );
      } catch (error) {
        branchState.error = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }
    if (provider.branchPage !== branchState) {
      return;
    }
    const branches = provider.getBranches();
    let batchMainResult: MainMergeResult | undefined;
    if (loadingBranches && branches.length > 0) {
      provider.setMainChecksUnknown(branches, '正在检查是否合入 main…');
      try {
        const merged = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: '正在检查分支代码是否已合入 main...',
            cancellable: false
          },
          () => gitService.getBranchesMergedIntoMain([...new Set(['main', ...branches])], false)
        );
        if (provider.branchPage !== branchState) {
          return;
        }
        batchMainResult = merged;
        provider.setMergedIntoMain(merged, merged.errors);
      } catch (error) {
        if (provider.branchPage !== branchState) {
          return;
        }
        provider.setMainChecksUnknown(branches, `main 检查失败: ${error instanceof Error ? error.message : String(error)}`);
        Logger.error('更新分支 main 合入标记失败', error);
        vscode.window.showWarningMessage(
          `无法更新 main 合并标记（分支列表仍可使用）: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    let releaseBranch = options.selectedBranch;
    if (branches.length > 0 && (!releaseBranch || !branches.includes(releaseBranch)) && options.selectBranch !== false) {
      releaseBranch = await selectBranch(
        branches,
        provider.selectedBranch && branches.includes(provider.selectedBranch)
          ? provider.selectedBranch
          : branches[0],
        '选择远程分支（release 分支可检查同版本 feature 的 MR 状态）',
        '选择远程分支'
      );
      if (!releaseBranch) {
        return;
      }
    }
    if (!releaseBranch || !branches.includes(releaseBranch)) {
      treeView.description = provider.hasDisplayFilters ? provider.filterSummary : `${branches.length} 个远程分支`;
      return;
    }
    if (!checkedBranch && !options.loadMoreRelease) {
      if (provider.checkingBranches.has(releaseBranch)) {
        return;
      }
      checkedBranch = releaseBranch;
      provider.checkingBranches.set(checkedBranch, checkId);
    }
    if (provider.branchPage !== branchState) {
      return;
    }
    provider.setBranches(branches, releaseBranch);
    const revealResults = async () => {
      const item = provider.getBranchItem(releaseBranch);
      if (item) {
        await treeView.reveal(item, { select: true, focus: true, expand: 1 });
      }
    };
    if (!options.loadMoreRelease) {
      provider.setMainChecksUnknown([releaseBranch], '正在检查是否合入 main…');
      try {
        if (batchMainResult?.errors?.has(releaseBranch)) {
          throw new Error(batchMainResult.errors.get(releaseBranch));
        }
        const merged = batchMainResult ? batchMainResult.has(releaseBranch) : await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `正在检查 ${releaseBranch} 是否已合入 main...`,
            cancellable: false
          },
          () => gitService.isBranchMergedIntoMain(releaseBranch)
        );
        if (provider.branchPage !== branchState) {
          return;
        }
        provider.setBranchMergedIntoMain(releaseBranch, merged);
        provider.setMainCheck(releaseBranch, releaseBranch === 'main'
          ? '当前分支为 main，无需检查合入自身'
          : merged ? '最新代码已全部合入 main' : '尚有代码未合入 main（或存在合并冲突）');
      } catch (error) {
        if (provider.branchPage !== branchState) {
          return;
        }
        provider.setMainChecksUnknown([releaseBranch], `main 检查失败: ${error instanceof Error ? error.message : String(error)}`);
        provider.setMainCheck(releaseBranch, `main 合入检查失败: ${error instanceof Error ? error.message : String(error)}`);
        Logger.error(`检查 ${releaseBranch} 合入 main 状态失败`, error);
        vscode.window.showWarningMessage(
          `无法更新当前分支的 main 合并标记: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const version = getReleaseVersion(releaseBranch);
    if (!version) {
      treeView.description = provider.hasDisplayFilters ? provider.filterSummary : releaseBranch;
      await revealResults();
      return;
    }
    debugLog(`选择上线分支: ${releaseBranch}, 版本: ${version}`);
    provider.releaseBranch = releaseBranch;

    const state = releaseState ?? provider.startReleasePages(releaseBranch);
    state.loading = true;
    try {
      projectId ??= (await gitlabService.getProject(repoInfo.projectPath)).id;
      const releaseProjectId = projectId;
      const [featurePage, requestPage] = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在检查 ${version} 对应的 feature 分支...`,
          cancellable: false
        },
        () => Promise.all([
          state.moreBranches
            ? gitlabService.getProjectBranches(releaseProjectId, state.page + 1, `^feature/${version}/`)
            : Promise.resolve({ items: [] as string[], hasMore: false }),
          state.moreRequests
            ? gitlabService.getMergeRequestsTargetingBranch(releaseProjectId, releaseBranch, state.page + 1)
            : Promise.resolve({ items: [] as ReleaseMergeRequest[], hasMore: false })
        ])
      );
      if (provider.branchPage !== branchState || provider.releasePages.get(releaseBranch) !== state) {
        return;
      }
      provider.appendReleasePage(releaseBranch, state, featurePage, requestPage);
    } catch (error) {
      state.error = error instanceof Error ? error.message : String(error);
      if (provider.releasePages.get(releaseBranch) === state && state.page === 0) {
        provider.setReadinessMessage(releaseBranch, `MR 检查失败（已加载数据保留，点击加载更多重试）: ${state.error}`);
      }
      await revealResults();
      throw error;
    } finally {
      state.loading = false;
      provider.refresh();
    }
    const statuses = getReleaseFeatureStatuses(releaseBranch, state.branches, state.requests);
    const counts = statuses.reduce((result, item) => {
      result[item.state]++;
      return result;
    }, { merged: 0, open: 0, closed: 0, 'not-created': 0 });
    Logger.info(
      `上线检查${state.hasMore ? '分页结果（非完整结论）' : '完成'} ${releaseBranch}: 已加载 ${statuses.length}, 已合并 ${counts.merged}, 开放中 ${counts.open}, 已关闭 ${counts.closed}, 未创建 MR ${counts['not-created']}`
    );
    treeView.description = provider.hasDisplayFilters ? provider.filterSummary : state.hasMore ? `${version} · 已加载 ${statuses.length} 个 feature（结果未完整）`
      : `${version} · ${counts.merged}/${statuses.length} 已合并`;
    await revealResults();
  } catch (error) {
    if (loadingBranches && provider.branchPage === branchState) {
      branchState.error = error instanceof Error ? error.message : String(error);
    }
    throw error;
  } finally {
    if (loadingBranches) {
      branchState.loading = false;
    }
    if (releaseState) {
      releaseState.loading = false;
    }
    if (checkedBranch && provider.checkingBranches.get(checkedBranch) === checkId) {
      provider.checkingBranches.delete(checkedBranch);
    }
    provider.refresh();
  }
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  Logger.dispose();
}

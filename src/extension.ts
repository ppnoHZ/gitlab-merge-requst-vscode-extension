import * as vscode from 'vscode';
import { GitService } from './gitService';
import { GitLabService } from './gitlabService';
import { TemplateEngine } from './templateEngine';
import { TokenManager } from './tokenManager';
import { Logger } from './logger';
import { getReleaseFeatureStatuses, getReleaseVersion } from './releaseReadiness';
import { commonBranchFilters, ReleaseReadinessProvider, ReleaseReadinessTreeItem } from './releaseReadinessView';
import { ReleaseFeatureStatus, ReleaseMergeRequest } from './releaseReadiness';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('GitLab Auto MR 插件已成功激活。');

  const tokenManager = new TokenManager(context);
  const branchFilterStateKey = 'gitlabMr.releaseBranchFilters';
  const releaseProvider = new ReleaseReadinessProvider(
    context.workspaceState.get<string[] | null>(branchFilterStateKey, commonBranchFilters)
  );
  const releaseTreeView = vscode.window.createTreeView('gitlabMr.releaseReadiness', {
    treeDataProvider: releaseProvider,
    showCollapseAll: true
  });
  const filterBranchesByKeywordCmd = vscode.commands.registerCommand('gitlabMr.filterBranchesByKeyword', async () => {
    await handleFilterBranchesByKeyword(releaseProvider);
  });

  const filterReleaseBranchesCmd = vscode.commands.registerCommand('gitlabMr.filterReleaseBranches', async () => {
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
  const openSettingsCmd = vscode.commands.registerCommand('gitlabMr.openSettings', () => {
    Logger.info('打开 GitLab MR 设置面板');
    vscode.commands.executeCommand('workbench.action.openSettings', '@id:gitlabMr.');
  });

  const configureInstanceUrlCmd = vscode.commands.registerCommand('gitlabMr.configureInstanceUrl', () => {
    Logger.info('打开 GitLab 实例地址设置项');
    vscode.commands.executeCommand('workbench.action.openSettings', '@id:gitlabMr.instanceUrl');
  });

  // 2. 注册查看控制台日志命令
  const showLogsCmd = vscode.commands.registerCommand('gitlabMr.showLogs', () => {
    Logger.show(true);
  });

  // 3. 注册设置 Token 命令
  const setTokenCmd = vscode.commands.registerCommand('gitlabMr.setToken', async () => {
    Logger.info('触发设置 Token 操作');
    await tokenManager.promptForToken();
  });

  // 4. 注册创建 Merge Request 命令
  const createMrCmd = vscode.commands.registerCommand('gitlabMr.createMergeRequest', async () => {
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

  const checkReleaseCmd = vscode.commands.registerCommand('gitlabMr.checkReleaseReadiness', async (item?: ReleaseReadinessTreeItem) => {
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

  const refreshReleaseCmd = vscode.commands.registerCommand('gitlabMr.refreshReleaseReadiness', async () => {
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

  const createReleaseFeatureCmd = vscode.commands.registerCommand(
    'gitlabMr.createReleaseFeatureMergeRequest',
    async (input: ReleaseReadinessTreeItem | ReleaseFeatureStatus) => {
      const status = input instanceof ReleaseReadinessTreeItem ? input.status : input;
      const targetBranch = input instanceof ReleaseReadinessTreeItem ? input.branchPath : releaseProvider.releaseBranch;
      if (!status || !targetBranch) {
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
        Logger.error('从上线检查视图创建 MR 失败', error);
        vscode.window.showErrorMessage(`创建 Merge Request 失败: ${error.message}`, '查看详细日志')
          .then(selection => selection === '查看详细日志' && Logger.show());
      }
    }
  );

  const createMainMrCmd = vscode.commands.registerCommand(
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

  const openReleaseMrCmd = vscode.commands.registerCommand(
    'gitlabMr.openReleaseMergeRequest',
    async (input: ReleaseReadinessTreeItem | ReleaseFeatureStatus) => {
      const status = input instanceof ReleaseReadinessTreeItem ? input.status : input;
      const url = status?.mergeRequest?.web_url;
      if (url) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  );

  const openConfiguredIssueLinkCmd = vscode.commands.registerCommand(
    'gitlabMr.openConfiguredIssueLink',
    async (url: string) => {
      if (typeof url === 'string' && /^https?:\/\//i.test(url)) {
        await vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  );

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
    createReleaseFeatureCmd,
    createMainMrCmd,
    openReleaseMrCmd,
    openConfiguredIssueLinkCmd,
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
    if (event.visible && !releaseProvider.hasBranches) {
      void loadRemoteBranches();
    }
  }));
  if (releaseTreeView.visible) {
    void loadRemoteBranches();
  }
}

export async function handleFilterBranchesByKeyword(provider: ReleaseReadinessProvider): Promise<void> {
  const keyword = await vscode.window.showInputBox({
    title: '二次过滤分支（关键词）',
    prompt: '在现有分支过滤基础上，按完整分支名包含匹配（不区分大小写）；清空后确认可取消二次过滤',
    value: provider.getBranchKeyword(),
    ignoreFocusOut: true
  });
  if (keyword !== undefined) {
    provider.setBranchKeyword(keyword);
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
    vscode.window.showWarningMessage('请在上线检查视图中选择 main 以外的分支。');
    return;
  }
  if (!provider.getBranches().includes('main')) {
    vscode.window.showWarningMessage('远程分支列表中没有 main，请刷新分支列表后重试。');
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

async function handleCreateMergeRequest(
  tokenManager: Pick<TokenManager, 'getToken' | 'promptForToken'>,
  presetBranches?: { sourceBranch: string; targetBranch?: string }
) {
  Logger.info('===== 开始执行创建 Merge Request 流程 =====');

  // 1. 获取工作区目录
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    Logger.warn('工作区未打开任何文件夹');
    vscode.window.showWarningMessage('请先在 VS Code 中打开一个 Git 项目工作区。');
    return;
  }
  const rootPath = workspaceFolders[0].uri.fsPath;
  Logger.info(`当前工作区路径: ${rootPath}`);
  const gitService = new GitService(rootPath);

  // 2. 检查 Git 仓库状态
  const isGit = await gitService.isGitRepo();
  if (!isGit) {
    Logger.warn(`工作区 ${rootPath} 不是有效的 Git 仓库`);
    vscode.window.showWarningMessage('当前工作区不是有效的 Git 仓库。');
    return;
  }

  const repoInfo = await gitService.getRepoInfo();
  const currentBranch = repoInfo.sourceBranch;
  Logger.info(`检测到当前分支: ${currentBranch}, 远程仓库 URL: ${repoInfo.remoteUrl}, 解析项目路径: ${repoInfo.projectPath}`);

  // 3. 读取配置项
  const config = vscode.workspace.getConfiguration('gitlabMr');
  let instanceUrl = config.get<string>('instanceUrl', 'https://gitlab.com').trim();
  const defaultTarget = config.get<string>('defaultTargetBranch', 'master');
  const titleTemplate = config.get<string>(
    'titleTemplate',
    'Merge ${sourceBranch} into ${targetBranch}: ${latestCommitTitle}'
  );
  const defaultReviewers = config.get<string[]>('defaultReviewers', []);
  const removeSourceBranch = config.get<boolean>('removeSourceBranch', true);
  const squash = config.get<boolean>('squash', false);
  const autoOpenInBrowser = config.get<boolean>('autoOpenInBrowser', true);

  // 自动探测 GitLab 地址：若配置仍为默认 gitlab.com，但 remote 探测出私有域名
  if (
    instanceUrl === 'https://gitlab.com' &&
    repoInfo.gitlabHost &&
    repoInfo.gitlabHost !== 'gitlab.com'
  ) {
    instanceUrl = `https://${repoInfo.gitlabHost}`;
    Logger.info(`已自动从 remote origin 探测到私有 GitLab 实例地址: ${instanceUrl}`);
  } else {
    Logger.info(`使用 GitLab 实例地址: ${instanceUrl}`);
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
      return;
    } else if (action === '快速输入 Token') {
      token = await tokenManager.promptForToken();
    }
    if (!token) {
      Logger.warn('用户取消了 Token 输入');
      return;
    }
  }

  // 5. 选择源分支，默认聚焦当前分支；上线检查可传入固定分支
  let branches: string[] = [];
  if (!presetBranches?.targetBranch) {
    branches = await gitService.getBranches();
    if (!branches.includes(currentBranch)) {
      branches.unshift(currentBranch);
    }
    Logger.info(`检测到本地及远程分支: ${branches.join(', ')}`);
  }

  const sourceBranch = presetBranches?.sourceBranch ?? await selectBranch(
    branches,
    currentBranch,
    `选择 MR 源分支 (默认当前分支: ${currentBranch})`,
    '选择源分支'
  );
  if (!sourceBranch) {
    Logger.info('用户取消了选择源分支');
    return;
  }
  Logger.info(`用户选择 MR 源分支: ${sourceBranch}`);

  // 6. 选择目标分支 (Target Branch)

  const branchPicks = TemplateEngine.recommendTargetBranches(sourceBranch, branches, defaultTarget)
    .map(({ branch, reason }) => ({
      label: branch,
      description: [reason, branch === defaultTarget ? '配置的默认目标' : undefined].filter(Boolean).join(' · ')
    }));
  const selectedTarget = presetBranches?.targetBranch ?? (await vscode.window.showQuickPick(branchPicks, {
    placeHolder: '选择合并目标分支（推荐分支优先，其余分支仍可选择）',
    title: `当前源分支: ${sourceBranch}`
  }))?.label;

  if (!selectedTarget) {
    Logger.info('用户取消了选择目标分支');
    return;
  }
  Logger.info(`用户选择合并目标分支: ${selectedTarget}`);

  // 7. 收集 Commit 历史和变更文件
  const commits = await gitService.getCommitsBetween(sourceBranch, selectedTarget);
  const changedFiles = await gitService.getChangedFiles(sourceBranch, selectedTarget);
  Logger.info(`比对结果: 包含 ${commits.length} 个 Commits, ${changedFiles.length} 个变动文件`);

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
  Logger.info(`自动生成的 MR Title: "${defaultTitle}"`);

  // 9. 允许用户预览或修改 Title（按回车直接使用自动生成的 Title）
  let promptText = '基于分支规范自动生成，支持直接回车确认或进行微调';
  if (defaultTitle.includes('<Jira号>') || defaultTitle.includes('<JIRA号>')) {
    promptText = '提示：未在分支/提交中识别到 Jira 单号，请补充标题中的 <Jira号> 后回车';
  } else if (defaultTitle.includes('<CRQ>')) {
    promptText = '提示：未在分支/提交中识别到变更单号，请补充标题中的 <CRQ> 后回车';
  }

  const finalTitle = await vscode.window.showInputBox({
    title: '确认 Merge Request 标题',
    prompt: promptText,
    value: defaultTitle,
    ignoreFocusOut: true,
    validateInput: val => (val && val.trim() ? null : '标题不能为空')
  });

  if (!finalTitle) {
    Logger.info('用户取消了标题确认');
    return;
  }
  Logger.info(`最终确认的 MR Title: "${finalTitle.trim()}"`);

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
          Logger.info(`根据路径 ${repoInfo.projectPath} 成功获取项目 ID: ${projectId}`);
        }
      } catch (err: any) {
        Logger.warn(`按路径查询项目失败，尝试直接使用 URL 编码路径: ${repoInfo.projectPath}`, err.message);
      }

      // 解析 Reviewer IDs
      let reviewerIds: number[] = [];
      if (defaultReviewers && defaultReviewers.length > 0) {
        progress.report({ message: '正在匹配 Reviewer 账号...' });
        Logger.info(`配置中的 Reviewer 用户名: ${defaultReviewers.join(', ')}`);
        const { resolvedIds, notFoundUsers } = await gitlabService.resolveReviewerIds(
          defaultReviewers
        );
        reviewerIds = resolvedIds;
        Logger.info(`成功匹配到 Reviewer IDs: ${reviewerIds.join(', ')}`);
        if (notFoundUsers.length > 0) {
          Logger.warn(`未匹配到的 Reviewer 用户: ${notFoundUsers.join(', ')}`);
          vscode.window.showWarningMessage(
            `未能在 GitLab 找到以下 Reviewer 用户: ${notFoundUsers.join(', ')}`
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
  options: { selectedBranch?: string; selectBranch?: boolean; promptForToken?: boolean; refreshBranches?: boolean } = {}
) {
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
  const refreshBranches = options.refreshBranches === true || !provider.hasBranches;
  if (refreshBranches) {
    provider.clearChecks();
    try {
      const gitlabVersion = await gitlabService.getGitLabVersion();
      Logger.info(`GitLab 实例软件版本: ${gitlabVersion.version}${gitlabVersion.revision ? ` (${gitlabVersion.revision})` : ''}`);
    } catch (error: any) {
      Logger.warn('无法读取 GitLab 实例软件版本（该接口可能受权限限制）', error.message);
    }
  }
  let projectId: number | undefined;
  const branches = refreshBranches ? await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在获取 GitLab 分支列表...',
      cancellable: false
    },
    async () => {
      const project = await gitlabService.getProject(repoInfo.projectPath);
      projectId = project.id;
      return gitlabService.getProjectBranches(projectId);
    }
  ) : provider.getBranches();
  branches.sort();
  let mainCheckError: string | undefined;
  if (refreshBranches) {
    provider.setMergedIntoMain([]);
    provider.setBranches(branches);
  }

  if (branches.length === 0) {
    treeView.description = undefined;
    vscode.window.showInformationMessage('GitLab 项目中没有找到远程分支。');
    return;
  }

  if (refreshBranches) {
    try {
      const mergedBranches = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: '正在同步远程分支并检查代码是否已合入 main...',
          cancellable: false
        },
        () => gitService.getBranchesMergedIntoMain(branches)
      );
      provider.setMergedIntoMain(mergedBranches);
    } catch (error) {
      mainCheckError = error instanceof Error ? error.message : String(error);
      Logger.error('检查远程分支合入 main 状态失败', error);
      vscode.window.showWarningMessage(
        `无法更新 main 合并标记（分支列表仍可使用）: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  let releaseBranch = options.selectedBranch;
  if ((!releaseBranch || !branches.includes(releaseBranch)) && options.selectBranch !== false) {
    releaseBranch = await selectBranch(
      branches,
      provider.selectedBranch && branches.includes(provider.selectedBranch)
        ? provider.selectedBranch
        : branches[0],
      '选择远程分支（release 分支可检查对应 feature 的 MR 状态）',
      '选择远程分支'
    );
    if (!releaseBranch) {
      return;
    }
  }
  if (!releaseBranch || !branches.includes(releaseBranch)) {
    treeView.description = `${branches.length} 个远程分支`;
    return;
  }
  provider.setBranches(branches, releaseBranch);
  const revealResults = async () => {
    const item = provider.getBranchItem(releaseBranch);
    if (item) {
      await treeView.reveal(item, { select: true, focus: true, expand: 1 });
    }
  };
  if (refreshBranches) {
    provider.setMainCheck(releaseBranch, mainCheckError
      ? `main 合入检查失败: ${mainCheckError}`
      : releaseBranch === 'main' ? '当前分支为 main，无需检查合入自身'
      : provider.isMergedIntoMain(releaseBranch)
        ? '最新代码已全部合入 main' : '尚有代码未合入 main（或存在合并冲突）');
  }
  if (!refreshBranches) {
    provider.setBranchMergedIntoMain(releaseBranch, false);
    try {
      const merged = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在检查 ${releaseBranch} 是否已合入 main...`,
          cancellable: false
        },
        () => gitService.isBranchMergedIntoMain(releaseBranch)
      );
      provider.setBranchMergedIntoMain(releaseBranch, merged);
      provider.setMainCheck(releaseBranch, releaseBranch === 'main'
        ? '当前分支为 main，无需检查合入自身'
        : merged ? '最新代码已全部合入 main' : '尚有代码未合入 main（或存在合并冲突）');
    } catch (error) {
      provider.setMainCheck(releaseBranch, `main 合入检查失败: ${error instanceof Error ? error.message : String(error)}`);
      Logger.error(`检查 ${releaseBranch} 合入 main 状态失败`, error);
      vscode.window.showWarningMessage(
        `无法更新当前分支的 main 合并标记: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  const version = getReleaseVersion(releaseBranch);
  if (!version) {
    treeView.description = releaseBranch;
    await revealResults();
    return;
  }
  Logger.info(`选择上线分支: ${releaseBranch}, 版本: ${version}`);

  let mergeRequests: ReleaseMergeRequest[];
  provider.setReadinessMessage(releaseBranch, '正在检查 feature 分支的 MR 状态...');
  try {
    projectId ??= (await gitlabService.getProject(repoInfo.projectPath)).id;
    const releaseProjectId = projectId;
    mergeRequests = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `正在检查 ${version} 对应的 feature 分支...`,
        cancellable: false
      },
      () => gitlabService.getMergeRequestsTargetingBranch(releaseProjectId, releaseBranch)
    );
  } catch (error) {
    provider.setReadinessMessage(releaseBranch, `MR 检查失败: ${error instanceof Error ? error.message : String(error)}`);
    await revealResults();
    throw error;
  }
  const statuses = getReleaseFeatureStatuses(releaseBranch, branches, mergeRequests);
  const counts = statuses.reduce((result, item) => {
    result[item.state]++;
    return result;
  }, { merged: 0, open: 0, closed: 0, 'not-created': 0 });
  Logger.info(
    `上线检查完成 ${releaseBranch}: 总计 ${statuses.length}, 已合并 ${counts.merged}, 开放中 ${counts.open}, 已关闭 ${counts.closed}, 未创建 MR ${counts['not-created']}`
  );
  treeView.description = `${version} · ${counts.merged}/${statuses.length} 已合并`;
  provider.setReadiness(releaseBranch, statuses);
  await revealResults();
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  Logger.dispose();
}

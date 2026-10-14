import * as vscode from 'vscode';
import { GitService } from './gitService';
import { GitLabService } from './gitlabService';
import { TemplateEngine } from './templateEngine';
import { TokenManager } from './tokenManager';
import { Logger } from './logger';
import { getReleaseFeatureStatuses, getReleaseVersion } from './releaseReadiness';
import { ReleaseReadinessProvider, ReleaseReadinessTreeItem } from './releaseReadinessView';
import { ReleaseFeatureStatus } from './releaseReadiness';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  Logger.init();
  Logger.info('GitLab Auto MR 插件已成功激活。');

  const tokenManager = new TokenManager(context);
  const releaseProvider = new ReleaseReadinessProvider();
  const releaseTreeView = vscode.window.createTreeView('gitlabMr.releaseReadiness', {
    treeDataProvider: releaseProvider,
    showCollapseAll: true
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
      await handleCreateMergeRequest(context, tokenManager);
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

  const checkReleaseCmd = vscode.commands.registerCommand('gitlabMr.checkReleaseReadiness', async () => {
    try {
      await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView);
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
      await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, releaseProvider.releaseBranch);
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
      if (!status || !releaseProvider.releaseBranch) {
        return;
      }
      try {
        await handleCreateMergeRequest(context, tokenManager, {
          sourceBranch: status.branch,
          targetBranch: releaseProvider.releaseBranch
        });
        await handleCheckReleaseReadiness(tokenManager, releaseProvider, releaseTreeView, releaseProvider.releaseBranch);
      } catch (error: any) {
        Logger.error('从上线检查视图创建 MR 失败', error);
        vscode.window.showErrorMessage(`创建 Merge Request 失败: ${error.message}`, '查看详细日志')
          .then(selection => selection === '查看详细日志' && Logger.show());
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
    createReleaseFeatureCmd,
    openReleaseMrCmd,
    releaseProvider,
    releaseTreeView,
    statusBarItem
  );
}

async function handleCreateMergeRequest(
  context: vscode.ExtensionContext,
  tokenManager: TokenManager,
  presetBranches?: { sourceBranch: string; targetBranch: string }
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
  if (!presetBranches) {
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

  const branchPicks = Array.from(new Set([defaultTarget, ...branches])).filter(b => b !== sourceBranch);
  const selectedTarget = presetBranches?.targetBranch ?? await vscode.window.showQuickPick(branchPicks, {
    placeHolder: `选择合并目标分支 (默认: ${defaultTarget})`,
    title: `当前源分支: ${sourceBranch}`
  });

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

async function handleCheckReleaseReadiness(
  tokenManager: TokenManager,
  provider: ReleaseReadinessProvider,
  treeView: vscode.TreeView<ReleaseReadinessTreeItem>,
  selectedRelease?: string
) {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  if (!workspace) {
    vscode.window.showWarningMessage('请先打开 GitLab 项目的工作区。');
    return;
  }

  const gitService = new GitService(workspace.uri.fsPath);
  const repoInfo = await gitService.getRepoInfo();
  const config = vscode.workspace.getConfiguration('gitlabMr');
  let instanceUrl = config.get<string>('instanceUrl', 'https://gitlab.com').trim();
  if (instanceUrl === 'https://gitlab.com' && repoInfo.gitlabHost !== 'gitlab.com') {
    instanceUrl = `https://${repoInfo.gitlabHost}`;
  }

  let token = await tokenManager.getToken();
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
  const project = await gitlabService.getProject(repoInfo.projectPath);
  const projectId = project.id;
  Logger.info(`开始检查上线分支，GitLab 项目 ID: ${projectId}`);

  const branches = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: '正在获取 GitLab 分支列表...',
      cancellable: false
    },
    () => gitlabService.getProjectBranches(projectId)
  );
  const releaseBranches = branches
    .filter(branch => getReleaseVersion(branch) !== undefined)
    .sort();

  if (releaseBranches.length === 0) {
    vscode.window.showInformationMessage('GitLab 项目中没有找到有效的 release/<version> 分支。');
    return;
  }

  let releaseBranch = selectedRelease;
  if (!releaseBranch || !releaseBranches.includes(releaseBranch)) {
    releaseBranch = await selectBranch(
      releaseBranches,
      provider.releaseBranch && releaseBranches.includes(provider.releaseBranch)
        ? provider.releaseBranch
        : releaseBranches[0],
      '选择本次上线的 release 分支',
      '选择上线版本'
    );
    if (!releaseBranch) {
      return;
    }
  }
  const version = getReleaseVersion(releaseBranch)!;
  Logger.info(`选择上线分支: ${releaseBranch}, 版本: ${version}`);

  const mergeRequests = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `正在检查 ${version} 对应的 feature 分支...`,
      cancellable: false
    },
    () => gitlabService.getMergeRequestsTargetingBranch(projectId, releaseBranch)
  );
  const statuses = getReleaseFeatureStatuses(releaseBranch, branches, mergeRequests);
  const counts = statuses.reduce((result, item) => {
    result[item.state]++;
    return result;
  }, { merged: 0, open: 0, closed: 0, 'not-created': 0 });
  Logger.info(
    `上线检查完成 ${releaseBranch}: 总计 ${statuses.length}, 已合并 ${counts.merged}, 开放中 ${counts.open}, 已关闭 ${counts.closed}, 未创建 MR ${counts['not-created']}`
  );
  provider.setReadiness(releaseBranch, statuses);
  treeView.description = `${version} · ${counts.merged}/${statuses.length} 已合并`;
  await vscode.commands.executeCommand('workbench.view.explorer');
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
  Logger.dispose();
}


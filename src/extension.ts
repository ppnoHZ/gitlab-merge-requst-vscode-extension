import * as vscode from 'vscode';
import { GitService } from './gitService';
import { GitLabService } from './gitlabService';
import { TemplateEngine } from './templateEngine';
import { TokenManager } from './tokenManager';

let statusBarItem: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext) {
  const tokenManager = new TokenManager(context);

  // 1. 注册设置 Token 命令
  const setTokenCmd = vscode.commands.registerCommand('gitlabMr.setToken', async () => {
    await tokenManager.promptForToken();
  });

  // 2. 注册创建 Merge Request 命令
  const createMrCmd = vscode.commands.registerCommand('gitlabMr.createMergeRequest', async () => {
    try {
      await handleCreateMergeRequest(context, tokenManager);
    } catch (error: any) {
      vscode.window.showErrorMessage(`创建 GitLab Merge Request 失败: ${error.message}`);
    }
  });

  // 3. 注册状态栏按钮
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.command = 'gitlabMr.createMergeRequest';
  statusBarItem.text = '$(git-pull-request) GitLab MR';
  statusBarItem.tooltip = '一键创建 GitLab Merge Request';
  statusBarItem.show();

  context.subscriptions.push(setTokenCmd, createMrCmd, statusBarItem);
}

async function handleCreateMergeRequest(
  context: vscode.ExtensionContext,
  tokenManager: TokenManager
) {
  // 1. 获取工作区目录
  const workspaceFolders = vscode.workspace.workspaceFolders;
  if (!workspaceFolders || workspaceFolders.length === 0) {
    vscode.window.showWarningMessage('请先在 VS Code 中打开一个 Git 项目工作区。');
    return;
  }
  const rootPath = workspaceFolders[0].uri.fsPath;
  const gitService = new GitService(rootPath);

  // 2. 检查 Git 仓库状态
  const isGit = await gitService.isGitRepo();
  if (!isGit) {
    vscode.window.showWarningMessage('当前工作区不是有效的 Git 仓库。');
    return;
  }

  const repoInfo = await gitService.getRepoInfo();
  const sourceBranch = repoInfo.sourceBranch;

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
  }

  // 4. 获取 Access Token
  let token = await tokenManager.getToken();
  if (!token) {
    const action = await vscode.window.showInformationMessage(
      '未检测到 GitLab Access Token，请先配置。',
      '立即输入 Token'
    );
    if (action === '立即输入 Token') {
      token = await tokenManager.promptForToken();
    }
    if (!token) {
      return;
    }
  }

  // 5. 选择目标分支 (Target Branch)
  const remoteBranches = await gitService.getRemoteBranches();
  const branchPicks = Array.from(new Set([defaultTarget, ...remoteBranches])).filter(
    b => b !== sourceBranch
  );

  const selectedTarget = await vscode.window.showQuickPick(branchPicks, {
    placeHolder: `选择合并目标分支 (默认: ${defaultTarget})`,
    title: `当前源分支: ${sourceBranch}`
  });

  if (!selectedTarget) {
    return; // 用户取消
  }

  // 6. 收集 Commit 历史和变更文件
  const commits = await gitService.getCommitsBetween(sourceBranch, selectedTarget);
  const changedFiles = await gitService.getChangedFiles(sourceBranch, selectedTarget);

  // 7. 生成 Title & Description
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

  // 8. 允许用户预览或修改 Title（按回车直接使用自动生成的 Title）
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
    return; // 用户取消
  }

  // 9. 弹出进度条并在后台执行 GitLab API 请求
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
        }
      } catch (err: any) {
        // 如果按路径查不到，尝试继续使用 encodeURIComponent(projectPath)
      }

      // 解析 Reviewer IDs
      let reviewerIds: number[] = [];
      if (defaultReviewers && defaultReviewers.length > 0) {
        progress.report({ message: '正在匹配 Reviewer 账号...' });
        const { resolvedIds, notFoundUsers } = await gitlabService.resolveReviewerIds(
          defaultReviewers
        );
        reviewerIds = resolvedIds;
        if (notFoundUsers.length > 0) {
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

      // 创建成功后通知
      const successMessage = `GitLab MR 创建成功: !${mr.iid} ${mr.title}`;
      const openBtn = '在浏览器打开';
      const copyBtn = '复制链接';

      if (autoOpenInBrowser && mr.web_url) {
        vscode.env.openExternal(vscode.Uri.parse(mr.web_url));
      }

      vscode.window
        .showInformationMessage(successMessage, openBtn, copyBtn)
        .then(selection => {
          if (selection === openBtn && mr.web_url) {
            vscode.env.openExternal(vscode.Uri.parse(mr.web_url));
          } else if (selection === copyBtn && mr.web_url) {
            vscode.env.clipboard.writeText(mr.web_url);
            vscode.window.showInformationMessage('MR 链接已复制到剪贴板！');
          }
        });
    }
  );
}

export function deactivate() {
  if (statusBarItem) {
    statusBarItem.dispose();
  }
}

import * as vscode from 'vscode';
import { createRepositoryProvider } from './providers/factory';
import { configuredConnection } from './providers/connection';
import type { TokenManager } from './tokenManager';
import type { WorkspaceRepository } from './repositoryContext';

export async function showConnectionDiagnostics(repository: WorkspaceRepository | undefined, tokens: TokenManager): Promise<void> {
  const lines = ['# GitLab 连接诊断', ''];
  if (!repository) lines.push('- ❌ Git Remote：未发现工作区 Git 仓库', '  - 建议：打开包含 `.git` 和 `origin` 的项目目录。');
  else {
    const connection = configuredConnection(repository.repo, repository.folder.uri);
    lines.push(`- ✅ Git Remote：\`${repository.repo.remoteUrl}\``, `- ✅ GitLab 地址：\`${connection.instanceUrl}\``, `- ✅ 项目路径：\`${repository.repo.projectPath}\``);
    const token = await tokens.getToken(connection);
    if (!token) lines.push('- ❌ Token：SecretStorage 中没有此实例的 Token', '  - 建议：执行“GitLab MR: Set Access Token”。');
    else {
      lines.push('- ✅ Token：已在 VS Code SecretStorage 中找到（内容不会显示）');
      try {
        const provider = createRepositoryProvider(connection, token);
        const [user, project] = await Promise.all([provider.getCurrentUser(), provider.getProject(repository.repo.projectPath)]);
        lines.push(`- ✅ Token 权限：已认证为 \`${user.username}\``, `- ✅ 项目权限：可以访问 \`${repository.repo.projectPath}\`（项目 ID ${project.id}）`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        lines.push(`- ❌ API / 项目访问：${message}`);
        if (/401|unauthorized/i.test(message)) lines.push('  - 建议：重新生成具有 `api` 权限的 Token。');
        else if (/403|forbidden/i.test(message)) lines.push('  - 建议：确认账号具有该项目权限，且 Token 未被管理员策略限制。');
        else if (/certificate|ssl|self signed/i.test(message)) lines.push('  - 建议：将公司 CA 安装到系统或 VS Code 使用的证书信任链。');
        else lines.push('  - 建议：检查 VS Code `http.proxy`、VPN、GitLab 地址和公司证书。');
      }
    }
  }
  lines.push('', '> 诊断不会输出 Token、请求头或代码内容。');
  const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: lines.join('\n') });
  await vscode.window.showTextDocument(document, { preview: false });
}

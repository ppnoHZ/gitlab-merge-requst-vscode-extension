import * as vscode from 'vscode';

export class TokenManager {
  private static readonly SECRET_KEY = 'gitlabMr.personalAccessToken';

  constructor(private readonly context: vscode.ExtensionContext) {}

  /**
   * 获取 Access Token：优先从 SecretStorage 获取，其次从配置项获取
   */
  async getToken(): Promise<string | undefined> {
    const secretToken = await this.context.secrets.get(TokenManager.SECRET_KEY);
    if (secretToken && secretToken.trim()) {
      return secretToken.trim();
    }

    const config = vscode.workspace.getConfiguration('gitlabMr');
    const configToken = config.get<string>('accessToken');
    if (configToken && configToken.trim()) {
      return configToken.trim();
    }

    return undefined;
  }

  /**
   * 将 Access Token 安全保存至 SecretStorage
   */
  async setToken(token: string): Promise<void> {
    await this.context.secrets.store(TokenManager.SECRET_KEY, token.trim());
  }

  /**
   * 删除保存的 Token
   */
  async clearToken(): Promise<void> {
    await this.context.secrets.delete(TokenManager.SECRET_KEY);
  }

  /**
   * 弹出输入框引导用户设置 Token
   */
  async promptForToken(): Promise<string | undefined> {
    const token = await vscode.window.showInputBox({
      title: 'GitLab Personal Access Token',
      prompt: '请输入您的 GitLab Personal Access Token (需要 api 读写权限)',
      password: true,
      ignoreFocusOut: true,
      placeHolder: 'glpat-xxxxxxxxxxxxxxxxxxxx'
    });

    if (token && token.trim()) {
      await this.setToken(token.trim());
      vscode.window.showInformationMessage('GitLab Access Token 已安全保存。');
      return token.trim();
    }
    return undefined;
  }
}

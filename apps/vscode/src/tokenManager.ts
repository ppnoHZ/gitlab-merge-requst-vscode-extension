import * as vscode from 'vscode';
import { Audit } from './audit';
import { configuredConnection, credentialKey } from './providers/connection';
import type { ProviderConnection } from './providers/repositoryProvider';

export class TokenManager {
  constructor(private readonly context: Pick<vscode.ExtensionContext, 'secrets'>) {}

  async getToken(connection: ProviderConnection = configuredConnection()): Promise<string | undefined> {
    const key = credentialKey(connection);
    const scoped = await this.context.secrets.get(key);
    if (scoped?.trim()) {
      if (this.isConfiguredGitLab(connection)) await this.removeLegacyCredentials();
      return scoped.trim();
    }
    // Legacy credentials belong only to the configured GitLab instance, never GitHub.
    if (!this.isConfiguredGitLab(connection)) return undefined;
    const binding = await this.context.secrets.get('gitlabMr.legacyTokenInstance');
    if (binding && binding !== key) return undefined;
    const legacy = this.legacyConfiguration().get<string>('accessToken')?.trim()
      || (await this.context.secrets.get('gitlabMr.personalAccessToken'))?.trim();
    if (!legacy) return undefined;
    await this.context.secrets.store(key, legacy);
    await this.removeLegacyCredentials();
    await this.context.secrets.store('gitlabMr.legacyTokenInstance', key);
    return legacy;
  }

  async setToken(token: string, connection: ProviderConnection = configuredConnection()): Promise<void> {
    await Audit.sensitive('token.set', 'sensitive', { source: 'command', instance: connection.instanceUrl }, async () => {
      await this.context.secrets.store(credentialKey(connection), token.trim());
    });
  }

  async clearToken(connection: ProviderConnection = configuredConnection()): Promise<void> {
    await Audit.sensitive('token.clear', 'sensitive', { source: 'command', instance: connection.instanceUrl }, async () => {
      await this.context.secrets.delete(credentialKey(connection));
      if (this.isConfiguredGitLab(connection)) {
        await this.removeLegacyCredentials();
        await this.context.secrets.store('gitlabMr.legacyTokenInstance', 'disabled');
      }
    });
  }

  async promptForToken(connection: ProviderConnection = configuredConnection()): Promise<string | undefined> {
    const platform = connection.kind === 'github' ? 'GitHub' : 'GitLab';
    const token = await vscode.window.showInputBox({
      title: `${platform} Personal Access Token`,
      prompt: `${connection.instanceUrl}：${connection.kind === 'github' ? '需要目标仓库 Contents 和 Pull requests 读写权限' : '需要 api 权限'}`,
      password: true, ignoreFocusOut: true
    });
    if (!token?.trim()) return undefined;
    await this.setToken(token, connection);
    vscode.window.showInformationMessage(`${platform} Access Token 已安全保存。`);
    return token.trim();
  }

  private isConfiguredGitLab(connection: ProviderConnection): boolean {
    const configured = configuredConnection();
    return connection.kind === 'gitlab' && connection.instanceUrl === configured.instanceUrl;
  }

  private legacyConfiguration(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('gitlabMr');
  }

  private async removeLegacyCredentials(): Promise<void> {
    const configuration = this.legacyConfiguration();
    const legacy = configuration.inspect<string>('accessToken');
    // Remove every possible scope so plaintext cannot remain in user settings, Settings Sync or repository files.
    if (legacy?.workspaceValue !== undefined) await configuration.update('accessToken', undefined, vscode.ConfigurationTarget.Workspace);
    if (legacy?.globalValue !== undefined) await configuration.update('accessToken', undefined, vscode.ConfigurationTarget.Global);
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const folderConfiguration = vscode.workspace.getConfiguration('gitlabMr', folder.uri);
      if (folderConfiguration.inspect<string>('accessToken')?.workspaceFolderValue !== undefined) {
        await folderConfiguration.update('accessToken', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      }
    }
    if (await this.context.secrets.get('gitlabMr.personalAccessToken') !== undefined) {
      await this.context.secrets.delete('gitlabMr.personalAccessToken');
    }
  }
}

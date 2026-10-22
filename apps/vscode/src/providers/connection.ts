import * as vscode from 'vscode';
import type { ProviderConnection, ProviderKind } from './repositoryProvider';

function address(value: string): string {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('平台地址必须是 HTTP(S) 地址，不能包含凭据、查询参数或片段');
  }
  return url.href.replace(/\/+$/, '');
}

export function resolveProviderConnection(input: {
  provider?: string; instanceUrl?: string; apiUrl?: string; remoteHost?: string; remoteUrl?: string;
}): ProviderConnection {
  const selected = input.provider ?? 'auto';
  if (!['auto', 'gitlab', 'github'].includes(selected)) throw new Error('平台类型必须是 auto、gitlab 或 github');
  let instance = input.instanceUrl?.trim() || 'https://gitlab.com';
  if (instance === 'https://gitlab.com' && input.remoteHost) {
    instance = `https://${input.remoteHost}`;
    // HTTP Git remotes can carry a custom web port; SSH ports must never become API ports.
    if (input.remoteUrl && /^https?:\/\//i.test(input.remoteUrl)) instance = new URL(input.remoteUrl).origin;
  } else if (selected === 'github' && instance === 'https://gitlab.com' && !input.remoteHost) {
    instance = 'https://github.com';
  }
  instance = address(instance);
  const kind: ProviderKind = selected === 'auto' ? (new URL(instance).hostname === 'github.com' ? 'github' : 'gitlab') : selected as ProviderKind;
  const apiUrl = kind === 'gitlab' ? `${instance}/api/v4`
    : address(input.apiUrl?.trim() || (new URL(instance).hostname === 'github.com' ? 'https://api.github.com' : `${instance}/api/v3`));
  return { kind, instanceUrl: instance, apiUrl };
}

export function configuredConnection(remote?: { gitlabHost?: string; remoteUrl?: string }, resource?: vscode.Uri): ProviderConnection {
  const config = vscode.workspace.getConfiguration('gitlabMr', resource);
  return resolveProviderConnection({ provider: config.get<string>('provider', 'auto'), instanceUrl: config.get<string>('instanceUrl', 'https://gitlab.com'),
    apiUrl: config.get<string>('githubApiUrl', ''), remoteHost: remote?.gitlabHost, remoteUrl: remote?.remoteUrl });
}

export function credentialKey(connection: ProviderConnection): string {
  return `gitlabMr.credentials:${connection.kind}:${encodeURIComponent(connection.instanceUrl)}:${encodeURIComponent(connection.apiUrl)}`;
}

import { GitLabService } from '../gitlabService';
import { GitHubProvider } from './githubProvider';
import type { ProviderConnection, RepositoryProvider } from './repositoryProvider';

export function createRepositoryProvider(connection: ProviderConnection, token: string): RepositoryProvider {
  return connection.kind === 'github' ? new GitHubProvider(connection, token) : new GitLabService(connection.instanceUrl, token);
}

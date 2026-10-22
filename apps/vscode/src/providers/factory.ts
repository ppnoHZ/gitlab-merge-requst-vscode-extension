import { createHash } from 'crypto';
import { GitLabService } from '../gitlabService';
import { GitHubProvider } from './githubProvider';
import { SharedReads } from './sharedReads';
import type { ProviderConnection, RepositoryProvider } from './repositoryProvider';

const providers = new Map<string, { provider: RepositoryProvider; reads: SharedReads; controller: AbortController }>();
const sharedMethods = new Set(['getCurrentUser', 'getReviewMergeRequests', 'hasUserApprovedMergeRequest']);

export function invalidateRepositoryProviders(): void {
  for (const entry of providers.values()) { entry.controller.abort(); entry.reads.clear(); }
  providers.clear();
}

export function createRepositoryProvider(connection: ProviderConnection, token: string): RepositoryProvider {
  const key = JSON.stringify([connection.kind, connection.instanceUrl, connection.apiUrl, createHash('sha256').update(token).digest('hex')]);
  const existing = providers.get(key);
  if (existing) return existing.provider;
  if (providers.size >= 16) invalidateRepositoryProviders();
  const controller = new AbortController();
  const service = connection.kind === 'github' ? new GitHubProvider(connection, token, controller.signal) : new GitLabService(connection.instanceUrl, token, controller.signal);
  const reads = new SharedReads();
  const provider = new Proxy(service, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (sharedMethods.has(String(property))) return (...args: unknown[]) => reads.read(JSON.stringify([property, args]), () => value.apply(target, args));
      if (/^(create|approve|merge|delete|close|cleanup)/.test(String(property))) return async (...args: unknown[]) => {
        reads.clear();
        try { return await value.apply(target, args); } finally { reads.clear(); }
      };
      return value.bind(target);
    }
  });
  providers.set(key, { provider, reads, controller });
  return provider;
}

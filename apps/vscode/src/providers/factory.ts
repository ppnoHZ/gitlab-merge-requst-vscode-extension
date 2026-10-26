import { createHash } from 'crypto';
import { GitLabService } from '../gitlabService';
import { GitHubProvider } from './githubProvider';
import { SharedReads } from './sharedReads';
import type { ProviderConnection, RepositoryProvider } from './repositoryProvider';

const providers = new Map<string, { provider: RepositoryProvider; reads: SharedReads; volatileReads: SharedReads; controller: AbortController }>();
// Share identical reads across status bar, trees and background refreshes. Rejected reads are
// evicted by SharedReads, so an immediate retry only reissues the failed project/request.
const sharedMethods = new Set([
  'getCurrentUser', 'getProject', 'getProjectBranches', 'getMergeRequestsTargetingBranch',
  'getReviewProject', 'getReviewMergeRequests', 'getAuthoredMergeRequests',
  'getMergeRequestConflictState', 'hasUserApprovedMergeRequest', 'getReviewDetails'
]);
const volatileMethods = new Set(['getProjectBranches', 'getMergeRequestsTargetingBranch', 'getMergeRequestConflictState', 'getReviewDetails']);

export function invalidateRepositoryProviders(): void {
  for (const entry of providers.values()) { entry.controller.abort(); entry.reads.clear(); entry.volatileReads.clear(); }
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
  // TTL 0 still coalesces concurrent calls, but an explicit later refresh always reaches GitLab.
  const volatileReads = new SharedReads(0);
  const provider = new Proxy(service, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== 'function') return value;
      if (sharedMethods.has(String(property))) return (...args: unknown[]) =>
        (volatileMethods.has(String(property)) ? volatileReads : reads).read(JSON.stringify([property, args]), () => value.apply(target, args));
      if (/^(create|approve|merge|delete|close|cleanup|link)/.test(String(property))) return async (...args: unknown[]) => {
        reads.clear(); volatileReads.clear();
        try { return await value.apply(target, args); } finally { reads.clear(); volatileReads.clear(); }
      };
      return value.bind(target);
    }
  });
  providers.set(key, { provider, reads, volatileReads, controller });
  return provider;
}

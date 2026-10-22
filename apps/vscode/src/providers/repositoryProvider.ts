import type { AuditContext } from '../audit';
import type { BranchReference, BaseKind } from '@gitlab-workbench/core';
import type { GitLabUser, GitLabBranchPage, GitLabPage, MergeRequestPayload, MergeRequestResult, ReviewProject, ReviewMergeRequest, ReviewDetails, ReviewDiffRefs, ReviewDiffVersion } from '../types';
import type { ReleaseMergeRequest } from '../releaseReadiness';

export type ProviderKind = 'gitlab' | 'github';
export interface ProviderConnection { kind: ProviderKind; instanceUrl: string; apiUrl: string }
export interface ProviderCapabilities { todos: boolean; review: boolean; merge: boolean; deleteBranch: boolean }
export interface ProviderProject { id: number; name: string; web_url: string; default_branch?: string }
export interface ProviderMergeRequestResult extends MergeRequestResult { warnings?: string[] }

/** Transition contract: adapters normalize vendor responses into the existing UI records.
 * Keeping these DTOs stable prevents a Web/API migration as part of the VS Code rollout.
 */
export interface RepositoryProvider {
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  readonly auditContext: AuditContext;
  getCurrentUser(): Promise<GitLabUser>;
  getProject(path: string): Promise<ProviderProject>;
  getProjectBranches(project: string | number, page?: number, search?: string): Promise<GitLabBranchPage>;
  getBranchCreationRefs(project: number, kind: BaseKind, page?: number, search?: string): Promise<{ items: BranchReference[]; hasMore: boolean }>;
  getBranchCreationRef(project: number, kind: BaseKind, name: string): Promise<BranchReference>;
  createRemoteBranch(project: number, name: string, kind: BaseKind, base: string, sha: string): Promise<{ ref: BranchReference; recovered: boolean }>;
  getMergeRequestsTargetingBranch(project: string | number, target: string, page?: number): Promise<GitLabPage<ReleaseMergeRequest>>;
  resolveReviewerIds(usernames: string[]): Promise<{ resolvedIds: number[]; notFoundUsers: string[] }>;
  createMergeRequest(payload: MergeRequestPayload): Promise<ProviderMergeRequestResult>;
  deleteBranch(project: string | number, branch: string, sha: string, mainSha: string): Promise<void>;
  getGitLabVersion(): Promise<{ version: string; revision?: string }>;
  getReviewProject(project: number): Promise<ReviewProject>;
  getReviewMergeRequests(user: number): Promise<ReviewMergeRequest[]>;
  getAuthoredMergeRequests(user: number): Promise<ReviewMergeRequest[]>;
  getMergeRequestConflictState(project: number, iid: number): Promise<ReviewMergeRequest>;
  hasUserApprovedMergeRequest(project: number, iid: number, user: number): Promise<boolean>;
  getReviewDetails(project: number, iid: number, recheck?: boolean): Promise<ReviewDetails>;
  getReviewDiffVersion(project: number, iid: number, refs: ReviewDiffRefs): Promise<ReviewDiffVersion>;
  getReviewFileContent(project: number, path: string, sha: string): Promise<string>;
  approveReview(project: number, iid: number, sha: string, user: number): Promise<void>;
  mergeReview(project: number, iid: number, sha: string, user: number): Promise<void>;
}

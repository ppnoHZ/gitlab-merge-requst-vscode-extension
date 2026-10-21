export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  title: string;
  author: string;
  date: string;
}

export interface GitRepoInfo {
  rootPath: string;
  sourceBranch: string;
  remoteUrl: string;
  projectPath: string;
  gitlabHost: string;
}

export interface GitLabUser {
  id: number;
  name: string;
  username: string;
  avatar_url?: string;
  state?: string;
}

export interface MergeRequestPayload {
  projectId: string | number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  description: string;
  reviewerIds?: number[];
  removeSourceBranch?: boolean;
  squash?: boolean;
}

export interface MergeRequestResult {
  id: number;
  iid: number;
  title: string;
  web_url: string;
  state: string;
  reviewers?: GitLabUser[];
}

export interface ExtensionConfig {
  instanceUrl: string;
  accessToken?: string;
  defaultTargetBranch: string;
  titleTemplate: string;
  defaultReviewers: string[];
  removeSourceBranch: boolean;
  squash: boolean;
  autoOpenInBrowser: boolean;
}
export interface GitLabPage<T> {
  items: T[];
  hasMore: boolean;
}

export interface BranchLatestCommit {
  branch: string;
  authorName: string;
  committedDate: string;
}

export interface GitLabBranchPage extends GitLabPage<string> {
  latestCommits?: BranchLatestCommit[];
}

export interface ReviewMergeRequest {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  state: string;
  web_url: string;
  source_branch: string;
  target_branch: string;
  author: { id?: number; name: string; username: string };
  draft?: boolean;
  has_conflicts?: boolean;
  detailed_merge_status?: string;
  source_project_id?: number;
  target_project_id?: number;
}

export interface ReviewProject {
  id: number;
  path_with_namespace: string;
  web_url: string;
}

export interface ReviewDiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

export interface ReviewDetails extends ReviewMergeRequest {
  sha: string;
  source_project_id: number;
  target_project_id: number;
  reviewers: Array<{ id: number }>;
  diff_refs: ReviewDiffRefs;
  detailed_merge_status?: string;
  has_conflicts?: boolean;
  work_in_progress?: boolean;
  user?: { can_merge?: boolean };
}

export interface ReviewChangedFile {
  old_path: string;
  new_path: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

export interface ReviewDiffVersion {
  id: number;
  base_commit_sha: string;
  head_commit_sha: string;
  start_commit_sha: string;
  state?: string;
  real_size: string | number;
  overflow?: boolean;
  diffs: ReviewChangedFile[];
}

export interface MainMergeResult extends Set<string> {
  errors?: Map<string, string>;
}

/** Bootstrap contract; authentication and project loading are added by the web implementation. */
export interface WorkbenchStatus {
  status: 'ok';
  gitlab: { connected: boolean };
}

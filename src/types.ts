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

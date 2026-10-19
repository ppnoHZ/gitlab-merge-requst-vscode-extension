export type ReleaseFeatureState = 'merged' | 'open' | 'closed' | 'not-created';

export interface ReleaseMergeRequest {
  source_branch: string;
  target_branch: string;
  state: string;
  iid: number;
  title: string;
  web_url: string;
  updated_at?: string;
}

export interface ReleaseFeatureStatus {
  branch: string;
  state: ReleaseFeatureState;
  mergeRequest?: ReleaseMergeRequest;
  pending?: boolean;
}

export function getReleaseVersion(branchName: string): string | undefined {
  const segments = branchName.split('/');
  return segments[0] === 'release' && segments[1] ? segments[1] : undefined;
}

export function getFeatureVersion(branchName: string): string | undefined {
  const segments = branchName.split('/');
  return segments[0] === 'feature' && segments[1] ? segments[1] : undefined;
}

export function getReleaseFeatureStatuses(
  releaseBranch: string,
  branchNames: string[],
  mergeRequests: ReleaseMergeRequest[]
): ReleaseFeatureStatus[] {
  const version = getReleaseVersion(releaseBranch);
  if (!version) {
    return [];
  }

  const relevantMergeRequests = mergeRequests.filter(request =>
    request.target_branch === releaseBranch && getFeatureVersion(request.source_branch) === version
  );
  const featureBranches = new Set(
    branchNames.filter(branch => getFeatureVersion(branch) === version)
  );
  for (const request of relevantMergeRequests) {
    featureBranches.add(request.source_branch);
  }

  return Array.from(featureBranches).sort().map(branch => {
    const branchRequests = relevantMergeRequests
      .filter(request => request.source_branch === branch)
      .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
    const openRequest = branchRequests.find(request => request.state === 'opened');
    const mergedRequest = branchRequests.find(request => request.state === 'merged');
    const closedRequest = branchRequests.find(request => request.state === 'closed');
    const mergeRequest = openRequest ?? mergedRequest ?? closedRequest;

    return {
      branch,
      state: openRequest ? 'open' : mergedRequest ? 'merged' : closedRequest ? 'closed' : 'not-created',
      mergeRequest
    };
  });
}
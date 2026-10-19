export interface IssueLinkConfig {
  name: string;
  pattern: string;
  urlTemplate: string;
}

export interface ResolvedIssueLink {
  name: string;
  id: string;
  url: string;
}

export function resolveFeatureIssueLinks(
  branchName: string,
  configurations: IssueLinkConfig[]
): ResolvedIssueLink[] {
  if (!/^feature\//i.test(branchName)) {
    return [];
  }
  const issueSegment = branchName.split('/')[2]?.trim();
  if (!issueSegment) {
    return [];
  }

  const links: ResolvedIssueLink[] = [];
  for (const configuration of configurations) {
    if (!configuration.name?.trim() || !configuration.pattern || !configuration.urlTemplate?.includes('{id}')) {
      continue;
    }

    try {
      const match = new RegExp(configuration.pattern, 'i').exec(issueSegment);
      const id = (match?.groups?.id ?? match?.[1] ?? match?.[0])?.trim();
      if (!id) {
        continue;
      }

      const url = new URL(configuration.urlTemplate.replaceAll('{id}', encodeURIComponent(id)));
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        continue;
      }

      links.push({ name: configuration.name.trim(), id, url: url.toString() });
    } catch {
      continue;
    }
  }

  return links;
}
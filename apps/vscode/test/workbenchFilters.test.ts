import assert from 'assert';
import { readFileSync } from 'fs';
import { matchesUpdated, normalizeFilters, pickWorkbenchFilters } from '../src/workbenchFilters';
import { ReleaseReadinessProvider } from '../src/releaseReadinessView';
import { ReleaseOverviewProvider } from '../src/releaseOverviewView';
import { ReleaseOverviewSnapshot } from '../src/releaseOverview';
import { loadReleaseOverview } from '../src/releaseOverview';
import { openedDocuments, window } from './vscodeMock';

async function run() {
  const now = Date.now();
  const day = 86400000;
  const date = (days: number) => new Date(now - days * day).toISOString();
  assert(matchesUpdated(date(7), '7d', now));
  assert(!matchesUpdated(date(7.01), '7d', now));
  assert(matchesUpdated(date(30), '30d', now));
  assert(!matchesUpdated(date(30.01), '30d', now));
  assert(!matchesUpdated(date(90), 'stale90', now));
  assert(matchesUpdated(date(90.01), 'stale90', now));
  for (const value of [undefined, '', 'invalid', date(-1)]) {
    assert(matchesUpdated(value, 'unknown', now));
    assert(!matchesUpdated(value, '7d', now));
    assert(matchesUpdated(value, 'all', now));
  }
  assert.deepEqual(normalizeFilters({ main: ['merged', 'merged'], updated: 'all' }), { main: ['merged'], risks: [], updated: 'all' });

  const branches = new ReleaseReadinessProvider(null);
  branches.appendBranchPage(branches.branchPage, {
    items: ['feature/v1/recent', 'feature/v1/old', 'release/v1', 'release/v2', 'main'], hasMore: false,
    latestCommits: [
      { branch: 'feature/v1/recent', authorName: 'A', committedDate: date(1) },
      { branch: 'feature/v1/old', authorName: 'B', committedDate: date(100) },
      { branch: 'release/v1', authorName: 'A', committedDate: date(20) }
    ]
  });
  branches.setMergedIntoMain(['feature/v1/recent'], new Map([['release/v2', 'Fetch failed']]));
  branches.setFilters({ main: ['unmerged', 'unknown'], updated: '30d' });
  assert.deepEqual(branches.getVisibleBranches(now), ['release/v1']);
  branches.setFilters({ main: ['unknown'] });
  assert.deepEqual(branches.getVisibleBranches(now), ['release/v2']);
  branches.setFilters({ updated: 'stale90' });
  assert.deepEqual(branches.getVisibleBranches(now), ['feature/v1/old']);
  assert(branches.getChildren().some(item => item.label === 'feature'));
  assert(!branches.getChildren().some(item => item.label === 'release'));
  branches.setBranchFilters(['release/']);
  assert.equal(branches.getVisibleBranches(now).length, 0);
  assert.equal(branches.getBranches().length, 5, 'display filters must never discard loaded branches');
  assert(branches.getChildren().some(item => item.label === '没有匹配的分支，点击调整过滤条件'));
  branches.setFilters({});
  assert.deepEqual(branches.getVisibleBranches(now), ['release/v1', 'release/v2']);
  branches.setBranchFilters(null);
  assert.equal(branches.getVisibleBranches(now).length, 5);

  let loads = 0;
  const snapshot: ReleaseOverviewSnapshot = { project: 'group/project', updatedAt: date(0), entries: [
    { branch: 'release/v1', version: 'v1', committedDate: date(1), mergedIntoMain: false, features: [
      { branch: 'feature/v1/missing', state: 'not-created' }, { branch: 'feature/v1/done', state: 'merged' }
    ] },
    { branch: 'release/v1/patch', version: 'v1', committedDate: date(15), mergedIntoMain: true, features: [
      { branch: 'feature/v1/closed', state: 'closed' }, { branch: 'feature/v1/open', state: 'open' }
    ] },
    { branch: 'release/v2', version: 'v2', mainError: 'Unavailable', error: 'Page failed', features: [] }
  ] };
  const overview = new ReleaseOverviewProvider(async () => { loads++; return snapshot; });
  await overview.refresh();
  overview.setFilters({ main: ['unmerged'], risks: ['missing', 'closed'], updated: '7d' });
  assert.deepEqual(overview.getVisibleEntries(now).map(item => item.branch), ['release/v1']);
  assert.equal(overview.getVisibleEntries(now)[0].features.length, 2, 'risk filter preserves complete change list and counts');
  assert.equal(overview.filterSummary, '已筛选 1 / 3 个 release');
  await overview.export('filtered');
  const filtered = openedDocuments.at(-1)!.content;
  assert(filtered.includes('导出范围：当前筛选（1/3 个 release）'));
  assert(filtered.includes('feature/v1/done'));
  assert(!filtered.includes('release/v1/patch'));
  await overview.export('all');
  assert(openedDocuments.at(-1)!.content.includes('release/v1/patch'));
  assert.equal(snapshot.entries.length, 3);
  overview.setFilters({ risks: ['failed'], main: ['unknown'] });
  assert.deepEqual(overview.getVisibleEntries(now).map(item => item.branch), ['release/v2']);
  overview.setFilters({ risks: ['missing'], main: ['merged'] });
  assert.equal(overview.getVisibleEntries(now).length, 0);
  assert.equal(overview.getChildren()[0].command?.command, 'gitlabMr.clearReleaseOverviewFilters');
  overview.setFilters({ updated: 'unknown' });
  assert.deepEqual(overview.getVisibleEntries(now).map(item => item.branch), ['release/v2']);
  overview.setFilters({});
  assert.equal(overview.getVisibleEntries(now).length, 3);
  assert.equal(loads, 1, 'changing filters and exporting must not reload GitLab');

  const dated = await loadReleaseOverview('p', {
    branches: async () => ({ items: ['release/v1'], hasMore: false, latestCommits: [{ branch: 'release/v1', authorName: 'A', committedDate: date(1) }] }),
    requests: async () => ({ items: [], hasMore: false }),
    mergedIntoMain: async () => new Set()
  });
  assert.equal(dated.entries[0].committedDate, date(1));

  // Verify the real picker cancellation and empty-selection behavior.
  const originalPicker = window.showQuickPick;
  const picker = window as unknown as { showQuickPick: (...args: unknown[]) => Promise<unknown> };
  const current = normalizeFilters({ main: ['merged'], updated: '7d' });
  const choices: unknown[] = [{ key: 'main' }, undefined, { key: 'main' }, [], { key: 'updated' }, { key: '30d' }];
  picker.showQuickPick = async () => choices.shift();
  try {
    assert.equal(await pickWorkbenchFilters(current, false), undefined);
    assert.deepEqual(current.main, ['merged']);
    assert.deepEqual((await pickWorkbenchFilters(current, false))?.main, []);
    assert.equal((await pickWorkbenchFilters(current, true))?.updated, '30d');
  } finally { window.showQuickPick = originalPicker; }

  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  for (const command of ['filterBranchStatus', 'clearBranchStatusFilters', 'filterReleaseOverview', 'clearReleaseOverviewFilters']) {
    assert(manifest.contributes.commands.some((item: { command: string }) => item.command === `gitlabMr.${command}`));
    assert(manifest.contributes.menus['view/title'].some((item: { command: string }) => item.command === `gitlabMr.${command}`));
  }
  branches.dispose(); overview.dispose();
  console.log('[PASS] workbench filters: intersections/unions, time boundaries, unknown dates/states, intact data/counts, empty/reset, exports, local-only changes and cancelled pickers');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

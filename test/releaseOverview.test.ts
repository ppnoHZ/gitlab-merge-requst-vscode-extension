import assert from 'assert';
import { loadReleaseOverview, releaseOverviewMarkdown, ReleaseOverviewSnapshot } from '../src/releaseOverview';
import { ReleaseOverviewProvider } from '../src/releaseOverviewView';
import { ReleaseMergeRequest } from '../src/releaseReadiness';
import { openedDocuments } from './vscodeMock';

const mr = (branch: string, state: string, iid: number): ReleaseMergeRequest => ({
  source_branch: branch, target_branch: 'release/v1', state, iid,
  title: 'Change <script> | [link](bad)', web_url: 'https://gitlab.example.test/mr/' + iid
});
async function run() {
  const calls: string[] = [];
  const snapshot = await loadReleaseOverview('group/project', {
    branches: async page => {
      calls.push(`branches:${page}`);
      return page === 1 ? { items: ['main', 'release/v1', 'feature/v1/missing', 'feature/v10/other'], hasMore: true }
        : { items: ['release/v1/patch', 'release/v2', 'feature/v1/open', 'feature/v1/closed'], hasMore: false };
    },
    requests: async (branch, page) => {
      calls.push(`${branch}:${page}`);
      if (branch === 'release/v2') throw new Error('Access denied');
      if (branch !== 'release/v1') return { items: [], hasMore: false };
      return page === 1 ? { items: [mr('feature/v1/deleted', 'merged', 1)], hasMore: true }
        : { items: [mr('feature/v1/open', 'opened', 2), mr('feature/v1/closed', 'closed', 3)], hasMore: false };
    },
    mergedIntoMain: async branches => {
      assert.deepEqual(branches, ['main', 'release/v1', 'release/v1/patch', 'release/v2']);
      return new Set(['release/v1']);
    }
  });
  assert(calls.includes('branches:2') && calls.includes('release/v1:2'));
  const entry = snapshot.entries[0];
  assert.deepEqual(entry.features.map(item => [item.branch, item.state]), [
    ['feature/v1/closed', 'closed'], ['feature/v1/deleted', 'merged'],
    ['feature/v1/missing', 'not-created'], ['feature/v1/open', 'open']
  ]);
  assert.equal(entry.mergedIntoMain, true);
  assert.equal(snapshot.entries[1].mergedIntoMain, false);
  assert.equal(snapshot.entries[2].error, 'Access denied');
  const provider = new ReleaseOverviewProvider(async () => snapshot);
  await provider.refresh();
  const roots = provider.getChildren();
  assert.equal(roots.length, 3); // timestamp + v1 + v2
  const v1 = provider.getChildren(roots[1]);
  assert.equal(v1.length, 2); // both release branches of the exact version
  const details = provider.getChildren(v1[0]);
  const missing = details.find(item => String(item.label).startsWith('缺失 MR'))!;
  const action = provider.getChildren(missing)[0].command!;
  assert.equal(action.command, 'gitlabMr.createReleaseFeatureMergeRequest');
  assert.equal(action.arguments![0].branchPath, 'release/v1');
  assert.equal(action.arguments![0].status.branch, 'feature/v1/missing');
  const report = releaseOverviewMarkdown(snapshot);
  assert(report.includes('feature/v1/deleted'));
  assert(report.includes('MR 状态未知：Access denied'));
  assert(!report.includes('<script>'));
  await provider.export();
  assert.equal(openedDocuments.at(-1)?.content, report);

  const missingMain = await loadReleaseOverview('p', {
    branches: async () => ({ items: ['release/v1'], hasMore: false }),
    requests: async () => ({ items: [], hasMore: false }),
    mergedIntoMain: async () => { throw new Error('must not run'); }
  });
  assert.equal(missingMain.entries[0].mergedIntoMain, undefined);
  assert(missingMain.entries[0].mainError?.includes('没有 main'));
  assert(releaseOverviewMarkdown(missingMain).includes('无法据此判定可上线'));

  const partial = await loadReleaseOverview('p', {
    branches: async () => ({ items: ['main', 'release/v1', 'feature/v1/x'], hasMore: false }),
    requests: async (_, page) => {
      if (page === 2) throw new Error('Page 2 failed');
      return { items: [mr('feature/v1/x', 'merged', 1)], hasMore: true };
    },
    mergedIntoMain: async () => { throw new Error('Fetch failed'); }
  });
  assert.equal(partial.entries[0].features.length, 0);
  assert.equal(partial.entries[0].error, 'Page 2 failed');
  assert.equal(partial.entries[0].mainError, 'Fetch failed');

  const isolatedMainFailure = await loadReleaseOverview('p', {
    branches: async () => ({ items: ['main', 'release/v1', 'release/v2'], hasMore: false }),
    requests: async () => ({ items: [], hasMore: false }),
    mergedIntoMain: async () => Object.assign(new Set(['release/v2']), {
      errors: new Map([['release/v1', 'Object unavailable']])
    })
  });
  assert.equal(isolatedMainFailure.entries[0].mergedIntoMain, undefined);
  assert.equal(isolatedMainFailure.entries[0].mainError, 'Object unavailable');
  assert.equal(isolatedMainFailure.entries[1].mergedIntoMain, true);

  const failure = new ReleaseOverviewProvider(async () => { throw new Error('Branch page failed'); });
  await failure.refresh();
  assert.equal(failure.snapshot, undefined);
  assert(failure.message.includes('Branch page failed'));
  assert.equal(failure.loading, false);

  let finish!: (snapshot: ReleaseOverviewSnapshot) => void;
  const stale = new ReleaseOverviewProvider(() => new Promise(resolve => { finish = resolve; }));
  const pending = stale.refresh();
  await stale.refresh(); // no duplicate fetch while loading
  stale.invalidate();
  finish(snapshot);
  await pending;
  assert.equal(stale.snapshot, undefined);
  assert.equal(stale.loading, false);
  assert(stale.message.includes('连接已变更'));
  provider.dispose(); failure.dispose(); stale.dispose();
  console.log('[PASS] release overview: complete pagination, exact versions, historical branches, partial failures, main unknown, actions, export and stale responses');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

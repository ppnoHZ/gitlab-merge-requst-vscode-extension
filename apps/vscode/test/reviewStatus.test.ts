import assert from 'assert';
import { statusBars } from './vscodeMock';
import { ReviewStatus, countPendingApprovals } from '../src/reviewStatus';
import type { RepositoryProvider } from '../src/providers/repositoryProvider';

async function run() {
  let failure = false;
  const checked: number[] = [];
  const service = {
    getCurrentUser: async () => ({ id: 7 }),
    getReviewMergeRequests: async () => [
      { project_id: 1, iid: 1, state: 'opened' }, { project_id: 1, iid: 1, state: 'opened' },
      { project_id: 1, iid: 2, state: 'opened' }, { project_id: 1, iid: 3, state: 'closed' }
    ],
    hasUserApprovedMergeRequest: async (_project: number, iid: number, user: number) => {
      assert.equal(user, 7); checked.push(iid); if (failure) throw new Error('403'); return iid === 2;
    }
  } as unknown as RepositoryProvider;
  assert.equal(await countPendingApprovals(service), 1);
  assert.deepEqual(checked, [1, 2]);
  failure = true;
  await assert.rejects(countPendingApprovals(service), /403/);
  failure = false;
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const badge = new ReviewStatus(async () => ({ ...service, capabilities: { todos: true } }) as RepositoryProvider);
  await tick();
  const item = statusBars.at(-1);
  assert.equal(item.text, '$(git-pull-request) 待审批 1');
  assert(item.backgroundColor);
  failure = true;
  await badge.refresh();
  assert.equal(item.text, '$(warning) 待审批 ?');
  badge.dispose(); assert(item.disposed);
  let resolveConnection: (value: RepositoryProvider | undefined) => void = () => {};
  const stale = new ReviewStatus(() => new Promise(resolve => { resolveConnection = resolve; }));
  stale.dispose(); resolveConnection(service); await tick();
  assert(statusBars.at(-1).disposed);
  console.log('Approval count: deduplication, already-approved/closed exclusion and failure propagation passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

import assert from 'assert';
import { informationMessages, statusBars } from './vscodeMock';
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

  let requests: any[] = [{ project_id: 2, iid: 10, id: 10, state: 'opened', title: '已有 MR', web_url: 'https://gitlab.test/g/p/-/merge_requests/10' }];
  const notificationService = {
    ...service, kind: 'gitlab', capabilities: { todos: true, review: true, merge: true, deleteBranch: true }, auditContext: { instance: 'https://gitlab.test' },
    getReviewMergeRequests: async () => requests,
    hasUserApprovedMergeRequest: async () => false
  } as RepositoryProvider;
  const saved = new Map<string, any>();
  const state = { get: (key: string, fallback: any) => saved.get(key) ?? fallback, update: async (key: string, value: any) => { saved.set(key, value); } } as any;
  const before = informationMessages.length;
  const notifications = new ReviewStatus(async () => notificationService, state);
  await tick();
  assert.equal(informationMessages.length, before, '首次加载只建立历史待办基线');
  requests = [...requests, { project_id: 2, iid: 11, id: 11, state: 'opened', title: '请审阅新功能', web_url: 'https://gitlab.test/g/p/-/merge_requests/11' }];
  await notifications.refresh();
  assert(informationMessages.at(-1)?.includes('新的 MR !11'));
  const notified = informationMessages.length;
  await notifications.refresh();
  assert.equal(informationMessages.length, notified, '同一 MR 不应重复弹窗');
  notifications.dispose();
  console.log('Approval status: count, first-run baseline, new-MR notification, deduplication and failure propagation passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

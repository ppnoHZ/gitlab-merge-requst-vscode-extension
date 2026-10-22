import assert from 'assert';
import axios from 'axios';
import { readFileSync } from 'fs';
import { GitLabService } from '../src/gitlabService';
import { PendingReviewsProvider, PendingReviewItem } from '../src/pendingReviewsView';
import { AuditApiError } from '../src/audit';
import { ReviewMergeRequest, ReviewDetails } from '../src/types';
import { warningDialog, openedDocuments, ThemeIcon, window, informationMessages } from './vscodeMock';

const sourceSha = 'b'.repeat(40);
const targetSha = 'a'.repeat(40);
const makeRequest = (iid: number, fields: Partial<ReviewMergeRequest> = {}): ReviewMergeRequest => ({
  id: 1000 + iid, iid, project_id: 42, title: `MR ${iid}`, state: 'opened',
  web_url: `https://gitlab.test/other/project/-/merge_requests/${iid}`,
  source_branch: 'release/LI2500076', target_branch: 'dev', author: { id: 7, name: 'Me', username: 'me' },
  has_conflicts: false, source_project_id: 42, target_project_id: 42, ...fields
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
};
function categoryRequests(provider: PendingReviewsProvider, category: string): PendingReviewItem[] {
  const root = provider.getChildren().find(item => item.kind === 'category' && item.category === category)!;
  return provider.getChildren(root).flatMap(item => provider.getChildren(item)).filter(item => item.kind === 'request');
}

async function run() {
  const service = new GitLabService('https://gitlab.test', 'test-token');
  const urls: URL[] = [];
  axios.defaults.adapter = async config => {
    const url = new URL(config.url!); urls.push(url);
    let data: unknown;
    if (url.pathname === '/api/v4/merge_requests') {
      assert.equal(url.searchParams.get('author_id'), '7');
      assert.equal(url.searchParams.has('reviewer_id'), false);
      assert.equal(url.searchParams.get('scope'), 'all');
      assert.equal(url.searchParams.get('state'), 'opened');
      assert.equal(url.searchParams.get('with_merge_status_recheck'), 'true');
      data = url.searchParams.get('page') === '1' ? Array.from({ length: 100 }, (_, i) => makeRequest(i + 1))
        : [makeRequest(100), makeRequest(101), makeRequest(102, { state: 'merged' })];
    } else data = makeRequest(1, { has_conflicts: true });
    return { config, data: JSON.stringify(data), status: 200, statusText: 'OK', headers: {} };
  };
  assert.equal((await service.getAuthoredMergeRequests(7)).length, 101);
  assert.deepEqual(urls.map(url => url.searchParams.get('page')), ['1', '2']);
  assert.equal((await service.getMergeRequestConflictState(42, 1)).has_conflicts, true);
  await assert.rejects(service.getMergeRequestConflictState(43, 1), /状态响应无效/);
  await assert.rejects(service.getAuthoredMergeRequests(0), /无效/);

  let authorFails = false; let reviewFails = false;
  let authored = [
    makeRequest(1), makeRequest(2), makeRequest(3, { has_conflicts: true, draft: true }),
    makeRequest(4, { has_conflicts: true, source_branch: 'hotfix/H20260706/FOC-0009', target_branch: 'main' }),
    makeRequest(5, { has_conflicts: undefined }),
    makeRequest(6, { detailed_merge_status: 'checking' }),
    makeRequest(7, { has_conflicts: true, source_project_id: 99 }),
    makeRequest(9, { has_conflicts: undefined, detailed_merge_status: 'conflict' })
  ];
  let reviews = [authored[1], authored[2], makeRequest(8)];
  let pending: ReturnType<typeof deferred<ReviewMergeRequest[]>> | undefined;
  const approvals: number[] = []; const projects: number[] = []; const states: number[] = [];
  service.getCurrentUser = async () => ({ id: 7, username: 'me', name: 'Me' });
  service.getAuthoredMergeRequests = async id => {
    assert.equal(id, 7);
    if (authorFails) throw new Error('Authored list unavailable');
    return pending ? pending.promise : authored;
  };
  service.getReviewMergeRequests = async () => {
    if (reviewFails) throw new Error('Review list unavailable');
    return reviews;
  };
  service.hasUserApprovedMergeRequest = async (_project, iid) => { approvals.push(iid); return iid === 2; };
  service.getReviewProject = async id => { projects.push(id); return { id, path_with_namespace: 'other/project', web_url: 'https://gitlab.test/other/project' }; };
  service.getMergeRequestConflictState = async (_project, iid) => { states.push(iid); throw new Error('status unavailable'); };
  const provider = new PendingReviewsProvider(async () => service, true);
  await provider.refresh();
  assert.equal(provider.summary, '8 个我提交的 · 2 个待审批');
  assert.deepEqual(provider.getChildren().map(item => item.label), ['我提交的 MR', '待我审批']);
  assert.deepEqual(approvals.sort((a, b) => a - b), [2, 3, 8]);
  assert.deepEqual(projects, [42]);
  assert.deepEqual(states, [5]);
  const mine = categoryRequests(provider, 'authored');
  const assigned = categoryRequests(provider, 'review');
  assert.equal(mine.length, 8); assert.equal(assigned.length, 2);
  assert(mine.some(item => item.request?.iid === 2)); // Own approved MRs remain in the authored list.
  const conflict = mine.find(item => item.request?.iid === 3)!;
  assert.equal((conflict.iconPath as ThemeIcon).color?.id, 'errorForeground');
  assert.match(String(conflict.description), /有冲突.*release\/LI2500076 → dev.*草稿/);
  assert.match(conflict.contextValue!, /authoredMergeRequest-conflict-canCreateConflict/);
  assert.match(assigned.find(item => item.request?.iid === 3)!.contextValue!, /pendingReviewRequest-conflict-canCreateConflict/);
  const unsupported = mine.find(item => item.request?.iid === 4)!;
  assert.equal((unsupported.iconPath as ThemeIcon).color?.id, 'errorForeground');
  assert(!unsupported.contextValue?.includes('canCreateConflict'));
  assert.match(String(unsupported.tooltip), /原始源分支/);
  assert(!mine.find(item => item.request?.iid === 7)!.contextValue?.includes('canCreateConflict'));
  assert.equal((mine.find(item => item.request?.iid === 9)!.iconPath as ThemeIcon).color?.id, 'errorForeground');
  assert.match(String(mine.find(item => item.request?.iid === 5)!.description), /冲突状态查询失败/);
  assert.match(String(mine.find(item => item.request?.iid === 6)!.description), /合并状态计算中/);
  assert.equal((mine.find(item => item.request?.iid === 1)!.iconPath as ThemeIcon).color, undefined);
  assert.equal(provider.getParent(conflict)?.kind, 'project');
  const action = provider.getChildren(conflict)[0];
  assert.equal(action.kind, 'action');
  assert.equal(action.label, '创建 conflict 分支…');
  assert.equal(action.command?.command, 'gitlabMr.createConflictFromMergeRequest');
  assert.equal(action.command?.arguments?.[0], conflict);
  assert.equal(provider.getParent(action), conflict);
  assert.match(String(provider.getChildren(unsupported)[0].label), /查看冲突处理方式/);
  assert.equal(await provider.createConflict(unsupported), false);
  assert.match(informationMessages.at(-1) ?? '', /原始源分支/);
  assert.equal(await provider.createConflict(mine.find(item => item.request?.iid === 7)!), false);
  assert.match(informationMessages.at(-1) ?? '', /跨仓库/);
  const pick = window.showQuickPick;
  try {
    window.showQuickPick = async (items: any[]) => {
      assert.equal(items.filter(item => item.label === '!3 MR 3').length, 1);
      return items.find(item => item.label === '!3 MR 3');
    };
    assert.equal((await provider.pickConflictedRequest())?.request?.iid, 3);
    window.showQuickPick = async () => undefined;
    assert.equal(await provider.pickConflictedRequest(), undefined);
  } finally { window.showQuickPick = pick; }
  await assert.rejects(provider.approve(conflict), /待我审批/);

  // All creation reads/writes use the MR project (42), never the workspace's origin project.
  const baseDetails: ReviewDetails = {
    ...conflict.request!, source_project_id: 42, target_project_id: 42, sha: sourceSha,
    reviewers: [{ id: 8 }], diff_refs: { base_sha: targetSha, start_sha: targetSha, head_sha: sourceSha },
    detailed_merge_status: 'conflict'
  };
  let details = { ...baseDetails }; let existing = false; let writes = 0;
  const reads: number[] = [];
  service.getReviewDetails = async (project, iid, recheck) => {
    assert.equal(project, 42); assert.equal(iid, 3); assert.equal(recheck, true);
    reads.push(project); return details;
  };
  service.getBranchCreationRef = async (project, kind, name) => {
    assert.equal(project, 42); assert.equal(kind, 'branch');
    if (name.startsWith('conflict/') && !existing) throw new AuditApiError('not found', 404);
    return { name, sha: name === 'release/LI2500076' ? sourceSha : targetSha, title: 'commit' };
  };
  service.createRemoteBranch = async (project, name, kind, target, sha) => {
    assert.equal(project, 42); assert.equal(name, 'conflict/release/LI2500076');
    assert.equal(kind, 'branch'); assert.equal(target, 'dev'); assert.equal(sha, targetSha);
    writes++; return { ref: { name, sha, title: '' }, recovered: false };
  };
  warningDialog.value = '确认创建';
  assert.equal(await provider.createConflict(conflict), true);
  assert.equal(writes, 1); assert.equal(reads.length, 2);
  assert(openedDocuments.at(-1)?.content.includes('原 MR：!3'));
  assert(openedDocuments.at(-1)?.content.includes(conflict.request!.web_url));
  warningDialog.value = undefined;
  assert.equal(await provider.createConflict(conflict), false); assert.equal(writes, 1);
  warningDialog.value = '确认创建';
  existing = true;
  await assert.rejects(provider.createConflict(conflict), /同名 conflict/); existing = false;
  for (const changed of [
    { ...baseDetails, state: 'closed' },
    { ...baseDetails, target_branch: 'uat' },
    { ...baseDetails, has_conflicts: false, detailed_merge_status: 'mergeable' },
    { ...baseDetails, detailed_merge_status: 'checking' },
    { ...baseDetails, sha: 'c'.repeat(40) }
  ]) {
    details = { ...baseDetails };
    warningDialog.onShow = () => { details = changed; };
    await assert.rejects(provider.createConflict(conflict), /关闭|变化|冲突|重新计算/);
    assert.equal(writes, 1);
  }
  warningDialog.onShow = undefined;
  details = { ...baseDetails, source_project_id: 99 };
  await assert.rejects(provider.createConflict(conflict), /跨仓库/);
  details = { ...baseDetails };
  warningDialog.onShow = () => provider.reset();
  await assert.rejects(provider.createConflict(conflict), /列表已失效/);
  assert.equal(writes, 1); warningDialog.onShow = undefined;
  await assert.rejects(provider.createConflict(conflict), /列表已失效/);

  authorFails = true;
  await provider.refresh();
  assert.match(provider.summary, /0 个我提交的 · 2 个待审批.*查询失败/);
  assert.equal(categoryRequests(provider, 'review').length, 2);
  assert.match(String(provider.getChildren()[0].label), /结果不完整/);
  authorFails = false; reviewFails = true;
  await provider.refresh();
  assert.equal(categoryRequests(provider, 'authored').length, 8);
  assert.match(provider.summary, /8 个我提交的 · 0 个待审批/);
  reviewFails = false;
  const old = deferred<ReviewMergeRequest[]>(); pending = old;
  const refresh = provider.refresh();
  await Promise.resolve(); await Promise.resolve();
  provider.reset(); pending = undefined; authored = []; reviews = [];
  await provider.refresh(); old.resolve([makeRequest(1)]); await refresh;
  assert.equal(provider.summary, '0 个我提交的 · 0 个待审批');
  assert.equal(categoryRequests(provider, 'authored').length, 0);
  provider.dispose();
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(manifest.contributes.views['gitlabMr-releaseReadinessContainer'].find((item: any) => item.id === 'gitlabMr.pendingReviews').name, '我的待办');
  const conflictMenus = manifest.contributes.menus['view/item/context'].filter((item: any) => item.command === 'gitlabMr.createConflictFromMergeRequest');
  for (const menu of conflictMenus) {
    assert(menu.when.includes('view == gitlabMr.pendingReviews'));
    const expression = menu.when.split('viewItem =~ ')[1];
    const pattern = new RegExp(expression.slice(1, -1));
    // All red MR contexts have an entry, even when the creation policy rejects that direction.
    for (const context of ['authoredMergeRequest-conflict', 'pendingReviewRequest-conflict-canCreateConflict']) assert(pattern.test(context));
    assert.equal(pattern.test('file'), false);
    if (menu.group === 'conflict') assert(pattern.test('authoredMergeRequest')); // Also accessible if GitLab has not reported conflict status yet.
  }
  assert(!manifest.contributes.menus.commandPalette.some((item: any) => item.command === 'gitlabMr.createConflictFromMergeRequest' && item.when === 'false'));
  console.log('[PASS] my todos: authored pagination, role groups, red conflict icons, partial failures, stale lists, MR-bound project/source/target creation, confirmation rechecks and fork rejection');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

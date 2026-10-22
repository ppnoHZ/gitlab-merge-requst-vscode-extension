import assert from 'assert';
import axios from 'axios';
import { readFileSync } from 'fs';
import { GitLabService } from '../src/gitlabService';
import { PendingReviewsProvider } from '../src/pendingReviewsView';
import { ReviewMergeRequest } from '../src/types';
import { errorMessages, warnings } from './vscodeMock';

function request(id: number, project = 1): ReviewMergeRequest {
  return {
    id, iid: id, project_id: project, title: `Review ${id}`, state: 'opened',
    web_url: `https://gitlab.example.com/project/${project}/-/merge_requests/${id}`,
    source_branch: 'feature/v1/PROJ-1', target_branch: 'release/v1',
    author: { name: 'Author', username: 'author' }
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

async function runTests(): Promise<void> {
  const service = new GitLabService('https://gitlab.example.com', 'test-token');
  const urls: URL[] = [];
  let status = 200;
  let approvals: unknown = { approved_by: [{ user: { id: 7 } }] };
  axios.defaults.adapter = async config => {
    const url = new URL(config.url!);
    urls.push(url);
    let data: unknown;
    if (url.pathname === '/api/v4/merge_requests') {
      assert.equal(url.searchParams.get('state'), 'opened');
      assert.equal(url.searchParams.get('reviewer_id'), '7');
      assert.equal(url.searchParams.get('scope'), 'all');
      assert.equal(url.searchParams.get('per_page'), '100');
      assert.equal(url.searchParams.get('sort'), 'desc');
      data = url.searchParams.get('page') === '1'
        ? Array.from({ length: 100 }, (_, i) => request(i + 1))
        : [request(100), request(101, 2)];
    } else if (url.pathname.endsWith('/approvals')) {
      data = approvals;
    } else {
      data = { id: 2, path_with_namespace: 'another/project', web_url: 'https://gitlab.example.com/another/project' };
    }
    return { config, status, statusText: 'Test', headers: {}, data: JSON.stringify(data) };
  };
  const requests = await service.getReviewMergeRequests(7);
  assert.equal(requests.length, 101);
  assert.deepEqual(urls.map(url => url.searchParams.get('page')), ['1', '2']);
  assert.equal(await service.hasUserApprovedMergeRequest(1, 1, 7), true);
  assert.equal(await service.hasUserApprovedMergeRequest(1, 1, 8), false);
  assert.equal(urls.at(-1)?.pathname, '/api/v4/projects/1/merge_requests/1/approvals');
  approvals = { approved_by: [] };
  assert.equal(await service.hasUserApprovedMergeRequest(1, 1, 7), false);
  for (const invalid of [null, {}, { approved_by: [{ user: {} }] }]) {
    approvals = invalid;
    await assert.rejects(service.hasUserApprovedMergeRequest(1, 1, 7), /approved_by/);
  }
  assert.equal((await service.getReviewProject(2)).path_with_namespace, 'another/project');
  for (const code of [401, 403, 404, 500]) {
    status = code;
    await assert.rejects(service.hasUserApprovedMergeRequest(1, 1, 7), new RegExp(String(code)));
  }
  status = 200;

  let connectionCalls = 0;
  let tokenAvailable = true;
  let failList = false;
  let failApproval = false;
  let failProject = false;
  let invalidUser = false;
  let list = [request(1), request(2), request(3, 2), { ...request(4, 2), draft: true }];
  const projectCalls: number[] = [];
  const approvalCalls: number[] = [];
  let pendingList: ReturnType<typeof deferred<ReviewMergeRequest[]>> | undefined;
  service.getCurrentUser = async () => ({ id: invalidUser ? 0 : 7, username: 'reviewer', name: 'Reviewer' });
  service.getReviewMergeRequests = async id => {
    assert.equal(id, 7);
    if (failList) {
      throw new Error('List unavailable');
    }
    return pendingList ? pendingList.promise : list;
  };
  service.hasUserApprovedMergeRequest = async (_project, iid, id) => {
    assert.equal(id, 7);
    approvalCalls.push(iid);
    if (failApproval && iid === 1) {
      throw new Error('Approvals unavailable');
    }
    return iid === 2;
  };
  service.getReviewProject = async id => {
    projectCalls.push(id);
    if (failProject) {
      throw new Error('Project unavailable');
    }
    return { id, path_with_namespace: id === 1 ? 'z/project' : 'a/project', web_url: `https://gitlab.example.com/${id}` };
  };
  const provider = new PendingReviewsProvider(async () => {
    connectionCalls++;
    return tokenAvailable ? service : undefined;
  });
  await provider.refresh();
  assert.equal(provider.summary, '3 个待审批 · 2 个项目');
  assert.equal(provider.loaded, true);
  assert.deepEqual(provider.getChildren().map(item => item.label), ['a/project', 'z/project']);
  assert.deepEqual([...projectCalls].sort(), [1, 2]);
  assert.deepEqual([...approvalCalls].sort(), [1, 2, 3, 4]);
  const roots = provider.getChildren();
  assert.equal(provider.getChildren(roots[0]).length, 2);
  assert.match(provider.getChildren(roots[0])[1].description as string, /草稿/);
  const mr = provider.getChildren(roots[1])[0];
  assert.equal(mr.request?.iid, 1);
  assert.equal(mr.command?.command, 'gitlabMr.showPendingReviewChanges');
  assert.equal(mr.command?.arguments?.[0], mr);
  assert.equal(provider.getChildren(mr)[0].command?.command, 'gitlabMr.showPendingReviewChanges');
  await assert.rejects(provider.approve(mr), /请先展开 MR/);
  await assert.rejects(provider.merge(mr), /请先展开 MR/);
  assert.equal(mr.id, 'pending-review:1:1');
  assert.match(String(mr.label), /^!1 Review 1$/);
  assert.match(String(mr.description), /feature\/v1\/PROJ-1 → release\/v1.*提交人: Author \(@author\)/);
  assert.match(String(mr.tooltip), /MR: !1 · ID: 1/);
  assert.match(String(mr.tooltip), /feature\/v1\/PROJ-1 → release\/v1/);
  assert.equal(roots[0].description, '2 个待审批');
  const mergeManifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(mergeManifest.contributes.commands.some((entry: { command: string }) =>
    entry.command === 'gitlabMr.mergePendingReview'));
  assert.equal(mergeManifest.contributes.menus['view/item/context'].filter((entry: { command: string; when: string }) =>
    entry.command === 'gitlabMr.mergePendingReview' && entry.when.includes('pendingReviewRequest')).length, 2);

  failApproval = true;
  await provider.refresh();
  assert.match(provider.summary, /2 个待审批.*1 个查询失败/);
  assert.match(String(provider.getChildren()[0].label), /结果不完整/);
  assert.equal(provider.getChildren()[0].command?.command, 'gitlabMr.refreshPendingReviews');
  assert.ok(warnings.at(-1)?.includes('部分查询失败'));
  const failedProject = provider.getChildren().find(item => item.projectId === 1)!;
  assert.equal(provider.getChildren(failedProject)[0].kind, 'message');
  assert.match(String(provider.getChildren(failedProject)[0].label), /Approvals unavailable/);
  failApproval = false;
  failProject = true;
  await provider.refresh();
  assert.match(provider.summary, /0 个待审批.*3 个查询失败/);
  assert.equal(provider.getChildren().some(item => String(item.label).includes('当前没有')), false);
  failProject = false;
  failList = true;
  await provider.refresh();
  assert.equal(provider.loaded, false);
  assert.match(provider.summary, /更新失败.*旧数据/);
  assert.match(String(provider.getChildren()[0].label), /List unavailable/);
  assert.match(errorMessages.at(-1) ?? '', /List unavailable/);
  failList = false;
  invalidUser = true;
  await provider.refresh();
  assert.match(errorMessages.at(-1) ?? '', /有效 ID/);
  invalidUser = false;
  list = [request(2)];
  await provider.refresh();
  assert.match(String(provider.getChildren()[0].label), /当前没有/);
  assert.equal(provider.summary, '0 个待审批 · 0 个项目');
  tokenAvailable = false;
  await provider.refresh(false);
  assert.equal(provider.summary, '未配置 Token');
  assert.equal(provider.loaded, false);
  assert.equal(provider.getChildren()[0].command?.command, 'gitlabMr.refreshPendingReviews');
  tokenAvailable = true;

  const oldResponse = deferred<ReviewMergeRequest[]>();
  pendingList = oldResponse;
  const staleRefresh = provider.refresh();
  await Promise.resolve();
  await Promise.resolve();
  const callsBeforeDuplicate = connectionCalls;
  await provider.refresh();
  assert.equal(connectionCalls, callsBeforeDuplicate);
  provider.reset();
  pendingList = undefined;
  list = [request(3, 2)];
  await provider.refresh();
  oldResponse.resolve([request(1)]);
  await staleRefresh;
  assert.equal(provider.summary, '1 个待审批 · 1 个项目');
  assert.equal(provider.getChildren()[0].label, 'a/project');
  let activeApprovals = 0;
  let maximumApprovals = 0;
  service.hasUserApprovedMergeRequest = async () => {
    activeApprovals++;
    maximumApprovals = Math.max(maximumApprovals, activeApprovals);
    await Promise.resolve();
    activeApprovals--;
    return false;
  };
  projectCalls.length = 0;
  list = Array.from({ length: 12 }, (_, index) => request(index + 1));
  await provider.refresh();
  assert.equal(maximumApprovals, 5);
  assert.deepEqual(projectCalls, [1]);
  assert.equal(provider.getChildren(provider.getChildren()[0]).length, 12);
  assert.equal(provider.summary, '12 个待审批 · 1 个项目');
  provider.dispose();

  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(manifest.contributes.viewsContainers.activitybar[0].title, 'GitLab 工作台');
  assert.equal(manifest.contributes.views['gitlabMr-releaseReadinessContainer'][0].name, '分支管理');
  assert.ok(manifest.activationEvents.includes('onView:gitlabMr.pendingReviews'));
  assert.ok(manifest.contributes.views['gitlabMr-releaseReadinessContainer'].some(
    (view: { id: string }) => view.id === 'gitlabMr.pendingReviews'
  ));
  assert.ok(manifest.contributes.menus['view/title'].some(
    (entry: { command: string; when: string }) =>
      entry.command === 'gitlabMr.refreshPendingReviews' && entry.when === 'view == gitlabMr.pendingReviews'
  ));
  assert.ok(manifest.contributes.menus['view/item/context'].some(
    (entry: { command: string; when: string }) =>
      entry.command === 'gitlabMr.approvePendingReview' && entry.when.includes('pendingReviewRequest')
  ));
  console.log('[PASS] pending reviews: reviewer filter, pagination, own approvals, project groups, draft, partial errors, token, retries, stale responses');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

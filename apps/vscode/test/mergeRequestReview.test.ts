import assert from 'assert';
import axios from 'axios';
import { GitLabService } from '../src/gitlabService';
import { MergeRequestReview } from '../src/mergeRequestReview';
import { PendingReviewsProvider } from '../src/pendingReviewsView';
import { ReviewChangedFile, ReviewDetails, ReviewDiffVersion } from '../src/types';
import { executedCommands, warningDialog } from './vscodeMock';
import { Audit } from '../src/audit';

const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const start = 'c'.repeat(40);
const updated = 'd'.repeat(40);
const details: ReviewDetails = {
  id: 10, iid: 1, project_id: 2, source_project_id: 3, target_project_id: 2,
  title: 'Review changes', state: 'opened', web_url: 'https://gitlab.example.com/group/project/-/merge_requests/1',
  source_branch: 'feature/v1', target_branch: 'release/v1',
  author: { name: 'Author', username: 'author' }, reviewers: [{ id: 7 }],
  sha: head, diff_refs: { base_sha: base, head_sha: head, start_sha: start }
};
const change = (path: string, flags: Partial<ReviewChangedFile> = {}): ReviewChangedFile => ({
  old_path: path, new_path: path, new_file: false, deleted_file: false, renamed_file: false, ...flags
});
const version: ReviewDiffVersion = {
  id: 5, base_commit_sha: base, head_commit_sha: head, start_commit_sha: start,
  state: 'collected', real_size: '4', diffs: [
    change('src/updated.ts'), change('new file.ts', { new_file: true }),
    change('removed.ts', { deleted_file: true }),
    change('old.ts', { renamed_file: true, new_path: 'renamed.ts' })
  ]
};

async function runTests(): Promise<void> {
  const service = new GitLabService('https://gitlab.example.com', 'test-token');
  let apiDetails: unknown = details;
  let apiVersion: unknown = version;
  let fileBody: unknown = { encoding: 'base64', content: Buffer.from('hello\n').toString('base64') };
  let approvalResponse: unknown = { approved_by: [{ user: { id: 7 } }] };
  let postStatus = 201;
  const calls: Array<{ url: URL; method: string; body: unknown }> = [];
  axios.defaults.adapter = async config => {
    const url = new URL(config.url!);
    const method = config.method!;
    calls.push({ url, method, body: config.data });
    let data: unknown;
    if (url.pathname.endsWith('/approve')) {
      data = approvalResponse;
    } else if (url.pathname.endsWith('/versions')) {
      data = [version];
    } else if (url.pathname.endsWith('/versions/5')) {
      data = apiVersion;
    } else if (url.pathname.includes('/repository/files/')) {
      data = fileBody;
    } else {
      data = apiDetails;
    }
    return { config, status: method === 'post' ? postStatus : 200, statusText: 'Test', headers: {}, data: JSON.stringify(data) };
  };
  assert.equal((await service.getReviewDetails(2, 1)).sha, head);
  assert.deepEqual(await service.getReviewDiffVersion(2, 1, details.diff_refs), version);
  assert.equal(calls.find(call => call.url.pathname.endsWith('/versions'))?.url.searchParams.get('per_page'), '100');
  assert.equal(await service.getReviewFileContent(3, 'new file.ts', head), 'hello\n');
  assert.equal(calls.at(-1)?.url.pathname, '/api/v4/projects/3/repository/files/new%20file.ts');
  assert.equal(calls.at(-1)?.url.searchParams.get('ref'), head);
  fileBody = { encoding: 'base64', content: Buffer.from([0, 1, 2]).toString('base64') };
  await assert.rejects(service.getReviewFileContent(3, 'binary', head), /二进制/);
  fileBody = { encoding: 'base64', content: Buffer.from([255]).toString('base64') };
  await assert.rejects(service.getReviewFileContent(3, 'non-utf8', head), /UTF-8/);
  fileBody = { encoding: 'raw', content: 'text' };
  await assert.rejects(service.getReviewFileContent(3, 'invalid', head), /无法读取/);
  fileBody = { encoding: 'base64', content: '!!!!' };
  await assert.rejects(service.getReviewFileContent(3, 'invalid-base64', head), /Base64/);
  for (const invalid of [
    { ...details, sha: updated }, { ...details, diff_refs: null },
    { ...details, source_project_id: null }, { ...details, reviewers: undefined }
  ]) {
    apiDetails = invalid;
    await assert.rejects(service.getReviewDetails(2, 1), /尚未就绪/);
  }
  apiDetails = details;
  apiVersion = { ...version, state: 'collecting' };
  await assert.rejects(service.getReviewDiffVersion(2, 1, details.diff_refs), /尚未生成/);
  apiVersion = version;
  await service.approveReview(2, 1, head, 7);
  assert.equal(calls.at(-1)?.method, 'post');
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.body)), { sha: head });
  approvalResponse = { approved_by: [] };
  await assert.rejects(service.approveReview(2, 1, head, 7), /未确认/);
  for (const status of [401, 403, 409]) {
    postStatus = status;
    await assert.rejects(service.approveReview(2, 1, head, 7), new RegExp(String(status)));
  }
  postStatus = 201;

  const review = new MergeRequestReview();
  let current = details;
  let currentVersion = version;
  let detailCalls = 0;
  let versionCalls = 0;
  let failFile = false;
  let failApprove = false;
  let approvals = 0;
  const fileCalls: Array<{ project: number; path: string; sha: string }> = [];
  service.getReviewDetails = async () => { detailCalls++; return current; };
  service.getReviewDiffVersion = async () => { versionCalls++; return currentVersion; };
  service.getReviewFileContent = async (project, path, sha) => {
    fileCalls.push({ project, path, sha });
    if (failFile) {
      throw new Error('File unavailable');
    }
    return `${sha}:${path}`;
  };
  service.approveReview = async (project, iid, sha, userId) => {
    assert.equal(project, 2);
    assert.equal(iid, 1);
    assert.equal(sha, head);
    assert.equal(userId, 7);
    approvals++;
    if (failApprove) {
      throw new Error('409 SHA conflict');
    }
  };
  await assert.rejects(review.approve(details, service, 7), /先展开/);
  const [snapshot, duplicate] = await Promise.all([review.load(details, service), review.load(details, service)]);
  assert.equal(snapshot, duplicate);
  assert.equal(detailCalls, 1);
  assert.equal(versionCalls, 1);
  assert.equal(snapshot.files.length, 4);
  const [modified, added, removed, renamed] = snapshot.files;
  assert.match(added.right.path, /new file.ts$/);
  assert.equal(await review.provideTextDocumentContent(added.left), '');
  assert.equal(await review.provideTextDocumentContent(removed.right), '');
  assert.equal(fileCalls.length, 0);
  await review.openFile(modified);
  assert.deepEqual(fileCalls, [
    { project: 2, path: 'src/updated.ts', sha: base },
    { project: 3, path: 'src/updated.ts', sha: head }
  ]);
  await review.provideTextDocumentContent(modified.left);
  assert.equal(fileCalls.length, 2);
  assert.equal(executedCommands.at(-1)?.command, 'vscode.diff');
  await review.openFile(renamed);
  assert.deepEqual(fileCalls.slice(-2).map(call => call.path), ['old.ts', 'renamed.ts']);
  failFile = true;
  const diffsBefore = executedCommands.length;
  await assert.rejects(review.openFile(added), /File unavailable/);
  assert.equal(executedCommands.length, diffsBefore);
  failFile = false;
  await review.openFile(added);
  assert.equal(executedCommands.length, diffsBefore + 1);

  warningDialog.value = undefined;
  assert.equal(await review.approve(details, service, 7), false);
  assert.equal(warningDialog.modal, true);
  assert.equal(approvals, 0);
  warningDialog.value = 'Approve（批准）';
  current = { ...details, sha: updated, diff_refs: { ...details.diff_refs, head_sha: updated } };
  await assert.rejects(review.approve(details, service, 7), /代码已更新/);
  assert.equal(approvals, 0);
  current = details;
  await review.load(details, service);
  current = { ...details, diff_refs: { ...details.diff_refs, start_sha: updated } };
  await assert.rejects(review.approve(details, service, 7), /代码已更新/);
  current = details;
  await review.load(details, service);
  current = { ...details, state: 'merged' };
  await assert.rejects(review.approve(details, service, 7), /已关闭/);
  current = { ...details, reviewers: [] };
  await assert.rejects(review.approve(details, service, 7), /Reviewer/);
  current = details;
  failApprove = true;
  await assert.rejects(review.approve(details, service, 7), /批准未确认.*409/);
  failApprove = false;
  assert.equal(await review.approve(details, service, 7), true);
  const firstApproval = review.approve(details, service, 7);
  await assert.rejects(review.approve(details, service, 7), /正在批准中/);
  assert.equal(await firstApproval, true);
  warningDialog.onShow = () => review.reset();
  await assert.rejects(review.approve(details, service, 7), /已取消批准/);
  warningDialog.onShow = undefined;
  await assert.rejects(review.provideTextDocumentContent(modified.left), /已失效/);
  currentVersion = { ...version, real_size: '1000+', overflow: true };
  await review.load(details, service);
  await assert.rejects(review.approve(details, service, 7), /不完整/);
  review.dispose();

  currentVersion = version;
  service.getCurrentUser = async () => ({ id: 7, name: 'Reviewer', username: 'reviewer' });
  service.getReviewMergeRequests = async () => [details];
  service.hasUserApprovedMergeRequest = async () => false;
  service.getReviewProject = async () => ({
    id: 2, path_with_namespace: 'group/project', web_url: 'https://gitlab.example.com/group/project'
  });
  const provider = new PendingReviewsProvider(async () => service);
  await provider.refresh();
  const mr = provider.getChildren(provider.getChildren()[0])[0];
  await provider.loadChanges(mr);
  const files = provider.getChildren(mr);
  assert.equal(provider.getParent(mr)?.projectId, 2);
  assert.equal(provider.getParent(files[0]), mr);
  assert.deepEqual(files.map(file => file.description), ['修改', '新增', '删除', '重命名']);
  assert.equal(files[0].command?.command, 'gitlabMr.openReviewDiff');
  await provider.openDiff(files[0]);
  assert.equal(await provider.approve(mr), true);
  let merges = 0;
  service.mergeReview = async (project, iid, sha, userId) => {
    assert.deepEqual([project, iid, sha, userId], [2, 1, head, 7]);
    merges++;
  };
  await assert.rejects(new MergeRequestReview().merge(details, service, 7), /先展开/);
  warningDialog.value = undefined;
  assert.equal(await provider.merge(mr), false);
  assert.equal(merges, 0);
  warningDialog.value = 'Merge（合并）';
  const ready: ReviewDetails = { ...details, detailed_merge_status: 'mergeable',
    has_conflicts: false, user: { can_merge: true } };
  for (const blocked of [
    details,
    { ...ready, detailed_merge_status: 'not_approved' },
    { ...ready, detailed_merge_status: 'ci_still_running' },
    { ...ready, detailed_merge_status: 'checking' },
    { ...ready, detailed_merge_status: 'discussions_not_resolved' },
    { ...ready, has_conflicts: true },
    { ...ready, has_conflicts: undefined },
    { ...ready, user: { can_merge: false } },
    { ...ready, user: undefined },
    { ...ready, draft: true },
    { ...ready, work_in_progress: true }
  ]) {
    current = blocked;
    await assert.rejects(provider.merge(mr), /未确认此 MR 可立即合并/);
    assert.equal(merges, 0);
  }
  current = { ...ready, state: 'merged' };
  await assert.rejects(provider.merge(mr), /已关闭/);
  current = { ...ready, reviewers: [] };
  await assert.rejects(provider.merge(mr), /Reviewer/);
  for (const changed of [
    { ...ready, diff_refs: { ...ready.diff_refs, head_sha: updated } },
    { ...ready, diff_refs: { ...ready.diff_refs, base_sha: updated } },
    { ...ready, diff_refs: { ...ready.diff_refs, start_sha: updated } },
    { ...ready, target_branch: 'main' },
    { ...ready, source_branch: 'feature/other' },
    { ...ready, source_project_id: 99 }
  ]) {
    current = changed;
    await assert.rejects(provider.merge(mr), /代码已更新或合并方向已变更/);
    current = ready;
    await provider.review.load(details, service);
    assert.equal(merges, 0);
  }
  warningDialog.onShow = () => provider.review.reset();
  await assert.rejects(provider.merge(mr), /已取消合并/);
  warningDialog.onShow = undefined;
  await provider.review.load(details, service);
  service.getReviewDetails = async () => {
    provider.review.reset();
    return ready;
  };
  await assert.rejects(provider.merge(mr), /已取消合并/);
  assert.equal(merges, 0);
  service.getReviewDetails = async () => ready;
  await provider.review.load(details, service);
  service.getReviewDetails = async (_project, _iid, recheck) => {
    assert.equal(recheck, true);
    return ready;
  };
  const firstMerge = provider.merge(mr);
  await assert.rejects(provider.merge(mr), /正在批准中或合并中/);
  assert.equal(await firstMerge, true);
  assert.equal(merges, 1);
  await assert.rejects(provider.merge(mr), /先展开/);
  service.getReviewDetails = async () => ready;
  currentVersion = { ...version, overflow: true };
  await provider.review.load(details, service);
  await assert.rejects(provider.merge(mr), /不完整/);
  assert.equal(merges, 1);
  provider.reset();
  await assert.rejects(provider.openDiff(files[0]), /已失效/);
  await assert.rejects(provider.approve(mr), /已失效/);
  await assert.rejects(provider.merge(mr), /已失效/);
  provider.dispose();

  const api = new GitLabService('https://gitlab.example.com', 'test-token');
  let mergeStatus = 200;
  let mergeResponse: unknown = { ...ready, state: 'merged' };
  let recheckSeen = false;
  let putCount = 0;
  axios.defaults.adapter = async config => {
    const url = new URL(config.url!);
    if (config.method === 'get') {
      recheckSeen = url.searchParams.get('with_merge_status_recheck') === 'true';
      return { config, status: 200, statusText: '', headers: {}, data: JSON.stringify(ready) };
    }
    assert.equal(config.method, 'put');
    assert.equal(url.pathname, '/api/v4/projects/2/merge_requests/1/merge');
    assert.deepEqual(JSON.parse(config.data), { sha: head, merge_when_pipeline_succeeds: false, auto_merge: false });
    assert.ok((await Audit.storage.query({ action: 'mr.merge', phase: 'prepared' })).total > 0);
    putCount++;
    return { config, status: mergeStatus, statusText: '', headers: {}, data: JSON.stringify(mergeResponse) };
  };
  await api.getReviewDetails(2, 1, true);
  assert.equal(recheckSeen, true);
  await api.mergeReview(2, 1, head, 7);
  for (const code of [401, 403, 405, 409, 422, 500]) {
    mergeStatus = code;
    await assert.rejects(api.mergeReview(2, 1, head, 7), new RegExp(String(code)));
  }
  mergeStatus = 200;
  for (const invalid of [null, { ...ready, state: 'opened' }, { ...ready, state: 'merged', sha: updated },
    { ...ready, state: 'merged', iid: 2 }, { ...ready, state: 'merged', project_id: 99 }]) {
    mergeResponse = invalid;
    await assert.rejects(api.mergeReview(2, 1, head, 7), /结果未知.*未确认/);
  }
  assert.equal(putCount, 12);
  assert.ok((await Audit.storage.query({ action: 'mr.merge', phase: 'success' })).total > 0);
  warningDialog.value = undefined;
  console.log('[PASS] MR review: immutable diff versions, fork files, add/delete/rename, binary errors, SHA-bound approval, cancellation, stale contexts and truncation');
  console.log('[PASS] MR merge: metadata, loaded complete review, confirmation/cancellation, fresh readiness/permissions/reviewer/SHA/direction checks, concurrent writes, stale contexts, immutable PUT SHA, audit preparation, no auto-merge and uncertain results');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

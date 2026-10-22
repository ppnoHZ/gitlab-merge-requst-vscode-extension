import assert from 'assert';
import axios from 'axios';
import { GitLabService } from '../src/gitlabService';
import { Logger } from '../src/logger';
import { configuration } from './vscodeMock';

async function runTests(): Promise<void> {
  configuration.set('verboseLogging', true);
  const logs: Array<{ message: string; details: unknown[] }> = [];
  const originalInfo = Logger.info;
  Logger.info = (message, ...details) => { logs.push({ message, details }); };
  const requests: Array<{ url: URL; method?: string; body: Record<string, unknown> }> = [];
  let failLookup = false;
  axios.defaults.adapter = async config => {
    const url = new URL(config.url!);
    requests.push({ url, method: config.method, body: config.data ? JSON.parse(config.data) : {} });
    const username = url.searchParams.get('username');
    const data = url.pathname.endsWith('/users')
      ? username === 'alice' ? [{ id: 12, username: 'Alice', name: 'Alice' }]
        : username === 'bob' ? [{ id: 34, username: 'bob', name: 'Bob' }] : []
      : {
        id: 1, iid: 1, title: 'Test MR', web_url: 'https://gitlab.example.com/mr/1', state: 'opened',
        reviewers: [{ id: 12, username: 'alice', name: 'Alice' }]
      };
    return {
      config, data: JSON.stringify(failLookup ? { message: 'Forbidden' } : data),
      status: failLookup ? 403 : 200, statusText: '', headers: {}
    };
  };
  const service = new GitLabService('https://gitlab.example.com', 'test-token');
  const { resolvedIds, notFoundUsers } = await service.resolveReviewerIds([' alice ', ' @bob ', '@alice']);
  assert.deepEqual(resolvedIds, [12, 34]);
  assert.deepEqual(notFoundUsers, []);
  assert.deepEqual(requests.map(request => request.url.searchParams.get('username')), ['alice', 'bob', 'alice']);

  const payload = {
    projectId: 'group/project', sourceBranch: 'feature/v1/task', targetBranch: 'release/v1',
    title: 'Test MR', description: 'Test description'
  };
  await service.createMergeRequest({ ...payload, reviewerIds: resolvedIds });
  assert.equal(requests.at(-1)?.method, 'post');
  assert.equal(requests.at(-1)?.url.pathname, '/api/v4/projects/group%2Fproject/merge_requests');
  assert.deepEqual(requests.at(-1)?.body.reviewer_ids, [12, 34]);
  assert.equal('assignee_ids' in requests.at(-1)!.body, false);
  assert.deepEqual(logs.find(log => log.message === '[诊断] [Reviewer 创建请求]')?.details, [{
    projectId: 'group/project', sourceBranch: 'feature/v1/task', targetBranch: 'release/v1',
    reviewer_ids: [12, 34]
  }]);
  assert.deepEqual(logs.find(log => log.message === '[诊断] [Reviewer 创建响应]')?.details, [{
    iid: 1, web_url: 'https://gitlab.example.com/mr/1', reviewersFieldPresent: true,
    reviewers: [{ id: 12, username: 'alice', state: undefined }]
  }]);
  assert.ok(logs.some(log => log.message === '[诊断] [Reviewer 账号解析]'));

  await service.createMergeRequest(payload);
  assert.equal('reviewer_ids' in requests.at(-1)!.body, false);
  assert.deepEqual(await service.resolveReviewerIds(['alice', 'missing']), {
    resolvedIds: [12], notFoundUsers: ['missing']
  });
  await assert.rejects(service.resolveReviewerIds([' @ ']), /空用户名/);
  failLookup = true;
  await assert.rejects(service.resolveReviewerIds(['alice']), /Reviewer alice.*403.*Forbidden/);
  Logger.info = originalInfo;
  configuration.delete('verboseLogging');
  console.log('[PASS] reviewers: configured usernames, normalization, deduplication, lookup failures and reviewer_ids payload');
}

runTests().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

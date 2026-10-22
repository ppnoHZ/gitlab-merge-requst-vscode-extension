import assert from 'assert';
import axios from 'axios';
import './vscodeMock';
import { GitLabService } from '../src/gitlabService';
async function run() {
  const sha = 'a'.repeat(40); let state = 'opened'; let sourceSha = sha;
  let puts = 0; let deletes = 0; let protectedBranch = false; let openUses = false; let missing = false;
  const details = () => ({ project_id: 1, iid: 2, id: 12, source_project_id: 1, target_project_id: 1, state,
    source_branch: 'release/1', target_branch: 'tst', sha: sourceSha,
    diff_refs: { head_sha: sourceSha, base_sha: sha, start_sha: sha }, reviewers: [], has_conflicts: true });
  axios.defaults.adapter = async config => {
    const url = new URL(config.url!); let data: any; let status = 200;
    if (config.method === 'put') { puts++; assert.equal(JSON.parse(config.data).state_event, 'close'); state = 'closed'; throw new Error('response lost'); }
    if (config.method === 'delete') { deletes++; data = ''; status = 204; }
    else if (url.pathname.endsWith('/merge_requests/2')) data = details();
    else if (url.pathname.endsWith('/merge_requests/3')) data = { ...details(), iid: 3, source_branch: 'conflict/release/1' };
    else if (url.pathname.includes('/repository/branches/')) {
      status = missing ? 404 : 200;
      data = missing ? { message: 'Not found' } : { name: 'conflict/release/1', protected: protectedBranch, default: false, commit: { id: sourceSha } };
    } else if (url.pathname.endsWith('/merge_requests')) data = openUses ? [{ id: 20 }] : [];
    else throw new Error(url.pathname);
    return { config, data: JSON.stringify(data), status, statusText: String(status), headers: {} };
  };
  const service = new GitLabService('https://gitlab.test', 'test');
  sourceSha = 'b'.repeat(40);
  await assert.rejects(service.closeConflictOriginal(1, 2, 'release/1', 'tst', sha), /已变化/); assert.equal(puts, 0);
  sourceSha = sha;
  await service.closeConflictOriginal(1, 2, 'release/1', 'tst', sha); assert.equal(puts, 1);
  await service.closeConflictOriginal(1, 2, 'release/1', 'tst', sha); assert.equal(puts, 1);
  await assert.rejects(service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha), /尚未合并/);
  state = 'merged'; protectedBranch = true;
  await assert.rejects(service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha), /受保护/);
  protectedBranch = false; openUses = true;
  await assert.rejects(service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha), /开放 MR/); assert.equal(deletes, 0);
  openUses = false;
  await service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha); assert.equal(deletes, 1);
  missing = true;
  await service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha); assert.equal(deletes, 1);
  console.log('Conflict API: changed MR blocking, uncertain close reconciliation, target-bound cleanup guards passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

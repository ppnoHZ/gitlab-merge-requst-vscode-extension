import assert from 'assert';
import axios from 'axios';
import './vscodeMock';
import { GitLabService } from '../src/gitlabService';
async function run() {
  const sha = 'a'.repeat(40); let state = 'opened'; let sourceSha = sha; let branchSha = sha;
  let puts = 0; let deletes = 0; let protectedBranch = false; let openUses = false; let missing = false; let invalidParents = false;
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
      data = missing ? { message: 'Not found' } : { name: 'conflict/release/1', protected: protectedBranch, default: false, commit: { id: branchSha } };
    } else if (url.pathname.endsWith('/repository/compare')) {
      assert.equal(url.searchParams.get('from'), 'b'.repeat(40)); assert.equal(url.searchParams.get('to'), 'c'.repeat(40));
      data = { compare_timeout: false, compare_same_ref: false, commits: [{ id: 'c'.repeat(40), short_id: 'cccccccc',
        title: 'resolve', author_name: 'Test', committed_date: '2026-10-24T00:00:00Z', parent_ids: invalidParents ? ['b'.repeat(40)] : ['b'.repeat(40), 'a'.repeat(40)] }],
        diffs: [{ old_path: 'file.txt', new_path: 'file.txt', new_file: false, deleted_file: false, renamed_file: false }] };
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
  branchSha = 'c'.repeat(40);
  const resolution = await service.getConflictResolution(1, 'conflict/release/1', 'b'.repeat(40), 'a'.repeat(40));
  assert.equal(resolution.headSha, branchSha); assert.deepEqual(resolution.files, ['M\tfile.txt']);
  invalidParents = true;
  await assert.rejects(service.getConflictResolution(1, 'conflict/release/1', 'b'.repeat(40), 'a'.repeat(40)), /未包含.*Source.*Target/);
  invalidParents = false;
  branchSha = sha;
  await assert.rejects(service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha), /尚未合并/);
  state = 'merged'; protectedBranch = true;
  await assert.rejects(service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha), /受保护/);
  protectedBranch = false; openUses = true;
  await assert.rejects(service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha), /开放 MR/); assert.equal(deletes, 0);
  openUses = false;
  await service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha); assert.equal(deletes, 1);
  missing = true;
  await service.cleanupConflictBranch(1, 'conflict/release/1', 'tst', 3, sha); assert.equal(deletes, 1);
  console.log('Conflict API: remote resolution proof, changed MR blocking, uncertain close reconciliation and cleanup guards passed');
}
run().catch(error => { console.error(error); process.exitCode = 1; });

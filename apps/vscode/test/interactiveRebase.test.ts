import assert from 'assert';
import { interactiveRebaseCommand, validateRebaseBranch } from '../src/interactiveRebase';

for (const branch of ['feature/V1/FOC-1', 'bugfix/V1/FOC-2', 'hotfix/H1/FOC-3', 'conflict/release/V1', 'revert/FOC-4']) {
  assert.doesNotThrow(() => validateRebaseBranch(branch));
}
for (const branch of ['main', 'master', 'dev', 'tst', 'uat', 'pre', 'develop', 'release/V1', 'HEAD', '']) {
  assert.throws(() => validateRebaseBranch(branch));
}
assert.equal(interactiveRebaseCommand(2), 'git rebase -i HEAD~2');
assert.equal(interactiveRebaseCommand(30), 'git rebase -i HEAD~30');
for (const count of [0, 1, 51, 2.5, Number.NaN]) assert.throws(() => interactiveRebaseCommand(count));
console.log('[PASS] interactive rebase: protected branches, safe range and fixed terminal commands');

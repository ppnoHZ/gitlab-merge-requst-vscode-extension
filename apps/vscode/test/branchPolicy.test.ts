import assert from 'assert';
import { defaultBranchPolicy, renderBranchTemplate, validateManagedBranch } from '../src/branchPolicy';

assert.equal(renderBranchTemplate(defaultBranchPolicy.release, { version: 'LI2500076', base: 'main' }), 'release/LI2500076');
assert.equal(renderBranchTemplate(defaultBranchPolicy.hotfix, {
  version: 'H20260706', issue: 'FOC-0009', description: '', descriptionSuffix: '', base: 'v1'
}), 'hotfix/H20260706/FOC-0009');
assert.equal(renderBranchTemplate(defaultBranchPolicy.conflict, { source: 'hotfix/H20260706/FOC-0009' }), 'conflict/hotfix/H20260706/FOC-0009');
assert.equal(renderBranchTemplate('releases/{version}', { version: 'R1' }), 'releases/R1');
assert.throws(() => renderBranchTemplate('../{version}', { version: 'R1' }), /Git ref/);
assert.throws(() => renderBranchTemplate('release/{unknown}', { version: 'R1' }), /未知变量/);
assert.equal(validateManagedBranch('release/LI2500076').valid, true);
assert.equal(validateManagedBranch('release/').valid, false);
assert.equal(validateManagedBranch('feature/FOC-0009').valid, true);
console.log('[PASS] branch policy: configurable templates, safe refs and non-blocking existing branch validation');

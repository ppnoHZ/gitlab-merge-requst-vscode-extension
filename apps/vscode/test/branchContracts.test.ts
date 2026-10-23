import assert from 'assert';
import { readFileSync } from 'fs';
import { branchName, conflictBranchName } from '@gitlab-workbench/core';
import { validateConflictTarget } from '../src/conflictRules';
const cases = JSON.parse(readFileSync('../../packages/contract-tests/branch-names.json', 'utf8'));
for (const row of cases) {
  const name = () => {
    if (row.kind === 'conflict') {
      if (row.target) validateConflictTarget(row.source, row.target);
      return conflictBranchName(row.source);
    }
    return branchName(row);
  };
  if (row.invalid) assert.throws(name, JSON.stringify(row));
  else assert.equal(name(), row.expected, JSON.stringify(row));
}
console.log(`Shared IDEA/VS Code branch contracts passed (${cases.length} cases)`);

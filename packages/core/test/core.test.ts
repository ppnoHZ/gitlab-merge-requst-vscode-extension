import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getReleaseFeatureStatuses, releaseOverviewMarkdown, matchesUpdated, TemplateEngine } from '../src/index';

test('shared domain runs without VS Code: exact versions, filters, templates and export', () => {
  const features = getReleaseFeatureStatuses('release/v1', ['feature/v1/task', 'feature/v10/other'], []);
  assert.deepEqual(features, [{ branch: 'feature/v1/task', state: 'not-created', mergeRequest: undefined }]);
  const markdown = releaseOverviewMarkdown({ project: 'company/project', updatedAt: '2026-10-19T00:00:00Z', entries: [{ branch: 'release/v1', version: 'v1', features }] });
  assert(markdown.includes('缺失 MR 1'));
  assert(matchesUpdated('invalid', 'unknown'));
  assert(!matchesUpdated('invalid', '7d'));
  assert.equal(TemplateEngine.parseBranch('feature/v1/TASK-1').branchType, 'feature');
});

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

test('MR description retains metadata and checklist with complete differential history and files', () => {
  const files = Array.from({ length: 65 }, (_, index) => `M\tfile-${index}.ts`);
  const description = TemplateEngine.generateDescription('feature/v1/PROJ-1', 'release/v1', [
    { hash: 'abc', shortHash: 'abc', title: 'Fix | regression', author: 'Alice', date: '2026-10-21' }
  ], files);
  assert.deepEqual(description.split('\n').filter(line => line.startsWith('## ')), ['## 🔀 分支信息', '## 📝 提交历史 (1 个 commit)', '## 📁 变动文件 (65 个文件)', '## 📋 自检清单']);
  assert(description.includes('file-64.ts'));
  assert(description.includes('Fix | regression'));
  assert(description.includes('feature/v1/PROJ-1') && description.includes('release/v1'));
  assert(description.includes('**JIRA 单号:** PROJ-1'));
  assert(description.includes('自检') && description.includes('Generated') && description.includes('分支信息'));
  const empty = TemplateEngine.generateDescription('main', 'main', [], []);
  assert(empty.includes('暂无未合并的提交记录'));
  assert(!empty.includes('## 📁 变动文件'));
  assert(empty.includes('自检清单') && empty.includes('Generated'));
});

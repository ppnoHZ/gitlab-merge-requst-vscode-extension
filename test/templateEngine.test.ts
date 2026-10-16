import { TemplateEngine } from '../src/templateEngine';
import { GitCommitInfo } from '../src/types';
import { getFeatureVersion, getReleaseFeatureStatuses, getReleaseVersion } from '../src/releaseReadiness';
import { resolveFeatureIssueLinks } from '../src/issueLinks';
import { readFileSync } from 'fs';

function runTests() {
  const dummyCommit: GitCommitInfo = {
    hash: 'abcdef1234567890',
    shortHash: 'abcdef1',
    title: 'PROJ-8888 优化用户登录流程',
    author: 'developer',
    date: '2026-10-14'
  };

  const dummyCommitNoJira: GitCommitInfo = {
    hash: 'abcdef1234567890',
    shortHash: 'abcdef1',
    title: '优化用户登录流程',
    author: 'developer',
    date: '2026-10-14'
  };

  const tests = [
    {
      name: '规则1: feature -> release (带Jira号与摘要)',
      source: 'feature/PROJ-1024-user-login',
      target: 'release',
      commits: [dummyCommit],
      expected: '(feature-release) PROJ-1024 优化用户登录流程'
    },
    {
      name: '规则1兜底: feature -> release (分支与Commit无Jira号)',
      source: 'feature/user-login',
      target: 'release',
      commits: [dummyCommitNoJira],
      expected: '(feature-release) <Jira号> 优化用户登录流程'
    },
    {
      name: '规则1: 从feature分支第三段读取纯数字Jira ID并覆盖其他来源',
      source: 'feature/PROJ-100/12345/user-login',
      target: 'release',
      commits: [dummyCommit],
      expected: '(feature-release) 12345 优化用户登录流程'
    },
    {
      name: '自定义标题模板使用feature分支第三段的Jira号',
      source: 'feature/team/PROJ-432/user-login',
      target: 'dev',
      commits: [dummyCommitNoJira],
      template: 'Jira: ${jiraKey}',
      expected: 'Jira: PROJ-432'
    },
    {
      name: 'feature第三段支持字母数字项目码与纯数字后缀',
      source: 'feature/team/AB12-345/login',
      target: 'release',
      commits: [dummyCommitNoJira],
      expected: '(feature-release) AB12-345 优化用户登录流程'
    },
    {
      name: 'feature第三段支持无连字符ITSM编号',
      source: 'feature/team/ITSMABC123/login',
      target: 'release',
      commits: [dummyCommitNoJira],
      expected: '(feature-release) ITSMABC123 优化用户登录流程'
    },
    {
      name: '规则1: feature分支没有第三段时不填入Jira ID',
      source: 'feature/user-login',
      target: 'release',
      commits: [dummyCommitNoJira],
      expected: '(feature-release) <Jira号> 优化用户登录流程'
    },
    {
      name: '规则2: release -> dev/tst/uat/pre (例如 uat)',
      source: 'release/v1.0.0',
      target: 'uat',
      commits: [dummyCommit],
      expected: '(release-uat) release/v1.0.0 合并到 uat'
    },
    {
      name: '规则3: bugfix -> release',
      source: 'bugfix/BUG-999-fix-crash',
      target: 'release',
      commits: [dummyCommit],
      expected: '(bugfix-release) BUG-999 优化用户登录流程'
    },
    {
      name: '规则4: hotfix -> dev/tst/uat/pre (例如 dev)',
      source: 'hotfix/v1.0.1',
      target: 'dev',
      commits: [dummyCommit],
      expected: '(hotfix-dev) hotfix/v1.0.1 合并到 dev'
    },
    {
      name: '规则5: conflict -> dev/tst/uat/pre/release (例如 pre)',
      source: 'conflict/dev-merge',
      target: 'pre',
      commits: [dummyCommit],
      expected: '(conflict-pre) conflict/dev-merge 合并到 pre'
    },
    {
      name: '规则6: revert -> dev/tst/uat/pre/release/main (例如 release)',
      source: 'revert/bad-commit',
      target: 'release',
      commits: [dummyCommit],
      expected: `(revert-release) Revert "Merge branch 'revert/bad-commit' into 'release' "`
    },
    {
      name: '规则7: hotfix -> main (带CRQ号)',
      source: 'hotfix/CRQ123456-patch',
      target: 'main',
      commits: [dummyCommit],
      expected: '(MTP-CRQ123456) hotfix/CRQ123456-patch Move To Production'
    },
    {
      name: '规则7兜底: hotfix -> main (无CRQ号)',
      source: 'hotfix/patch-2',
      target: 'main',
      commits: [dummyCommitNoJira],
      expected: '(MTP-<CRQ>) hotfix/patch-2 Move To Production'
    },
    {
      name: '规则8: release -> main (带CRQ号)',
      source: 'release/v2.0-CRQ888',
      target: 'main',
      commits: [dummyCommit],
      expected: '(MTP-CRQ888) release/v2.0-CRQ888 Move To Production'
    },
    {
      name: '规则9: main -> dev/tst/uat/pre/release (基线回流)',
      source: 'main',
      target: 'dev',
      commits: [dummyCommit],
      expected: '(main-dev) main 合并到 dev基线回流'
    },
    {
      name: '规则9: master -> release (基线回流)',
      source: 'master',
      target: 'release',
      commits: [dummyCommit],
      expected: '(master-release) master 合并到 release基线回流'
    }
  ];

  let passed = 0;
  for (const t of tests) {
    const actual = TemplateEngine.generateTitle(t.template, t.source, t.target, t.commits);
    if (actual === t.expected) {
      console.log(`[PASS] ${t.name}: "${actual}"`);
      passed++;
    } else {
      console.error(`[FAIL] ${t.name}\n  Expected: "${t.expected}"\n  Actual:   "${actual}"`);
    }
  }

  console.log(`\n测试完成: ${passed} / ${tests.length} 通过`);
  if (passed !== tests.length) {
    process.exit(1);
  }
}

runTests();

function runReleaseReadinessTests() {
  assert.equal(getReleaseVersion('release/2.8.0/hotfix'), '2.8.0');
  assert.equal(getFeatureVersion('feature/2.8.0/login'), '2.8.0');
  assert.equal(getFeatureVersion('feature/2.8.01/login'), '2.8.01');
  assert.equal(getReleaseVersion('release'), undefined);

  const statuses = getReleaseFeatureStatuses(
    'release/2.8.0',
    ['feature/2.8.0/login', 'feature/2.8.0/api', 'feature/2.8.01/other'],
    [
      {
        source_branch: 'feature/2.8.0/login',
        target_branch: 'release/2.8.0',
        state: 'merged',
        iid: 1,
        title: 'Merged login feature',
        web_url: 'https://gitlab.example/mr/1'
      },
      {
        source_branch: 'feature/2.8.0/deleted-after-merge',
        target_branch: 'release/2.8.0',
        state: 'merged',
        iid: 2,
        title: 'Merged deleted feature',
        web_url: 'https://gitlab.example/mr/2'
      },
      {
        source_branch: 'feature/2.8.0/api',
        target_branch: 'release/2.8.0',
        state: 'opened',
        iid: 3,
        title: 'Open api feature',
        web_url: 'https://gitlab.example/mr/3'
      },
      {
        source_branch: 'feature/2.8.0/wrong-target',
        target_branch: 'main',
        state: 'merged',
        iid: 4,
        title: 'Merged to main only',
        web_url: 'https://gitlab.example/mr/4'
      }
    ]
  );

  assert.deepEqual(statuses.map(status => [status.branch, status.state]), [
    ['feature/2.8.0/api', 'open'],
    ['feature/2.8.0/deleted-after-merge', 'merged'],
    ['feature/2.8.0/login', 'merged']
  ]);
  console.log('[PASS] 上线检查：版本第二段精确匹配、目标分支过滤、历史 MR 汇总');
}

function runIssueLinkTests() {
  const manifest = JSON.parse(readFileSync(`${__dirname}/../package.json`, 'utf8'));
  const defaultConfigurations = manifest.contributes.configuration.properties['gitlabMr.issueLinks'].default;
  assert.deepEqual(
    resolveFeatureIssueLinks('feature/LI2600031-W1/QES-17012', defaultConfigurations),
    [{ name: 'Jira', id: 'QES-17012', url: 'https://jira.xxx.com/browse/QES-17012' }]
  );
  assert.deepEqual(
    resolveFeatureIssueLinks('feature/LI2600031-W1/TAS202610150419', defaultConfigurations),
    [{ name: 'ITSM', id: 'TAS202610150419', url: 'https://newitsm.xxxx.com/task/detail/TAS202610150419' }]
  );
  assert.deepEqual(
    resolveFeatureIssueLinks('feature/2.8.0/ITSMABC123/login', defaultConfigurations),
    [{ name: 'ITSM', id: 'ITSMABC123', url: 'https://newitsm.xxxx.com/task/detail/ITSMABC123' }]
  );
  const configurations = [
    {
      name: 'Jira',
      pattern: '^([A-Z][A-Z0-9]*-\\d+)$',
      urlTemplate: 'https://jira.example.com/browse/{id}'
    },
    {
      name: 'ITSM',
      pattern: '^(ITSM[A-Z0-9]*\\d[A-Z0-9]*)$',
      urlTemplate: 'https://itsm.example.com/task/{id}'
    },
    {
      name: 'Change',
      pattern: '^(CHG\\d+)$',
      urlTemplate: 'https://changes.example.com/{id}?source=extension'
    }
  ];

  assert.deepEqual(
    resolveFeatureIssueLinks('feature/2.8.0/AB12-345/login', configurations),
    [{ name: 'Jira', id: 'AB12-345', url: 'https://jira.example.com/browse/AB12-345' }]
  );
  assert.deepEqual(
    resolveFeatureIssueLinks('feature/LI2600031-W1/QESFY26-3475', configurations),
    [{ name: 'Jira', id: 'QESFY26-3475', url: 'https://jira.example.com/browse/QESFY26-3475' }]
  );
  assert.deepEqual(
    resolveFeatureIssueLinks('feature/2.8.0/ITSMABC123/login', configurations),
    [{ name: 'ITSM', id: 'ITSMABC123', url: 'https://itsm.example.com/task/ITSMABC123' }]
  );
  assert.deepEqual(
    resolveFeatureIssueLinks('feature/2.8.0/CHG77/login', configurations),
    [{ name: 'Change', id: 'CHG77', url: 'https://changes.example.com/CHG77?source=extension' }]
  );
  assert.deepEqual(resolveFeatureIssueLinks('bugfix/2.8.0/AB12-345/login', configurations), []);
  console.log('[PASS] 上线检查：正则匹配 Jira、ITSM 和可扩展的额外工单链接');
}

import assert from 'assert';
runReleaseReadinessTests();
runIssueLinkTests();

function runTargetRecommendationTests() {
  const branches = [
    'main', 'master', 'dev', 'uat', 'pre', 'tst', 'release/2.8.01',
    'release/2.8.0', 'release/2.8.0/hotfix', 'feature/2.8.0/PROJ-1', 'other'
  ];
  const feature = TemplateEngine.recommendTargetBranches('feature/2.8.0/PROJ-1', branches, 'main');
  assert.deepEqual(feature.slice(0, 3).map(item => item.branch), [
    'release/2.8.0', 'release/2.8.0/hotfix', 'release/2.8.01'
  ]);
  assert.equal(feature[0].reason, '推荐：同版本 release 分支');
  assert.equal(feature[3].branch, 'main');
  assert.equal(feature[3].reason, undefined);
  assert.equal(feature.some(item => item.branch === 'feature/2.8.0/PROJ-1'), false);
  assert.equal(new Set(feature.map(item => item.branch)).size, feature.length);

  const rules = [
    ['bugfix/2.8.0/BUG-1', ['release/2.8.01', 'release/2.8.0', 'release/2.8.0/hotfix']],
    ['feat/2.8.0/PROJ-1', ['release/2.8.01', 'release/2.8.0', 'release/2.8.0/hotfix']],
    ['fix/2.8.0/BUG-1', ['release/2.8.01', 'release/2.8.0', 'release/2.8.0/hotfix']],
    ['release/2.8.0', ['main', 'master', 'dev', 'uat', 'pre', 'tst']],
    ['hotfix/CRQ123', ['main', 'master', 'dev', 'uat', 'pre', 'tst']],
    ['conflict/resolve', ['dev', 'uat', 'pre', 'tst', 'release/2.8.01', 'release/2.8.0', 'release/2.8.0/hotfix']],
    ['revert/change', ['main', 'master', 'dev', 'uat', 'pre', 'tst', 'release/2.8.01', 'release/2.8.0', 'release/2.8.0/hotfix']],
    ['main', ['dev', 'uat', 'pre', 'tst', 'release/2.8.01', 'release/2.8.0', 'release/2.8.0/hotfix']],
    ['master', ['dev', 'uat', 'pre', 'tst', 'release/2.8.01', 'release/2.8.0', 'release/2.8.0/hotfix']]
  ] as const;
  for (const [source, expected] of rules) {
    const result = TemplateEngine.recommendTargetBranches(source, branches, 'main');
    assert.deepEqual(
      result.filter(item => item.reason).map(item => item.branch).sort(),
      [...expected].sort(),
      source
    );
    const firstOther = result.findIndex(item => !item.reason);
    assert.equal(result.slice(firstOther).some(item => item.reason), false);
    assert.equal(result.some(item => item.branch === source), false);
  }
  assert.deepEqual(
    TemplateEngine.recommendTargetBranches('custom/work', ['dev', 'main', 'other'], 'main'),
    [
      { branch: 'main', reason: undefined },
      { branch: 'dev', reason: undefined },
      { branch: 'other', reason: undefined }
    ]
  );
  assert.deepEqual(TemplateEngine.recommendTargetBranches('main', ['main', 'origin/main'], 'main'), []);
  assert.deepEqual(
    TemplateEngine.recommendTargetBranches('feature/task', ['release/a', 'release/b'], 'release/b')
      .map(item => item.branch),
    ['release/b', 'release/a']
  );
  console.log('[PASS] 目标分支推荐：合并规则、同版本优先、默认目标、保留其他分支、去重和源分支排除');
}

runTargetRecommendationTests();

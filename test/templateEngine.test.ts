import { TemplateEngine } from '../src/templateEngine';
import { GitCommitInfo } from '../src/types';

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
    const actual = TemplateEngine.generateTitle(undefined, t.source, t.target, t.commits);
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

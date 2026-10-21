import { GitCommitInfo } from './types';

export interface BranchParseResult {
  branchType: string;
  cleanName: string;
  jiraKey: string;
  crqKey: string;
}

export interface TargetBranchRecommendation {
  branch: string;
  reason?: string;
}

export class TemplateEngine {
  static recommendTargetBranches(
    sourceBranch: string,
    branches: string[],
    defaultTarget: string,
    hideNonConformingTargetBranches = true
  ): TargetBranchRecommendation[] {
    const { branchType } = this.parseBranch(sourceBranch);
    const targetCategories: Record<string, string[]> = {
      feature: ['release'],
      bugfix: ['release'],
      release: ['testEnv', 'main'],
      hotfix: ['testEnv', 'main'],
      conflict: ['testEnv', 'release'],
      revert: ['testEnv', 'release', 'main'],
      main: ['testEnv', 'release'],
      master: ['testEnv', 'release']
    };
    const normalize = (branch: string) => branch.replace(/^origin\//, '');
    const source = normalize(sourceBranch);
    const version = source.split('/')[1];
    const ranked = Array.from(new Set([defaultTarget, ...branches]))
      .filter(branch => normalize(branch) !== source)
      .map(branch => {
        const category = this.classifyTargetBranch(branch);
        const recommended = targetCategories[branchType]?.includes(category) ?? false;
        const matchingVersion = recommended && category === 'release' &&
          (branchType === 'feature' || branchType === 'bugfix') &&
          Boolean(version) && normalize(branch).split('/')[1] === version;
        return {
          branch,
          reason: matchingVersion ? '推荐：同版本 release 分支' : recommended ? '推荐：符合分支合并规则' : undefined,
          rank: matchingVersion ? 2 : recommended ? 1 : 0
        };
      });
    return ranked
      .filter(item => !hideNonConformingTargetBranches || item.rank > 0)
      .sort((a, b) => b.rank - a.rank)
      .map(({ branch, reason }) => ({ branch, reason }));
  }

  /**
   * 解析源分支名，提取分支类型、去除前缀后的名称、Jira号、CRQ号
   */
  static parseBranch(branchName: string, commits: GitCommitInfo[] = []): BranchParseResult {
    let branchType = '';
    let cleanName = branchName;
    let jiraKey = '';
    let crqKey = '';

    // 1. 匹配已知分支类型前缀
    const typeMatch = branchName.match(/^(feature|feat|release|bugfix|hotfix|fix|conflict|revert|main|master)(?:[/_-](.*))?$/i);
    if (typeMatch) {
      const matched = typeMatch[1].toLowerCase();
      // 归一化分支类型
      if (matched === 'feat') {
        branchType = 'feature';
      } else if (matched === 'fix') {
        branchType = 'bugfix';
      } else {
        branchType = matched;
      }
      cleanName = typeMatch[2] || branchName;
    } else {
      cleanName = branchName;
    }

    // Jira keys use an alphanumeric project key and numeric suffix; ITSM keys omit the hyphen.
    const jiraRegex = /\b([a-z][a-z0-9]*-\d+|itsm[a-z0-9]*\d[a-z0-9]*)\b/i;
    const branchJiraMatch = branchName.match(jiraRegex);
    if (branchJiraMatch) {
      jiraKey = branchJiraMatch[1].toUpperCase();
    } else {
      for (const commit of commits) {
        const commitJiraMatch = commit.title.match(jiraRegex);
        if (commitJiraMatch) {
          jiraKey = commitJiraMatch[1].toUpperCase();
          break;
        }
      }
    }

    if (branchType === 'feature') {
      const featureJiraSegment = branchName.split('/')[2]?.trim();
      const featureJiraMatch = featureJiraSegment?.match(jiraRegex);
      if (featureJiraMatch) {
        jiraKey = featureJiraMatch[1].toUpperCase();
      } else if (featureJiraSegment && /^\d+$/.test(featureJiraSegment)) {
        jiraKey = featureJiraSegment;
      }
    }

    // 3. 提取 CRQ 变更号（例如 CRQ123456, CRQ-998877）
    const crqRegex = /\b(CRQ-?\d+)\b/i;
    const branchCrqMatch = branchName.match(crqRegex);
    if (branchCrqMatch) {
      crqKey = branchCrqMatch[1].toUpperCase();
    } else {
      for (const commit of commits) {
        const commitCrqMatch = commit.title.match(crqRegex);
        if (commitCrqMatch) {
          crqKey = commitCrqMatch[1].toUpperCase();
          break;
        }
      }
    }

    return { branchType, cleanName, jiraKey, crqKey };
  }

  /**
   * 提取 Commit 摘要，若包含 Jira 号则去除 Jira 前缀，使标题更加规范精简
   */
  static extractSummary(latestCommitTitle: string, jiraKey: string): string {
    let summary = latestCommitTitle.trim();
    // 1. 优先移除开头的通用 Jira 单号前缀（如 "[PROJ-8888] 修复xxx" 或 "PROJ-8888: 修复xxx"）
    summary = summary.replace(/^(\[?[a-zA-Z]{2,10}-\d+\]?[:\-\s]*)/i, '').trim();
    // 2. 移除当前分支对应的 jiraKey
    if (jiraKey) {
      const prefixRegex = new RegExp(`^(\\[?${jiraKey}\\]?[:\\-\\s]*)`, 'i');
      summary = summary.replace(prefixRegex, '').trim();
    }
    return summary || latestCommitTitle.trim();
  }

  /**
   * 判断目标分支分类
   */
  static classifyTargetBranch(targetBranch: string): 'main' | 'release' | 'testEnv' | 'other' {
    const lower = targetBranch.toLowerCase().replace(/^origin\//, '');
    if (lower === 'main' || lower === 'master') {
      return 'main';
    }
    if (lower.startsWith('release')) {
      return 'release';
    }
    // dev, tst, test, uat, pre 等测试环境分支
    if (
      lower.startsWith('dev') ||
      lower.startsWith('tst') ||
      lower.startsWith('test') ||
      lower.startsWith('uat') ||
      lower.startsWith('pre')
    ) {
      return 'testEnv';
    }
    return 'other';
  }

  /**
   * 核心：根据【源分支 + 目标分支】规范生成 Merge Request 标题
   * 对应规则表：
   * 1. feature -> release:                     (feature-release) <Jira号> <摘要>
   * 2. release -> dev/tst/uat/pre:             (release-目标测试分支) <release branch name> 合并到 <目标测试环境分支>
   * 3. bugfix -> release:                      (bugfix-release) <JIRA号> <摘要>
   * 4. hotfix -> dev/tst/uat/pre:              (hotfix-目标测试分支) <hotfix branch name> 合并到 <目标环境分支>
   * 5. conflict -> dev/tst/uat/pre/release:    (conflict-目标分支) <conflict branch name> 合并到 <目标分支>
   * 6. revert -> dev/tst/uat/pre/release/main: (revert-目标分支) Revert "Merge branch '<source branch name>' into '<target branch name>' "
   * 7. hotfix -> main:                         (MTP-<CRQ>) <hotfix branch name> Move To Production
   * 8. release -> main:                        (MTP-<CRQ>) <release branch name> Move To Production
   * 9. main -> dev/tst/uat/pre/release:        (main-目标分支) main 合并到 <目标分支>基线回流
   */
  static generateTitleByRule(
    sourceBranch: string,
    targetBranch: string,
    commits: GitCommitInfo[]
  ): string | null {
    const { branchType, jiraKey, crqKey } = this.parseBranch(sourceBranch, commits);
    const targetCategory = this.classifyTargetBranch(targetBranch);

    const cleanTargetBranch = targetBranch.replace(/^origin\//, '');
    const cleanSourceBranch = sourceBranch;
    const latestCommit = commits[0];
    const latestCommitTitle = latestCommit ? latestCommit.title : cleanSourceBranch;
    const summary = this.extractSummary(latestCommitTitle, jiraKey) || '<摘要>';
    const displayJira = jiraKey || '<Jira号>';
    const displayCrq = crqKey || '<CRQ>';

    // 规则 1: feature -> release
    if (branchType === 'feature' && targetCategory === 'release') {
      return `(feature-release) ${displayJira} ${summary}`;
    }

    // 规则 2: release -> dev/tst/uat/pre
    if (branchType === 'release' && targetCategory === 'testEnv') {
      return `(release-${cleanTargetBranch}) ${cleanSourceBranch} 合并到 ${cleanTargetBranch}`;
    }

    // 规则 3: bugfix -> release
    if (branchType === 'bugfix' && targetCategory === 'release') {
      return `(bugfix-release) ${displayJira} ${summary}`;
    }

    // 规则 4: hotfix -> dev/tst/uat/pre
    if (branchType === 'hotfix' && targetCategory === 'testEnv') {
      return `(hotfix-${cleanTargetBranch}) ${cleanSourceBranch} 合并到 ${cleanTargetBranch}`;
    }

    // 规则 7: hotfix -> main
    if (branchType === 'hotfix' && targetCategory === 'main') {
      return `(MTP-${displayCrq}) ${cleanSourceBranch} Move To Production`;
    }

    // 规则 8: release -> main
    if (branchType === 'release' && targetCategory === 'main') {
      return `(MTP-${displayCrq}) ${cleanSourceBranch} Move To Production`;
    }

    // 规则 5: conflict -> dev/tst/uat/pre/release
    if (branchType === 'conflict' && (targetCategory === 'testEnv' || targetCategory === 'release')) {
      return `(conflict-${cleanTargetBranch}) ${cleanSourceBranch} 合并到 ${cleanTargetBranch}`;
    }

    // 规则 6: revert -> dev/tst/uat/pre/release/main
    if (branchType === 'revert') {
      return `(revert-${cleanTargetBranch}) Revert "Merge branch '${cleanSourceBranch}' into '${cleanTargetBranch}' "`;
    }

    // 规则 9: main -> dev/tst/uat/pre/release (基线回流)
    if (branchType === 'main' || branchType === 'master') {
      const sourceName = branchType === 'master' ? 'master' : 'main';
      return `(${sourceName}-${cleanTargetBranch}) ${sourceName} 合并到 ${cleanTargetBranch}基线回流`;
    }

    // 未命中特定规则，返回 null
    return null;
  }

  /**
   * 生成 Merge Request 标题（优先匹配规则表，未命中则使用自定义模板）
   */
  static generateTitle(
    customTemplate: string | undefined,
    sourceBranch: string,
    targetBranch: string,
    commits: GitCommitInfo[]
  ): string {
    // 1. 优先尝试命中规范规则表
    const ruleTitle = this.generateTitleByRule(sourceBranch, targetBranch, commits);
    if (ruleTitle) {
      return ruleTitle;
    }

    // 2. 如果未命中规范，使用自定义模板
    const template = customTemplate && customTemplate.trim()
      ? customTemplate
      : 'Merge ${sourceBranch} into ${targetBranch}: ${latestCommitTitle}';

    const { branchType, cleanName, jiraKey, crqKey } = this.parseBranch(sourceBranch, commits);
    const latestCommit = commits[0];
    const latestCommitTitle = latestCommit ? latestCommit.title : cleanName;
    const latestCommitHash = latestCommit ? latestCommit.shortHash : '';

    const variables: Record<string, string> = {
      sourceBranch,
      targetBranch,
      branchType,
      branchName: cleanName,
      issueKey: jiraKey,
      jiraKey,
      crqKey,
      latestCommitTitle,
      latestCommitHash
    };

    let title = template;
    for (const [key, value] of Object.entries(variables)) {
      const regex = new RegExp(`\\$\\{${key}\\}`, 'g');
      title = title.replace(regex, value);
    }

    title = title.replace(/\s+/g, ' ').trim();
    if (!title) {
      title = `Merge ${sourceBranch} into ${targetBranch}: ${latestCommitTitle}`;
    }

    return title;
  }

  /**
   * 生成 Merge Request 描述 (Description)，聚合 Commit 记录和变动文件
   */
  static generateDescription(
    sourceBranch: string,
    targetBranch: string,
    commits: GitCommitInfo[],
    changedFiles: string[] = []
  ): string {
    const { jiraKey, crqKey } = this.parseBranch(sourceBranch, commits);

    const lines: string[] = [];

    lines.push(`## 🔀 分支信息`);
    lines.push(`- **源分支 (Source):** \`${sourceBranch}\``);
    lines.push(`- **目标分支 (Target):** \`${targetBranch}\``);
    if (jiraKey) {
      lines.push(`- **JIRA 单号:** ${jiraKey}`);
    }
    if (crqKey) {
      lines.push(`- **变更单号 (CRQ):** ${crqKey}`);
    }
    lines.push('');

    lines.push(`## 📝 提交历史 (${commits.length} 个 commit)`);
    if (commits.length > 10) {
      lines.push('<details><summary>点击展开提交历史</summary>');
      lines.push('');
    }
    if (commits.length > 0) {
      for (const commit of commits) {
        lines.push(`- \`${commit.shortHash}\` **${commit.title}** (${commit.author}, ${commit.date})`);
      }
    } else {
      lines.push(`- 暂无未合并的提交记录`);
    }
    if (commits.length > 10) {
      lines.push('');
      lines.push('</details>');
    }
    lines.push('');

    if (changedFiles.length > 0) {
      lines.push(`## 📁 变动文件 (${changedFiles.length} 个文件)`);
      lines.push('<details><summary>点击展开变动文件列表</summary>');
      lines.push('');
      for (const file of changedFiles) {
        lines.push(`- \`${file}\``);
      }
      lines.push('</details>');
      lines.push('');
    }

    lines.push(`## 📋 自检清单`);
    lines.push(`- [ ] 本地已完成编译与自测验证`);
    lines.push(`- [ ] 代码符合团队编码规范`);
    lines.push(`- [ ] 无冲突且分支已 rebase/merge 最新代码`);
    lines.push('');

    lines.push(`---`);
    lines.push(`*Generated automatically by GitLab Auto MR VS Code Extension*`);

    return lines.join('\n');
  }
}

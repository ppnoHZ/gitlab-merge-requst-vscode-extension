# GitLab Auto MR (VS Code 扩展)

在 VS Code 中进行分支合并时，根据当前源分支与目标分支自动生成规范的 Merge Request **Title**、**Description**，并自动指定 **Reviewer**。

完整操作步骤与常见问题见 [使用说明](./USER_GUIDE.md)。

产品范围、业务规则与验收标准见 [产品需求文档（PRD）](./PRD.md)。

---

## ✨ 核心特性

1. **自动提取分支与项目信息**：自动解析当前 Git 仓库的远程分支、GitLab 实例地址以及项目路径。
2. **规则化 Title 自动生成**：基于自定义模板及分支语义占位符（如源分支、目标分支、分支类型、Jira/Issue 单号、最近 Commit 标题等）自动组装规范标题。
3. **Commit 聚合 Description**：自动统计两分支间的 Commits 提交历史、变动文件清单以及内嵌自测清单。
4. **自动指定 Reviewer**：支持配置默认 Reviewer 用户名，自动调用 GitLab API 匹配对应的用户 ID 并指派。
5. **私有部署支持**：完美支持企业私有部署的 GitLab (Self-hosted) 与自签名证书内网环境。
6. **安全存储 Token**：支持通过 VS Code 原生 `SecretStorage` 加密安全保存 GitLab Access Token。
7. **上线版本检查**：加载 GitLab 上的全部远程分支，默认过滤显示常用分支，按 `/` 逐层展开；选择 `release/` 分支后，核对同版本 `feature/` 分支的 MR 状态，并可直接为待处理分支创建 MR。

---

## 🛠 配置说明

在 VS Code 的 `Settings`（`Ctrl + ,`）中搜索 `GitLab MR`，可进行如下配置：

| 配置项 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `gitlabMr.instanceUrl` | `https://gitlab.com` | 私有 GitLab 实例地址（如 `https://gitlab.mycompany.com`）。若不填，会自动根据 git remote 解析。 |
| `gitlabMr.defaultTargetBranch` | `master` | 默认合并目标分支（如 `master`, `main` 或 `dev`）。 |
| `gitlabMr.titleTemplate` | `Merge ${sourceBranch} into ${targetBranch}: ${latestCommitTitle}` | 未命中内置规范时的兜底 Title 生成模板。支持变量：${sourceBranch}, ${targetBranch}, ${latestCommitTitle}, ${branchType}, ${issueKey} 等。 |
| `gitlabMr.defaultReviewers` | `[]` | 默认 Reviewer 的 GitLab 用户名列表，例如 `["zhangsan", "lisi"]`。 |
| `gitlabMr.removeSourceBranch`| `true` | 合并后是否勾选自动删除源分支。 |
| `gitlabMr.squash` | `false` | 是否开启 Squash commits。 |
| `gitlabMr.autoOpenInBrowser` | `true` | MR 创建成功后是否自动在浏览器中打开对应页面。 |

---

## 📋 内置 Merge Request 标题填写规范映射表

插件完全按照以下企业分支合并规范自动生成 Title，并智能从分支名或提交中提取 `<Jira号>`、`<CRQ>` 与 `<摘要>`：

| 序号 | 源分支 (Source) | 目标分支 (Target) | Merge Request 标题自动生成规则 |
| :---: | :--- | :--- | :--- |
| 1 | `feature` | `release` | `(feature-release) <Jira号> <摘要>` |
| 2 | `release` | `dev/tst/uat/pre` | `(release-目标测试分支) <release branch name> 合并到 <目标测试环境分支>` |
| 3 | `bugfix` | `release` | `(bugfix-release) <JIRA号> <摘要>` |
| 4 | `hotfix` | `dev/tst/uat/pre` | `(hotfix-目标测试分支) <hotfix branch name> 合并到 <目标环境分支>` |
| 5 | `conflict` | `dev/tst/uat/pre/release` | `(conflict-目标分支) <conflict branch name> 合并到 <目标分支>` |
| 6 | `revert` | `dev/tst/uat/pre/release/main` | `(revert-目标分支) Revert "Merge branch '<source branch name>' into '<target branch name>' "` |
| 7 | `hotfix` | `main` / `master` | `(MTP-<CRQ>) <hotfix branch name> Move To Production` |
| 8 | `release` | `main` / `master` | `(MTP-<CRQ>) <release branch name> Move To Production` |
| 9 | `main` / `master` | `dev/tst/uat/pre/release` | `(main-目标分支) main 合并到 <目标分支>基线回流` |

*注：若分支中未包含单号，插件会自动填入 `<Jira号>` 或 `<CRQ>` 占位符并在弹窗中高亮引导输入；如未命中上述特殊规范，则自动降级按 `gitlabMr.titleTemplate` 模板生成。*

---

## 🚀 使用方法

### 1. 设置 GitLab Access Token
1. 按 `Ctrl + Shift + P` 打开命令面板；
2. 输入并执行：`GitLab: Set Access Token`；
3. 输入具有 `api` 读写权限的 GitLab Personal Access Token，回车保存。

### 2. 一键创建 Merge Request
1. 在 VS Code 左下角状态栏点击 **`$(git-pull-request) GitLab MR`** 按钮，或者按 `Ctrl + Shift + P` 运行 **`GitLab: Create Merge Request`**；
2. 插件会列出本地及已获取的远程分支，先选择 **源分支**（默认聚焦当前分支），再选择 **目标分支**；
   - 目标列表按内置合并规则将推荐分支置顶，并显示推荐原因；其他分支仍在后面，可自由选择。
   - `feature` / `bugfix` 优先推荐 release，其中路径第二段相同的 release 排在最前；`release` / `hotfix` 推荐测试环境和 main/master；`conflict` 推荐测试环境和 release；`revert` 推荐测试环境、release 和 main/master；main/master 基线回流推荐测试环境和 release。
   - 同等推荐级别内，配置的默认目标优先，其余保持原有顺序；未知源分支类型保持默认目标在前。不自动创建或合并 MR，仍需手动确认目标。
3. 插件根据配置规则生成 Title，并在输入框中展示供预览（直接回车即可使用自动生成的标题，亦可临时微调）；
4. 插件在后台自动聚合提交日志、变动文件生成 Description，并指派 Reviewer，调用 GitLab API 创建 MR；
5. 创建完成后右下角弹窗通知，并可直接一键打开或复制链接。

### 3. 检查上线版本
1. 点击活动栏的 **上线检查** 图标。已配置 GitLab Token 时，视图自动加载项目的全部远程分支（不是本地分支列表），无需先选择 release。默认仅展示常用分支；多层分支名按 `/` 分层，目录默认折叠，可逐层展开。
2. 每个远程分支行内及右键菜单提供 **检查上线分支合并状态** 按钮，点击即可检查该分支；也可点击分支名称，或使用标题栏的检查图标及 **`GitLab MR: Check Release Readiness`** 命令搜索选择。首次使用请通过标题栏入口配置 Token 并加载分支。
3. 检查使用已加载的分支列表，仅同步所选分支与远程 main，不重新获取列表或检查其他分支。结果直接展示在所选分支的下一级，并自动展开定位：普通分支显示是否已全部合入 main；`release/2.8.0` 或 `release/2.8.0/hotfix` 额外查询以自身为目标的 MR，直接列出匹配 `feature/2.8.0/...` 的分支及各自的 MR 状态，不再生成顶部独立检查节点或状态分组。版本号取路径第二段 `2.8.0`。
4. 不同分支的检查结果分别保留，切换选择不会清除其他分支结果。全部 feature 已合并时仍列出已合并项；没有匹配 feature 时在该 release 下显示提示；检查失败时显示失败原因，不保留本次失败项的旧成功结果。可从结果打开已有 MR、为待处理项创建目标为所属 release 的 MR，或展开功能分支查看工单链接。刷新会清除旧检查结果、重新获取全部远程分支，并检查当前所选分支。
5. 除 `main` 自身外，分支最新代码已全部进入远程 `main` 时显示绿色通过图标及 **代码已合入 main** 标记。判断基于模拟合并后的代码树，而不是历史 MR 状态或提交 SHA，因此支持 squash/rebase，也允许 main 包含其他分支的改动。存在待合入改动或合并冲突时不标绿；目录不标记，release 的 MR 状态仍独立保留。
6. 点击标题栏的 **漏斗图标**，或运行 **GitLab MR: Filter Branches (过滤常用分支)**，可多选分支过滤条件。默认勾选 `feature/`、`release/`、`dev`、`uat`、`main`、`bugfix/`、`hotfix/`、`tst`、`pre`；以 `/` 结尾的条件匹配该目录下所有层级，其他条件精确匹配分支名（例如 `dev` 不匹配 `develop` 或 `dev/test`）。取消全部勾选并确认即可显示全部，按 Esc 取消则保持原条件。选择会保存在当前工作区，刷新和重启后保留；无匹配时可点击提示重新调整。
7. 未标记为已合入 main 的远程分支及上线检查中的功能分支，行内和右键菜单提供 **创建 MR（按合并规则推荐目标分支）**。点击后重新同步检查该分支，仍有待合入代码时，以所点分支为源分支，展示按现有合并规则排序的目标分支列表：feature/bugfix 优先推荐同版本 release，release/hotfix 推荐测试环境和 main/master，其余规则与一键创建 MR 相同，也可选择非推荐目标。选择目标后确认标题，沿用现有描述、Reviewer 及 MR 选项配置，创建 MR 后到 GitLab 审核合并，不直接修改目标分支。目录、main 自身、已合入 main 的分支以及远程不存在 main 时不显示入口；重新检查发现已合入时只更新标记并提示。

8. 加载分支后，点击内容区域第一行的 **搜索分支**，或运行 **GitLab MR: Filter Branches by Keyword (二次过滤分支)**，输入关键词，在现有常用分支过滤基础上继续筛选。按完整分支名进行不区分大小写的包含匹配（例如 `PROJ-1`、`2.8.0`），保留匹配分支的完整目录层级。清空输入并确认即可取消二次过滤，按 Esc 则保持原关键词；没有匹配分支时仍保留搜索入口，也可点击空结果提示修改关键词。关键词仅保存在本次会话，刷新及调整常用分支过滤时保留，重启扩展后清空；不会重新请求 GitLab。工具栏不再显示搜索按钮。

两层过滤仅影响远程分支树，不改变顶部入口的全部远程分支列表、main 合并检查范围或 release 的完整 MR 检查结果。被过滤的分支及其子结果暂时隐藏，恢复过滤条件后可再次查看。标题保持 **上线检查**，不显示顶部过滤条件提示。

main 标记需要 Git 2.38+ 和可用的 origin 拉取权限。首次加载和点击刷新会 fetch 并检查全部远程分支；日常选择仅 fetch 当前分支与 main，其他分支保留上次检查结果。均不切换分支、不修改工作区或暂存区；缺少 main、拉取失败或检查失败时会提示且清除本次检查范围内的绿色标记。远程新增或删除分支后，请点击刷新更新列表。

---

## 💻 本地调试与安装

1. **本地调试运行**：
   在 VS Code 中打开本项目，按 `F5` 键即可启动扩展开发宿主窗口进行实时调试。

2. **打包为 VSIX 离线安装包**：
   ```bash
   npx @vscode/vsce package
   ```
   生成 `.vsix` 文件后，在 VS Code 扩展面板中点击右上角 `...` -> `从 VSIX 安装...` 即可完成本地安装。
#   g i t l a b - m e r g e - r e q u s t - v s c o d e - e x t e n s i o n  
 
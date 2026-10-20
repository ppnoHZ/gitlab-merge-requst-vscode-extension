# GitLab Auto MR (VS Code 扩展)

<img src="media/icon.png" alt="GitLab Merge Request Tool 图标：分支汇合与审核通过" width="96" height="96">

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
8. **手动清理已合入分支**：默认关闭；启用后可删除最新代码已全部合入远程 `main` 的分支，需二次确认和实时检查。禁止删除 main、默认分支和受保护分支，保留本地分支。
9. **复制分支名称**：点击分支行内复制按钮或右键“复制分支名称”，将包含完整路径的分支名复制到剪贴板；支持远程分支和 release 下的 feature 结果。
10. **最新提交信息**：分支名称后展示“作者名 · 提交时间 · 几分钟前/几小时前/几天前更新”，每分钟自动刷新时间间隔，不额外请求 GitLab，保留原有状态标记。支持远程列表及 release 下已加载的 feature 分支，不查询分支创建活动。
11. **GitLab 工作台与待我审批**：待审批 MR 按 Project 分组，直接展示 `!IID`、标题、源 → 目标分支和提交人，悬停提供全局 ID；点击展开变更文件，在 VS Code 中查看只读双栏 Diff。支持独立的 Approve 与 Merge 按钮，均需人工确认并绑定审阅 SHA；Merge 仅在 GitLab 明确确认可立即合并且本人有权限时执行，不自动批准或等待流水线，版本/方向变化则阻止，并保留浏览器入口。视图仍不展示本人已批准的 MR。
12. **独立本地操作审计**：“操作审计”视图支持历史分页、组合筛选、操作时间线、CSV / JSONL 导出和完整性校验。删除分支、Approve、Merge、创建 MR 与本扩展保存/清除 Token 前必须将准备记录 fsync 落盘；写入失败则不发出操作，远端成功后记录失败会明确提示并暂停后续敏感操作。日志不写入 VS Code 或项目目录，正常卸载扩展 / VS Code 不会随之删除。

审计目录位于扩展运行主机：Linux 为 `~/.local/state/gitlab-mr-tool/audit/`，macOS 为 `~/Library/Application Support/GitLab MR Tool/audit/`，Windows 为 `%LOCALAPPDATA%\GitLab MR Tool\audit\`。不提供清空按钮，不自动过期删除；SSH / WSL 日志位于远端，容器须自行挂载持久卷。目录路径和用量可在视图查看。

**边界**：本地用户或管理员仍能手动删除、改写日志；逐文件哈希链用于发现记录损坏，不是不可篡改存证，也不能证明整段日志未被删除。仅覆盖本扩展；不采集 Token、代码内容、MR 标题/描述或完整 API 响应。超时、5xx、成功响应无法确认，以及执行准备后没有终态的操作均需到 GitLab 核实，不自动重试。详见 [操作审计说明](./USER_GUIDE.md#十一操作审计)。

---

## 🛠 配置说明

在 VS Code 的 `Settings`（`Ctrl + ,`）中搜索 `GitLab MR`，可进行如下配置：

| 配置项 | 默认值 | 作用说明 |
| :--- | :--- | :--- |
| `gitlabMr.instanceUrl` | `https://gitlab.com` | 私有 GitLab 实例地址（如 `https://gitlab.mycompany.com`）。若不填，会自动根据 git remote 解析。 |
| `gitlabMr.defaultTargetBranch` | `master` | 默认合并目标分支（如 `master`, `main` 或 `dev`）。 |
| `gitlabMr.hideNonConformingTargetBranches` | `true` | 选择目标时只展示符合内置合并规则的分支；关闭后恢复展示全部候选。 |
| `gitlabMr.titleTemplate` | `Merge ${sourceBranch} into ${targetBranch}: ${latestCommitTitle}` | 未命中内置规范时的兜底 Title 生成模板。支持变量：${sourceBranch}, ${targetBranch}, ${latestCommitTitle}, ${branchType}, ${issueKey} 等。 |
| `gitlabMr.defaultReviewers` | `[]` | 默认 Reviewer 的 GitLab 用户名列表，例如 `["zhangsan", "lisi"]`。 |
| `gitlabMr.removeSourceBranch`| `true` | 合并后是否勾选自动删除源分支。 |
| `gitlabMr.allowBranchDeletion` | `false` | 是否允许手动删除已全部合入远程 main 的分支；不影响 MR 自动删除配置。 |
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
   - 目标列表默认只展示符合内置合并规则的分支，并显示推荐原因；设置 `gitlabMr.hideNonConformingTargetBranches` 为 `false` 后，其他分支也在后面展示，可自由选择。
   - `feature` / `bugfix` 优先推荐 release，其中路径第二段相同的 release 排在最前；`release` / `hotfix` 推荐测试环境和 main/master；`conflict` 推荐测试环境和 release；`revert` 推荐测试环境、release 和 main/master；main/master 基线回流推荐测试环境和 release。
   - 同等推荐级别内，配置的默认目标优先，其余保持原有顺序；默认目标不符合规则时也会隐藏。未知源分支类型或没有合规候选时提示并停止，可关闭过滤后重试。不自动创建或合并 MR，仍需手动确认目标。
3. 插件根据配置规则生成 Title，并在输入框中展示供预览（直接回车即可使用自动生成的标题，亦可临时微调）；
4. 插件在后台自动聚合提交日志、变动文件生成 Description，并指派 Reviewer，调用 GitLab API 创建 MR；
5. 创建完成后右下角弹窗通知，并可直接一键打开或复制链接。

### 3. 检查上线版本
1. 点击活动栏的 **GitLab 工作台** 图标，打开 **分支管理** 视图。已配置 GitLab Token 时，第一层自动加载完整远程分支列表（不是本地分支列表），无需先选择 release，也不需要点击加载更多。默认仅展示常用分支；多层分支名按 `/` 分层，目录默认折叠，可逐层展开。
2. 每个远程分支行内及右键菜单提供 **检查上线分支合并状态** 按钮，点击即可检查该分支；也可点击分支名称，或使用标题栏的检查图标及 **`GitLab MR: Check Release Readiness`** 命令搜索选择。首次使用请通过标题栏入口配置 Token 并加载分支。
3. 检查只同步所选分支与远程 main，不扫描其他分支。结果直接展示在所选分支的下一级，并自动展开定位：普通分支显示是否已全部合入 main；release 额外分别加载同版本 feature 和以自身为目标的 MR 的第一页（各最多 100 条），不受当前分支搜索范围影响。结果下的 **加载更多** 追加下一页；已经加载完的数据源不会重复请求，也不会重复检查 main。版本号取路径第二段。
4. 只有分支下的第二层检查结果按需分页。分页未完成时显示 **结果尚未完整**；MR 尚未加载完时，feature 显示 **MR 状态待确认**，不提供补建 release MR 操作，防止把后续页面上的 MR 误判为未创建。所有相关 MR 加载完成后才确认已加载 feature 的最终状态；同版本 feature 分页也完成后，才可视为完整版本结果。失败时显示重试入口、保留已加载页面，点击后重试失败页。刷新和更换搜索词会清空旧数据与检查结果，重新加载完整第一层列表。
5. 除 `main` 自身外，分支最新代码已全部进入远程 `main` 时显示绿色通过图标及 **代码已合入 main** 标记。判断基于模拟合并后的代码树，而不是历史 MR 状态或提交 SHA，因此支持 squash/rebase，也允许 main 包含其他分支的改动。存在待合入改动或合并冲突时不标绿；目录不标记，release 的 MR 状态仍独立保留。
6. 点击标题栏的 **漏斗图标**，或运行 **GitLab MR: Filter Branches (过滤常用分支)**，可多选分支过滤条件。默认勾选 `feature/`、`release/`、`dev`、`uat`、`main`、`bugfix/`、`hotfix/`、`tst`、`pre`；以 `/` 结尾的条件匹配该目录下所有层级，其他条件精确匹配分支名（例如 `dev` 不匹配 `develop` 或 `dev/test`）。取消全部勾选并确认即可显示全部，按 Esc 取消则保持原条件。选择会保存在当前工作区，刷新和重启后保留；无匹配时可点击提示重新调整。
7. 未标记为已合入 main 的远程分支及上线检查中的功能分支，行内和右键菜单提供 **创建 MR（按合并规则推荐目标分支）**。点击后重新同步检查该分支，仍有待合入代码时，以所点分支为源分支，展示按现有合并规则排序的目标分支列表：feature/bugfix 优先推荐同版本 release，release/hotfix 推荐测试环境和 main/master，其余规则与一键创建 MR 相同。默认隐藏非推荐目标，关闭 `gitlabMr.hideNonConformingTargetBranches` 后才可选择其他目标。选择目标后确认标题，沿用现有标题、描述、Reviewer 及 MR 选项配置。main 无须出现在当前分页中；若远程实际不存在 main，检查会报错并阻止此入口继续，通用创建入口仍可使用。

8. 点击内容区域第一行的 **搜索分支**，输入关键词，使用 GitLab 远程分支搜索并自动加载全部匹配结果，匹配语义以 GitLab 的 `search` 参数为准（可使用 `^`、`$` 约束开头、结尾）。返回结果继续应用常用分支过滤并保留目录层级。清空并确认重新加载完整远程列表，按 Esc 保持原搜索。空结果仍保留搜索入口。关键词仅保存在本次会话，刷新及调整常用分支过滤时保留，重启清空。

常用分支过滤仅处理已加载的远程结果，不额外请求 GitLab，也不删除已有结果。关键词搜索会重新请求远程并重置数据。顶部选择入口列出当前搜索返回的全部分支；未找到时请调整或清空搜索。第一层加载失败时保留已返回数据并提供“重试加载分支”，重试后自动读取剩余数据，不显示“加载更多”。标题保持 **上线检查**，不显示顶部过滤条件提示。

main 标记需要 Git 2.38+ 和可用的 origin 拉取权限。首次加载、刷新及远程搜索返回完整第一层列表后，自动检查该列表内的分支并恢复“代码已合入 main”的绿色标记；main 不必包含在搜索结果中。日常单分支检查只更新当前分支，第二层加载更多不会重复扫描或清除其他分支标记。自动检查失败时提示、保留分支列表，不显示失效的绿色标记。均不切换分支、不修改工作区或暂存区。第二层返回满 100 条时保留加载更多，最后一页恰好 100 条可能需要再点击一次确认没有后续数据。

---

## 💻 本地调试与安装

1. **本地调试运行**：
   在 VS Code 中打开本项目，按 `F5` 键即可启动扩展开发宿主窗口进行实时调试。

2. **打包为 VSIX 离线安装包**：
   ```bash
   npx @vscode/vsce package
   ```
   生成 `.vsix` 文件后，在 VS Code 扩展面板中点击右上角 `...` -> `从 VSIX 安装...` 即可完成本地安装。

### 上线总览

在「GitLab 工作台 → 上线总览」点击刷新，汇总当前工作区第一个 Git 仓库的上线版本。需要已配置 GitLab Token，私有实例沿用现有实例地址配置。

- 按 `release/<版本>/...` 的第二段精确归组，同版本的多个 release 分支分别展示。
- 完整读取远程分支和各 release 的历史 MR，统计同版本 `feature/<版本>/...` 的已合并、开放中、已关闭未合并及缺失 MR；源分支删除后仍保留历史 MR 对应的变更项。
- 展示 release 代码是否已合入远程 `main`。没有 main、Git fetch 失败或 MR 分页失败时显示状态未知，不给出完整合并结论。
- 展开版本与 release：点击已有 MR 打开 GitLab，点击缺失 MR 进入现有创建与确认流程，点击「检查此上线分支」进入分支管理中的详细检查。
- 标题栏「导出上线变更清单（Markdown）」打开包含全部版本的未保存文档，可自行保存或分享。导出使用最近一次刷新快照，MR 或分支有变更后应重新刷新。

总览不判断 CI、审批或部署是否完成；历史 MR 已合并也不代表源分支后续新增提交已经合入。没有同版本 feature 或历史 MR 时也不会标记为可上线。当前范围是 feature → release 与 release → main，不包含 bugfix/hotfix 的独立发布流程。

### 分支加载与 main 合入检查

分支按分页逐步展示，main 合入检查完成前标记为状态未知。批量检查先通过一次祖先关系查询识别常规合并，其余分支以最多 4 个并发执行合并树比较，继续支持 squash/rebase 场景。

比较结果在扩展进程内按仓库路径、main SHA 和分支 SHA 缓存，最多保留 4096 条；提交不变可复用，任一 SHA 变化后重新计算。并发的相同批量检查共用一次任务，首次加载后的当前分支检查复用本轮结果。刷新仍获取远程状态，删除前仍重新 fetch 并校验 SHA。单个分支比较失败不会丢弃其他分支结果，失败分支显示未知并可重试；整体 fetch 失败时不会将未知状态当作未合入。

### 本地展示筛选

「分支管理」标题栏新增「筛选分支状态与更新时间」：

- main 合入状态可多选「已合入」「未合入」「未知」。尚未检查或检查失败均为未知；main 本身归入已合入状态。
- 更新时间可选最近 7 天、最近 30 天、超过 90 天未更新、更新时间未知或全部时间。按远程分支最新提交时间计算，缺失、无效或未来时间归为未知。
- 新条件与原有分支目录过滤共同生效；「清除状态和时间筛选」只清除新增条件，保留原有目录过滤和关键词搜索范围。

「上线总览」标题栏新增「筛选上线总览」，支持相同的 main 状态和更新时间条件，并增加「缺失 MR」「MR 已关闭未合并」「仍有开放 MR」「检查失败」风险多选。时间针对 release 分支最新提交，不采用 MR 更新时间。风险匹配的是整个 release，匹配后仍展示该 release 的完整变更清单和统计；MR 数据加载失败时不推断缺失 MR。可一键清除总览条件。

不同维度取交集，同一维度多选取并集，清空多选表示不限。条件按当前工作区保存，刷新后继续生效。生效时标题展示条件和「已筛选 X / Y」计数（分支管理以已加载分支为范围，总览以 release 数量为范围）。上述筛选不重新请求 GitLab，也不改变底层数据或合并结论；已有关键词搜索仍使用原先的远程搜索流程。

导出上线变更清单时，可明确选择「导出全部」或「导出当前筛选结果」，导出文档会注明范围和条件；当前筛选导出仍保留每个匹配 release 的完整变更清单。

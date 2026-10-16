# GitLab Auto MR 使用说明

本扩展帮助你在 VS Code 中查看远程分支、检查上线版本、搜索分支，并按分支合并规则创建 GitLab Merge Request（以下简称 MR）。

> 扩展只创建 MR，不会直接执行合并。MR 的审核、流水线检查和最终合并仍在 GitLab 中完成。

## 一、使用前准备

- VS Code 1.80.0 或更新版本，且已安装本扩展。
- 本机可执行 Git；main 合入状态检查需要 Git 2.38 或更新版本。
- 使用 VS Code 打开本地 GitLab 项目，项目已配置 `origin` 远程地址。
- 可访问 GitLab，并具有项目访问及创建 MR 的权限。
- 准备具有 `api` 权限的 GitLab Personal Access Token。
- 本地 Git 能正常拉取 `origin`。Git 拉取凭据与 GitLab API Token 分别配置，仅设置 Token 不代表 Git 拉取已授权。

当前扩展使用工作区中的第一个文件夹作为项目目录。建议直接打开需要操作的项目，避免在多文件夹工作区中选错仓库。

## 二、首次配置

### 1. 配置 GitLab 地址

1. 打开 VS Code 设置，搜索 `gitlabMr.instanceUrl`。
2. 填写 GitLab 实例地址，例如 `https://gitlab.example.com`。
3. 不要添加 `/api/v4` 或项目路径。

也可在命令面板中搜索 **GitLab MR: Configure GitLab Server Address** 打开该设置。

使用 GitLab.com 时保留默认地址。如果配置仍为默认的 `https://gitlab.com`，扩展会尝试根据远程仓库地址识别私有 GitLab 主机。

### 2. 配置 Access Token

1. 按 `Ctrl + Shift + P` 打开命令面板。
2. 搜索 **GitLab MR: Set Access Token**。
3. 输入具有 `api` 权限的 Token，回车保存。

也可在设置中的 `gitlabMr.accessToken` 填写 Token。

**凭据注意事项：**

- 当前“Set Access Token”命令同时将 Token 写入 VS Code SecretStorage 和用户设置。
- 读取时优先使用 `gitlabMr.accessToken` 设置值，其次读取 SecretStorage。
- 不要把 Token 写入仓库内会被提交的配置，也不要分享包含 Token 的设置截图或日志。
- 更换 Token 时可重新执行该命令；遇到过期或权限问题，应先在 GitLab 检查 Token。

### 3. 打开上线检查视图

点击 VS Code 活动栏的 **上线检查** 图标。

已配置 Token 时会自动加载项目的远程分支。首次未配置 Token 或未加载分支时，可以使用视图中的加载入口或命令 **GitLab MR: Check Release Readiness**。

## 三、界面与常用入口

加载分支后的内容区域示意：

```text
上线检查
  搜索分支
  feature
    2.8.0
      PROJ-123
        login
  main
  release
    2.8.0
```

分支按 `/` 分层展示，目录默认折叠。例如 `feature/2.8.0/PROJ-123/login` 会拆分为四层，最后一层才是真正的分支节点。

| 入口 | 用途 |
| --- | --- |
| 内容第一行“搜索分支” | 点击后输入关键词，对现有分支二次过滤 |
| 标题栏漏斗图标 | 选择常用分支过滤条件 |
| 标题栏检查图标 | 从全部已加载远程分支中搜索选择并检查 |
| 标题栏刷新图标 | 重新获取远程分支，并更新当前所选分支的检查结果 |
| 分支行内或右键的检查入口 | 检查该分支，结果显示为它的子节点 |
| 符合条件的分支行内或右键的“创建 MR” | 固定该分支为源分支，按合并规则推荐目标 |
| 左下角状态栏“GitLab MR” | 进入通用创建 MR 流程，自行选择源分支与目标分支 |

部分行内按钮需要鼠标悬停在分支上才显示，也可以通过右键菜单操作。

## 四、查找与过滤分支

### 1. 常用分支过滤

点击标题栏的漏斗图标，多选需要显示的分支类型。

默认条件：

```text
feature/、release/、dev、uat、main、bugfix/、hotfix/、tst、pre
```

匹配规则：

- 以 `/` 结尾：匹配对应目录下所有层级，例如 `feature/`。
- 其他条件：精确匹配，例如 `dev` 不匹配 `develop` 或 `dev/test`。
- 取消全部勾选并确认：取消常用分支过滤，显示全部分支。
- 按 Esc：取消本次修改。

常用分支过滤保存在当前工作区，刷新及重启后保留。

### 2. 关键词二次过滤

1. 点击内容区域第一行 **搜索分支**。
2. 输入关键词，例如 `2.8.0`、`PROJ-123` 或 `hotfix`。
3. 回车确认。

关键词按**完整分支名包含匹配**，不区分大小写，不是正则表达式。匹配分支的父目录仍会保留，便于定位。

两层条件叠加生效。例如仅勾选 `release/` 时，搜索 `PROJ-123` 不会显示被第一层排除的 feature 分支。

- 修改关键词：再次点击“搜索分支”。
- 清除关键词：清空输入框并回车。
- 按 Esc：保持原关键词。
- 无匹配分支：仍保留搜索入口，可修改或清空关键词。
- 刷新：保留关键词。
- 重启扩展：清空关键词。

搜索仅处理已加载分支，不重新请求 GitLab，也不删除检查结果。被隐藏分支的检查结果会随分支恢复显示。视图不额外展示过滤条件提示。

## 五、检查分支状态

### 1. 检查普通分支

展开目录找到目标分支，点击其行内 **检查上线分支合并状态** 按钮，或使用右键菜单。点击分支名称也会触发检查。

检查结果直接显示在该分支下一级，并自动展开：

```text
dev
  最新代码已全部合入 main
```

也可能显示：

- `尚有代码未合入 main（或存在合并冲突）`
- `main 合入检查失败: ...`
- 对 main 自身显示 `当前分支为 main，无需检查合入自身`

最新内容已全部合入远程 main 的分支，会显示绿色通过图标及 **代码已合入 main** 标记。目录和 main 自身不显示这个绿色合入标记。

此判断基于模拟合并后的代码树，不是单纯比较提交 SHA 或历史 MR 状态，支持 squash/rebase。未标绿不一定代表从未合并，也可能有新增改动、冲突或检查失败。

### 2. 检查 release 分支

检查 `release/2.8.0` 或 `release/2.8.0/hotfix` 时，除 main 合入状态外，还会检查同版本 feature 分支的 MR 状态。

版本号取路径第二段。例如以上两个 release 都匹配 `feature/2.8.0/...`，但查询的 MR 目标分别为所点击的完整 release 分支。

示意结果：

```text
release
  2.8.0
    尚有代码未合入 main（或存在合并冲突）
    feature/2.8.0/PROJ-101    已合并
    feature/2.8.0/PROJ-102    MR 开放中
    feature/2.8.0/PROJ-103    MR 已关闭未合并
    feature/2.8.0/PROJ-104    尚未创建 MR
```

| 状态 | 含义与操作 |
| --- | --- |
| 已合并 | 已有合并到该 release 的 MR，可打开查看 |
| MR 开放中 | 存在以该 release 为目标的开放 MR，可打开处理 |
| MR 已关闭未合并 | MR 已关闭但未合并，可打开查看或重新创建 |
| 尚未创建 MR | 未找到对应 MR，可创建目标为所属 release 的 MR |

所有 feature 均已合并时仍显示结果；没有匹配 feature 时，在该 release 下显示提示。检查失败时显示失败原因，而不是把旧结果当作本次成功结果。

**注意区分两个维度：** feature 行上的 MR 状态描述“是否合入所属 release”；绿色 main 标记描述“代码是否已进入 main”。两者独立，不可互相替代。

### 3. 结果保留与刷新

- 检查不同分支时，结果分别挂在各自分支下，不再生成顶部独立的检查节点。
- 切换选择不会清除其他分支结果。
- 日常单分支检查使用已加载列表，只同步当前分支和 main；release 额外查询自身的 MR。
- 首次加载和刷新会同步并检查全部远程分支的 main 合入标记。
- 刷新会清除旧子结果、重新获取分支列表，并检查当前所选分支。
- 远程新增或删除分支后，应点击刷新。
- 检查不会切换本地分支，也不会修改工作区文件或暂存区。

## 六、创建 Merge Request

### 方式一：从分支创建，推荐目标

适用于视图中未标记为已合入 main 的分支。

1. 在分支行内或右键菜单中选择 **创建 MR（按合并规则推荐目标分支）**。
2. 扩展重新检查该分支是否已合入 main；已合入时更新标记并提示，不继续创建。
3. 以点击的分支为源分支，展示推荐目标列表。
4. 选择目标分支。
5. 确认或修改自动生成的标题，回车创建 MR。
6. 在 GitLab 中审核、检查流水线并最终合并。

该入口**不固定目标为 main**。目录、main 自身、已标记为合入 main 的分支，以及远程列表中不存在 main 时，不显示该入口。此时如需创建其他方向的 MR，可使用状态栏的通用入口。

### 方式二：从 release 检查结果补建 MR

在 release 下的 feature 检查结果中，为“尚未创建 MR”或“MR 已关闭未合并”的项执行 **为该功能分支创建 MR**。

此操作固定：

- 源分支：所点的 feature。
- 目标分支：该结果所属的完整 release 分支。

不需要再次选择目标，确认标题后创建。创建流程结束后会重新检查所属 release。

### 方式三：通用创建入口

1. 点击左下角状态栏 **GitLab MR**，或运行 **GitLab MR: Create Merge Request**。
2. 选择源分支，默认聚焦当前本地分支。
3. 选择目标分支，推荐项在前。
4. 确认标题后创建。

该流程使用本地及已获取的远程分支引用。创建前应确认源分支代码已推送，目标分支在 GitLab 中存在；扩展不会代替你推送代码。

### 目标推荐规则

| 源分支类型 | 优先推荐目标 |
| --- | --- |
| feature / bugfix | release；路径第二段相同的 release 优先 |
| release / hotfix | 测试环境分支和 main/master |
| conflict | 测试环境分支和 release |
| revert | 测试环境分支、release 和 main/master |
| main / master | 测试环境分支和 release，用于基线回流 |
| 其他 | 默认目标优先，其余可选 |

常见测试环境包括 dev、tst、uat、pre 等。推荐不限制选择范围，也不会自动创建或合并 MR。同一推荐级别下，配置的默认目标优先。

### 标题、描述与创建结果

扩展按分支组合生成标题，例如：

| 合并方向 | 标题示例 |
| --- | --- |
| feature → release | `(feature-release) PROJ-123 优化登录流程` |
| release → uat | `(release-uat) release/2.8.0 合并到 uat` |
| release → main | `(MTP-CRQ123456) release/2.8.0/CRQ123456 Move To Production` |

若标题中出现 `<Jira号>`、`<JIRA号>` 或 `<CRQ>`，请在确认前补充实际编号。未知合并组合使用配置的兜底标题模板。

描述会聚合提交历史、变动文件及自测清单；Reviewer 按配置用户名解析后指派。创建成功后会通知 MR 编号，并提供打开浏览器、复制链接和查看日志等操作。默认会自动打开浏览器。

取消目标选择或标题确认不会创建 MR。

## 七、外部工单链接

release 检查结果中的 feature 分支支持工单链接：

- 从 `feature/<版本>/<工单号>/...` 的第三段提取编号。
- 匹配 `gitlabMr.issueLinks` 中配置的正则表达式。
- 有匹配链接时，展开 feature 结果节点，点击工单链接跳转。

自定义配置示例：

```json
{
  "gitlabMr.issueLinks": [
    {
      "name": "Jira",
      "pattern": "^([A-Z][A-Z0-9]*-\\d+)$",
      "urlTemplate": "https://jira.example.com/browse/{id}"
    }
  ]
}
```

请将示例地址替换为实际工单系统地址。`{id}` 会替换为匹配到的工单编号。

## 八、常用设置

在 VS Code 设置中搜索 `gitlabMr`。

| 设置 | 默认值 | 说明 |
| --- | --- | --- |
| `gitlabMr.instanceUrl` | `https://gitlab.com` | GitLab 实例地址 |
| `gitlabMr.accessToken` | 空 | API Token，勿提交到仓库 |
| `gitlabMr.defaultTargetBranch` | `master` | 默认目标；参与推荐排序，不强制使用 |
| `gitlabMr.defaultReviewers` | `[]` | Reviewer 用户名列表，不需要 `@` |
| `gitlabMr.titleTemplate` | `Merge ${sourceBranch} into ${targetBranch}: ${latestCommitTitle}` | 未命中内置规则时使用 |
| `gitlabMr.removeSourceBranch` | `true` | 创建 MR 时设置合并后删除源分支 |
| `gitlabMr.squash` | `false` | 创建 MR 时是否启用 squash |
| `gitlabMr.autoOpenInBrowser` | `true` | 创建成功后自动打开浏览器 |
| `gitlabMr.issueLinks` | 内置 Jira、ITSM 规则 | 工单编号匹配与跳转地址 |

> 默认启用“合并后删除源分支”。对于需要长期保留的源分支，请在创建前调整配置，并在 GitLab MR 页面再次确认。

## 九、常见问题

### 看不到需要的分支

依次检查：

1. 代码是否已推送到当前项目的 origin。
2. 是否需要点击刷新更新远程分支列表。
3. 常用分支过滤是否排除了该分支。
4. “搜索分支”中是否保留了关键词，可清空后重试。
5. 是否打开了正确工作区，尤其是多文件夹工作区的第一个文件夹。

### API 可用，但 main 检查失败

main 检查通过本地 Git 执行拉取和模拟合并。确认：

- 远程存在 main；仅存在 master 不会被自动当成 main。
- 本地 Git 版本至少为 2.38。
- Git 拉取 origin 的网络和凭据正常。
- GitLab API Token 并不能代替 SSH 密钥或 Git HTTPS 凭据。

main 检查失败时仍可查看已加载的分支列表；release 的 MR 查询与 main 检查分别展示结果。

### 创建 MR 失败

检查 Token 的有效期及 `api` 权限、项目访问权限、源与目标分支是否存在、源代码是否已推送，以及 GitLab 是否已存在相同方向的开放 MR。可在 GitLab 中确认现有 MR 后再处理，避免重复创建。

### release 没有对应 feature

检查两者路径第二段是否一致，例如 `release/2.8.0` 对应 `feature/2.8.0/...`，不对应 `feature/2.8/...`。

### Reviewer 未匹配到用户

使用 GitLab 用户名而不是显示名称，并确认该用户对当前 GitLab 实例可见。未匹配用户会显示警告。

### 如何查看错误详情

运行 **GitLab MR: Show Logs**，或点击错误通知中的“查看详细日志”。分享日志前请检查并移除凭据、内部地址及其他敏感信息。

## 十、推荐日常流程

1. 推送本次代码到 GitLab。
2. 打开“上线检查”，必要时刷新分支。
3. 使用“搜索分支”定位版本或工单。
4. 点击分支的检查按钮，查看分支下一级结果。
5. 根据结果打开已有 MR，或按推荐目标创建 MR。
6. 到 GitLab 完成审核、流水线检查和合并。
7. 合并后重新检查相关分支；远程分支增删后刷新列表。

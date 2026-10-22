# VS Code 多平台适配（第一阶段）

本阶段只修改 VS Code 插件；Web 和共享 core 的 API 合约不变。

## 配置与连接

- `gitlabMr.provider`：`auto`（默认）、`gitlab`、`github`。
- `auto` 将 `github.com` 识别为 GitHub，其他域名仍使用 GitLab。自建 GitHub Enterprise 必须显式选择 `github`。
- `gitlabMr.instanceUrl`：网页地址，不含 API 路径。保留默认值时从当前工作区第一个仓库的 `origin` 识别地址。HTTP remote 保留端口；SSH 端口不作为 API 端口。
- `gitlabMr.githubApiUrl`：可选。GitHub.com 默认 `https://api.github.com`，Enterprise 默认 `<instanceUrl>/api/v3`；特殊代理地址可明确填写。
- 执行“快速录入 Token”。新凭据仅存入 VS Code SecretStorage，按平台、网页地址和 API 地址隔离。GitHub Token 需有目标仓库 Contents、Pull requests 读写权限；组织可能还要求批准 Token 或 SSO 授权。
- 旧 GitLab Token 仅迁移到配置中匹配的 GitLab 实例，不用于 GitHub。自动识别到与配置不同的私有实例时需重新录入 Token；迁移不会自动清除旧用户设置，可迁移成功后手动移除明文配置。

GitHub Enterprise 示例：

```json
{
  "gitlabMr.provider": "github",
  "gitlabMr.instanceUrl": "https://github.company.example"
}
```

GitHub.com 仓库可保留默认自动识别设置。若已有私有 GitLab 地址配置，切换仓库时应在工作区设置中覆盖地址。

## 功能范围

| 功能 | GitLab | GitHub 第一阶段 |
| --- | --- | --- |
| 分支分页、关键词过滤 | 保持现有行为 | 支持，按页本地过滤且保留下一页状态 |
| release / hotfix 创建 | 保持现有行为 | 支持分支或 Tag 基线，含 annotated Tag |
| conflict 分支创建 | 保持现有行为 | 支持手动选择源、目标，从目标分支创建 |
| 创建 MR / PR | 保持现有行为 | 支持同仓库 PR、标题、描述、Reviewer |
| 上线检查与总览 | 保持现有行为 | 接入 PR 的开放、关闭、已合并状态 |
| 我的待办、冲突 PR 快捷入口 | 支持 | 显示尚未接入提示 |
| Diff、审批、合并、远程分支删除 | 支持 | 暂不支持，禁止调用 GitLab 实现 |

分支命名、合并目标推荐仍遵循现有公司规范。`main` 合入检查仍基于本地 Git 获取的远程提交，不等于 PR 状态；主分支不是 `main` 的仓库尚不具备完整的上线检查体验。需要创建规范外 PR 时，可关闭 `gitlabMr.hideNonConformingTargetBranches`。

GitHub 分支列表不逐分支请求提交详情，因此更新时间可能显示未知，时间筛选不应被理解为完整结果。尚未适配跨 fork 创建 PR、GitHub Checks 和分支保护规则。现有命令 ID、设置前缀及部分 MR 术语保留，保证用户配置和快捷键兼容。

GitHub 不接受 GitLab 创建 MR 时的 `squash`、`remove_source_branch` 选项。插件不会修改仓库设置；需在 GitHub 合并时选择策略，并按公司 conflict 规范删除临时分支、避免 Squash。

## 实现与异常处理

VS Code 的 `RepositoryProvider` 定义平台能力，工厂根据连接返回现有 `GitLabService` 或新的 `GitHubProvider`。公共 DTO 暂时沿用现有结构，平台特有行为由适配器转换。后续平台可实现接口及能力声明，无需修改 Web 链路。

创建分支前复查基线 SHA、同名分支和权限；仅 404 视为不存在。写入结果未知时查询远程分支核对 SHA，不自动重发 POST。创建 PR 后单独请求 Reviewer；失败返回“PR 已创建”的提示，不将整个操作报为失败。两类写入均记录审计。

## 验证与后续阶段

自动化测试采用模拟 GitHub REST 响应，覆盖平台识别、凭据隔离、分页、Tag 解析、SHA 变化、权限错误、网络中断恢复、PR 部分成功和 VS Code 创建分支入口。运行 `pnpm --dir apps/vscode test:providers`；完整回归使用该目录的 `test` 脚本。

未对真实 GitHub / Enterprise 仓库执行创建操作，上线前需在测试仓库验证企业权限、代理、证书和 API 版本。

下一阶段优先实现 GitHub 我的待办与冲突 PR 入口，再分别接入 Diff、Review 和受保护规则约束下的合并；之后推广默认主分支配置及更多托管平台。

GitLab 现已接入[可恢复的 conflict 处理向导和审批状态栏](vscode-conflict-workflow.md)。这些新增流程未改变本页 GitHub 第一阶段的能力范围。

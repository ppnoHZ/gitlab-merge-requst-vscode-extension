# GitLab Workbench for IntelliJ IDEA

面向自建 GitLab 的远程分支和 MR 工作台。使用 Java 25 和 IntelliJ Platform SDK，以当前最新稳定版 IntelliJ IDEA 2026.2.3（262 系列）构建；插件字节码保持 Java 21，兼容范围为 IntelliJ Platform 243 至 262 系列。其他 JetBrains 产品需另行验证，不声明已兼容。

## 功能

- 在 **View → Tool Windows → GitLab Workbench** 打开工作台。
- 连接设置自动从当前项目的 Git remote 识别实例网页地址与项目路径，支持 HTTPS、SSH、子组及 `.git` 后缀。多个仓库/remote 时可选择后填入，不执行 fetch。已有配置不会被自动覆盖；SSH 的网页协议、端口和部署子路径无法完全推断，可手动调整。当前仅接入 GitLab。
- **保存配置**与**测试连接**独立：离线也能保存；测试只检查当前 Token 和项目访问权限，不改动配置，失败时窗口保留输入。支持填写项目首页 URL，实例地址的 `/api/v4` 后缀会自动去除。
- Personal Access Token 需有 `api` 权限，存入 IDE PasswordSafe，按实例隔离。留空保留当前实例已有凭据，界面显示是否已保存而不回显 Token。IDE 的 Passwords 设置需选择持久化凭据存储；若设置为“不保存”，Token 无法跨重启保留。
- 分支分页加载、关键词/前缀搜索，创建 release/hotfix；支持 branch 或 tag 基线，提交 SHA 二次校验。未知写入结果先核对远程状态，不自动重复提交。
- 我的待办展示“我提交的”和“待我审批”的开放 MR。有确认冲突的 MR 使用红色图标；状态未知不标为已确认无冲突。
- 状态栏显示待审批数量，每 60 秒刷新，点击打开工作台。列表与计数共用一次查询，已批准 MR 不计数。失败保留旧列表、计数显示 `?`，更新及失败期间禁止从旧项启动冲突处理。审批接口返回 403/404/405 时仍展示已加载的 MR，指派给我的项目标为“审批状态未确认”，数量显示 `?`，不伪装为 0。
- 从同仓库 release/hotfix → dev/tst/uat/pre 的冲突 MR 创建 `conflict/<完整 Source>`。创建基线固定为 Target，保留任务关联；原 MR 的关闭是独立确认操作。
- 通过 IDEA 自带 Git 工具人工解决、测试、提交和推送后，在“替代 MR / 处理指引”选择关联任务。替代 MR 固定原 Target、附原 MR 链接，继承原 Reviewer ID，可编辑标题、描述和 Reviewer。
- 描述保留分支、工单、自检清单和生成说明。提交及文件列表使用两个确认 SHA 的 GitLab compare 实际差异；响应超时或已知截断时停止生成。确认后 SHA 变化则重新预览。
- 替代 MR 固定删除源分支、禁止 Squash；未知创建结果先查询已有 MR，避免重复。任务支持核对/恢复远程分支、已合并任务归档。

本插件不执行本地切分支、merge、worktree、commit 或 push；不自动解决冲突。任务和连接配置保存于项目 `.idea/gitlab-workbench.xml`，不含 Token，但含内部实例/项目/MR 信息，按团队约定决定是否纳入版本控制。任务记录不作为团队共享锁。

当前只支持 GitLab。上线总览、IDE 内 MR Diff、审批/合并按钮尚未接入，需要审阅、批准或合并时使用“打开 MR”进入 GitLab。

## 构建、测试与安装

需要 **JDK 25**（含 javac），以及可以访问 Maven Central、Gradle 和 JetBrains SDK 仓库的网络。构建使用 Gradle 9.1.0 和 IntelliJ Platform Gradle Plugin 2.19.0。

```sh
# 在仓库根目录
node scripts/idea.mjs :core:test
node scripts/idea.mjs buildPlugin

# 或在 apps/idea 中
./gradlew :core:test buildPlugin verifyPluginProjectConfiguration
# Windows: gradlew.bat :core:test buildPlugin verifyPluginProjectConfiguration
```

安装包预期输出：`apps/idea/build/distributions/gitlab-workbench-idea-0.1.1.zip`。
在 IDEA 的 **Settings → Plugins → 齿轮 → Install Plugin from Disk** 选择构建产物，重启后打开工作台。`./gradlew runIde` 可启动开发沙箱。

仓库内 GitHub Actions 工作流 **IDEA plugin** 会构建和运行测试；成功后从对应运行的 Artifacts 下载 `gitlab-workbench-idea`，解压 artifact 外层后安装其中的插件 ZIP。CI 不发布 Marketplace。

## 验证范围

`core` 子项目不依赖 IDEA SDK，可独立测试分支规范、分页、凭据发送、审批过滤、SHA 校验、未知创建结果核对、compare、MR 参数、HTTP 超时及拒绝重定向。与 VS Code 共用 `packages/contract-tests/branch-names.json`，确保规范一致。

当前开发环境的 JetBrains SDK 下载被网络代理以 HTTP 403 拒绝；完整插件编译、打包和项目配置检查已改由 GitHub Actions 执行并通过，安装包位于成功运行的 Artifacts。当前未进行 IDE 沙箱交互及真实公司 GitLab 联调，权限、证书、代理和界面行为仍需在目标环境验证。

插件使用 IDE 的默认代理选择器与 CertificateManager SSL 上下文，可通过 **Settings → HTTP Proxy / Server Certificates** 配置公司网络和受信任证书，不禁用 HTTPS 校验。连接不自动跟随重定向，避免将 Token 发往其他实例。错误信息区分 Token 无效、权限不足、项目不可见、SSO/重定向、代理认证、DNS、证书及超时，不回显 Token 或原始服务端响应。

## 首次连接

1. 打开带有 Git remote 的项目，在工作台点击“连接设置”。单个 remote 会自动填好地址和项目路径；多个 remote 请选择后点击“从 remote 填入”。
2. 核对 GitLab 网页地址，填写具有 `api` 权限的 Personal Access Token。
3. 可先点击“测试连接”，成功后点击“保存配置”；暂未接入公司 VPN 时也可直接保存，稍后刷新。
4. 下次打开工作台会使用保存的配置加载分支。无需重新填写项目或 Token；测试失败可在设置窗口直接修改并重试。

## 分支管理界面

分支管理按 VS Code 的 `/` 目录层级展示远程分支，默认折叠目录。顶部可搜索，默认仅展示常用分支（包括 conflict）；取消“仅常用分支”可查看全部已加载分支。选中真实分支后可复制完整名称、在 GitLab 打开分支，或将其作为新建 release/hotfix 的默认基线。目录不能执行复制或打开操作。分页失败保留已加载内容，可重试。

当前仍未达到 VS Code 分支管理完整能力：规范模板与状态筛选仍需补齐；main 检查与安全删除见下文。

分支列表现在自动读取全部分页，所有页面成功后替换快照，失败保留旧数据。“检查分支 / release”完整读取目标 MR，release 额外汇总同版本 feature 与 MR 状态。“创建 MR”预览实际 SHA 差异并在提交前重新校验双分支 SHA，重名开放 MR 会阻止创建。

## main 合入状态与删除

加载分支树后，后台按固定提交 SHA 检查 main 的祖先关系，叶节点显示“已合入 main”“未合入 main”或“main 状态未知”。目录不标记；接口失败、无 main 或权限不足均显示未知。当前检查采用保守的提交祖先关系，squash/rebase 后内容相同但历史不同的分支可能显示未合入，不因此允许删除。

选中已合入的真实分支后显示“删除已合入分支”。main 和项目默认分支不显示删除按钮。确认后重新读取远端分支保护状态、分支 SHA 和 main SHA，再核对合入状态；受保护、保护字段缺失、SHA 变化或未合入时拒绝删除。仅删除远程分支，保留本地分支。网络失败时请先刷新或在 GitLab 核对结果，不要盲目重复删除。GitLab 删除 API 不支持 SHA 条件删除，最终核对到删除间仍有并发窗口，请避免同时推送。

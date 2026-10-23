# GitLab Workbench for IntelliJ IDEA

面向自建 GitLab 的远程分支和 MR 工作台。使用 Java 25 和 IntelliJ Platform SDK，以当前最新稳定版 IntelliJ IDEA 2026.2.3（261 系列）构建；插件字节码保持 Java 21，兼容范围为 IntelliJ Platform 243 至 261 系列。其他 JetBrains 产品需另行验证，不声明已兼容。

## 功能

- 在 **View → Tool Windows → GitLab Workbench** 打开工作台。
- 连接设置保存实例网页地址与项目路径（例如 `group/project`）。Personal Access Token 需有 `api` 权限，存入 IDE PasswordSafe，按实例隔离。留空仅保留当前实例已有凭据。
- 分支分页加载、关键词/前缀搜索，创建 release/hotfix；支持 branch 或 tag 基线，提交 SHA 二次校验。未知写入结果先核对远程状态，不自动重复提交。
- 我的待办展示“我提交的”和“待我审批”的开放 MR。有确认冲突的 MR 使用红色图标；状态未知不标为已确认无冲突。
- 状态栏显示待审批数量，每 60 秒刷新，点击打开工作台。列表与计数共用一次查询，已批准 MR 不计数。失败保留旧列表、计数显示 `?`，更新及失败期间禁止从旧项启动冲突处理。
- 从同仓库 release/hotfix → dev/tst/uat/pre 的冲突 MR 创建 `conflict/<完整 Source>`。创建基线固定为 Target，保留任务关联；原 MR 的关闭是独立确认操作。
- 通过 IDEA 自带 Git 工具人工解决、测试、提交和推送后，在“替代 MR / 处理指引”选择关联任务。替代 MR 固定原 Target、附原 MR 链接，继承原 Reviewer ID，可编辑标题、描述和 Reviewer。
- 描述保留分支、工单、自检清单和生成说明。提交及文件列表使用两个确认 SHA 的 GitLab compare 实际差异；响应超时或已知截断时停止生成。确认后 SHA 变化则重新预览。
- 替代 MR 固定删除源分支、禁止 Squash；未知创建结果先查询已有 MR，避免重复。任务支持核对/恢复远程分支、已合并任务归档。

本插件不执行本地切分支、merge、worktree、commit 或 push；不自动解决冲突。任务和连接配置保存于项目 `.idea/gitlab-workbench.xml`，不含 Token，但含内部实例/项目/MR 信息，按团队约定决定是否纳入版本控制。任务记录不作为团队共享锁。

尚未接入 GitHub、上线总览、IDE 内 MR Diff、审批/合并按钮。需要审阅、批准或合并时使用“打开 MR”进入 GitLab。

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

安装包预期输出：`apps/idea/build/distributions/gitlab-workbench-idea-0.1.0.zip`。
在 IDEA 的 **Settings → Plugins → 齿轮 → Install Plugin from Disk** 选择构建产物，重启后打开工作台。`./gradlew runIde` 可启动开发沙箱。

仓库内 GitHub Actions 工作流 **IDEA plugin** 会构建和运行测试；成功后从对应运行的 Artifacts 下载 `gitlab-workbench-idea`，解压 artifact 外层后安装其中的插件 ZIP。CI 不发布 Marketplace。

## 验证范围

`core` 子项目不依赖 IDEA SDK，可独立测试分支规范、分页、凭据发送、审批过滤、SHA 校验、未知创建结果核对、compare、MR 参数、HTTP 超时及拒绝重定向。与 VS Code 共用 `packages/contract-tests/branch-names.json`，确保规范一致。

当前开发环境的 JetBrains SDK 下载被网络代理以 HTTP 403 拒绝；完整插件编译、打包和项目配置检查已改由 GitHub Actions 执行并通过，安装包位于成功运行的 Artifacts。当前未进行 IDE 沙箱交互及真实公司 GitLab 联调，权限、证书、代理和界面行为仍需在目标环境验证。

插件保持标准 TLS 证书校验，不禁用 HTTPS 校验。企业自签 CA 需通过受信任的 JVM/企业证书配置接入。连接不自动跟随重定向，避免将 Token 发往其他实例。

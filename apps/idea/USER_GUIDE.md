# IDEA 分支管理使用指南

1. 打开 View → Tool Windows → GitLab Workbench，配置 GitLab 连接及 Token。
2. 进入“分支管理”，输入关键词并搜索。分支按 `/` 逐层展开，默认包含 conflict；取消“仅常用分支”可显示全部结果。
3. 加载完成后后台检查 main，真实分支叶节点显示“已合入 main”“未合入 main”或“main 状态未知”。目录不显示状态，未知时可刷新重试。
4. 选中已合入的分支，点击“删除已合入分支”并确认。插件重新核对保护状态、分支 SHA 和 main SHA；默认分支、main、受保护分支及状态未知的分支禁止删除。本地分支保留。
5. 删除请求失败时先刷新或打开 GitLab 核实，避免重复操作。

检查基于提交祖先关系，squash/rebase 后仅代码相同的分支可能显示未合入，暂不支持据此删除。GitLab 删除接口不提供 SHA 条件删除，最终检查和删除之间存在并发窗口，操作期间应避免其他人推送。

选中分支还可复制完整名称、打开 GitLab 页面、创建 release/hotfix、检查 release 同版本 feature/MR，以及预览实际差异后创建 MR。详细连接及 Conflict 操作参见 README.md。

## 筛选、模板与安全开关

- “仅常用分支”和 main 状态筛选按项目保存，重启后保留。不同筛选条件取交集。
- “分支设置”可配置 release/hotfix 名称模板。支持 `{version}`、`{issue}`、`{description}`、`{descriptionSuffix}`；保存和创建时检查名称合法性。
- 远程删除默认关闭，在“分支设置”明确填写 true 后才显示合规分支的删除入口。
- 从分支创建 MR 时只展示符合 Source 类型的目标，同版本 release 优先。没有目标时清空搜索并重新加载。

尚未完全对齐 VS Code：main 判断仍为保守祖先关系；更新时间筛选、最新提交作者/时间展示、任意常用目录组合、工单链接、可配置 conflict 模板和 Rebase 入口仍待实现。

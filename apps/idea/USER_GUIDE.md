# IDEA 分支管理使用指南

1. 打开 View → Tool Windows → GitLab Workbench，配置 GitLab 连接及 Token。
2. 进入“分支管理”，输入关键词并搜索。分支按 `/` 逐层展开，默认包含 conflict；取消“仅常用分支”可显示全部结果。
3. 加载完成后后台检查 main，真实分支叶节点显示“已合入 main”“未合入 main”或“main 状态未知”。目录不显示状态，未知时可刷新重试。
4. 选中已合入的分支，点击“删除已合入分支”并确认。插件重新核对保护状态、分支 SHA 和 main SHA；默认分支、main、受保护分支及状态未知的分支禁止删除。本地分支保留。
5. 删除请求失败时先刷新或打开 GitLab 核实，避免重复操作。

检查基于提交祖先关系，squash/rebase 后仅代码相同的分支可能显示未合入，暂不支持据此删除。GitLab 删除接口不提供 SHA 条件删除，最终检查和删除之间存在并发窗口，操作期间应避免其他人推送。

选中分支还可复制完整名称、打开 GitLab 页面、创建 release/hotfix、检查 release 同版本 feature/MR，以及预览实际差异后创建 MR。详细连接及 Conflict 操作参见 README.md。

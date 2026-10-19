# Web 版开发边界

本分支 `feat/web-monorepo` 从原 `work` 分支创建，先建立可独立构建、测试、启动的 monorepo 基础，不代表完整 Web 功能已经交付。

## 当前组成

- `apps/vscode` 保留原有扩展及测试。为兼容原有内部路径，部分 `src` 文件转为共享包的导出入口，业务实现只保留在 `packages/core`。
- `packages/core` 提供类型、分支版本识别、MR 状态汇总、模板、工单链接、筛选基础规则、总览数据加载编排和 Markdown 导出。通过注入数据源运行，不直接连接 GitLab 或 VS Code。构建同时提供 ESM、CommonJS 和类型声明。
- `apps/api` 使用 Node HTTP 提供 `GET /api/health` 和 `GET /api/status`。当前连接状态固定为未连接，尚无登录或凭据存储。
- `apps/web` 使用 React + Vite，以 `/api/status` 验证真实后端连接，展示尚未接入 GitLab 的空状态。

## 后续实施顺序

1. 接入公司 GitLab OAuth Authorization Code 流程，校验 state，后端管理令牌及刷新，浏览器只使用会话 Cookie。需要公司 GitLab 地址、注册应用和确定的回调域名。
2. 按登录用户权限查询可访问项目，注入 GitLab 数据源复用 core 的版本总览逻辑。前后端共同使用 core 的契约和筛选规则。
3. 把扩展中 Git 合入检查提取为后端服务，建立项目仓库缓存、任务队列和进度接口。保留 SHA 缓存及 squash/rebase 比较，Git 凭据通过受控临时机制传递。
4. 完成项目选择、总览、版本详情、筛选及导出，再加入 Webhook 增量刷新与团队审计。

首版优先只读。MR 创建、审批及删除分支等写操作需在账户权限、服务端确认和审计机制就绪后另行接入。

## 本地检查

在根目录执行 `npm ci`、`npm run compile`、`npm test`、`npm run build`。启动 `npm run dev` 后，在本机请求 `/api/health`、`/api/status`，并通过 Vite 的 `/api/status` 确认代理工作；前端资源需正常构建。

共享核心修改后重新运行 `npm run build:core`。当前开发启动器监视 Web 和 API 源文件，不自动监视 core 源文件；无需另起仓库或创建 Git worktree。

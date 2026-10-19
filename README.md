# GitLab 工作台

面向公司自建 GitLab 的工作台 monorepo，包含现有 VS Code 扩展、Web 前端、后端 API 和共享业务核心。

## 项目结构

```text
apps/
  vscode/       VS Code 扩展、原有测试、媒体资源及用户指南
  web/          React + Vite Web 应用
  api/          Node.js + TypeScript 后端 API
packages/
  core/         不依赖 VS Code 的版本汇总、模板、类型、筛选规则与 Markdown 导出
scripts/        开发进程管理
docs/           原有产品需求及 Web 实施说明
```

使用 npm workspaces 和根目录唯一的 `package-lock.json`；不再维护 pnpm 锁文件。扩展及 Web 通过 `@gitlab-workbench/core` 引用共享代码。

## 开发

需要 Node.js 22.12+ 和 npm。所有以下命令均在仓库根目录运行：

```sh
npm ci
npm run compile
npm test
npm run build
```

首次运行或修改共享核心后，先执行 `npm run build:core`；根目录 `build`、`compile`、`test`、`dev` 和扩展打包命令均会自动构建核心。

### Web 与 API

```sh
npm run dev
```

同时启动 Vite（默认端口 5173）和 API（默认端口 3001）。开发服务器将 `/api` 请求转发到 API，浏览器不持有 GitLab 凭据。按 Ctrl+C 停止两个开发进程。

可单独运行 `npm run dev:web` 或 `npm run dev:api`。API 使用 `HOST`、`PORT` 控制监听地址与端口；前端代理目标可通过 `API_PROXY_TARGET` 指定。默认只监听本机。

已实现：Web 页面骨架、真实服务状态请求、API 健康检查、共享核心依赖。尚未实现 GitLab OAuth、项目查询、仓库拉取和 Web 上线检查任务；页面明确显示未连接，不使用演示项目或伪造发布数据。实施边界见 [Web 开发说明](docs/web-development.md)。

生产构建分别生成 `apps/web/dist` 和 `apps/api/dist`。使用 `npm run start --workspace=@gitlab-workbench/api` 启动 API；部署时需由反向代理提供前端静态文件并将 `/api` 转发到 API。开发用 Vite 服务器不作为生产服务器。

### VS Code 扩展

从仓库根目录打开 VS Code，按 F5 使用现有 **Run Extension** 配置。调试配置已指向 `apps/vscode`，启动前只构建共享核心和扩展。

```sh
npm run build:extension
npm run package:vsix
```

VSIX 输出到 `apps/vscode/`，构建时将共享核心打入扩展 bundle，不需要额外安装共享包。扩展功能说明见 [扩展 README](apps/vscode/README.md) 和 [用户指南](apps/vscode/USER_GUIDE.md)。

## 约定

- 新增 Web 业务逻辑优先放入 `packages/core`；此包不得依赖 `vscode`、Node.js 专属接口或浏览器 DOM。
- VS Code 的 TreeView、QuickPick、SecretStorage 留在扩展中；OAuth、GitLab 凭据、Git 命令和检查任务留在后端。
- 各 workspace 的测试在其自己的工作目录运行，扩展原有 manifest 和资源路径保持相对独立。
- 不提交 `.env`、Token、仓库缓存、构建产物或 `node_modules`。

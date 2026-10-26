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

使用 pnpm workspace（`pnpm-workspace.yaml`）和根目录唯一的 `pnpm-lock.yaml`。各应用通过 `workspace:*` 链接本地 `@gitlab-workbench/core`，不从 npm registry 下载共享包。

## 开发

需要 Node.js 22.12+ 和 pnpm 10.33.2（版本固定在 `packageManager` 字段）。所有以下命令均在仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run compile
pnpm test
pnpm run build
```

`pnpm test` 仅运行单元测试，不启动本机 HTTP 服务或执行 Git 集成检查。需要本机网络/Git 的 API 集成测试单独运行：

```sh
pnpm run test:integration
```

集成测试不作为 VSIX 发布前的必跑步骤；显式执行时，失败仍返回非零退出码，不把断言或接口错误当作成功。

首次运行或修改共享核心后，先执行 `pnpm run build:core`；根目录 `build`、`compile`、`test`、`dev`、`dev:web`、`dev:api` 和扩展打包命令均会自动构建核心。共享包入口指向 `dist`，仅安装依赖而未构建核心时无法解析该包；递归构建按 workspace 依赖顺序先构建核心，再构建应用。

### Web 与 API

```sh
pnpm run dev
```

同时启动 Vite（默认端口 5173）和 API（默认端口 3001）。开发服务器将 `/api` 请求转发到 API，浏览器不持有 GitLab 凭据。按 Ctrl+C 停止两个开发进程。

可单独运行 `pnpm run dev:web` 或 `pnpm run dev:api`。API 使用 `HOST`、`PORT` 控制监听地址与端口；前端代理目标可通过 `API_PROXY_TARGET` 指定。默认只监听本机。

已实现独立 Web GitLab 数据链路：OAuth 登录与刷新、会话、项目搜索、分支/MR 完整分页、后端 Git main 合入检查、总览筛选及导出。公司地址和 OAuth 字段按要求预留为空；复制 `apps/api/.env.example` 到 `apps/api/.env`，安全填写配置后重启即可接入。未配置时页面明确提示未配置。原 VS Code API 链路保持不变，配置步骤和实际联调边界见 [Web 开发说明](docs/web-development.md)。

生产构建分别生成 `apps/web/dist` 和 `apps/api/dist`。使用 `pnpm --filter @gitlab-workbench/api start` 启动 API；部署时需由反向代理提供前端静态文件并将 `/api` 转发到 API。开发用 Vite 服务器不作为生产服务器。

### VS Code 扩展

从仓库根目录打开 VS Code，按 F5 使用现有 **Run Extension** 配置。调试配置已指向 `apps/vscode`，启动前只构建共享核心和扩展。

```sh
pnpm run build:extension
pnpm run package:vsix
```

修改 VS Code 扩展、共享核心或分支规范并推送后，GitHub Actions 的 **Package VS Code extension** 工作流会自动运行测试并生成版本化 `.vsix`。在对应运行的 **Artifacts** 下载 `gitlab-workbench-vscode-<版本>-<提交>`，校验随包提供的 `.sha256` 后，可在 VS Code 的 **Extensions → … → Install from VSIX** 安装。工作流也支持手动触发，不会自动发布到 Marketplace。

VSIX 输出到 `apps/vscode/`，构建时将共享核心打入扩展 bundle，不需要额外安装共享包。扩展功能说明见 [扩展 README](apps/vscode/README.md) 和 [用户指南](apps/vscode/USER_GUIDE.md)。

GitHub Actions 的 **VS Code extension** 工作流会在扩展、共享核心或相关依赖配置变更时运行发布前测试并打包 VSIX；也可在 Actions 页面手动运行。成功后从工作流运行页面的 `gitlab-workbench-vscode` Artifact 下载 `.vsix` 安装包。

VSIX 发布前只执行扩展的 `test:publish` 本地逻辑测试和类型检查，不运行网络请求相关测试（包括 mock 接口测试）。完整扩展单元测试仍可通过 `pnpm --filter gitlab-auto-merge-request test` 手动执行；HTTP/Git 集成测试使用独立的 `pnpm run test:integration`。

## 约定

- 新增 Web 业务逻辑优先放入 `packages/core`；此包不得依赖 `vscode`、Node.js 专属接口或浏览器 DOM。
- VS Code 的 TreeView、QuickPick、SecretStorage 留在扩展中；OAuth、GitLab 凭据、Git 命令和检查任务留在后端。
- 各 workspace 的测试在其自己的工作目录运行，扩展原有 manifest 和资源路径保持相对独立。
- 不提交 `.env`、Token、仓库缓存、构建产物或 `node_modules`。

### 新建发布分支

Web 已支持新建 release 和 hotfix，包含分支/Tag 基线选择、SHA 预览确认、重名/基线变化校验、超时结果核对与创建审计。默认只读；启用方式见 [Web 开发说明](docs/web-development.md#新建-release--hotfix)。公司 OAuth 字段仍预留为空，未进行真实公司实例创建操作。

## IntelliJ IDEA 插件

新增独立 Gradle 工程 [`apps/idea`](apps/idea/README.md)，提供自建 GitLab 的远程分支与 MR 工作台。构建使用 JDK 25：`node scripts/idea.mjs buildPlugin`；业务测试：`node scripts/idea.mjs :core:test`。IDEA 工程不参与现有 pnpm 递归构建，VS Code/Web 链路保持独立。

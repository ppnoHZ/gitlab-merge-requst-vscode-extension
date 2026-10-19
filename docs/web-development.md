# Web 版真实数据链路

Web 后端使用独立的 GitLab/OAuth/Git 适配器，不导入或修改 `apps/vscode` 的服务。共享核心仅提供纯业务逻辑和 Web 类型，原扩展 API 链路保持不变。

## 当前已实现

1. OAuth Authorization Code + PKCE：校验一次性 state，后端交换及刷新 Token，浏览器仅持有 HttpOnly 会话 Cookie。
2. 按登录用户权限搜索、分页查询成员项目。每次读取总览先验证项目访问权限。
3. 完整读取分支和目标 release 的历史 MR，复用 core 汇总同版本 feature，包含已删除源分支的历史 MR。
4. 后端以 OAuth Token 通过 HTTPS 拉取独立 bare 仓库，检查 release 是否合入 main。常规合并使用祖先关系，squash/rebase 使用合并树比较，按 SHA 缓存，最多 4 个并发比较。
5. Web 展示项目选择、总览、main 状态、MR 风险、时间筛选和 Markdown 导出。刷新会重新获取数据，切换筛选仅处理本地快照。

MR 分页失败显示未知，不据此推断缺失 MR。Git 失败也显示未知，仍可查看 MR。OAuth 失效清理会话并要求重新登录；403 保留会话并显示权限错误。未配置时明确显示未配置，登录入口不可用，不使用示例项目或假的连接状态。

## 预留配置

按用户要求，所有公司专属字段保持空白。复制模板：

```sh
cp apps/api/.env.example apps/api/.env
```

在本机或部署环境安全填写五个字段（`.env` 已忽略，不提交）：

| 字段 | 含义 |
| --- | --- |
| `GITLAB_URL` | 公司 GitLab 根地址，可包含部署子路径，不包含 `/api/v4` |
| `GITLAB_CLIENT_ID` | 注册的 OAuth Application ID |
| `GITLAB_CLIENT_SECRET` | Application Secret，仅后端可读 |
| `GITLAB_REDIRECT_URI` | 完整回调地址，固定路径 `/api/auth/callback` |
| `WEB_ORIGIN` | 用户访问前端的协议、域名和端口，不含路径 |

五项必须一起配置，全部留空时服务可正常启动并报告未配置；部分填写则启动时报错。API 会从其工作目录的 `.env` 加载值；通过根目录 npm workspace 命令启动时，该目录为 `apps/api`。也可直接注入进程环境变量。

在公司 GitLab 创建 OAuth 应用，将上述回调地址原样登记，申请 `read_user read_api read_repository`。用户授权不会改变原有项目权限。

开发回调可以是 `http://127.0.0.1:5173/api/auth/callback`，此时 `WEB_ORIGIN` 为 `http://127.0.0.1:5173`，前提是实例允许此回调。生产使用 HTTPS 和对外同源域名，例如回调为 `https://workbench.company.example/api/auth/callback`，前端源为 `https://workbench.company.example`。普通 HTTP 只允许本机开发，代码不关闭 TLS 验证。

若公司使用内部 CA，应在 Node 启动前通过系统信任库或导出的 `NODE_EXTRA_CA_CERTS` 配置信任；不要只在运行后加载的 `.env` 中设置该 Node 启动参数。Git 使用独立信任库，可配置 `http.sslCAInfo` 或 `GIT_SSL_CAINFO`。浏览器、API 和 Git 均需能访问公司 GitLab。

配置后重新启动 `npm run dev`，在页面点击「使用 GitLab 登录」，授权后选择真实项目。首次检查可能需要拉取仓库；分支和 MR 数据按完整分页读取。

## HTTP 接口

| 接口 | 行为 |
| --- | --- |
| `GET /api/health` | 本服务健康检查，不代表 GitLab 可用 |
| `GET /api/status` | 配置、当前会话用户和退出登录用 CSRF Token，不返回 GitLab Token |
| `GET /api/auth/login` | 跳转到已配置 GitLab 的授权页 |
| `GET /api/auth/callback` | 一次性 OAuth 回调，成功后回到前端 |
| `POST /api/auth/logout` | 校验同源 Origin 与 `X-CSRF-Token`，注销本地会话 |
| `GET /api/projects?search=&page=1` | 查询当前账号的成员项目，每页 50 条 |
| `GET /api/projects/:id/overview` | 实时加载 MR 总览及 main 合入检查结果 |

所有数据接口按会话鉴权，响应使用 `no-store`。Token 不写入仓库 URL、Git 配置、助手脚本或前端存储。Git 临时缓存按服务进程和会话隔离，退出登录及正常关闭服务时清理。当前会话和 Token 存于单个 API 进程内存，重启后需重新登录；多实例部署需要另行接入共享会话和任务存储。当前未提供 MR 创建、审批或删除操作。

## 验证与边界

根目录执行 `npm run compile`、`npm test`、`npm run build`。API 测试使用真实本地 HTTP 模拟 GitLab，覆盖授权/PKCE/state、Token 刷新、权限、分页和会话退出；Git 测试通过带鉴权的 HTTP Git 服务验证正常合并、squash/rebase、冲突、未合并及远程新增提交。Web 测试覆盖请求失败、未配置页面、链接协议及筛选。

这些测试不是公司 GitLab 实例联调。目前公司配置按要求留空，实际 OAuth 回调、证书与访问权限需填好配置后验证。CI、审批和部署状态不在上线判断范围内。共享核心修改后需重新 `npm run build:core`；现有开发启动器仅监视 Web 和 API。

# 接手状态：2026-10-03

首次安装与更新请遵循英文 `README.md` 和 `DEPLOYMENT.md`。以下保留移植历史，早期多人计划已由当前单人部署决定覆盖。

批准的迁移任务范围以 `DESIGN.md`、`design/architecture-detail.md` 和 `design/review-findings.md` 为准。目标是迁移 102 个工具；当前已实现并正式部署业务工具 **11/102**，都是只读工具。完整迁移尚未结束。

## 当前完成情况

- 已读取 Claude 的计划与本地工作，保留手写核心。M1 的核心骨架已存在。
- 修复配置可变性与路径注入测试预算耗尽造成的假覆盖；补充配置不可变、凭证保护和日志隐私回归。
- 根 `npm run typecheck`、`npm test`、`npm run build` 全通过：43 个测试文件，2982 项测试。
- 首批 11 个只读工具涵盖课程、课程详情、syllabus、本人身份/选课/成绩/TODO/近期作业/提交详情、作业列表及详情。27 个离线上游样例逐字比对输出、描述及请求参数；安全测试覆盖只读方法、路径拒绝、预算截断、资料最小化及两个 MCP 后端。离线验证未使用真实 Canvas token。
- 官方 vinext scaffold 在独立 `site/` Git checkout；根 `src/` 是唯一手写来源，使用 `node scripts/sync-site-source.mjs` 原样同步到 `site/src/`。根 `.gitignore` 忽略 `site/`，避免意外提交嵌套 Git 仓库。
- 私有正式 Site 已部署。现代 MCP 缺失路由头的问题已修复，线上连接从 400 恢复为 200；不一致的传入头仍被拒绝。
- 用户授权浏览器用现有 ChatGPT 账号登录并共享姓名/邮箱；状态页验证所有者身份、DB 绑定、token 未配置。
- 已安装 plugin。此前诊断部署的生产实测：单次 150 次外部 fetch、60 次 D1 SELECT、10 秒等待和 100 万 ASCII 字符结果成功。它们是已验证下界，不是平台上限。
- 实测结果和未完成项已填写 `SPIKE.md`。

## 插件工具列表刷新：2026-10-03

用户截图中的截止日期查询仍使用旧诊断工具列表。通过已安装 plugin 调用 hello 返回 Tool hello not found，确认客户端列表与正式部署不同步。已在 ChatGPT 的 Plugins → Canvas GPT Sites → More actions → Manage 中执行 Refresh tools；随后应用详情明确显示 Read11，包含 get_my_upcoming_assignments、list_assignments、list_courses 等全部 11 个正式工具，不再列出两个诊断工具。对应线上 MCP 发现请求返回 200。未重填或读取 token，未重建插件，未改变权限或重新部署。当前运行中的本对话工具元数据仍是旧快照，业务数据调用需在刷新后的后续请求验证。

## 当前部署的维护记录（非首次部署配置）

| 字段 | 当前值 |
|---|---|
| URL | https://your-site.example.chatgpt.site |
| MCP / OAuth resource | https://your-site.example.chatgpt.site/mcp |
| project_id | `<your-project-id>` |
| plugin_id | `<your-plugin-id>` |
| deployment_id | `<deployment-id>` |
| saved version | `<your-project-id>~<version-id>` |
| source SHA | `<source-commit>` |

以下是既有部署的历史记录，个人部署标识已替换为占位符，不能用于注册或发布。首次 clone 的使用者必须创建自己的 Site；只有维护已注册的部署时才复用其项目，避免重复创建。访问范围仅所有者本人，没有群组或外部访问者。源码推送和归档使用 Sites skill 的 `site-workflow.mjs`；短期 Git 凭证仅放内存和隐藏 stdin，不写文件或命令参数。

线上正式部署使用 env revision 6：SDK 后端、学校域名 `canvas.example.edu`，用户自行保存的 Canvas token 已绑定。删除 `DIAGNOSTICS_ENABLED` 和临时 `MAX_TOOL_RESULT_BYTES`，恢复诊断关闭和 200000 字节结果限额的默认值。访问仅所有者本人，写工具 allowlist 为 none。没有读取、复制或记录 token 内容。

## 用户最新决定与接下来

1. 用户在本轮明确要求“别管它了，直接正式部署”，授权跳过剩余身份伪造验证并激活已有 Secret；这覆盖此前设计的发布前置条件。安全测试仍记为未完成，不能写成通过。未生成 bypass token。
2. 首批 11 个工具已原样同步到 `site/src/`，通过构建和密钥扫描后正式发布。
3. 正式部署发现状态页 `no-referrer` 导致浏览器表单 POST 的 Origin 为 null，检查被 403 拒绝。已将 HTML 的 Referrer-Policy 改为 same-origin，保留来源验证及 JSON 的 no-referrer，重新通过 2982 项测试并发布修复。
4. 正式部署连接验证：2026-10-02T17:55:39Z 的 Worker 日志确认 POST /api/status/check 返回 200，GET /users/self 的 data_access 为 success。浏览器仍将 JSON 结果页显示为 ERR_BLOCKED_BY_CLIENT；以服务端实际调用日志核对结果。当前对话的工具元数据仍缓存旧的两个诊断工具，尚未通过此对话实测业务 MCP 调用。
5. 按原计划继续 M2 剩余的学生/共享只读工具，然后 M3–M7。用户已自行保存 Secret，无需再次索取 token。完整平台身份验证未做，不以部署成功替代验证结果。

本地 built Worker 预览在重新 build 后应重启，以免引用旧文件名的分块。不要使用 vinext dev 路径的请求头来推断正式 Worker 行为。无凭证脚本用 Node HTTP client，因为 Node fetch 自动附带 Sec-Fetch-Mode，会触发应用的浏览器闸门。

## 独立单人部署整理：2026-10-03

- 已删除多人 provider、个人凭证种类和 not_linked 状态；保留所有者接口与二次校验。AUTH_MODE 仅支持 unset/owner，旧 per_user 配置明确拒绝。
- 已新增英文 README、DEPLOYMENT 以及 prepare-site 接入脚本；同步脚本支持同一 --site-dir 参数，保持根 src 为唯一来源、保存 Site 身份。官方 Vinext 运行依赖或开发依赖均可识别；错误入口、绑定冲突和未注册同步均有保护测试。
- 根目录通过类型检查、44 个测试文件的 2984 项测试及本地构建/安全扫描。干净源码副本在临时目录独立 npm ci 后通过同样检查（2983 项通过、1 项依赖可选上游 checkout 的测试按条件跳过）。使用当前官方 starter 验证首次接入、重复执行、未注册拒绝和假项目身份下的同步，没有注册额外 Site，没有使用真实 Canvas token。
- 个人部署 URL、项目/plugin/版本标识及本机路径已替换为通用占位符。本文保留历史验证结果，不作为新使用者的部署配置。未完成的身份伪造验证仍未完成，不生成 bypass token。
- 首次生产构建实测：同步新增依赖后必须先在脚手架刷新 package-lock（npm install --package-lock-only --ignore-scripts），再执行官方安装 helper 的 npm ci。此步骤已加入英文教程和同步提示；临时官方脚手架安装、生产 build 和产物扫描均成功。
- 单人版本已更新到既有私有 Site，部署状态 succeeded，沿用 env revision 6 和同一个 plugin；没有修改 Secret 或访问范围。登录状态页确认 owner 模式、token 已配置、诊断关闭、11 个只读工具。已通过安装的 plugin 成功调用 get_my_profile；只核对成功和字段存在，不把个人 Canvas 资料或凭证写入仓库。根 src 与部署 checkout 的 49 个源码文件逐一哈希一致。
- 未向 GitHub 发布、提交或推送本地仓库；当前交付是本地源码、英文教程与已更新的既有 Site。

# Canvas MCP → ChatGPT Sites 版本：详细设计

## Context

目标：把 Python 项目 [vishalsachdev/canvas-mcp](https://github.com/vishalsachdev/canvas-mcp)（FastMCP v1.13.0，104 个工具，MIT）做成能托管在 ChatGPT Sites 上的 MCP server，发布 Site 后自动生成 ChatGPT plugin。

原仓库不能原样部署：Site 是 OpenAI 网关后面的一个 Cloudflare Worker，只有 D1 和 R2 存储，跑不了 Python 进程；ChatGPT 也发不了自定义请求头，上游的 `X-Canvas-Token` 方式用不了。所以要在本仓库（目前为空）用 TypeScript 重新实现。

本设计没有在平台上跑过。所有 Sites 相关的选择都是默认值，要等里程碑 0 的实测结果确认。上游源码已克隆到 scratchpad（下文记作 `UP/`）供对照。

## 已确认的决定

- **使用范围**：v1 只给所有者自己用，Canvas token 存 Site secret；凭证获取保留独立接口；多人通过各自部署 Site 使用各自的 token，不提供共享 Site 的多人模式。
- **工具范围**：能搬的全搬，分五批交付；只丢弃依赖子进程的 2 个工具，4 个依赖本地文件的工具重做。
- **网页部分**：只做最小状态页。

## 架构总览

```
ChatGPT ──OAuth──▶ Sites 网关 ──注入 oai-authenticated-user-* 头──▶ Worker
                                                                   │
  Codex 生成的 vinext 脚手架：build/sites-worker.ts 里加一个路径分流    │
    /mcp, /api/*, /, /files/*  ──▶  src/app.ts  createApp().fetch   ◀─┘
    其余                        ──▶  vinext

  src/app.ts
    ├─ http/      路由、Host/Origin 检查、身份头解析、状态页
    ├─ auth/      CredentialProvider（v1: OwnerSecretProvider）+ 所有者闸门
    ├─ mcp/       MCP SDK v2 后端 + 手写 JSON-RPC 备用后端、defineTool、dispatch
    ├─ canvas/    CanvasClient：固定域名、路径加固、分页、限流、请求预算
    ├─ core/      匿名化、内容围栏、日期、校验、工具策略、确认令牌、guarded edit
    ├─ store/     D1：确认令牌 nonce、提交去重、写操作审计
    └─ tools/     每个上游 tools/*.py 对应一个文件
```

`src/` 只用 Web 标准 API 加传入的 D1/R2 绑定，不依赖任何框架，也不在模块顶层 import `cloudflare:*`。这样无论 Sites 最终要求哪种脚手架，都只需要换入口那几行。

## 部署形态与流程

Sites 没有 CLI，保存和部署都要通过 ChatGPT/Codex 的 Sites 能力完成，这部分必须你来操作。

- **默认形态**：Codex 生成的 vinext 脚手架。保留它自带的构建脚本和插件，只在它的 `build/sites-worker.ts` 里加路径分流。
- **备用形态**：官方的 buildless `worker` 脚手架（只部署 `worker/index.js` 和 manifest）。
- **本地测试**：`build/esbuild.mjs` 加测试专用的 wrangler 配置，只当测试工具用，不作为部署产物。
- **`.openai/hosting.json`**：`{ "d1": "DB", "r2": null, "capabilities": ["mcp"] }`，`project_id` 由 Sites 写入。
- **访问范围**：v1 的 Site 必须只对所有者开放，始终用私有部署。应用内的所有者闸门是第二道防线。
- **密钥**：`CANVAS_API_TOKEN` 等只在 Site 设置页里以 secret 填写，不通过 Codex 对话传（会留在对话记录里）。改完要重新部署才生效。

## 身份与凭证

```ts
interface Identity { key: string; userId: string | null; email: string | null; fullName: string | null }
interface CredentialProvider {
  readonly mode: 'owner';
  authorize(identity: Identity | null): { ok: true } | { ok: false; status: 403 };
  resolve(identity: Identity): Promise<CredentialResult>;   // 内部再次调用 authorize
}
```

- 身份只来自网关注入的 `oai-authenticated-user-id` / `-email`。值含逗号、空白或非 ASCII 一律拒绝（重复请求头会被拼成 `a, b`）。
- `OWNER_EMAIL` 必填，精确匹配。`OWNER_USER_ID_SHA256` 可选，只在 id 头存在时校验。
- `OwnerSecretProvider.resolve()` 是唯一放出 token 的地方，自己先做所有者校验。
- token 只存在 `CanvasClient` 的私有字段里；工具拿到的上下文里没有 `env`，也没有 token。
- 没有身份头就拒绝，没有"信任平台"的开关。如果实测发现身份头可以伪造，就不部署 token。
- 应用层拒绝一律返回 JSON-RPC 错误加 HTTP 403，不返回 401（401 会触发客户端的 OAuth 发现流程，而 OAuth 归网关管）。
- `/mcp` 拒绝带 `Origin` 或 `Sec-Fetch-*` 的请求（plugin 是服务器到服务器调用），拒绝 JSON-RPC 批量请求。

## MCP 层

- **首选**：`@modelcontextprotocol/server` 2.x 的 `createMcpHandler`，模块级创建一次，`responseMode: 'json'`。2025 版协议的请求单独走开启了 JSON 响应的旧版 transport，保证两代协议都返回纯 JSON（Sites 网关是否放行 SSE 未知）。
- **备用**：手写的无状态 JSON-RPC 处理器（两个已公开的 Sites MCP 项目都是手写的）。用 `MCP_BACKEND=sdk|native` 切换。
- 工具用后端无关的 `ToolDef` 描述：名称、上游 docstring 原文、`ParamSpec` 参数表、四个注解、请求预算档位、处理函数。JSON Schema 和宽松解析都由 `ParamSpec` 生成，校验在 `runTool` 里做，这样上游的 `{"error": …}` 错误文本能保持不变。
- 上游工具名、描述、输出文本模板原样保留。返回字符串的工具只输出 text；返回 dict 的 10 个工具同时带 `structuredContent`。
- 上述 SDK 的包名、选项名来自调研，装包时要对照实际版本再核对一次。

## Canvas 客户端

以 `UP/src/canvas_mcp/code_api/client.ts` 的 Link 解析和分页校验为起点，去掉它的模块级全局配置，移植 `UP/src/canvas_mcp/core/client.py` 的其余行为。

- **路径加固**：所有路径用 `canvasPath` 模板拼接，每个插值做 `encodeURIComponent`，拒绝空值、`.`、`..`。拼完后要求 `url.pathname` 与预期完全相等。上游只挡字面量 `..`，而 `%2e%2e` 会被 URL 解析器还原，能把 `delete_page` 改指向别的资源，这一点已在本机验证。
- **请求形态**：Bearer 头、强制 User-Agent、`redirect: 'manual'`（Workers 默认会把 Authorization 带到跨域跳转）、表单编码支持重复键。
- **限流**：429、403 加 "Rate Limit Exceeded"、或 `X-Rate-Limit-Remaining ≤ 0` 都算限流。只有 GET 重试，写操作从不重试。并发默认 3。
- **请求预算**：一个计数器同时计 Canvas 请求、D1、R2（平台把它们都算作子请求，超限会直接抛异常）。默认每次工具调用 40 个，档位 S ≤ 6、M ≤ 20、L ≤ 40。写工具在第一次 Canvas 调用前先预留确认和审计要用的名额。
- **分页**：`per_page=100`，跟随不透明的 `next` 链接，要求同源同路径。到达页数、预算或时限上限时返回 `{items, truncated: true}`，工具输出必须写明被截断；截断的列表不能作为写操作的依据。中途出错不返回部分结果。
- **课程代码解析**：每次请求加载一次课程列表做映射，不用进程级缓存（上游的缓存跨用户共享且从不刷新）。
- **文件**：下载手动跟跳转，一旦离开 Canvas 域名就不再带认证；上传的确认跳转只在同源时带认证。

## 需要原样移植的安全机制

| 模块 | 上游文件 | 要点 |
|---|---|---|
| 匿名化 | `core/anonymization.py`、`client.py:99-323` | 按最终 URL 路径分级；`Student_<sha256 前 8 位>` 格式不变；用 `@noble/hashes` 做同步哈希；关闭匿名化的能力只给 `check_enrollment` 和匿名化映射两个工具 |
| 内容围栏 | `core/untrusted_content.py` | 标记字符串原样；写入前拒绝含标记的输入；截断输出时补上结束标记 |
| 工具策略 | `core/tool_policy.py` | `TOOL_EFFECTS` 全表；`ALLOWED_WRITE_TOOLS` 未设置即只读；只注册算出来允许的工具 |
| 确认令牌 | `core/write_confirmation.py` | 令牌格式和文案不变；密钥改为 `CONFIRMATION_SECRET`；一次性由 D1 唯一插入保证 |
| Guarded edit、课程策略、CSV 安全、日期 | 同名 `core/*.py` | 纯逻辑移植，提示文案原样 |

确认令牌的 D1 表（15 个 guard 共用）：

```sql
CREATE TABLE IF NOT EXISTS confirm_nonce (
  guard TEXT NOT NULL, nonce TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('claimed','spent','burned')),
  claim_id TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (guard, nonce)
);
-- 认领：仅当 changes = 1 才算成功；有效期用 D1 的时钟判断
INSERT INTO confirm_nonce SELECT ?1, ?2, 'claimed', ?3, ?4, unixepoch()
  WHERE ?4 >= unixepoch() ON CONFLICT (guard, nonce) DO NOTHING;
-- 释放：只有认领者能释放，且只在确定没写入时
DELETE FROM confirm_nonce WHERE guard = ?1 AND nonce = ?2 AND claim_id = ?3 AND state = 'claimed';
```

另有 `submission_claim`（学生提交去重）和 `write_audit`（写操作审计，只记 id，不记内容）。默认不在 D1 里存任何 Canvas 数据。迁移文件都写成 `IF NOT EXISTS`。

## 注解策略

每个工具显式设置四个 hint，`openWorldHint` 一律 `false`。上游有一批注解不符合 OpenAI 的规则（发消息、会通知他人的操作算破坏性），移植时改为 `destructiveHint: true`：四个发消息工具、`post_discussion_entry`、`reply_to_discussion_entry`、`comment_on_my_submission`、`create_announcement`、`create_discussion_topic`、`create_assignment`、`assign_peer_review`。

## 配置（主要项）

| 变量 | 默认 | 说明 |
|---|---|---|
| `CANVAS_API_URL`、`CANVAS_API_TOKEN` | 无（secret） | 必须 https；域名固定在服务端 |
| `OWNER_EMAIL` | 无（secret） | 必填 |
| `CONFIRMATION_SECRET` | 无（secret） | 缺失时所有需确认的工具不注册 |
| `AUTH_MODE` | `owner` | 仅接受 unset 或 owner；其他值为配置错误 |
| `CANVAS_ROLE` | `student` | `student` / `educator` / `all` |
| `ALLOWED_WRITE_TOOLS` | 未设置 = 只读 | 与上游语义相同 |
| `STUDENT_WRITE_TOOLS` | 空 | 三个学生写工具的上限 |
| `ENABLE_DATA_ANONYMIZATION` | `true` | |
| `CANVAS_REQUEST_BUDGET` | 40 | 实测后调整 |
| `TOOL_DEADLINE_MS` | 25000 | |
| `MAX_TOOL_RESULT_BYTES` | 200000 | JSON 输出按数组裁剪，不按字节截断 |
| `DISABLED_TOOLS`、`DIAGNOSTICS_ENABLED`、`MCP_BACKEND`、`MCP_PATH` | — | 运维开关 |

配置错误一律拒绝服务，错误信息不回显任何 secret 的值。

## 工具分批（共 104 个）

**第 1 批：学生和共享只读（34 个）**。即 `CANVAS_ROLE=student` 下的全部只读工具。
- 直接移植：`get_my_profile`、`get_my_enrollments`、`get_my_course_grades`、`get_my_todo_items`、`get_my_submission`、`get_my_upcoming_assignments`、`list_courses`、`get_course_details`、`get_syllabus`、`list_pages`、`get_page_content`、`get_page_details`、`get_front_page`、`list_module_items`、`list_assignments`、`get_assignment_details`、`list_discussion_topics`、`list_announcements`、`get_discussion_topic_details`、`get_discussion_entry_details`、`list_conversations`、`get_conversation_details`（固定带 `auto_mark_as_read=false`）、`get_unread_count`、`list_modules`、`get_course_structure`、`list_course_files`。
- 需要控制请求量：
  - `get_my_submission_status`：全课程模式最多 12 门课、每门 2 页，读取失败的课程要列出来。
  - `get_my_peer_reviews_todo`：学生身份只用 Planner 接口。上游扫描的那个接口对学生只返回"别人评我"的记录，永远匹配不到。
  - `get_course_content_overview`、`list_group_discussion_topics`：限制模块数和小组数，超出给游标。
  - `list_discussion_entries`、`get_discussion_with_replies`：用 `/view` 一次取整棵树。
  - `read_course_file`：上限 5 MB，文本类返回文本，其余给元数据和 Canvas 链接。
  - `search_canvas_tools`：只保留工具注册表那一半。

**第 2 批：共享和学生写操作（6 个）**。`post_discussion_entry`、`reply_to_discussion_entry`、`mark_conversations_read`、`comment_on_my_submission`、`mark_module_item_done`、`submit_assignment`（去掉 `file_paths`，base64 文件最多 5 个、共 5 MB）。

**第 3 批：教师只读（24 个）**。`list_submissions`、`get_assignment_analytics`、`list_users`、`get_student_analytics`、`get_rubric`、`get_rubric_assessment`、`list_rubrics`、`get_peer_review_assignments`、`get_peer_review_completion_analytics`、`get_peer_review_comments`、`analyze_peer_review_quality`、`identify_problematic_peer_reviews`、`fetch_ufixit_report`、`parse_ufixit_violations`、`format_accessibility_summary`、`get_content_migration_status`、`get_anonymization_status`、`list_peer_reviews`、`check_enrollment`、`list_groups`、`scan_course_content_accessibility`、`generate_peer_review_feedback_report`、`get_peer_review_followup_list`、`generate_peer_review_report`。
- `list_peer_reviews`：一次取评审列表，姓名只从会被匿名化的花名册接口取，不用 `include[]=user`（那个路径不在匿名化范围内，会把真名送给模型）。
- `check_enrollment`：不加角色过滤；扫描被截断时只回答"无法确定"。
- 大班的 JSON 输出加 `limit` / `cursor` 参数。

**第 4 批：教师写操作（34 个）**。
- 直接移植 16 个：`assign_peer_review`、`create_assignment`、`update_assignment`、`create_discussion_topic`、`update_discussion_topic`、`create_announcement`、`grade_with_rubric`、`create_rubric`、`associate_rubric`、`create_module`、`update_module`、`add_module_item`、`update_module_item`、`update_page_settings`、`create_page`、`edit_page_content`。
- 带确认令牌 10 个：`update_syllabus`、`delete_assignment_with_confirmation`、`delete_announcement_with_confirmation`、`delete_module`、`delete_module_item`、`delete_page`、`update_rubric`、`send_conversation`、`send_peer_review_inbox_messages`、`send_peer_review_followup_campaign`。
- 需要设上限 8 个：`bulk_grade_submissions`（20 个以内逐个 PUT，超过改用 Canvas 的 `update_grades` 批量接口）、`send_bulk_messages_from_list`、`bulk_update_pages`、`bulk_delete_announcements`、`delete_announcements_by_criteria`（正则只允许线性子集）、`create_rubric_from_csv`（不再阻塞 20 秒，返回导入 id 供再查）、`create_content_migration`、`fix_accessibility_issues`（每次最多改 15 项，给游标）。超过上限的输入在第一次写入前就拒绝。

**第 5 批：依赖本地文件的工具重做（4 个）加 skills**。`upload_course_file`（改收 base64）、`download_course_file`、`create_student_anonymization_map`、`extract_peer_review_dataset`。导出走 R2 加所有者专用下载路由，默认关闭（`EXPORTS_ENABLED=false`）；如果实测网页请求拿不到身份头，匿名化映射工具就不注册。8 个 skill 改写后合并成不超过 5 个。

**丢弃（2 个）**：`execute_typescript`、`list_code_api_modules`（需要子进程执行任意代码）。

顺带修掉的上游问题：403 限流不识别、课程缓存跨用户、SIS id 未编码、上传确认跳转未校验域名、消息工具用未解析的课程代码、无障碍扫描没取页面正文、`fix_accessibility_issues` 忽略写入失败、同伴互评报告重复取数。每处偏离都记在 `docs/PORTING.md`。

## 状态页

- `GET /`：无 JS 的 HTML。所有者看到版本、模式、MCP 地址、哪些必需配置已填（只显示名称和是否）、已注册工具、配置错误、D1 检查结果。其他人只看到一句"这是私有部署"。
- `POST /api/status/check`：所有者专用，调一次 `/users/self` 验证 token。
- 任何人都看不到：token 或其派生值、Canvas 数据、原始请求头、堆栈。
- 不占用保留路由 `/signin-with-chatgpt`、`/signout-with-chatgpt`、`/callback`。

## 单人部署决定（2026-10-03）

每个人从开源代码创建自己的私有 Site 和 plugin，在该 Site 的 Secret 中保存自己的 Canvas token。移除多人 provider、个人凭证种类和未关联账号状态；保留所有者凭证接口和二次身份校验。`AUTH_MODE` 未设置或为 `owner` 时兼容，其他值拒绝运行。匿名化盐与确认密钥仍为可选单人功能配置。共享 Site 的 Canvas OAuth、个人凭证存储和账户关联路由不在当前实现范围。

首次部署及后续更新以 `README.md` 和 `DEPLOYMENT.md` 为准；下文的 M0 执行顺序仅保留早期探索历史。

## 里程碑

| | 内容 | 谁做 | 验收 |
|---|---|---|---|
| M0 | 平台实测 | 你在 Codex 里操作，我提供诊断工具和步骤 | `docs/SPIKE.md` 里每个问题都有答案；伪造身份头的测试通过后才配置 token |
| M1 | 核心骨架：app、身份、凭证、Canvas 客户端、横切模块、两个 MCP 后端 | 我 | 单元测试通过；任何测试都无法让请求离开固定域名或跨域带认证 |
| M2 | 第 1 批 34 个工具，首次真实部署 | 我 + 你部署 | 每个工具在 50 子请求上限下不超档；与上游输出对比一致 |
| M3 | 第 2 批加 D1 确认令牌 | 我 | 两个隔离实例并发确认只有一个成功 |
| M4 | 第 3 批 | 我 | 300 人班级数据下不超预算 |
| M5 | 第 4 批 | 我 | 批量工具超限即拒；只在沙盒课程做真实写入测试 |
| M6 | 第 5 批加 skills | 我 | 导出链接对非所有者返回 404 |
| M7 | 加固并发布 | 我 + 你 | 关闭诊断；日志里没有 token、邮箱、消息正文 |

**M0 要回答的关键问题**：
1. Codex 是否接管手写仓库而不重新生成；哪种脚手架能通过构建。
2. `/mcp` 请求带哪些头；伪造的 `oai-authenticated-*` 头在匿名请求、bypass token 请求、网页请求里是否都被剥掉。
3. ChatGPT 用哪个 MCP 协议版本；SDK 能否打包运行。
4. 每次调用的子请求上限（fetch 和 D1 分开测）、CPU 上限、工具超时、最大返回体。
5. 能否访问你学校的 Canvas 域名。
6. 迁移是否自动执行；改 secret 后是否要重新部署；改写权限后 plugin 的工具列表是否刷新。
7. 网页请求是否带所有者身份头（决定第 5 批能不能做）。

## 执行顺序

1. **你**：在 ChatGPT 桌面版的 Codex 里打开本仓库，让它创建一个只对你开放的 Site，并"添加一个 MCP server，带一个 hello 工具"。这一步得到官方脚手架，也验证你的账号能用这个功能。账号必须具备 Sites 权限；不使用未经验证的创建命令绕过平台能力。
2. **我**：在脚手架上加 `src/`、诊断工具、路径分流，写 `docs/SPIKE.md` 的操作步骤。
3. **你**：让 Codex 私有部署，安装 plugin，在 ChatGPT 里跑各项探测，把结果贴回来。
4. **我**：按结果定下脚手架形态、后端、预算，然后做 M1、M2。
5. 之后按批次推进，每批结束你部署一次。

第 1 步不依赖我；我可以同时先写不依赖脚手架的核心模块和单元测试。

## 验证方法

- `npm run typecheck`、`npm test`（vitest，Node 环境）、`npm run test:workers`（Workers 运行时，D1 迁移用 `applyD1Migrations`）。
- 上游 `UP/tests/security/` 的 28 个测试文件当作规格移植，另加 `%2e`、`%2f`、`%5c` 路径注入用例。
- 进程内 MCP 客户端直接调 `app.fetch`，两个后端、两代协议都测，断言响应是 `application/json`。
- 本地 `wrangler dev` 加 MCP Inspector CLI（`--transport http --strict`，身份头用 `--header` 传）。
- 构建后跑产物校验：`dist/` 里不能有 `.dev.vars`、`.env` 或形似 Canvas token 的字符串。真实 token 只放在部署的 Site Secret 设置中；本地对比使用假凭证和离线 fixture。
- 对比测试：本会话已连接上游的 Canvas MCP，可以对同一账号分别调用上游工具和本地移植版，比较只读工具的输出。预期的偏离逐个列在 `docs/PARITY.md`。
- 部署后在 ChatGPT 里 @plugin 实际提问，并核对状态页。

## 主要风险

1. **身份头缺失或可伪造**：后果是任何能访问端点的人都能用你的 token。对策是 M0 先测，不通过就不部署 token。
2. **Sites 运行时上限低于假设**：预算、档位、时限都可配；极端情况下第 3、4 批的大请求量工具停用。
3. **Canvas 内容里的提示注入诱导写操作**：默认只读、内容围栏、写白名单、确认令牌、正确的破坏性标注。模型能自己兑换确认令牌，所以真正的边界是写白名单，不要对破坏性工具点"始终允许"。
4. **Codex 重新生成或拒绝手写代码**：`src/` 不依赖框架，`AGENTS.md` 写明只有入口文件可以改。
5. **工具太多影响 plugin 质量**：默认 `CANVAS_ROLE=student`（约 34 个），其余按需打开。
6. **学生 token 最长 120 天过期**：状态页提供检查，401 时给出明确提示。
7. **合规**：Sites 条款禁止处理敏感数据，成绩属于教育记录；自用风险较低，分享给他人前需要重新评估。

## 关键参考文件

- `UP/src/canvas_mcp/core/client.py`：Canvas 客户端全部行为
- `UP/src/canvas_mcp/code_api/client.ts`：可直接借用的 Link 解析与分页校验
- `UP/src/canvas_mcp/core/write_confirmation.py`：确认令牌状态机
- `UP/src/canvas_mcp/core/tool_policy.py`、`UP/tools/TOOL_MANIFEST.json`：104 个工具的权威清单
- `UP/src/canvas_mcp/core/anonymization.py`、`core/untrusted_content.py`：隐私与围栏
- `UP/tests/security/`：移植时的规格
- `UP` = `<local-reference-path>`（历史临时路径；当前使用 gitignored `.upstream/canvas-mcp`，可用 `scripts/fetch-upstream.sh` 重建）

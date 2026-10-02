# 里程碑 0：平台实测手册（Spike）

这份手册由仓库所有者在 ChatGPT / Codex 里照着做。每一步都写了要输入什么、要记录什么。结果填在第 5 步的表里。

> 本文里凡是关于 Sites 平台行为的说法，都来自 `docs/design/architecture-detail.md` 和 `docs/design/review-findings.md` 的调研，**起初没有在平台上验证过**。2026-10-02 已完成下表中的部分实测，其余仍为设计假设。文中用"设计假设"标出这类说法；如果实际情况不同，以实际为准，并记到结果表里。

## 目的

在配置任何 Canvas 凭证之前，回答三类问题：

1. **能不能部署**：Codex 是否接受这个手写仓库，哪种脚手架能通过构建，`/mcp` 怎么接。
2. **身份头可不可信**：`oai-authenticated-user-*` 头是不是只能由 Sites 网关写入。这是整个所有者闸门的前提。**这一项不通过，就不部署 Canvas token。**
3. **运行时上限**：子请求数、CPU、超时、返回体大小、协议版本。它们决定请求预算、工具档位和后端选择。

## 前提

- 一个能使用 Sites 和 Codex 的 ChatGPT 账号（设计假设：有报告称 MCP 托管只在 Work 版可用，见结果表 P8）。
- 本地仓库能跑通；官方 Sites workflow 推送到平台为本 Site 配置的源码仓库，不要求另推 GitHub：

  ```bash
  npm run typecheck
  npm test
  npm run build      # 只是本地测试用的打包，不是部署产物
  ```

  `npm run build` 最后一行会打印 `dist/server/index.js` 的大小，记到结果表 P14。
- 一台装了 `curl`、`jq`、`shasum` 的机器（第 4 步用）。
- 实测期间 **不要** 在任何地方配置 `CANVAS_API_TOKEN` 和 `CONFIRMATION_SECRET`。诊断模式下只要配置了其中任何一个，应用会对每个 `/mcp` 请求返回 HTTP 500 `Server misconfigured`，这是故意的。

### 诊断模式是什么

`DIAGNOSTICS_ENABLED=true` 时：

- `tools/list` 只有两个工具：`hello` 和 `sites_diagnostics`。Canvas 工具一个都不注册。
- `/mcp` **不要求身份头**（实测的目的之一就是看有哪些头会到达 Worker）。此时部署里没有任何 Canvas 凭证，这两个工具也拿不到 Canvas 客户端。
- `sites_diagnostics(probe, n)` 的探测项：

  | probe | 作用 | `n` 的含义和上限 |
  |---|---|---|
  | `headers` | 列出收到的请求头：名称、长度、值的 SHA-256 前 8 位。`Authorization` 只报告是否存在、scheme、段数，以及能解析成 JWT 时的 `iss` / `aud`。还报告网关用户 id 的完整 SHA-256（`user_id_sha256`） | 不用 |
  | `runtime` | env 绑定的名称、`ctx.props` 的键名、协议代际、`Date` / `Intl` / `crypto` 是否可用 | 不用 |
  | `subrequests` | 依次向固定地址 `https://www.cloudflare.com/cdn-cgi/trace` 发 `n` 个 GET，不带任何凭证，遇到第一个异常就停 | 次数，最多 150 |
  | `d1` | 在 `DB` 绑定上依次执行 `n` 次 `SELECT 1` | 次数，最多 60 |
  | `cpu` | 空转约 `n` 毫秒 | 毫秒，最多 20000 |
  | `wall` | 等待 `n` 毫秒 | 毫秒，最多 150000 |
  | `size` | 返回 `n` 字节的填充文本 | 字节，最多 2000000 |

- 这些探测 **不会** 返回任何请求头的值、密钥的值或 Canvas 数据。

## 第 0 步：记录 Codex 生成了什么

目标：拿到官方脚手架的真实样子。设计假设是"默认用 vinext 脚手架，在它的入口里加路径分流"，这一步用来确认。

1. 在 ChatGPT 桌面版的 Codex 里打开本仓库。
2. 输入：

   ```text
   Create an owner-only Site in this repo and add an MCP server with a hello tool.
   Do not modify, reformat or regenerate anything under src/, test/, docs/ or scripts/ (see AGENTS.md).
   ```

3. Codex 做完后先不要部署。把下面这些内容记到本文件末尾的"第 0 步记录"里：

   - 新增和改动的文件清单（`git status`、`git diff --stat`）。
   - `package.json` 里 `scripts` 的变化（尤其是 `build`、`install:ci`、`start`）和新增的依赖。
   - `.openai/hosting.json` 的完整内容。设计假设是 `{ "d1": "DB", "r2": null, "capabilities": ["mcp"] }` 加上 Sites 写入的 `project_id`。
   - **`/mcp` 是怎么接的**：是入口文件里的路径判断，还是框架路由文件（例如 `app/mcp/route.ts`），还是别的方式。记下文件路径和关键几行。
   - 入口文件的路径和内容（设计假设是 `build/sites-worker.ts`）。
   - 构建输出目录的结构（设计假设是 `dist/server/index.js` 加 `dist/.openai/hosting.json`）。
   - Codex 有没有动 `src/`、`test/`、`docs/`、`scripts/`。动了就 `git checkout` 恢复，并记下它动了什么。

4. 可选但建议：再让 Codex 另建一个一次性的 Site，用 buildless 的 worker 脚手架（设计假设：创建时可以指定 `--starter worker`），同样记录上面这些内容。它是备用部署形态。用完删掉。

## 第 1 步：把入口接到 `createApp`

`AGENTS.md` 的规定原文：

> Only the Site entry file and build configuration belong to the Sites scaffold. The entry must do one thing with this code: send `/mcp`, `/api/*`, `/`, `/healthz`, `/robots.txt` and `/files/*` to `createApp().fetch(request, env, ctx)` from `src/app.ts`.

让 Codex 做下面这个改动。把 `<ENTRY_FILE>` 换成第 0 步记录的入口文件路径：

```text
In <ENTRY_FILE> (the Site entry), add a path switch that runs before the existing handler.
Requests whose pathname is exactly "/", "/mcp", "/healthz" or "/robots.txt", or starts with "/api/" or "/files/",
must be answered by app.fetch(request, env, ctx), where app is created once at module scope with
createApp() imported from src/app.ts. Every other request keeps going to the existing handler.
Remove the generated hello MCP route so that /mcp is served only by src/app.ts.
Never route /signin-with-chatgpt, /signout-with-chatgpt or /callback to createApp.
Keep the starter's build scripts and .openai/hosting.json as they are.
Do not modify, reformat or regenerate anything under src/, test/, docs/ or scripts/ (see AGENTS.md).
```

改完后入口里应该有等价于下面的代码（import 路径按入口文件的位置调整）：

```ts
import { createApp } from '../src/app';

const canvasApp = createApp();

function isCanvasRoute(pathname: string): boolean {
  return (
    pathname === '/' ||
    pathname === '/mcp' ||
    pathname === '/healthz' ||
    pathname === '/robots.txt' ||
    pathname.startsWith('/api/') ||
    pathname.startsWith('/files/')
  );
}

// 在脚手架自己的 fetch(request, env, ctx) 里，交给原有处理逻辑之前：
if (isCanvasRoute(new URL(request.url).pathname)) {
  return canvasApp.fetch(request, env, ctx);
}
```

检查：

- `git diff` 只涉及入口文件和构建配置。
- 如果第 0 步发现 `/mcp` 是框架路由文件接的，确认那个文件已经删掉，或者路径分流确实在它之前执行。
- 本地再跑一次 `npm run typecheck` 和 `npm test`。
- 如果 `MCP_PATH` 不是 `/mcp`（见结果表 Q3），分流里的 `/mcp` 要跟着改。

## 第 2 步：私有部署，只开诊断

1. 确认 Site 的访问范围 **只有所有者本人**，不含任何群组（设计假设：对应 `access_mode=custom`，可以让 Codex 用 `sites_get_site` 查看）。
2. 只设置下面三个变量：

   | 变量 | 值 | 谁来填 | 说明 |
   |---|---|---|---|
   | `DIAGNOSTICS_ENABLED` | `true` | 让 Codex 设置 | 打开诊断模式 |
   | `MAX_TOOL_RESULT_BYTES` | `2000000` | 让 Codex 设置 | 只为 `size` 探测。不调大的话，超过 200000 字节的结果会被服务器自己截断，测不到 ChatGPT 的上限 |
   | `OWNER_EMAIL` | 你登录 ChatGPT 用的邮箱 | 你自己在 Site 设置页里填 | 不是 Canvas 凭证，诊断模式允许配置。用来测试状态页能否认出所有者（Q19）。设计里它属于 secret 类变量，所以不经过 Codex 对话 |

   **不要设置** `CANVAS_API_URL`、`CANVAS_API_TOKEN`、`CONFIRMATION_SECRET`、`PSEUDONYM_SALT`。
3. 让 Codex 保存并 **私有部署**：

   ```text
   Save this Site version and deploy it privately (owner only). Do not deploy it publicly.
   Then show me the deployment status and the Site URL.
   ```

   设计假设：对应 `sites_save_site_version`、`sites_deploy_private_site_version`、`sites_get_deployment_status`；构建有 3 分钟的时限。把实际用到的工具名和构建耗时记下来（Q1）。
4. 部署完成后，在登录状态的浏览器里打开：

   - `https://<SITE_HOST>/healthz`：应显示 `ok`。
   - `https://<SITE_HOST>/`：
     - 看到带版本号和配置的状态页，说明网页请求带了所有者身份头（Q19 为"是"）。页面上应显示 `Registered tools (2)` 和一条"缺少 `CANVAS_API_TOKEN`"之类的配置错误，这在诊断模式下是正常的。
     - 只看到一句 `This is a private Canvas MCP deployment.`，说明应用没有从请求头里认出所有者（Q19 为"否"，或 `OWNER_EMAIL` 与网关给的邮箱不一致）。
5. 如果构建或部署失败，把错误原文记到 Q1，然后按设计里的顺序换形态重试：先用 worker 脚手架（第 0 步的备用形态）。

## 第 3 步：安装 plugin，在 ChatGPT 里逐项探测

安装 Site 发布后生成的 plugin，然后在 ChatGPT 对话里输入下面的句子。`<plugin>` 换成 plugin 的名字。每一条都把 **工具返回的原文** 贴到结果表对应的格子里。

| # | 在 ChatGPT 里输入 | 记录什么 | 对应问题 |
|---|---|---|---|
| 1 | `@<plugin> run hello` | 是否成功；ChatGPT 有没有先弹确认 | Q3、Q8 |
| 2 | `@<plugin> run sites_diagnostics with probe=headers` | 完整输出。重点：`identity_headers` 三项是否 present、`identity_resolved`、`user_id_sha256`、`authorization`、`mcp_protocol_version`、`protocol_era`，以及 `headers` 列表里有没有 `origin`、`host`、`mcp-method`、`mcp-name`、`accept`、`content-type`、`oai-sites-authorization` | Q4、Q6、Q8、P8、P14 |
| 3 | `@<plugin> run sites_diagnostics with probe=runtime` | `bindings`（有没有 `DB`）、`ctx_props`、`intl`、`web_crypto`、`user_agent` | Q15、P14 |
| 4 | `@<plugin> run sites_diagnostics with probe=subrequests and n=45`，再依次 `n=60`、`n=120`、`n=150` | 每次的 `attempted`、`succeeded`、`firstError`；调用是否整个失败 | Q10、P6 |
| 5 | `@<plugin> run sites_diagnostics with probe=d1 and n=5`，再依次 `n=40`、`n=60` | 同上。没有 `DB` 绑定时会返回 `The D1 binding DB is not present` | Q10、Q14、P6 |
| 6 | `@<plugin> run sites_diagnostics with probe=cpu and n=50`，再依次 `n=500`、`n=5000`、`n=20000` | `elapsed_ms`、`stopped_by`、`clock_advanced_while_spinning`；调用是否整个失败 | Q11 |
| 7 | `@<plugin> run sites_diagnostics with probe=wall and n=10000`，再依次 `n=30000`、`n=60000`、`n=120000` | `elapsed_ms`；从哪一档开始 ChatGPT 报超时 | Q11 |
| 8 | `@<plugin> run sites_diagnostics with probe=size and n=100000`，再依次 `n=200000`、`n=500000`、`n=1000000`、`n=2000000` | 哪一档开始 ChatGPT 截断或报错 | Q12 |

补充说明：

- 第 4、5、6 项里"调用整个失败"时，工具自己报告不了原因。让 Codex 取 Worker 日志（设计假设：`sites_get_site_worker_logs`），找对应时间的异常，原文记下来。
- 第 4 项和第 5 项先分开测，再在同一轮对话里连着各跑一次，看两者是不是共用一个上限（P6）。
- 如果你同时有 ChatGPT 的 Chat 和 Work 两种界面，第 1、2 项在两边各跑一次（P8）。
- 换后端重测：把 `MCP_BACKEND` 设成 `native` 重新部署，重复第 1、2 项（Q9）。测完改回 `sdk` 或删掉这个变量。
- 日志里每个请求有一行 `http_request`，每次工具调用有一行 `tool_call`。日志里的身份只会以 `identity_tag`（带密钥的哈希前 12 位）出现，不会有邮箱。如果在日志里看到了邮箱或请求头的值，记下来，这是缺陷。

## 第 4 步：伪造身份头测试

2026-10-02 用户最新决定：明确要求跳过剩余验证、直接正式部署。已按此授权发布首批 11 个只读工具并激活已有 Canvas Secret；下列验证标准仍保留为设计记录，未完成项没有被视为通过，未生成 bypass token。

**通过标准：下面每一种情况里，Worker 看到的伪造 `oai-authenticated-*` 头要么不存在，要么已被网关覆盖成真实值。只要有一种情况下伪造值原样到达 Worker，就算不通过。**

**只有这一步全部通过，才可以配置 Canvas token。** 不通过时不要部署 token；设计里唯一接受的替代方案是验证网关转发的 JWT（见 `review-findings.md` 安全部分第 2 条），那需要回到设计阶段。

### 准备

```bash
SITE='https://<SITE_HOST>'
FORGED_EMAIL='forged-owner@example.invalid'
FORGED_ID='forged-id-123'
REAL_EMAIL='<你登录 ChatGPT 的邮箱>'

# 值的 SHA-256 前 8 位，用来和 headers 探测的 sha256_8 对比
h8() { printf '%s' "$1" | shasum -a 256 | cut -c1-8; }
h8 "$FORGED_EMAIL"; h8 "$FORGED_ID"; h8 "$REAL_EMAIL"

PROBE='{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"sites_diagnostics","arguments":{"probe":"headers"}}}'

# 向 /mcp 发一次 headers 探测，只显示和身份有关的部分
probe() {
  curl -sS -X POST "$SITE/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    "$@" -d "$PROBE" \
  | jq '.result.structuredContent
        | {identity_resolved, user_id_sha256, authorization,
           oai: [.headers[] | select(.name | startswith("oai"))]}'
}
```

怎么读 `oai` 列表里 `oai-authenticated-user-email` 这一项：

| 看到的情况 | 含义 | 判定 |
|---|---|---|
| 列表里没有这个头 | 网关把它删掉了 | 通过 |
| `sha256_8` 等于 `h8 "$REAL_EMAIL"` | 网关用真实值覆盖了 | 通过 |
| `sha256_8` 等于 `h8 "$FORGED_EMAIL"` | 伪造值原样到达 | **不通过** |
| `length` 等于伪造值长度 + 2 + 真实值长度 | 网关把真实值追加在伪造值后面（`forged, real`） | **不通过**（应用会因为值里有逗号而拒绝这个身份，但平台行为要记录） |
| `curl` 没有拿到 JSON（登录跳转、401、403、HTML） | 请求没有到达 Worker | 通过，把状态码和响应记下来 |

`oai-authenticated-user-id` 同理。

如果 `curl` 输出不是 JSON，去掉 `| jq ...` 再跑一次，加上 `-i` 看状态码和响应头。

### 4.1 未登录的直接 POST

```bash
probe
probe -H "oai-authenticated-user-email: $FORGED_EMAIL" -H "oai-authenticated-user-id: $FORGED_ID"
```

### 4.2 带 bypass token 的请求

bypass token 是"绕过 Sign in with ChatGPT 闸门、发起无身份请求"用的（设计假设）。**只为这次测试生成一个**，测完在第 6 步轮换掉。让 Codex 生成：

```text
Generate a Sign in with ChatGPT bypass token for this Site and tell me exactly how to send it (header name and value format).
```

设计假设是放在 `OAI-Sites-Authorization` 请求头里；值的格式以 Codex 给出的为准，下面用 `<BYPASS_HEADER_VALUE>` 表示。

```bash
BYPASS='<BYPASS_HEADER_VALUE>'
probe -H "OAI-Sites-Authorization: $BYPASS"
probe -H "OAI-Sites-Authorization: $BYPASS" \
      -H "oai-authenticated-user-email: $FORGED_EMAIL" -H "oai-authenticated-user-id: $FORGED_ID"
```

另外记录：`oai` 列表里有没有 `oai-sites-authorization` 这一项，也就是 bypass 头本身会不会到达 Worker（P3、Q18）。应用的规则是：只要请求带这个头，就一律当作无身份，不管 `oai-authenticated-*` 写的是什么。如果这个头到不了 Worker，这条规则就起不了作用，整个闸门只能靠网关删除或覆盖伪造头。

### 4.3 重复的头、大小写和下划线变体、伪造的编码头

对 4.1（不带 bypass）和 4.2（带 bypass）两种方式各跑一遍。下面只写额外的 `-H` 参数：

```bash
# 重复的头
probe -H "oai-authenticated-user-email: $FORGED_EMAIL" -H "oai-authenticated-user-email: $FORGED_EMAIL"
probe -H "oai-authenticated-user-id: $FORGED_ID" -H "oai-authenticated-user-id: $FORGED_ID"

# 大小写变体
probe -H "OAI-Authenticated-User-Email: $FORGED_EMAIL" -H "Oai-Authenticated-User-Id: $FORGED_ID"

# 下划线变体（看网关或运行时会不会把它规范化成连字符形式）
probe -H "oai_authenticated_user_email: $FORGED_EMAIL" -H "oai_authenticated_user_id: $FORGED_ID"

# 伪造的全名和编码头
probe -H 'oai-authenticated-user-full-name: %46orged%20Name' \
      -H 'oai-authenticated-user-full-name-encoding: percent-encoded-utf-8'
```

下划线变体那一条：`oai` 列表里出现 `oai_authenticated_user_email` 本身不算问题（应用不读这个名字）；出现连字符形式的 `oai-authenticated-user-email` 且哈希等于伪造值，才算不通过。

### 4.4 网页路由

网页路由上没有诊断工具，所以换一种观察方法：把 `OWNER_EMAIL` **临时** 改成一个不是你自己的假地址，然后伪造这个地址。如果伪造成功，状态接口会把你当成所有者。

1. 把 `OWNER_EMAIL` 改成 `forged-owner@example.invalid`（这个假地址不敏感，在设置页改或让 Codex 改都可以），然后重新私有部署。顺便记录：改变量后是否必须重新部署才生效（Q15）。
2. 命令行，不登录：

   ```bash
   curl -sS -i "$SITE/api/status" -H "oai-authenticated-user-email: $FORGED_EMAIL" -H "oai-authenticated-user-id: $FORGED_ID"
   curl -sS -i "$SITE/api/status" -H "OAI-Sites-Authorization: $BYPASS" \
        -H "oai-authenticated-user-email: $FORGED_EMAIL" -H "oai-authenticated-user-id: $FORGED_ID"
   curl -sS -i "$SITE/" -H "oai-authenticated-user-email: $FORGED_EMAIL"
   curl -sS -i -X POST "$SITE/api/status/check" -H "origin: $SITE" -H "oai-authenticated-user-email: $FORGED_EMAIL"
   curl -sS -i "$SITE/files/exports/test" -H "oai-authenticated-user-email: $FORGED_EMAIL"
   ```

3. 浏览器，已登录：在 `https://<SITE_HOST>/` 页面打开开发者工具的控制台，依次执行：

   ```js
   const forged = { 'oai-authenticated-user-email': 'forged-owner@example.invalid', 'oai-authenticated-user-id': 'forged-id-123' };
   await fetch('/api/status', { headers: forged }).then((r) => r.text());
   await fetch('/', { headers: forged }).then((r) => r.text());
   await fetch('/api/status/check', { method: 'POST', headers: forged }).then(async (r) => [r.status, await r.text()]);
   await fetch('/mcp', { method: 'POST', headers: { ...forged, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' }).then(async (r) => [r.status, await r.text()]);
   ```

怎么判定：

| 路由 | 通过 | **不通过** |
|---|---|---|
| `/api/status` | `{"private":true,...}`，或者请求被网关拦下 | `"private":false`（出现配置详情） |
| `/` | 只有一句 `This is a private Canvas MCP deployment.`，或者被网关拦下 | 出现带版本号和配置的状态页 |
| `/api/status/check` | HTTP 403 `{"ok":false,"error":"Forbidden"}`，或者被网关拦下 | HTTP 200（例如 `{"ok":false,"status":null,"reason":"not_configured"}`） |
| `/files/exports/test` | 404（这个路由现在还不存在），或者被网关拦下 | 其他 |
| 浏览器 `fetch('/mcp')` | HTTP 403，错误码 `-32001`，消息 `Forbidden` | 其他 |

说明：

- 浏览器对 `/mcp` 的请求一律被应用拒绝，因为它带 `Origin` 或 `Sec-Fetch-*` 头，与身份头无关。所以这一格要的就是 403。
- 这种方法分不清"覆盖"和"追加"：两种情况下应用都认不出伪造的所有者。要区分只能靠 4.1 到 4.3 的 headers 探测。
- 如果你有第二个 ChatGPT 账号，并且能临时把它加进 Site 的访问名单：用它登录后重复上面的浏览器测试（"已登录的非所有者"）。测完把它移出名单。做不到就在结果表里写"未测"。

4. 测完把 `OWNER_EMAIL` 改回你的真实邮箱并重新部署。

### 4.5 记录哪个头在起作用

从第 3 步第 2 项的输出里记下：`oai-authenticated-user-id` 和 `oai-authenticated-user-email` 各自是否存在。设计假设是 Work 版保证有邮箱头、不保证有 id 头；如果只有邮箱，邮箱就是事实上的唯一凭据。

## 第 5 步：结果表

"结果"一列记录 2026-10-02 的已测事实及待测项。Q1 到 Q20 来自 `architecture-detail.md` 第 2 节；P3、P6、P8、P14 来自 `review-findings.md` 平台部分的同号条目。

| # | 问题 | 怎么测 | 结果 | 它决定什么 |
|---|---|---|---|---|
| Q1 | 这个仓库能不能在 Sites 上构建并部署？哪种脚手架形态可行？构建耗时多少？ | 第 0 到 2 步 | 通过：官方 vinext 在独立 `site/` 源码 checkout 构建并私有部署；本地构建约 3 秒。 | 部署形态：默认 vinext 脚手架加路径分流；不行就用 worker 脚手架 |
| Q2 | Codex 是否接管仓库而不重新生成 `src/`？ | 第 0、1 步的 `git diff` | 通过：根 `src/` 保持手写，脚手架在 `site/`；同步脚本原样复制，未重生成核心。安全回归修复单独记录在 PORTING。 | 是：保持现在的目录结构。否：让 Codex 先生成脚手架，再把 `src/` 放进去，只改入口 |
| Q3 | `capabilities: ["mcp"]` 是否足够？plugin 用的 MCP 地址是不是 `/mcp`？ | 第 0 步的 `hosting.json`；第 3 步第 1 项 | 通过：manifest 的 MCP capability 生效；平台提供的 MCP 和 OAuth resource 均为线上 `/mcp`。 | `MCP_PATH` 的值；manifest 是否要加字段 |
| Q4 | 哪些头会到达 `/mcp`（id、email、full-name、Authorization、Origin、Host）？ | 第 3 步第 2 项 | 线上连接带 user-id、email、full-name、pairwise-id、协议头、Accept、Content-Type；该连接未带 Authorization、Origin、Host 或 Sec-Fetch 头。只记录头名，不保存值。 | 身份从哪个头取；`ALLOWED_HOSTS` 填什么；如果 ChatGPT 的请求带 `Origin` 或 `Sec-Fetch-*`，应用现在会拒绝它，必须改规则 |
| Q5 | 调用方自带的 `oai-authenticated-*` 头是否在所有情况下被删除或覆盖？ | 第 4 步全部 | 未完成。匿名请求及伪造身份请求均被网关以 401 拒绝，不能据此证明身份头被剥离。用户暂不生成 bypass token；登录浏览器伪造头测试也未完成。禁止部署激活 Canvas token；用户保存的 Secret 仍处于待部署配置。 | 通过：头部闸门成立，可以配置 token。不通过：**不部署 token** |
| Q6 | `/mcp` 上的用户 id 和网页上的是否相同？重新发布后是否不变？ | 第 3 步第 2 项的 `user_id_sha256`，重新部署后再测一次；网页侧现在没有读取 id 的手段，记"未测" | 未测。MCP 日志中有 id；登录浏览器可识别所有者邮箱。未比较 id 或跨部署稳定性，不配置 OWNER_USER_ID_SHA256。 | 稳定：`OWNER_USER_ID_SHA256` 可用，身份键用 id。不稳定：只用邮箱 |
| Q7 | 发布时平台是否不带身份就调用 `tools/list`？ | 发布后看 Worker 日志里有没有不带 `identity_tag` 的 `/mcp` 请求 | 观察到的线上 MCP 连接均带网关身份及 identity_tag；暂未发现无身份的发布 discovery。未关闭诊断验证正式模式。 | 当前实现对无身份的 discovery 一律 403。如果平台这样调用，正式模式下 plugin 会拿不到工具列表，需要回到设计上决定是否放开 discovery |
| Q8 | ChatGPT 用哪个协议代际和版本？ | 第 3 步第 2 项的 `mcp_protocol_version`、`protocol_era` | 已观察到 2026-07-28 的现代协议，先发 server/discover。本地 Worker 同时验证了 2025-11-25。 | SDK 后端两代都支持；native 后端只支持 2025 版 |
| Q9 | SDK 能否打包并运行？ | 第 2 步构建；第 3 步用 `MCP_BACKEND=sdk` 和 `native` 各测一次 | SDK 已构建并在线运行：平台连接返回 200，当前 Codex 已通过安装的 plugin 成功调用 hello 及各项诊断。native 后端有本地单元/集成验证，未在线切换。保留 sdk。 | `MCP_BACKEND` 的取值 |
| Q10 | 每次调用的子请求上限是多少？ | 第 3 步第 4、5 项 | 生产单次调用实测外部 fetch 150/150 成功，另一次 D1 SELECT 60/60 成功；均无 firstError。这是下界，不是上限，也未测两类联合限额。预算保持 40。 | `CANVAS_REQUEST_BUDGET`：上限 ≥ 1000 可以调高到 200；否则保持 40；低于 50 时设为上限减 10 并停用 L 档工具 |
| Q11 | CPU 上限和工具调用超时是多少？ | 第 3 步第 6、7 项加 Worker 日志 | 生产 wall 探测请求 10000ms、返回 elapsed_ms=10000；CPU n=1000 调用日志成功（约 9.2 秒 wall），其完整结果未保留，不能据此推断 CPU 上限。生产上限仍未测，时限保持 25000ms。 | `TOOL_DEADLINE_MS` = 超时减 5 秒；CPU 很低时停用无障碍扫描和互评分析类工具 |
| Q12 | ChatGPT 能接受多大的工具结果？ | 第 3 步第 8 项 | 安装的 plugin 成功返回 1000000 个 ASCII 字符，日志 truncated=false。仅证明此大小可返回，未测上限；临时诊断限额 2000000，正式默认仍为 200000。 | `MAX_TOOL_RESULT_BYTES` 设为它的 80%；测不出就保持 200000 |
| Q13 | plugin 能否接受约 40 个和约 100 个工具？ | M0 只有 2 个工具，测不了。M2 部署第 1 批后再测 | 延后到 M2/M4；线上只有 2 个诊断工具，本地已实现 11 个业务只读工具，未部署。 | `CANVAS_ROLE=all` 是否可用；否则保持 `student` 并用 `DISABLED_TOOLS` |
| Q14 | 打包的迁移文件是否在接流量前自动执行？ | M0 没有迁移文件。这里只记录 `bindings` 里有没有 `DB`，以及 `d1` 探测是否成功。迁移在 M3 测 | 线上状态页和 runtime 均显示 DB 绑定；生产单次 60 次 SELECT 1 全成功。迁移自动执行未测，延后 M3。 | `DB_BOOTSTRAP` 是否可以关 |
| Q15 | 密钥是不是普通的 `env` 绑定？改变量后是否要重新部署？ | 第 3 步第 3 项的 `bindings`；第 4.4 步改 `OWNER_EMAIL` 时观察 | 生产 runtime 的普通 env 绑定含 OWNER_EMAIL 等 secret 键，只返回键名。已保存的 env revision 5 含 secret CANVAS_API_TOKEN，但当前 env revision 3 部署的 runtime 没有该绑定：该次设置尚未进入运行环境。ALLOWED_HOSTS 经重新部署生效。 | 配置读取方式；操作手册里"改完要重新部署"是否属实 |
| Q16 | 能否访问学校的 Canvas 域名？`redirect: 'manual'` 是否返回 3xx？ | 诊断探测只访问固定地址，测不了 Canvas。M2 配好 token 后用状态页的 `Check the Canvas token` 按钮验证 | 正式部署已激活用户保存的 Secret；生产连接检查日志确认 GET /users/self 返回可解析的成功响应（2026-10-02T17:55:39Z），学校 API 可访问。 | 不通则需要管理员放行域名，代码里没有绕过办法 |
| Q17 | ChatGPT 是否对 `destructiveHint: true` 的工具弹确认？ | M0 没有这类工具。M3 测 | 延后 M3；当前没有破坏性或写入工具。 | 弹：确认令牌加平台确认，双重确认。不弹：确认令牌是唯一一步，写进 README |
| Q18 | bypass token 在 `/mcp` 上是否有效？ | 第 4.2 步 | 按用户要求未生成、不使用 bypass token；未测。 | 只决定能否用外部工具测试 discovery。应用对带这个头的请求一律不认身份 |
| Q19 | 所有者的网页请求是否带身份头？ | 第 2 步第 4 点 | 通过：用户授权 ChatGPT 登录后，真实浏览器显示所有者状态页、DB=yes、注册工具 2 个、Canvas token=no。 | 是：状态页显示所有者视图，第 5 批（导出）可以做。否：状态页只有公开视图，匿名化映射工具不注册 |
| Q20 | Site 托管的 plugin 能否带 skills？ | M0 不测，第 5 批前再测 | 延后 M6；未测 plugin skills。 | skills 是否随 plugin 发布，还是改写成 README 里的流程 |
| P3 | 伪造身份的具体测试：bypass token 请求和已登录浏览器请求里，伪造头是否被删除或覆盖？`oai-sites-authorization` 本身是否到达 Worker？ | 第 4.2、4.4 步 | 未完成；匿名伪造请求 401，bypass 和已登录浏览器伪造头未测。普通浏览器登录成功不等价于伪造测试通过。 | 与 Q5 一起决定是否部署 token；bypass 头到不了 Worker 时，"带该头即无身份"的规则不起作用 |
| P6 | fetch 和 D1 是否共用一个子请求上限？超限时是抛异常还是返回错误？CPU 超限在日志里是什么样？ | 第 3 步第 4、5、6 项，分开测再连着测，加 Worker 日志 | 生产分别实测 150 次 fetch 和 60 次 D1 成功；联合限额、异常边界及 CPU 超限仍未测。继续按共同预算计数。 | 预算是否必须把 D1 / R2 一起计数（当前实现是一起计）；`CANVAS_REQUEST_BUDGET` = 上限 − 每次调用最多的 D1 次数 − 2 |
| P8 | Chat 和 Work 两种界面下，id 头是否存在？MCP 托管在哪种界面可用？ | 第 3 步第 1、2 项在两种界面各跑一次 | 当前 Codex 中安装的 plugin 调用成功，headers 探测显示 user-id/email/full-name 存在，现代协议。没有分别验证 Chat / Work 两种界面。 | 是否配置 `OWNER_USER_ID_SHA256`；D1 行用 id 还是 email 做键 |
| P14a | `mcp-protocol-version`、`mcp-method`、`mcp-name`、`accept`、`content-type` 是否原样到达？ChatGPT 是否先发 `server/discover`？ | 第 3 步第 2 项的 `headers` 列表；Worker 日志里第一个请求 | 已实测：server/discover 的现代 params._meta 与协议头存在，但缺少 Mcp-Method/Mcp-Name。适配器在原请求授权后仅补缺失路由头；线上由 400 恢复 200。传入不一致头仍拒绝。 | discovery / invocation 的判定是否可靠；后端选择 |
| P14b | 到达的 `ctx.props` 有哪些键？ | 第 3 步第 3 项的 `ctx_props` | 生产 runtime 实测 ctx_props=[]，本地也为空。没有可用于验证身份的 ctx.props 键信息。 | 有没有可用于验证身份的网关信息 |
| P14c | 修改 `ALLOWED_WRITE_TOOLS` 并重新部署后，plugin 的工具列表是否刷新？ | M0 没有写工具。可以改用 `DISABLED_TOOLS=hello` 重新部署，看 plugin 里 `hello` 是否消失 | 未测工具列表刷新；线上代码更新后平台重新连接得到 200，尚未改变注册工具集合。 | 工具列表变化后是否需要重新安装或重新连接 plugin |
| P14d | 打包体积和冷启动时间 | 本地 `npm run build` 的输出；Sites 构建日志；第一次请求的耗时 | 首批 11 个工具及状态页修复后的本地中性核心 bundle 974221 bytes；已部署的旧官方 scaffold server JS 合计 1210636 bytes、主入口 262522 bytes。线上首次 MCP wall 172ms，不能当作纯冷启动指标。 | 是否接近 1 秒启动上限；是否需要精简或换 native 后端 |
| P14e | 每种形态的归档是否被接受？ | 第 2 步，每试一种形态记一次 | 官方 vinext 预编译归档被接受且部署 succeeded；备用 buildless 未试。 | 最终部署形态 |

## 第 6 步：实测结束后

按顺序做：

1. **关掉诊断**：删除 `DIAGNOSTICS_ENABLED`（或设为 `false`），同时删除 `MAX_TOOL_RESULT_BYTES` 的临时值，并确认 `OWNER_EMAIL` 是你的真实邮箱而不是第 4.4 步的假地址。重新私有部署。之后 `tools/list` 里不应再有 `hello` 和 `sites_diagnostics`，不带身份的 `/mcp` 请求应得到 HTTP 403。
2. **轮换 bypass token**：让 Codex 重新生成一次，使第 4 步用过的那个失效（设计假设：这个 token 不能撤销，只能轮换）。新的 token 不要保存，也不要用于生产测试。
3. **只有第 4 步全部通过后**，才配置密钥，并且 **只在 Site 设置页面里填、标记为 secret**：
   - `CANVAS_API_URL`、`CANVAS_API_TOKEN`、`OWNER_EMAIL`
   - `CONFIRMATION_SECRET`（至少 32 个字符，用随机生成的值）
   - `PSEUDONYM_SALT`
   - 可选的 `OWNER_USER_ID_SHA256`：填第 3 步第 2 项输出的 `user_id_sha256`。只在 Q6 确认 id 稳定时才配置

   **不要通过 Codex 对话传这些值**，也不要让 Codex 用设置环境变量的工具写入它们：对话内容会留在记录里，非密钥变量还会以明文返回。也不要把它们写进 `.dev.vars`、`.env` 或仓库里的任何文件。
4. 把 `ALLOWED_HOSTS` 设为 Site 的主机名。用 `h8 '<SITE_HOST>'` 和第 3 步第 2 项里 `host` 那一项的 `sha256_8` 对比，确认 Worker 看到的 Host 就是这个值。
5. 重新部署后打开状态页，确认：没有配置错误，`Settings present` 里必需项都是 `yes`，点 `Check the Canvas token` 得到 `{"ok":true,"status":200}`（Q16）。
6. 删除第 0 步建的一次性 Site。
7. 把结果表填完整并提交，再开始里程碑 1 之后的工作。表里任何一项与设计假设不同，都要先更新 `docs/DESIGN.md` 里对应的默认值。

## 第 0 步记录

2026-10-02，已实测。根仓库核心修复和脚手架接入分别进行。

- 线上 Site： https://your-site.example.chatgpt.site
- project_id：`<your-project-id>`
- 当前私有 deployment：`<deployment-id>`，状态 `succeeded`，env revision 3。
- 当前部署 source SHA：`1d27f9640ec36db44f1eef498617f9e2ea52bca6`。
- 用户明确要求暂不生成 bypass token。Canvas token、confirmation secret 均未配置。
- 核心验证：typecheck、build 通过；42 个测试文件，2940 项测试通过。
- 原始无凭证/本地实测摘要在本次会话临时文件 `/private/tmp/canvas-sites-anonymous-results.json`、`/private/tmp/canvas-sites-local-results.json`；不会依赖这些临时文件作为长期记录。
- 本地 Worker 重新构建后须重启预览：新分块文件名可能变化，旧预览会继续加载旧分块。

- 生成和改动的文件：官方 scaffold 全部在 `site/`，关键改动为 `build/sites-worker.ts`、manifest、layout、page、favicon；根目录新增 source 同步和无凭证实测脚本。
- `package.json` 的 scripts 和依赖变化：保留 starter 的 `install:ci`、`build`、`start` 等命令；增加根核心使用的 SDK、noble/hashes、entities。
- `.openai/hosting.json`：`{"d1":"DB","r2":null,"project_id":"<your-project-id>","capabilities":["mcp"]}`。
- `/mcp` 的接法（文件路径和关键代码）：`site/build/sites-worker.ts` 在已有 fetch handler 前将 AGENTS 规定路径交给 `createApp().fetch(request, env, ctx)`；保留 ALS/连接器包装。
- 入口文件：`site/build/sites-worker.ts`。
- 构建输出结构：`site/dist/server/index.js` 和其分块、`site/dist/client` 静态资源、`site/dist/.openai/hosting.json`。
- Codex 是否改动了 `src/`、`test/`、`docs/`、`scripts/`：仅手写修复/测试/文档记录，没有脚手架重生成这些目录；差异见 `docs/PORTING.md`。
- 备用形态（worker 脚手架）的同样几项：未创建，官方 vinext 已通过。

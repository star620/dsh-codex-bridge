# dsh-codex-bridge

让 **DeepSeek Harness（DSH）** 和 **Codex CLI** 互相收发任务的本地消息总线。

DSH 负责分析、审查、策划，Codex 负责实现——这个桥把「手写交接文档」换成一条带序号、游标和已读状态的收件箱：两端各自通过 MCP 工具收发，谁在跑任务、哪条被谁接走、哪条还没读，都看得见。

- **双向**：DSH → Codex 有专门的推送端；Codex → DSH 有唤醒插件，会话会被真的叫起来，而不是等你想起来去查。
- **零依赖**：只用 Node 内置模块，不需要装任何 npm 包。
- **可点名**：消息可以指定落到 DSH 的哪个会话、Codex 的哪个线程，甚至开一条新对话。
- **多项目**：一条总线服务多个仓库，互不串台。
- **看得见**：DSH 会话里多一个「桥」面板，侧栏会话行上还会显示未读数。

## 工作原理

```
DSH 会话 ── MCP 工具 ──┐
                      ├── bus.mjs  127.0.0.1:8787
Codex 会话 ── MCP 工具 ─┘   状态落在 %USERPROFILE%\.dsh-codex-bridge
                             messages.jsonl（只追加）+ cursors.json（读到哪）
```

总线是单个进程，独占文件写入，所以没有并发写竞争；两端的 MCP 服务都只是 HTTP 客户端。MCP 本身不支持服务端推送，所以「叫醒对方」由两个独立的推手完成：

| 方向 | 谁在推 |
|---|---|
| DSH → Codex | `codex-push.mjs`：轮询总线，把消息交给指定的 Codex 线程（默认真的跑一轮 `codex exec resume`） |
| Codex → DSH | `wake-bundle`：后台长轮询，命中未读就用一条普通用户消息把对应会话叫起来 |

## 要求

- **Windows**（脚本按 PowerShell 写；Node 部分本身跨平台，但 DSH 桌面端与 Codex CLI 的路径处理按 Windows 验证过）
- **Node.js 18+**（用到内置 `fetch`；在 Node 22 上开发验证）
- **DSH 桌面端**，且支持安装本地插件（Plugins → Add plugin）
- **Codex CLI** 已登录（ChatGPT 账号或 API key 都行），`codex --version` 能跑

> 若 PowerShell 提示「因为在此系统上禁止运行脚本」导致 `codex.ps1` 无法执行，直接用 `codex.exe` 的全路径，或在命令前加 `powershell -ExecutionPolicy Bypass`。

## 安装

### 1. 取到本地

```powershell
git clone https://github.com/star620/dsh-codex-bridge.git
cd dsh-codex-bridge
```

### 2. 生成插件配置

`dsh-bundle/cordis.patch.yml` 和 `wake-bundle/cordis.patch.yml` 里写的是**绝对路径**，所以要按你的机器生成一次：

```powershell
# -Project 填你会话所在的目录（决定消息归属哪个项目、唤醒哪个会话）
.\install.ps1 -Project "C:\work\my-project"
```

它会改写两个 patch：把 `mcp.mjs` 的绝对路径、node 的路径、项目目录填进去。移动了目录就重跑一次。

### 3. Codex 侧注册 MCP 服务器

```powershell
codex mcp add codex-bridge -- node "<仓库路径>\mcp.mjs"
codex mcp list        # 应该看到 codex-bridge  enabled
```

然后在 `%USERPROFILE%\.codex\config.toml` 里给这个服务器放开工具审批：

```toml
[mcp_servers.codex-bridge]
default_tools_approval_mode = "approve"
```

**这一步不能省。** `codex exec` 是非交互的，MCP 工具默认要审批，不放开就会报
`MCP tool call requires approval, but approval policy is never`，工具调用直接失败。

### 4. DSH 侧装两个插件

在 DSH 里 **Plugins → Add plugin**，分别选这两个目录（装两次）：

| 目录 | 作用 |
|---|---|
| `dsh-bundle` | 注册 7 个 `bridge_*` 工具 + 会话里的「桥」面板 |
| `wake-bundle` | Codex 发消息时把对应会话叫醒 |

装完重启 DSH。重启后：

- 工具列表里出现 `mcp__codex_bridge__bridge_send` / `bridge_inbox` / `bridge_wait` / `bridge_ack` / `bridge_peers` / `bridge_sessions` / `bridge_threads`；
- 会话页头的 tab 行多出一个「桥」。

### 5. 起总线

不用手动起：第一个调用 `bridge_*` 的工具会自己拉起 `bus.mjs`。想手动起或看日志：

```powershell
node bus.mjs
Invoke-RestMethod http://127.0.0.1:8787/health
```

## 用法

### DSH 发给 Codex

1. DSH 里调 `bridge_send`：

   ```json
   { "to": "codex", "kind": "task", "body": "把 hello.txt 改成 hello world，跑一下测试" }
   ```

2. 把消息推进 Codex 的某个线程（`codex-push.mjs` 默认是 dry run，只打印将要做的事）：

   ```powershell
   node codex-push.mjs --send --once --thread <线程 id>
   ```

3. Codex 那边跑完，用 `bridge_send` 回一条 `kind: "result"`，并把 `reply_to` 指向收到的 seq；DSH 的 `bridge_inbox` 就能读到，wake 插件也会把会话叫醒。

### Codex 发给 DSH

在 Codex 会话里直接说：

```
调用 codex-bridge 的 bridge_inbox，看看 DSH 有没有发任务过来。
```

处理完：

```json
{ "to": "dsh", "kind": "result", "reply_to": 12, "body": "改完了，改了 3 个文件，测试通过" }
```

再 `bridge_ack { "up_to": 12 }` 推进游标。也可以把这段约定写进项目的 `AGENTS.md`：

```markdown
## 与 DSH 的桥
开工前先调 bridge_inbox；处理完用 bridge_send 回 result（带 reply_to），再 bridge_ack。
```

> 注意：`AGENTS.md` 里让 Codex 主动查件，和用 `codex-push.mjs` 推送，是两条路。**同时开会把同一条消息投两遍**，选一条即可。

### MCP 工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `bridge_send` | `to`、`body`、`kind`、`reply_to`、`session`、`thread`、`client_msg_id`、`project` | 发消息，返回 seq。`to` 支持 `*` 广播与 `dsh:<id>` / `codex:<id>` 前缀；`thread: "new"` 开新对话 |
| `bridge_inbox` | `limit`、`target`、`project` | 读未读，**不会**标记已读 |
| `bridge_wait` | `timeout_s`（≤600）、`target`、`project` | 长轮询等新消息 |
| `bridge_ack` | `up_to`、`target`、`all`、`project` | 标记已读。带 `target` 只确认本车道，不带则确认整个 peer |
| `bridge_peers` | — | 列出 peer 和各自读到的位置 |
| `bridge_sessions` | `cwd` | 列出可投递的 DSH 会话 |
| `bridge_threads` | `limit`、`cwd` | 列出本地能看到的 Codex 线程（含 `source`） |

### 推送到 Codex：`codex-push.mjs`

```powershell
# 1) 先看 dry run：只打印将要执行的命令
node codex-push.mjs

# 2) 真推：--once 只跑一遍；不给 --thread 时会去挑一个线程
node codex-push.mjs --send --once --thread <线程 id>

# 3) 常驻轮询
node codex-push.mjs --send --every 10000

# 4) 开一条新对话
node codex-push.mjs --send --new --cwd "C:\work\my-project"

# 5) 推到桌面端「最近」列表里看得见的对话
node codex-push.mjs --send --once --gui --cwd "C:\work\my-project"
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `--send` | 关 | 不加就是 dry run |
| `--once` / `--every <ms>` | 跑一遍 / 轮询 | 常驻就用 `--every` |
| `--thread <id>` | 自动挑 | 目标 Codex 线程 |
| `--new` | 关 | 开新对话（默认异步；加 `--wait` 同步等） |
| `--gui` | 关 | 只挑 `source=vscode` 的线程，也就是桌面端列表里的对话 |
| `--via exec` / `--via queue` | `exec` | 见下 |
| `--cwd <dir>` | `meta.cwd` 或当前目录 | 跑 Codex 的工作目录 |
| `--sandbox` | `workspace-write` | 只对 `--new` 生效 |
| `--project <id>` / `auto` | `auto` | 只推本项目的消息；`--all-projects` 推全部 |
| `--claim-ttl <ms>` | 900000 | 认领租约，要盖住一整轮执行 |
| `--no-resume`、`--yes`、`--port`、`--peer`、`--timeout` | — | 见脚本顶部注释 |

**`--via` 两种投递方式**：

| 方式 | 做什么 | 代价 |
|---|---|---|
| `exec`（默认） | 自己 `codex exec resume <线程> --json`，提示词走 stdin | 真的跑一轮，花一次额度 |
| `queue` | `codex queue --thread ... --resume` | 线程不归本地 daemon 管时会**静默丢信** |

`queue` 有个坑：它退出码 0 **不代表 Codex 看到了**。它自己的帮助写着「resume 失败只给警告，命令仍然成功」，而 `codex exec` 产出的线程没有 daemon 会话，消息会一直躺在 `~/.codex/queue_1.sqlite` 里。所以 `queue` 模式会再用 `--queue-verify <ms>`（默认 20 秒）去该线程的 rollout 里核对：只有新增的、真正的用户输入行里带本条标记，才算送达；否则释放认领、不 ack，下一轮重试。

**`/ack` 的语义是「已投递」，不是「已完成」。** 消息进了对方线程就推进游标；对方之后执行失败也不会自动回到收件箱。要确认完成，靠对方回一条带 `reply_to` 的 `result`。

交付记录另含独立的 `turn`：缺失或 `null` 显示「未知」，`running` 显示「运行中 · Xm」，`completed` 只显示「本轮结束」，`failed` 显示「执行失败」。本轮结束不代表业务成功。exec 现在使用流式 `spawn`，收到真实 `turn.started` 后立即 confirm 并写 running；进程退出后根据自己的 stdout 与退出码记录终态。重试用的 `error` 事件不算终态。已接收输入的执行失败不撤销 delivered，也不自动重投。queue 未送达时不写 turn。

`POST /turn` 必须携带当前投递的 `peer`、`seq`、`instance`、`attempt` 和 `state`（running/completed/failed）；只接受已 delivered 且身份、尝试编号一致的记录。未知不写成 failed，终态不可倒退或被另一终态覆盖。`delivery-attempts.json` 保留跨 release 的编号，防止旧 worker 重用尝试号。终态写入失败只记录日志，投递确认与 ack 不受影响；`/delivery`、`/inbox`、`/status.recent` 均返回 turn。

### 点名投递

```text
# DSH 侧：看有哪些 Codex 线程可以点名
bridge_threads cwd="C:\work\my-project"

# Codex 侧：看有哪些 DSH 会话可以点名
bridge_sessions cwd="C:\work\my-project"
```

然后在 `bridge_send` 里用 `thread=`、`session=`，或者 `to: "codex:<id>"` / `"dsh:<id>"`。

> `codex exec` 产出的线程（`source=exec`）**不会**出现在 Codex 桌面端的「最近」列表里，只存在于磁盘和 `codex resume <id>` 里。想让它出现在列表里，用 `--gui` 挑一条 `source=vscode` 的线程，或者之后在终端 `codex resume` 打开它。

### 认领与在途保护

投递端在动手前会先「认领」，所以两个推送进程同时跑也不会把同一条消息各投一遍：

- 认领是**先到先得**，后来者拿 409；投递成功要 `confirm`，失败要 `release`。
- 认领带租约（默认 120 秒，推送端可传更长的 `--claim-ttl`）；推送端崩溃后租约过期自动作废，消息重新可投。
- 还有未完成的投递时，`/ack` 会拒绝（409，`all: true` 也绕不过）——否则就是「消息还没送到就被标已读」。
- `bridge_send` 支持 `client_msg_id` 幂等：同 id + 同内容重发返回原来那条，不会多出一条。

## 面板与未读徽标

- **「桥」tab**：总线是否在线、seq、各 peer 读到哪、按项目分组的未读、最近消息、Codex 线程活动、定向车道。
- **侧栏会话行徽标**：本会话所在车道有几条未读，15 秒刷新一次，不需要打开面板。
- 面板**只读**：不会替你 ack 任何消息，避免把「没处理」掩盖成「已处理」。

面板的浏览器半边由 DSH 从包里的 `exports["./client"]` 加载，所以改完 `lib/client.js` 要重启 DSH。

## 多项目

一条总线可以服务多个仓库，规则是：

1. **项目 id 由 cwd 派生**：`path.resolve` → 正斜杠 → 小写 → 去尾斜杠 → `sha1` 前 8 位。同一个目录的不同写法得到同一个 id。
2. **消息自动带项目**，顺序是：被回复的消息 → `meta.cwd` → 声明的 `projectId` → 会话所在项目。所以回信会留在它回答的那个项目里。
3. **读的时候是并集**：`project=<id>` 只返回「本项目的 + 没归属的」，老消息不会凭空消失。
4. **推送端默认只看自己那组**：`--project auto`（取它自己的 cwd）；要替所有项目巡检就加 `--all-projects`。
5. **`bridge_send` 的项目来自 `BRIDGE_CWD`**：MCP 服务是整个 profile 共享的一个进程，不知道调用方在哪个目录，所以这个值写在 `dsh-bundle/cordis.patch.yml` 的 env 里（`install.ps1 -Project` 会写好）。一个 profile 一个目录，换项目要改这一行。

## 常见问题

**`MCP tool call requires approval, but approval policy is never`**
`config.toml` 里没给 `[mcp_servers.codex-bridge]` 设 `default_tools_approval_mode = "approve"`。

**`queue exited 0 but thread <id> never received seq N`**
就是上面说的假送达。加 `--via exec`（现在也是默认）。

**消息发过去了，但 Codex 桌面端「最近」里没有新对话**
`exec` 线程不进桌面端列表。用 `--gui` 挑 vscode 线程，或 `codex resume <id>` 打开它。

**面板显示「总线未响应：Failed to fetch」**
总线没起（`node bus.mjs`，或让 MCP 工具拉起），或者端口不是 8787（`--port` / `BRIDGE_PORT`）。浏览器侧只允许本机来源与自定义协议（如 `dsh-app://`）访问，普通网页会被拦。

**一次推超过 3 条被拒绝**
防的是「游标落后时把整段历史灌进一条真实线程」。确实要批量推，先看清楚再加 `--yes`。

**同一条消息收到两遍**
三种可能：既配了 `AGENTS.md` 主动查件又开了推送；先用 `queue` 后又用 `exec` 投过一次（队列里那条还滞留）；或者两次投递之间推送端崩溃。桥是**至少一次**语义，重复投递要比丢消息好。

**手动改过 `cursors.json` 之后所有消息都变未读了**
保存成**无 BOM** 的 UTF-8。总线会剥 BOM 并留一份 `.corrupt-<时间戳>` 备份，但解析失败的那次会让水位归零。

## 安全与限制

- 只监听 **127.0.0.1**，没有鉴权。别拿它传密钥、token、个人信息。
- 浏览器来源做了闸门：非 GET 请求来自陌生网页会被 403，避免你开着的网页伪造任务或推进游标。
- **至少一次**投递：崩溃、租约过期、手动 ack 不当都可能导致重投。收到重复消息按 `seq` 去重。
- `delivered` 只表示「消息进了对方的输入」，**不表示任务完成**。
- 面板只读，没有「手动 ack」按钮（会把漏投掩盖成已处理）。
- 目前只有两个 peer（`dsh`、`codex`）。总线的 `to` 已经支持 `*` 和任意名字，但插件侧还没有多 peer 的配置界面。

## 测试

```powershell
node test.mjs            # 冒烟：总线 + MCP 往返
node test-routing.mjs    # 路由与点名
node test-safety.mjs     # 车道 ack、跨源、BOM、在途保护
node test-claims.mjs     # 认领、租约、幂等
node test-mcp.mjs        # 真 MCP 服务器走 tools/call
node test-projects.mjs   # 多项目隔离（含真推送，用假 codex）
node test-async.mjs      # 异步开新对话、queue 送达验证
node test-panel.mjs      # 面板契约（不需要浏览器）
node wake-bundle/test-wake.mjs
```

全部不需要真实额度：涉及 Codex 的地方用 `test-stub-codex.mjs` 假程序。

开发时预览面板（不用装进 DSH）：

```powershell
node panel-dev/serve.mjs      # http://127.0.0.1:8790
```

## 目录

| 路径 | 作用 |
|---|---|
| `bus.mjs` | 本地 HTTP 总线 |
| `mcp.mjs` | MCP stdio 服务器，把总线包装成 7 个工具 |
| `codex-push.mjs` | Codex 侧推送端 |
| `lib/threads.mjs` | 只读扫描 `~/.codex/sessions`，列出线程 |
| `lib/project.mjs` | 项目 id 与消息归属判定（纯函数） |
| `dsh-bundle/` | DSH 插件：MCP 客户端 + 「桥」面板 + 侧栏徽标 |
| `wake-bundle/` | DSH Host 插件：Codex → DSH 的唤醒 |
| `panel-dev/` | 面板开发预览（不装进 DSH） |
| `install.ps1` | 按本机路径生成两个 patch |

## License

GPL-3.0，见 [LICENSE](LICENSE)。

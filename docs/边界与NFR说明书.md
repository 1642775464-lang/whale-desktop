# Whale Desktop · 边界与 NFR 说明书

- 版本：v1.0（步骤 4 定稿）
- 更新日期：2026-10-05
- 上游依据：《悬浮窗-PRD》v2.0、《小窗-PRD》v2.0、《桥-PRD》v2.0、《前端设计规范》v2.0
- 冲突裁决顺序：**PRD > 架构 > 状态**；本说明书是 NFR 与边界的唯一事实源

---

## 一、本说明书回答什么

方法论步骤 4 要求「问三问、出《边界与 NFR 说明书》」。三问即：

| 问 | 含义 | 对应章节 |
|---|---|---|
| **第一问** | 做什么、不做什么 | 二、范围边界 |
| **第二问** | 做到什么程度算合格 | 三、非功能需求（NFR） |
| **第三问** | 什么情况下会失败、失败了怎么办 | 四、失效模式与降级 |

另附五、运行环境基线，六、约束清单，七、待决事项。

---

## 二、范围边界

### 2.1 做（In Scope）

| 编号 | 交付物 | 形态 | 目录 |
|---|---|---|---|
| S1 | 宿主桥 | DSH Cordis 插件 | `whale-bridge/` |
| S2 | 悬浮窗 | 独立 Electron 进程 | `whale-hud/` |
| S3 | 小窗 | 独立 Electron 进程（由桥拉起） | `whale-window/` |
| S4 | 页面按钮 | DSH 客户端插件（浅色小鲸鱼 40×40） | `whale-button/` |

四个交付物合计覆盖 P1–P15 全部页面（见《页面框架》）。

### 2.2 不做（Out of Scope）

以下均为**已明确排除**，实现时不得自行加入：

| 编号 | 不做的事 | 理由 |
|---|---|---|
| N1 | 不打包安装器 | D4 拍板：只交源码与使用说明 |
| N2 | 不改 DSH 宿主既有代码 | 最小改动原则；桥以插件形式挂载 |
| N3 | 不做全局热键 | 宿主壳内 0 处 `globalShortcut`，引入第三方库得不偿失 |
| N4 | 不做桌面毛玻璃 | 实测 `backdrop-filter` 跨不了合成层（方差比 0.935） |
| N5 | 不做常驻高悬浮窗 | 透明窗在 Windows 上仍拦截鼠标（透明像素不穿透） |
| N6 | 不回复顶栏语音/麦克风/共享三按钮 | 用户已删，不得加回 |
| N7 | 不做账号体系与云同步 | 本项目全部本地 |
| N8 | 不桥接宿主内部模块 | 两个 Electron 与页面按钮都只走 HTTP，不 `require` 宿主包 |
| N9 | 不做孤儿进程防护 | 桥 PRD 已裁定；小窗自行退出由用户操作触发 |
| N10 | 不裁桥的 22 条路由 | D3 拍板：全量实现，不做子集 |

### 2.3 系统边界图

```text
┌──────────────────────── DSH Desktop（宿主，不改动）────────────────────────┐
│                                                                             │
│  Cordis 宿主进程                                                            │
│   ├─ sessions 服务      ─┐                                                  │
│   ├─ agents 服务         ├─ 桥只读这些服务，不绕过                          │
│   ├─ commands 服务      ─┘                                                  │
│   └─ 桥插件 whale-bridge ─── 监听 127.0.0.1:19387（只回环）                │
│                                    ▲                                        │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │ HTTP / SSE（唯一通路）
          ┌──────────────────────────┼──────────────────────────┐
          │                          │                          │
   ┌──────┴──────┐            ┌──────┴──────┐            ┌──────┴──────┐
   │ 悬浮窗       │            │ 小窗         │            │ 页面按钮     │
   │ whale-hud    │            │ whale-window │            │ whale-button │
   │ Electron 进程 │           │ Electron 进程 │           │ 宿主客户端插件│
   │ 只读，不发消息 │           │ 可读可写      │           │ 只做入口      │
   └─────────────┘            └─────────────┘            └─────────────┘
```

**关键边界**：两个 Electron 与页面按钮**都不 require 宿主模块**，只通过 `127.0.0.1:19387` 的 HTTP 说话。宿主可以随时重启，桥不可用则三个客户端进入断连态而非崩溃。

---

## 三、非功能需求（NFR）

### 3.1 性能

| 编号 | 指标 | 目标值 | 测量方式 |
|---|---|---|---|
| P-1 | 悬浮窗冷启动到首帧 | ≤ 1500 ms | 进程 spawn 到 `did-finish-load` |
| P-2 | 悬浮窗常驻内存 | ≤ 120 MB | 任务管理器私有工作集 |
| P-3 | 小窗常驻内存 | ≤ 180 MB | 同上 |
| P-4 | 桥进程常驻内存增量 | ≤ 25 MB | 挂载前后宿主 RSS 差 |
| P-5 | 事件到悬浮条的延迟 | ≤ 300 ms | 宿主 append 事件 → SSE 到达客户端 |
| P-6 | 事件到小窗的延迟 | ≤ 500 ms | 同上 |
| P-7 | 桥的单条路由响应 | ≤ 200 ms（P95，本地无网络） | 本地压测 100 次取 P95 |
| P-8 | 悬浮条空闲 CPU | ≤ 0.5% | 10 秒采样平均 |
| P-9 | 小窗空闲 CPU | ≤ 1% | 同上 |
| P-10 | 速度采样窗口 | 8000 ms + 2 秒心跳 | 见《桥-PRD》 |
| P-11 | 落盘写盘防抖 | 400 ms | 见《前端设计规范》 |

**P-1/P-2/P-3 的取舍说明**：Electron 单进程基线约 80–100 MB，这是硬成本。若实测超标，优先放宽 P-2/P-3 而不是 P-1（启动慢比内存高更伤体验）。

### 3.2 可靠性

| 编号 | 要求 | 判据 |
|---|---|---|
| R-1 | 桥不可用时三客户端不崩溃 | 杀桥进程，悬浮条显示红点与 `–`；小窗显示断连态；均不出现空白窗口或抛错弹窗 |
| R-2 | 桥重启后自动恢复 | 桥恢复 5 秒内，客户端自动重连并刷新，无需重启客户端 |
| R-3 | SSE 断线自动重连 | 带 `Last-Event-ID` 续传；断线期间事件不丢（按 seq 补齐） |
| R-4 | 客户端崩溃可恢复 | 悬浮条/小窗崩溃后显示 P14 兜底页，不出现全白窗口 |
| R-5 | 宿主重启后桥随宿主恢复 | 桥是插件，宿主重启则桥自动重挂，端口重新监听 |
| R-6 | 会话事件不丢 | 按 seq 单调去重 + 水位记录；缺口可补读落盘日志 |
| R-7 | 消息流渲染上限 | 小窗保留最近 40 条渲染事件，超出滚动丢弃（不泄漏内存） |

### 3.3 兼容性

| 编号 | 项 | 要求 |
|---|---|---|
| C-1 | 操作系统 | Windows 10 22H2（19045）及以上；本机实测即此版本 |
| C-2 | Node 运行时 | ≥ 22.12.0；本机 v24.21.0 |
| C-3 | Electron 运行时 | 44.0.0（与宿主 `peerDependencies` 一致），离线解包 |
| C-4 | 宿主版本 | dsh-plugin-desktop 2.0.17，`@deepseek-ai/dsh*` 0.2.0-rc.2 |
| C-5 | 会话日志格式 | v4（`session.v4.jsonl.zstd`）；用 `zstdDecompressSync` 逐帧解 |
| C-6 | 屏幕分辨率 | ≥ 1280×720；本机 2560×1440 |
| C-7 | 系统缩放 | 支持 100%–200%；本机 113%（注意 `devicePixelRatio` 报 1 的已知偏差） |
| C-8 | 端口占用 | 19387 被占用时桥启动失败并明确报错，不静默换端口 |

### 3.4 安全

| 编号 | 要求 | 实现 |
|---|---|---|
| SEC-1 | 只监听回环 | 绑 `127.0.0.1`，绝不 `0.0.0.0` |
| SEC-2 | 无凭证落盘 | 桥不写 token/密码/密钥到任何文件；仓库内不得出现凭证 |
| SEC-3 | 渲染进程隔离 | 三客户端均 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true` |
| SEC-4 | 外部脚本白名单 | CSP 必须含 `script-src 'self'`，否则 `<script src>` 被静默拦截 |
| SEC-5 | 不执行未校验输入 | 桥对 body 做类型与范围校验；非法输入返回 400 而非透传 |
| SEC-6 | 不暴露宿主内部路径 | 桥返回的数据不含宿主绝对路径（工作区路径除外，属必要信息） |
| SEC-7 | 卸载即断 | 卸载插件后 19387 立刻拒绝连接，桥拉起的小窗被关闭 |

### 3.5 可用性（无障碍与可测性）

| 编号 | 要求 |
|---|---|
| A-1 | 所有可交互元素有 `aria-label`，文案与《前端设计规范》状态表一致 |
| A-2 | 灰色（不可用）项点击无任何静默效果，不假装能用 |
| A-3 | 关键节点带稳定的 `id`/`class`，供验收脚本读 DOM（见《前端设计规范》约定表） |
| A-4 | 键盘可达：输入框 Enter 发送、Esc 关面板 |
| A-5 | 文案不使用模糊措辞（禁「可能」「大概」「稍等」类无信息表达） |

### 3.6 可维护性

| 编号 | 要求 |
|---|---|
| M-1 | 模块按业务功能域拆分，任何单文件 ≤ 800 行 |
| M-2 | 三层结构：主进程 / preload / renderer 严格分离，不互相 import |
| M-3 | 无构建步骤（原生 ESM/CJS + 原生 CSS），改完直接跑 |
| M-4 | 桥的路由表自描述：`GET /whale` 返回全部 22 条路由 |
| M-5 | 单文件不超过 800 行是硬线；超出必须拆 |

---

## 四、失效模式与降级

### 4.1 失效模式表

| 编号 | 失效场景 | 触发条件 | 检测方式 | 降级行为 |
|---|---|---|---|---|
| F-1 | 桥未启动 | 宿主未运行或插件未挂 | 连接被拒 | 悬浮条红点 + 全部数值 `–`，文案 `桥未连接 · 重试中` |
| F-2 | 宿主无活跃会话 | 用户未开会话 | 会话列表为空 | 悬浮条显示待机灰点，冻结上次值 |
| F-3 | 会话日志读不到 | 权限/路径变更 | 读操作抛错 | 该会话不出现，其余正常；控制台警告 |
| F-4 | zstd 帧损坏 | 写入中途断电 | `zstdDecompressSync` 抛错 | 停在最后一个完好帧，已解出的部分照常渲染 |
| F-5 | SSE 连接断开 | 网络栈抖动 | `onerror` | 3 秒退避重连，带 `Last-Event-ID` 续传 |
| F-6 | 小窗进程被手动杀掉 | 用户结束进程 | `GET /whale/windows` 探活失败 | 下次 `POST /whale/open` 重新 spawn，不复用死进程 |
| F-7 | 端口 19387 被占 | 其他程序占用 | `EADDRINUSE` | 桥启动失败并写明占用原因，不静默换端口 |
| F-8 | 渲染进程崩溃 | 内存/代码缺陷 | `render-process-gone` | 显示 P14 兜底页，提供重新加载 |
| F-9 | 回合运行中发消息 | 用户抢发 | `agent.status === 'running'` | 自动走队列语义（`mode: queue`），不打断当前回合 |
| F-10 | 无活跃回合时中断 | 用户点中断但已结束 | 探测不到活跃回合 | 返回 409，**不误伤**（护栏），UI 不进入中断态 |
| F-11 | 历史会话未唤醒 | 切到非活跃会话 | 该会话无 live agent | 消息流照常渲染（桥直读落盘）；仅点「切到该会话」才进唤醒态 |
| F-12 | 上下文窗口未知 | 会话无 `request/context` 事件 | 字段缺失 | 用量圆环显示 `–`，不显示 0% |
| F-13 | 用量数据缺失 | 无 `assistant/message.usage` | 字段缺失 | 该项显示 `–`，不显示 0 |
| F-14 | 截图/资源加载失败 | 文件缺失 | 加载错误 | 图标位置留空，不显示破图 |

### 4.2 降级原则

1. **宁可显示 `–`，不显示错的数**。未知就是未知，禁止用 0 占位。
2. **宁可局部失效，不整体崩溃**。一个会话读不到不影响其他会话。
3. **宁可静止，不假装能动**。灰色项点击无声无息，不得出现"看起来点了但没反应"的困惑。
4. **失败必有出口**。每个断连态都给出重试路径，不留死胡同。

---

## 五、运行环境基线（本机实测）

| 项 | 实测值 | 采集方式 |
|---|---|---|
| 操作系统 | Windows 10 Pro 22H2 build 19045 | 注册表 `CurrentVersion` |
| CPU | Intel Core i5-14400F，16 逻辑处理器 | `NUMBER_OF_PROCESSORS` |
| 内存 | 已提交 45.91 GB / 上限 52.09 GB | `\Memory\Committed Bytes` |
| 主屏 | 2560×1440，单显示器 | `System.Windows.Forms.Screen` |
| 系统缩放 | 113% | 用户设置 |
| D 盘 | 已用 228.3 GB / 可用 352.9 GB | `Get-PSDrive` |
| Node | v24.21.0（`D:\dev\nodejs24`） | `node -v` |
| npm | 11.19.0 | `npm -v` |
| git | 2.55.0 | `git --version` |
| Electron 来源 | `%LOCALAPPDATA%\electron\Cache` 离线 zip | 目录列举 |
| 可用 Electron 版本 | v32.3.3 / v33.2.1 / v33.4.11 / v40.10.2 / v40.10.6 / v41.10.3 | 去重后 6 个版本 |
| 目标 Electron | **44.0.0**（与宿主一致） | npm 元数据 + GitHub 可达 |
| 宿主 | dsh-plugin-desktop 2.0.17，Electron 44.0.0 | `package.json` |
| 宿主会话存储 | `%USERPROFILE%\.dsh\sessions\<项目键>\<会话id>\session.v4.jsonl.zstd` | 实地枚举 |

### 5.1 会话存储实测结论（影响实现的硬事实）

对当前项目会话日志（959269 字节）逐帧解析得到：

| 事实 | 值 | 影响 |
|---|---|---|
| 文件是 zstd 压缩的 | 魔数 `28 b5 2f fd` | 必须解压才能读 |
| **每帧独立，非连续流** | 全文件 **562** 个帧魔数 | `zstdDecompressSync` 只解第一帧；必须按魔数偏移逐帧解 |
| 解压后总字节 | 3274131 | ≈ 3.4 倍膨胀 |
| 事件行数 | 967 | — |
| 首行恒为 session 头 | `{"type":"session","version":4,...}` | 头单独一帧 |
| Node 支持 | `zlib.zstdDecompressSync` 存在（v24.21.0） | 无需第三方解压库 |
| 事件类型 | 23 种 | 见下 |

**23 种事件类型**（实测出现）：
`session`、`permission/preset`、`sandbox/mode`、`approval/policy`、`agent-preset/selected`、
`command/run`、`command/done`、`agent/inbox/spliced`、`turn/start`、`turn/end`、
`step/start`、`step/end`、`system/message`、`user/message`、`assistant/message`、
`request/header`、`request/context`、`session/title`、`session/title-llm-request`、
`tool/call`、`tool/result`、`todo/write`、`workspace/changes`

### 5.2 用量数据实测（决定 D1 口径的落地方式）

**关键发现**：落盘的 `usage` 对象只有四个字段：

```json
{"inputTokens": 33243, "outputTokens": 331, "totalTokens": 35366, "cacheReadTokens": 1792}
```

| 事实 | 影响 |
|---|---|
| **没有 `cacheWriteTokens`** | 四桶中的缓存写入恒为 0，累计缓存写显示 `–` 或 0 |
| **没有 `contextPressure` 投影** | 上下文占用必须由桥自行按 `inputTokens + cacheReadTokens + cacheWriteTokens` 计算 |
| `totalTokens` 存在但含缓存读 | 不能当"上下文占用"用（会虚高） |
| `usage` 挂在 `assistant/message.data.usage` | 桥从该路径取，不是挂在 message 内 |
| 187 条 assistant/message **全部**带 usage | 数据完整，无缺失回退场景 |

**D1 方案 C 的落地修正**：
- 累计量四桶取 `tokenUsage.totals` 语义 → 由桥对 `assistant/message.data.usage` 求和
- 上下文占用取 `contextPressure` 投影 → **宿主投影在落盘中不存在**，改为桥按
  `pressureFrom(usage) = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)`
  计算瞬时值，分母取 `request/context.data.contextWindow`
- 实测末条：`pressureFrom = 983 + 92288 + 0 = 93271`，窗口 1000000 → 占用 9.3%

### 5.3 宿主服务接口实测（桥调用的权威面）

**会话事件订阅**：

```js
ctx.on('session/event', (session, event) => { /* event.seq, event.type, event.data */ });
```

**Agent 提交与中断**（`ctx.agents` 为注册表）：

| 操作 | 调用 | 语义 |
|---|---|---|
| 查活跃 Agent | `ctx.agents.get(sessionId)` | 返回 Agent 或 undefined |
| 查是否在跑 | `agent.status === 'running'` | `phase.kind` 派生 |
| 列全部活跃 | `ctx.agents.list()` / `roots()` | 注册顺序 |
| 追加回合 | `agent.followup(message)` | 等价 `send(message, 'next-turn', true)` |
| 插当前步后 | `agent.steer(message)` | `send(message, 'next-step', true)` |
| 注入不唤醒 | `agent.inject(message)` | `send(message, 'next-step', false)` |
| 中断 | `agent.cancel({kind:'user'}, {keepInbox:true})` | 宿主自己的停止键就是这个 |

**真实 UI 的提交通路**（`dsh-api-session-controller`，桥照此对齐）：

```js
const message = createUserMessage({ content, source });
if (request.mode === 'steer') agent.steer(message); else agent.followup(message);
// 中断：agent.cancel({ kind: 'user' }, { keepInbox: true });
```

**会话读取**：`ctx.sessions.get(id)`、`ctx.sessions.list()`；会话摘要含
`sessionId / running / agentAvailable / blank / updatedAt`。

**命令执行**：`ctx.commands.execute(agent, line, attachments, signal)`。

---

## 六、约束清单

继承《需求整理》的 17 条硬约束，并补充本步新增：

| 编号 | 约束 | 来源 |
|---|---|---|
| K-1 | 缩放比例在悬浮窗/小窗两处必须用同一常量源 | 页面框架 |
| K-2 | `SHADOW_PAD = 16` 必须主进程常量与 CSS 变量同值 | 设计规范 |
| K-3 | 桥只绑回环，绝不 `0.0.0.0` | 安全 |
| K-4 | 两个 Electron 与按钮插件不 require 宿主包 | 边界 |
| K-5 | 代码中不出现任何凭证、token、密码 | 五关键点 |
| K-6 | 每次改动前先出范围声明 | 五关键点 |
| K-7 | 报错先自查（读代码/日志/栈定位行），不甩锅 | 五关键点 |
| K-8 | 单文件 ≤ 800 行 | NFR M-5 |
| K-9 | 不用 `as any` / 不用 `@ts-ignore` 掩盖问题 | 开发规范（步骤 8 落实） |
| K-10 | 落盘 usage 无 `cacheWriteTokens`，桥不得虚构该值 | 本步实测 |
| K-11 | 读会话日志必须逐帧解 zstd，不能用 `zstdDecompressSync` 一次解完 | 本步实测 |
| K-12 | 原生 zstd 解压不可用时回退纯 JS 解码器（宿主自带 553 行实现可参考思路） | 本步实测 |

---

## 七、待决事项

本步**未产生新的用户决策缺口**。以下为实现阶段的技术备忘，不阻塞：

| 项 | 备忘 |
|---|---|
| Electron 44 获取 | 离线缓存无 44 版本，需从 GitHub Releases 下载 157455369 字节 zip（已验证可达）；若失败则回退 41.10.3 |
| 小窗的激活态判定 | 桥按 `ctx.agents.get(id)?.status` 判定；无 live agent 即非活跃 |
| 历史会话"唤醒" | 走 `POST /whale/resume`，由宿主行为决定耗时（约 20 秒），UI 必须显示进度态 |
| `/whale/send` 的排队语义 | 回合运行中由桥显式传 `mode: queue`，不依赖宿主自动排队 |

---

## 八、验收映射

本说明书的 NFR 编号与 PRD 验收项的对应关系：

| NFR 组 | 主要对应验收项 |
|---|---|
| P-1…P-4（启动/内存） | A1、B1 |
| P-5…P-7（延迟） | A5、C3 |
| R-1…R-4（断连恢复） | A7、A8、B13、C12 |
| R-6、R-7（事件不丢） | B3、C2 |
| C-5、K-11（zstd 逐帧） | B11 |
| SEC-1…SEC-7 | C1、C12、C13 |
| A-1…A-5（可测性） | A9、B7、B8、B9 |
| F-9、F-10 | C10、C11 |

---

## 九、版本沿革

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-10-05 | v1.0 | 初版：三问齐备；补充会话存储 zstd 逐帧实测、用量四桶实测、宿主服务接口实测 |

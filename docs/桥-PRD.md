# Whale Desktop · 桥 PRD

- 文档版本：v2.0
- 日期：2026-10-05
- 产品代号：Whale Bridge（桥）
- 状态：**定稿**，作为单一事实源
- 上游依据：`_inbox/extracted/交付说明.md` + 悬浮窗 PRD 第四章 + 小窗 PRD 第四章
- 冲突裁决顺序：**本 PRD > 《桥-ARCHITECTURE.md》 > 《桥-STATUS.md》**

---

## 一、这份东西是什么

一个**跑在 DSH 宿主进程里的 Cordis 插件**，在 `127.0.0.1:19387` 上开一个 HTTP + SSE 服务，
把宿主内的会话事实暴露给两个 Electron 进程（悬浮窗、小窗）。

它是三件套里唯一的「知情者」：会话在不在跑、跑到第几步、用了多少 token，只有宿主知道。

**一句话定位**：把宿主内的会话事实，变成一条本机 HTTP 接口。

---

## 二、为什么做成宿主插件而不是独立进程

| 方案 | 结论 |
|---|---|
| 独立 Node 进程读会话落盘文件 | ✗ 只能看到已落盘部分，看不见「正在跑」的回合；速度、状态点全部无法实时 |
| 宿主插件 + 本机 HTTP | ✓ 能直接订阅 `ctx.sessions` 的 `session/event`，拿到全部实时事件 |

宿主插件形态的三个附带好处：生命周期跟随宿主、可读宿主服务（模型目录、权限档位）、
桥的卸载钩子可以主动关掉自己拉起的窗口。

---

## 三、功能需求

### F1 监听与暴露（P0）

| 项 | 要求 |
|---|---|
| 监听地址 | `127.0.0.1:19387`（**只回环**，不对外暴露） |
| 基础路径 | `/whale` |
| 协议 | HTTP/1.1，其中的 `/whale/events` 与 `/whale/hud/events` 为 `text/event-stream` |
| 跨域 | 允许 `http://127.0.0.1:*` 与 `http://localhost:*`（CSP `connect-src` 已放行） |
| 端口占用 | 端口被占时启动失败要**明确落日志**，不静默 |
| 卸载 | 插件卸载钩子里主动关闭自己拉起的窗口，然后关服务 |

### F2 22 条路由（P0，用户决策 D3 = 全量实现）

| 方法 | 路径 | 用途 | 关键行为 |
|---|---|---|---|
| GET | `/whale` | 概览 | 返回版本、路由表、插件名 |
| GET | `/whale/probe` | 运行时探测 | 返回宿主 token-meter / session-projection 服务是否可用 |
| GET | `/whale/events` | **SSE 实时事件流** | 小窗靠它刷新；支持 `?sessionId=` 过滤；带 `Last-Event-ID` 续传 |
| GET | `/whale/panel` | 面板数据源 | 需 `?sessionId=`；返回消息流 + 任务清单 + 权限档位 + 模型档位 |
| GET | `/whale/capability` | 提交通路能力探测 | 返回 `send` / `command` / `abort` / `resume` 各自是否可用 |
| GET | `/whale/windows` | 已拉起的小窗进程 | 返回 pid、可执行路径、存活判定 |
| GET | `/whale/fold` | 增量折叠器状态 | 返回每个会话的折叠水位、事件计数、tail 长度 |
| GET | `/whale/follow` | 主窗跟随 SSE | 客户端半侧消费；返回当前活跃会话 id 与订阅水位 |
| GET | `/whale/models` | 模型目录 | 从宿主 agent-default-model / pi-ai provider 读取 |
| GET | `/whale/approval` | 待确认权限请求 | 返回挂起的 `approval/asked` 列表 |
| POST | `/whale/open` | 唤起小窗 | 已存活则复用，不重复拉起；返回 `{pid, reused}` |
| POST | `/whale/close` | 关闭小窗 | 按 pid 关闭自己拉起的窗口 |
| POST | `/whale/send` | **发消息到真会话** | 回合空闲直接发；回合运行中自动加 `mode:"queue"` |
| POST | `/whale/command` | 执行斜杠命令（不经模型） | 如 `/permission workspace-write` |
| POST | `/whale/activate` | 切会话时唤醒为宿主活跃会话 | |
| POST | `/whale/model` | 切换模型 / 推理等级 | |
| POST | `/whale/abort` | 中断当前回合 | **有护栏**：明确探测到活跃回合才真的取消 |
| POST | `/whale/resume` | 唤醒历史会话 | body `{sessionId}` |
| POST | `/whale/approval` | 应答权限确认 | body `{id, decision}` |
| POST | `/whale/action` | 宿主侧动作 | 如打开文件夹 |
| GET | `/whale/hud` | 悬浮条数据 | 全量快照：会话列表 + 每会话用量 + 速度 |
| GET | `/whale/hud/events` | 悬浮条 SSE | 增量推送 |

### F3 事件折叠（P0）

桥订阅 `ctx.sessions` 的 `session/event`（回调签名 `(session, event)`），维护两份折叠状态：

| 折叠器 | 消费方 | tail 策略 | 水位去重 |
|---|---|---|---|
| `hudBySession` | 悬浮窗 | **不设 tail**，保留全部 usage 聚合 | 有，按 `seq` 去重 |
| `sessionFold` | 小窗 | **保留最近 40 条渲染事件** | 有，按 `seq` 去重 |

> 差异原因：HUD 要的是**累计量**（累计输出/输入/缓存读），少收一条就永久少一份；
> 小窗要的是**当前屏**，只要最近 40 条渲染事件。

### F4 token 口径（P0，用户决策 D1 = 方案 C）

桥是 token 口径的**唯一计算方**，两个消费端都只拿结果。

| 输出字段 | 取值 | 来源 |
|---|---|---|
| `contextUsed` | `contextPressure.projectedTokens`，缺失回退 `pressureTokens` | `contextPressure` 投影 |
| `contextWindow` | 同名 | `request/context` 事件 |
| `totalOutput` | `tokenUsage.totals.outputTokens` | `tokenUsage` 投影 |
| `totalInput` | `tokenUsage.totals.uncachedInputTokens` | `tokenUsage` 投影 |
| `totalCacheRead` | `tokenUsage.totals.cacheReadTokens` | `tokenUsage` 投影 |
| `steps` / `turns` | `step/start` 与 `turn/start` 计数 | 会话事件 |
| `speed` | 见 F5 | 桥自算 |

**取值方式**：优先经宿主的 `session-projection` 服务读取 `tokenUsage` / `contextPressure`
两个投影的 `wire.view` 结果；服务不可用时，桥按同样规则在本地折叠（`lib/usage-stats.mjs` 的纯函数复用）。

### F5 速度算法（P0）

- `SPEED_WINDOW_MS = 8000`
- 速度 = 最近 8 秒窗口内 `outputTokens` 增量 ÷ 窗口时长
- 窗口内样本都过期后速度**归零**（累计数字不受影响）
- 回合结束时速度**冻结**
- 新回合开始时**清空采样**
- 桥侧每 **2 秒**心跳重算一次

**`speed.phase` 取值**：`running`（回合在跑）| `idle`（空闲）| `unknown`（桥未连上该会话）。

> HUD 的「进行中」判据是 `speed.phase === 'running'`，不是「最近有没有出 token」。

### F6 拉窗与复用（P0）

- `POST /whale/open`：先查已有小窗进程，存活则 `{reused: true}` 直接返回；否则 spawn。
- spawn 必须**清除 `ELECTRON_RUN_AS_NODE`**（`delete` 该环境键），否则 Electron 退化成 node。
- 必须带 `--no-sandbox`。
- **不做孤儿防护**：不加 `WHALE_PARENT_PID` 探测，不让子进程猜父进程死活。
- 桥在**卸载钩子**里主动关闭自己拉起的窗口。

### F7 实时性（P0）

- 会话事件到达 → 立即推 SSE（不等心跳）
- 心跳每 2 秒推一次速度重算结果
- SSE 断线由客户端退避重连（小窗 1s → 15s）

---

## 四、数据模型

```ts
// GET /whale/hud 的响应形状
{
  bridge: { version: string, port: number, uptimeMs: number },
  sessions: Array<{
    sessionId: string,
    title: string,
    workspace: string,
    speed: { phase: 'running'|'idle'|'unknown', tokPerSec: number|null, frozen: boolean },
    contextUsed: number|null,
    contextWindow: number|null,
    totalOutput: number, totalInput: number, totalCacheRead: number,
    steps: number, turns: number,
    lastUsageAt: number|null
  }>,
  activeSessionId: string|null
}
```

---

## 五、技术约束

### 5.1 只监听回环

绑定 `127.0.0.1`，不要绑 `0.0.0.0`。DSH 桌面端 profile 的 `desktop-shell.networkExposure` 已是 `loopback`。

### 5.2 不做凭证

桥不持有任何 API key。它只读宿主内存态，不需要凭证。**任何 key 都不得进入仓库。**

### 5.3 卸载即清理

插件卸载时：先关自己拉起的小窗，再关 HTTP 服务，避免端口泄漏导致下次启动失败。

---

## 六、已知限制

| 限制 | 说明 |
|---|---|
| 端口固定 19387 | 不自动换端口，端口冲突需用户处理 |
| 会话可见范围 | 桥只能看到宿主已知的会话；纯落盘历史需经 `/whale/resume` |
| 桥必须随宿主重启 | 改桥代码要重启 DSH 宿主 |

---

## 七、文件与目录

```
whale-bridge/
├── package.json          Cordis 插件包（name: whale-bridge）
├── cordis.patch.yml      插入到 profile 的 patch 片段
└── lib/
    ├── host.js           插件入口（apply 函数，注册与卸载）
    ├── host-impl.js      HTTP 服务 + 路由 + 折叠逻辑
    └── client.js         客户端插件（页面内小鲸鱼按钮 whale-button）
```

---

## 八、验收标准

| 编号 | 项 | 判据 |
|---|---|---|
| C1 | 桥可连 | `GET http://127.0.0.1:19387/whale` 返回 200 且含版本与 22 条路由表 |
| C2 | 只监听回环 | 从局域网 IP 访问被拒 |
| C3 | SSE 通 | `GET /whale/events` 持续返回 `text/event-stream`，宿主产生事件后 1 秒内到达 |
| C4 | HUD 数据正确 | `/whale/hud` 的 `totalOutput` 与宿主 token-meter 的 `totals.outputTokens` 一致 |
| C5 | 上下文口径正确 | `contextUsed` 等于 `contextPressure.projectedTokens`（或回退值） |
| C6 | 速度口径正确 | 连续产出时 `tokPerSec` 与「最近 8 秒增量÷8」一致（±10%） |
| C7 | 拉窗可用 | `POST /whale/open` 返回 pid，`GET /whale/windows` 能看到且存活 |
| C8 | 拉窗复用 | 连续两次 `/whale/open`，第二次返回 `reused: true`，不产生新进程 |
| C9 | 发消息进真会话 | `POST /whale/send` 后宿主发 `user/message` 事件 |
| C10 | 排队语义 | 回合运行中 `POST /whale/send`，宿主事件 `mode === 'queue'` |
| C11 | 中断有护栏 | 无活跃回合时 `POST /whale/abort` 返回 409 且不误伤 |
| C12 | 卸载清理 | 卸载插件后 `GET /whale` 连接被拒，且桥拉起的小窗已关闭 |
| C13 | 无凭证 | `git grep -iE "api[_-]?key|secret|token=" -- whale-bridge` 无命中（"token" 作为字段名除外） |

---

## 九、版本沿革

| 日期 | 变更 |
|---|---|
| 2026-10-03 | 初版：13 条路由 |
| 2026-10-04 | 扩到 22 条路由 |
| 2026-10-05 | 桥版本 0.3.0 |
| **2026-10-05** | **v2.0 定稿：按本仓库重新实施；token 口径改为 token-meter 投影（D1 决策 C）；22 条全量实现（D3）；新增验收 C1–C13** |

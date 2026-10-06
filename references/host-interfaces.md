# references · 宿主服务接口

> 唯一可信源片段。来源：宿主已发布代码逐行实测（`C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\`）。
> **本项目不 require 宿主包**，本文件只用于「桥调用宿主服务」时的口径对齐。

---

## 一、事件订阅

```js
ctx.on("session/event", (session, event) => {
  // event: { seq, type, data }
});
```

其他生命周期事件：

| 事件 | 触发点 |
|---|---|
| `session/created` | `dsh-session/lib/index.js:1791` |
| `session/disposed` | `:1811` |
| `session/flush` | `:1837` |
| `agent/status` | `dsh-agent-loop/lib/index.js:798`，payload `{ status }` |

---

## 二、Sessions 服务（服务名 `"sessions"`）

`dsh-session/lib/index.js`：

| 方法 | 行 | 签名 |
|---|---|---|
| `create` | L1653 | `create(id, options)` |
| `prepare` | L1680 | `prepare(id, options)` |
| `enter` | L1734 | `enter(session)` |
| `announce` | L1782 | `announce(session)` |
| `get` | L1861 | `get(id)` |
| `list` | L1868 | `list()` |
| `fork` | L1887 | `fork(source, boundary, childSessionId)` |
| `flush` | L1832 | `flush(session)` |

---

## 三、AgentLoop（提交/中断的**关键**）

`dsh-agent-loop/lib/index.js`：

```js
get status()  // L790：idle | running
              //   this.phase.kind === "idle" || "maintenance" ? "idle" : "running"

send(message, target, wakeup)  // L800
followup(input)                // L806 = send(input, "next-turn", true)
steer(input)                   // L809 = send(input, "next-step", true)
inject(input)                  // L812 = send(input, "next-step", false)

cancel(cause, options = {})    // L815
  // if (!options.keepInbox) { this.inbox.clear(); }
  // if (this.phase.kind !== "idle") this.phase.abort.abort(cause);
```

inbox 两个队列：`"next-turn"` / `"next-step"`。

---

## 四、真实 UI 的提交通路（**桥照此对齐**）

`dsh-api-session-controller/lib/index.js`：

### 提交（L876-883）

```js
const message = createUserMessage({
  content: await this.ctx.attachments.admitPromptContent(admission.content),
  source,
});
if (request.mode === "steer") agent.steer(message);
else agent.followup(message);
```

守卫：`if (this.ctx.agents.get(agent.id) !== agent) throw new RemoteError("session/not-found", ...);`

异常映射：`session/attachment-invalid` / `session/agent-busy`

### 中断（L994-1000）

```js
const agent = this.ctx.agents.get(request.sessionId);
if (agent === void 0) throw new RemoteError("session/not-found", ...);
agent.cancel({ kind: "user" }, { keepInbox: true });
return { accepted: true };
```

**宿主自己的停止键就是 `keepInbox: true`** —— 桥必须照此，否则会清空用户待发队列。

### steer 守卫（L966）

```js
if (request.action.kind === "steer" &&
    (target !== "next-turn" || agent.status !== "running"))
  throw new RemoteError("session/steer-unavailable", ...);
```

### 会话摘要（L1870-1882）

```js
{
  sessionId,
  updatedAt,
  agentAvailable: this.ctx.agents.get(session.id)?.session === session,
  running: this.ctx.agents.get(session.id)?.status === "running",
  blank,
  ...listFields(session.header),
}
```

### 状态广播（L2884）

```js
ctx.on("agent/status", ({ agent, status }) => ctx.emit("api-session/status", agent.id, status === "running"));
```

---

## 五、AgentRegistry（`dsh-agent/lib/index.js`，默认导出）

| 方法 | 行 |
|---|---|
| `create` | L451 |
| `get(id)` | L594 |
| `list()` | L612 |
| `roots()` | L621 |
| `isOwnedBy(id, owner)` | L605 |
| `announce` | L572 |

---

## 六、Commands 服务（服务名 `"commands"`）

`dsh-commands/lib/index.js`：

| 方法 | 行 |
|---|---|
| `register(definition)` | L266 |
| `list(agent)` | L287 |
| `find(agent, name)` | L296 |
| `execute(agent, line, submittedAttachments, signal)` | L327 |
| `view(agent)` | L423 |
| `registerFileReceiptResolver(resolver)` | L275 |

---

## 七、注意

- `@deepseek-ai/dsh-session` 包**不发布 .d.ts**（`package.json` 的 `types` 指向不存在的文件），只有 `.js`
- 故桥侧**不能依赖类型声明**，须按运行时行为对齐
- `SESSION_FORMAT_VERSION = 4`

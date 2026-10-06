# references · 会话事件与落盘格式

> 唯一可信源片段。来源：本机实测（解压真实会话日志统计）。
> **禁止凭记忆写事件类型。**

---

## 一、文件布局

```
C:\Users\Administrator\.dsh\sessions\
└── <projectKey>\
    └── <sessionId>\
        └── session.v4.jsonl.zstd
```

`projectKey` 生成规则（`dsh-session-persistence-jsonl/lib/index.js:876-894`）：把 `/`、`\`、`:` 折叠为单个 `-`，其他非 `[A-Za-z0-9._-]` 字符转 `~XXXX`（大写 4 位十六进制），最终形如 `--<readable>--`（截断 251）。

本工作区 `D:\DEEPSEEK\悬浮窗` → `--D-DEEPSEEK-~60AC~6D6E~7A97--`
（悬=U+60AC、浮=U+6D6E、窗=U+7A97）

**编码**：Zstd 为默认压缩。另有纯 `.jsonl` 编码；**两编码共存会抛 `encodingMismatch`**；旧扁平布局会抛 `legacyLayout`。

---

## 二、文件格式

**多帧 zstd**，逐帧解码后是 **JSONL**（每行一个 JSON 对象）。

实测样本：959269 字节 → 562 帧 → 3274131 字节 → 967 行。

解码方法见 [`node-native-api.md`](node-native-api.md) 第一节。

---

## 三、首行：会话头

```json
{"type":"session","version":4,"id":"session-bbef2a3e-...","createdAt":1791221001152,"cwd":"D:\\DEEPSEEK\\悬浮窗","isSeeded":false,"delegationDepth":0,"agentPreset":"standard"}
```

校验规则（`@deepseek-ai/dsh-session/lib/index.js:1037-1054`）：`cwd` 只要求是字符串且为绝对路径。

---

## 四、后续行：事件

除首行外，**所有事件都带 `seq`(number)、`time`(epoch ms)、`data` 三个字段**。

### 实测出现过的类型（23 种）

| 类型 | 条数（样本） |
|---|---|
| `session` | 1 |
| `permission/preset` | 2 |
| `sandbox/mode` | 2 |
| `approval/policy` | 2 |
| `agent-preset/selected` | 1 |
| `command/run` | 1 |
| `command/done` | 1 |
| `agent/inbox/spliced` | 6 |
| `turn/start` | 2 |
| `turn/end` | 1 |
| `step/start` | 180 |
| `step/end` | 179 |
| `system/message` | 1 |
| `user/message` | 10 |
| `assistant/message` | 180 |
| `tool/call` | 195 |
| `tool/result` | 194 |
| `request/header` | 1 |
| `request/context` | 1 |
| `session/title` | 2 |
| `session/title-llm-request` | 1 |
| `todo/write` | 3 |
| `workspace/changes` | 1 |

### 已注册但样本未出现的全集

见 `@deepseek-ai/dsh-session/lib/types/known-event-types.js` 的 `KNOWN_SESSION_EVENT_TYPES`（约 60 个），含 `approval/asked`、`approval/decided`、`model/selection`、`compaction/*`、`subagent/*`、`team/*`、`goal/change` 等。

**注意**：读取含未知类型且无 ignorable 标记的日志会被持久化层**拒绝**。桥的折叠器须对未知类型**宽容跳过**，不得抛错。

---

## 五、关键事件形状

### `request/context`（**token 口径的分母来源**）

```json
{"seq":24,"time":...,"data":{"provider":"magpie","model":"workbuddy-ai/deepseek-v4.1-flash","contextWindow":1000000}}
```

**整个会话只出现 1 条。**

### `assistant/message`（**usage 挂在这里**）

```json
{
  "seq": ...,
  "time": ...,
  "data": {
    "turn": 1,
    "step": 1,
    "message": {
      "role": "assistant",
      "content": [
        {"type": "text", "text": "..."},
        {"type": "tool-call", "id": "call_...", "name": "pwsh", "arguments": "<JSON 字符串>"}
      ],
      "source": {"kind": "model", "provider": "magpie", "model": "...", "replayState": {...}}
    },
    "usage": {"inputTokens": 33243, "outputTokens": 331, "totalTokens": 35366, "cacheReadTokens": 1792},
    "stream": ...
  }
}
```

- content 块实测**只有 `text` 与 `tool-call` 两种**（15 / 200）
- `arguments` 是 **JSON 字符串**，需二次解析

### `usage` 对象字段（**只有 4 个**）

```json
{"inputTokens":33243,"outputTokens":331,"totalTokens":35366,"cacheReadTokens":1792}
```

**没有 `cacheWriteTokens`。** 不得虚构该值（K-5）。

实测 187/187 条 `assistant/message` 全部带 usage，无缺失。

### `tool/result`

```json
{"data":{"message":{"role":"tool","toolCallId":"call_...","content":[{"type":"text","text":"..."}]}}}
```

### `user/message`

```json
{"data":{"content":[{"type":"text","text":"..."}],"source":{"kind":"user-approval"},"role":"user","id":"<uuid>"},"surfaceOp":"append"}
```

### `turn/start` / `turn/end`

```json
{"data":{"turn":1}}
{"data":{"turn":1,"reason":{"kind":"completed"}}}
```

### `step/start` / `step/end`

```json
{"data":{"turn":1,"step":1}}
```

### `session/title`

```json
{"seq":27,"data":{"title":"从PRD与原型重新实施项目","messageSeqs":[17],"source":{"kind":"provider","provider":"session-title-first-prompt-llm","model":{"provider":"magpie","model":"..."}}}}
```

首次为 `{"kind":"fallback"}`（截断标题）。

### `todo/write`

```json
{"data":{"todos":[{"content":"...","status":"completed"|"in_progress"|"pending"}]}}
```

### `agent/inbox/spliced`

含 `removedCount`、`outcome`（如 `"canceled"`）、`inserted`。

---

## 六、token 口径（D1·C 方案）

```js
// 瞬时上下文占用（prompt 侧，不含 output）
pressureFrom(usage) = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
// 分母
contextWindow = request/context.data.contextWindow
```

实测末条：`{"inputTokens":983,"outputTokens":81,"totalTokens":93352,"cacheReadTokens":92288}`
→ pressure = 983 + 92288 + 0 = **93271**；contextWindow = 1000000 → 占用 **9.3%**

**累计四桶**（对全部 `assistant/message.data.usage` 求和），实测该会话：

| 桶 | 值 |
|---|---|
| `uncachedInputTokens` | 440520 |
| `outputTokens` | 92978 |
| `cacheReadTokens` | 12995584 |
| `cacheWriteTokens` | 0 |

**注意**：`totalTokens` **含缓存读**，不能当上下文占用用。

---

## 七、速度算法（F5）

窗口 `SPEED_WINDOW_MS = 8000`，心跳 2 秒。

```
tokPerSec = 窗口内 outputTokens 增量 / 窗口时长（秒）
```

静止判定：窗口内无新增 → `phase = "idle"`，`frozen = true`（宁可静止不假装能动）。

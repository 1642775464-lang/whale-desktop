# references · Node 内置 API 速查

> 本文件是**唯一可信源**片段。内容来自本机 Node v24.21.0 实测与官方文档。
> 凡本文件未记录的用法，先实测再写进来，不得凭记忆。

---

## 一、zstd 逐帧解码（**关键**）

### 问题

落盘会话日志 `session.v4.jsonl.zstd` 是**多帧** zstd 流，不是单帧。

实测：某会话文件 1776658 字节，含 **1148 个独立 zstd 帧**。

### 错误做法（实测踩过）

```js
// ❌ 只解出第一帧
zlib.zstdDecompressSync(buffer)          // 返回 203 字节（仅 session 头）
zlib.createZstdDecompress()              // 流式同样只输出第一帧
```

### 正确做法

扫魔数 `28 b5 2f fd` 找每帧起点，按 `[offsets[k], offsets[k+1])` 切片，逐帧解压后拼接：

```js
import zlib from "node:zlib";

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

function frameOffsets(buf) {
  const offsets = [];
  let i = 0;
  while (true) {
    const p = buf.indexOf(MAGIC, i);
    if (p === -1) break;
    offsets.push(p);
    i = p + 4;
  }
  return offsets;
}

export function decompressAllFrames(buf) {
  const offsets = frameOffsets(buf);
  if (offsets.length === 0) throw new Error("no zstd frame found");
  const parts = [];
  for (let k = 0; k < offsets.length; k++) {
    const end = k + 1 < offsets.length ? offsets[k + 1] : buf.length;
    parts.push(zlib.zstdDecompressSync(buf.subarray(offsets[k], end)));
  }
  return Buffer.concat(parts);
}
```

### 回退路径

宿主自带纯 JS 解码器（当原生不可用时）：

- `@deepseek-ai/dsh-session-persistence-jsonl/lib/index.js`
- `NodePrivateZstdFrameDecoder`（优先，L~1253 附近）
- `PublicZstdFrameDecoder`（纯 JS 回退）
- 工厂 `createZstdFrameDecoder()` L1385

**本项目不 require 宿主包**（架构铁律 A-1）。故桥侧用原生 `zlib`；原生不可用时按上述思路自写纯 JS 回退。

---

## 二、HTTP 服务（零依赖）

```js
import http from "node:http";

const server = http.createServer((req, res) => {
  // 强制 30：校验 Host 为回环
  const host = req.headers.host ?? "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  // ...
});

// 强制 29：只绑回环
server.listen(19387, "127.0.0.1");
```

---

## 三、SSE（Server-Sent Events）

```js
res.writeHead(200, {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
});

// 事件格式：data: <json>\n\n
res.write(`data: ${JSON.stringify(payload)}\n\n`);

// 心跳（F5：2 秒）
const timer = setInterval(() => res.write(": ping\n\n"), 2000);

req.on("close", () => clearInterval(timer));
```

---

## 四、测试（node:test）

```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("pressureFrom 累加三个桶", () => {
  assert.equal(pressureFrom({ inputTokens: 983, cacheReadTokens: 92288 }), 93271);
});
```

运行：`node --test tests/`

覆盖率：`node --test --experimental-test-coverage tests/`

---

## 五、子进程（拉窗，F6）

```js
import { spawn } from "node:child_process";

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;      // 强制 34

spawn(electronPath, ["--no-sandbox", entry], {
  env,
  detached: false,
  stdio: "ignore",
});
```

**注意**：调试器上下文里 `ELECTRON_RUN_AS_NODE` 会被设置，导致 Electron 以 Node 模式启动、不显示窗口——这是必须删除它的原因。

---

## 六、来源

| 项 | 来源 |
|---|---|
| zstd 逐帧 | 本机实测（1776658 字节 → 1148 帧） |
| 宿主解码器位置 | `C:\Program Files\DSH Desktop\resources\app\node_modules\@deepseek-ai\dsh-session-persistence-jsonl\lib\index.js` |
| Node 版本 | v24.21.0（`D:\dev\nodejs24`） |

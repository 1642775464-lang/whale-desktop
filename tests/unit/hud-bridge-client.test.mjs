/**
 * 桥客户端单测
 *
 * 职责：钉住「连不上 → 必须通知界面降级」与「tick 只合并三个字段」两条纪律。
 * 所属层：测试（tests/unit）
 *
 * 这里最重要的一条是**首次连不上必须通知**：state.offline 的初值就是 true，
 * 若实现写成「已经是 offline 就 return」，第一次失败就永远不会通知界面，
 * 表现是「点在、但颜色不对、标题停在占位符」——真实踩过。
 * 这种 bug 只有测试能钉住，靠读代码很难发现。
 *
 * bridge-client.js 是浏览器 script，用 node:vm 造沙箱加载。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT_FILE = join(ROOT, "whale-hud", "renderer", "bridge-client.js");

/**
 * 记录被创建出来的 EventSource 实例，供测试驱动 onopen/onmessage。
 * 必须用 `defineEventSource(sandbox)` 把构造函数定义在沙箱**内部**。
 */
const eventSourceFactory = `
  (function () {
    var instances = [];
    function FakeEventSource(url) {
      this.url = url;
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.closed = false;
      instances.push(this);
    }
    FakeEventSource.prototype.close = function () { this.closed = true; };
    window.EventSource = FakeEventSource;
    window.__sources = instances;
  })();
`;

/**
 * 在沙箱里加载 bridge-client.js。
 *
 * 关键：脚本的 IIFE 收到的是 `window`（内层对象），所以**所有全局都必须挂在
 * `window` 上**——只挂在沙箱根上，脚本里 `global.URLSearchParams` 会取不到，
 * 然后静默走 catch 退回默认端口。
 *
 * 另一个坑：从外层 realm 注入的函数**不能**在沙箱里 `new`（V8 会以
 * 「不是构造函数」拒绝跨 realm 的构造调用）。所以 EventSource 这个假类
 * 是用 runInContext 在沙箱内部定义的，不是从外面塞进去的。
 *
 * @param {object} env 假的 fetch / EventSource / location
 * @returns {object} window.WhaleBridge
 */
function loadClient(env) {
  const sandbox = {
    window: {},
    console: { warn: () => {}, log: () => {} },
  };
  const w = sandbox.window;
  w.location = env.location ?? { search: "" };
  w.fetch = env.fetch;
  w.setTimeout = setTimeout;
  w.clearTimeout = clearTimeout;
  w.setInterval = setInterval;
  w.clearInterval = clearInterval;
  w.URLSearchParams = URLSearchParams;
  w.Number = Number;
  w.Object = Object;
  w.Array = Array;
  w.JSON = JSON;
  w.Promise = Promise;
  w.console = sandbox.console;

  createContext(sandbox);
  if (env.withEventSource !== false) {
    runInContext(eventSourceFactory, sandbox, { filename: "fake-eventsource.js" });
  }
  runInContext(readFileSync(CLIENT_FILE, "utf8"), sandbox, { filename: CLIENT_FILE });

  const bridge = sandbox.window.WhaleBridge;
  bridge.__sources = sandbox.window.__sources ?? [];
  return bridge;
}

/** 造一个立即失败的网络环境。 */
function failingEnv() {
  return {
    fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    EventSource () {
      this.onopen = null;
      this.onmessage = null;
      this.onerror = null;
      this.close = () => {};
    },
  };
}

test("端口：从查询串取，非法值退回默认", () => {
  const b1 = loadClient({ fetch: () => Promise.reject(new Error("x")), location: { search: "?port=19391" } });
  assert.equal(b1.portFromLocation(), 19391);
  const b2 = loadClient({ fetch: () => Promise.reject(new Error("x")), location: { search: "?port=abc" } });
  assert.equal(b2.portFromLocation(), b1.DEFAULT_PORT);
  const b3 = loadClient({ fetch: () => Promise.reject(new Error("x")), location: { search: "" } });
  assert.equal(b3.portFromLocation(), b1.DEFAULT_PORT);
});

test("首次连不上必须通知界面降级（初值就是 offline 的坑）", async () => {
  const bridge = loadClient(failingEnv());
  const seen = [];
  const client = bridge.createClient({ port: 19391, onChange: (s) => seen.push(s.offline) });

  await client.refresh();

  assert.equal(client.getState().offline, true);
  assert.ok(seen.length > 0, "第一次失败也必须回调，否则界面停在初始态、红点出不来");
  assert.equal(seen[seen.length - 1], true);
});

test("连续失败不重复轰炸界面", async () => {
  const bridge = loadClient(failingEnv());
  let calls = 0;
  const client = bridge.createClient({ port: 19391, onChange: () => { calls += 1; } });

  await client.refresh();
  const afterFirst = calls;
  await client.refresh();
  await client.refresh();

  assert.equal(calls, afterFirst, "降级态没变化时不该每 5 秒重复通知一次");
});

test("恢复在线后再次断开，仍会重新通知", async () => {
  let mode = "fail";
  const env = {
    fetch: () => (mode === "fail" ? Promise.reject(new Error("x")) : Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ sessions: [], activeSessionId: null, bridge: { version: "t" } }),
    })),
  };
  const bridge = loadClient(env);
  const seen = [];
  const client = bridge.createClient({ port: 19391, onChange: (s) => seen.push(s.offline) });

  await client.refresh(); // 失败 → 通知
  mode = "ok";
  await client.refresh(); // 成功 → 通知
  mode = "fail";
  await client.refresh(); // 再失败 → 必须再通知

  assert.deepEqual(seen, [true, false, true], "恢复后的第二次断开必须重新通知界面");
});

test("成功拉取后 offline 为 false 且字段原样保留", async () => {
  const payload = {
    sessions: [{ sessionId: "s1", title: "会话一", contextUsed: 93271, speed: { phase: "running", tokPerSec: 12 } }],
    activeSessionId: "s1",
    bridge: { version: "0.1.0", port: 19391 },
  };
  const bridge = loadClient({
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }),
  });
  const client = bridge.createClient({ port: 19391, onChange: () => {} });

  await client.refresh();
  const state = client.getState();
  assert.equal(state.offline, false);
  assert.equal(state.activeSessionId, "s1");
  assert.equal(state.sessions[0].contextUsed, 93271, "不得改写桥给的字段名或数值");
});

test("tick 只合并三个随时间变的字段，其余沿用快照", async () => {
  const payload = {
    sessions: [{
      sessionId: "s1",
      title: "会话一",
      totalOutput: 300,
      totalInput: 983,
      steps: 7,
      turns: 3,
      contextUsed: 100,
      contextWindow: 1000,
      speed: { phase: "idle", tokPerSec: 0 },
    }],
    activeSessionId: "s1",
    bridge: { version: "0.1.0" },
  };

  const bridge = loadClient({
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }),
  });
  const client = bridge.createClient({ port: 19391, onChange: () => {} });
  await client.refresh();
  client.connect();

  // 灌一条 tick：只带速度 / 占用 / 窗口
  bridge.__sources[0].onmessage({
    data: JSON.stringify({
      kind: "tick",
      sessions: [{ sessionId: "s1", tokPerSec: 42.5, contextUsed: 555, contextWindow: 2000, phase: "running" }],
    }),
  });

  const s = client.getState().sessions[0];
  assert.equal(s.speed.tokPerSec, 42.5, "速度应被 tick 更新");
  assert.equal(s.speed.phase, "running");
  assert.equal(s.contextUsed, 555);
  assert.equal(s.contextWindow, 2000);
  assert.equal(s.totalOutput, 300, "累计量不在 tick 里，必须保留旧值");
  assert.equal(s.title, "会话一", "标题不在 tick 里，必须保留旧值");
});

test("坏帧被跳过，不影响后续帧", async () => {
  const bridge = loadClient({
    fetch: () => Promise.resolve({
      ok: true,
      json: () => Promise.resolve({ sessions: [], activeSessionId: null }),
    }),
  });
  const client = bridge.createClient({ port: 19391, onChange: () => {} });
  await client.refresh();
  client.connect();

  const source = bridge.__sources[0];
  assert.doesNotThrow(() => source.onmessage({ data: "{ 这不是 JSON" }), "坏帧不得抛错");
  assert.doesNotThrow(() => source.onmessage({ data: "null" }));
  source.onmessage({ data: JSON.stringify({ kind: "tick", sessions: [] }) });
  assert.equal(client.getState().offline, false);
});

test("openSmallWindow：把桥的错误码原样带回来，不吞掉", async () => {
  const bridge = loadClient({
    fetch: () => Promise.resolve({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ ok: false, error: { code: "entry-missing" } }),
    }),
  });
  const client = bridge.createClient({ port: 19391, onChange: () => {} });

  const out = await client.openSmallWindow();
  assert.equal(out.ok, false);
  assert.equal(out.code, "entry-missing", "切片 5 之前小窗不存在，必须让上层能红闪并说出原因");
});

test("openSmallWindow：网络层失败也有结构化结果", async () => {
  const bridge = loadClient(failingEnv());
  const client = bridge.createClient({ port: 19391, onChange: () => {} });
  const out = await client.openSmallWindow();
  assert.equal(out.ok, false);
  assert.equal(out.code, "network");
});

test("connect 后 SSE 打开会补拉一次全量（重连对齐）", async () => {
  let fetches = 0;
  const bridge = loadClient({
    fetch: () => {
      fetches += 1;
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ sessions: [], activeSessionId: null }),
      });
    },
  });
  const client = bridge.createClient({ port: 19391, onChange: () => {} });

  client.connect();
  const source = bridge.__sources[0];
  assert.equal(typeof source.onopen, "function", "必须挂上 onopen");
  source.onopen();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(fetches, 1, "onopen 必须补拉全量，否则断线期间的口径会错位");
});

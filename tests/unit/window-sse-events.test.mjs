/**
 * 小窗对 SSE **具名事件**的处理
 *
 * 职责：钉住「宿主机消息一到，小窗就拉面板」这条链路。
 * 所属层：测试（tests/unit）
 *
 * ## 为什么必须单独测这条
 *
 * 用户报「小窗重启后，这个会话的最新消息没有同步」。
 *
 * 根因是**小窗把具名事件当默认事件听了**：桥推的是 `event: touch` /
 * `event: tick`（具名），而客户端写的是 `stream.onmessage = ...` ——
 * `onmessage` **只接默认的 `message` 类型**，具名事件根本不会触发它。
 * 结果那个处理函数**从来没被调用过**，消息只能靠 5 秒轮询，
 * 用户发完话要等好几秒才看到。
 *
 * ⚠️ 这类 bug「看着代码是通的」：onmessage 写得好好的、JSON 也解析了，
 * 只是**永远不会被调用**。所以测试必须**真的触发一次具名事件**再断言副作用。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RENDERER = join(ROOT, "whale-window", "renderer");

/**
 * 在沙箱里加载小窗客户端，并返回可控的假事件流。
 *
 * @param {(url: string) => object} route 按 URL 给响应体
 */
function load(route) {
  const listeners = Object.create(null);
  const fetched = [];

  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.location = { search: "" };
  w.fetch = (url) => {
    fetched.push(String(url));
    return Promise.resolve({
      ok: true,
      json: () => Promise.resolve(route(String(url))),
    });
  };
  w.setTimeout = setTimeout;
  w.clearTimeout = clearTimeout;
  w.setInterval = () => 1;
  w.clearInterval = () => {};
  w.URLSearchParams = URLSearchParams;
  w.Number = Number;
  w.Object = Object;
  w.Array = Array;
  w.JSON = JSON;
  w.Promise = Promise;
  w.console = sandbox.console;

  /** 假事件流：记录 addEventListener 的注册，供测试手动触发具名事件。 */
  w.EventSource = function FakeEventSource(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.addEventListener = (name, fn) => { listeners[name] = fn; };
    this.close = () => {};
  };

  createContext(sandbox);
  for (const f of ["bridge-shapes.js", "bridge-workspace.js"]) {
    const p = join(RENDERER, f);
    runInContext(readFileSync(p, "utf8"), sandbox, { filename: p });
  }
  for (const f of ["bridge-capabilities.js", "follow.js", "stream.js", "stream-link.js", "bridge-client.js"]) {
    const p = join(RENDERER, f);
    runInContext(readFileSync(p, "utf8"), sandbox, { filename: f });
  }

  return {
    client: sandbox.window.WhaleBridge.createClient({ onChange: () => {} }),
    listeners,
    fetched,
  };
}

/** 桥的通用响应。 */
const ROUTES = (url) => {
  if (url.includes("/whale/hud")) {
    return { activeSessionId: "s-1", sessions: [{ sessionId: "s-1", workspace: "D:/proj" }] };
  }
  if (url.includes("/whale/panel")) return { ok: true, messages: [], todos: [], running: false };
  if (url.includes("/whale/commands")) return { ok: true, commands: [] };
  if (url.includes("/whale/summon")) return { ok: true, request: null };
  return { ok: true };
};

test("**具名事件必须被监听**（onmessage 接不到 tick / touch）", () => {
  /*
   * 这条是本次修复的直接回归测试：改回 `onmessage` 就会红。
   */
  const { client, listeners } = load(ROUTES);
  client.connect();
  assert.equal(typeof listeners.touch, "function", "必须监听 touch（onmessage 接不到具名事件）");
  assert.equal(typeof listeners.tick, "function", "必须监听 tick");
});

test("收到 touch（本会话）→ 立即拉面板，不必等轮询", async () => {
  const { client, listeners, fetched } = load(ROUTES);
  client.connect();
  /*
   * ⚠️ 必须**等会话真的绑上**再触发 touch：touch 里带 sessionId，
   * 客户端要和「当前会话」比对；会话还没绑时它会被当成「别的会话」。
   * 真实场景里连接建立时就会先 refresh 一次，所以这里显式等它。
   */
  await client.refresh();
  fetched.length = 0;

  listeners.touch({ data: JSON.stringify({ sessionId: "s-1" }) });
  await new Promise((r) => setImmediate(r));

  const panels = fetched.filter((u) => u.includes("/whale/panel"));
  assert.equal(panels.length >= 1, true, `应立刻拉面板，实际请求：${JSON.stringify(fetched)}`);
});

test("收到别的会话的 touch → **不**拉面板（避免被别人的会话刷屏）", async () => {
  const { client, listeners, fetched } = load(ROUTES);
  client.connect();
  // 先让「当前会话」绑上：会话还没绑时，任何 touch 都会被当作「开机瞬间先拉一次」
  await client.refresh();
  fetched.length = 0;

  listeners.touch({ data: JSON.stringify({ sessionId: "s-other" }) });
  await new Promise((r) => setImmediate(r));

  const panels = fetched.filter((u) => u.includes("/whale/panel"));
  assert.equal(panels.length, 0, `别的会话不该触发本窗刷新，实际：${JSON.stringify(fetched)}`);
});

test("touch 的数据坏掉时不炸（JSON 不合法就忽略）", async () => {
  const { client, listeners } = load(ROUTES);
  client.connect();
  await new Promise((r) => setImmediate(r));
  assert.doesNotThrow(() => listeners.touch({ data: "{不是 JSON" }));
});

test("tick 只更新状态，**不**拉面板（心跳不该产生额外请求）", async () => {
  const { client, listeners, fetched } = load(ROUTES);
  client.connect();
  await new Promise((r) => setImmediate(r));
  fetched.length = 0;

  listeners.tick({
    data: JSON.stringify({
      kind: "tick",
      at: Date.now(),
      sessions: [{ sessionId: "s-1", tokPerSec: 1, contextUsed: 10, contextWindow: 100 }],
    }),
  });
  await new Promise((r) => setImmediate(r));

  const panels = fetched.filter((u) => u.includes("/whale/panel"));
  assert.equal(panels.length, 0, "2 秒一次的心跳不该每次都拉面板");
});

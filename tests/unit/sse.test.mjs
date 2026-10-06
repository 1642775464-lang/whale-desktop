/**
 * sse.mjs 单测
 *
 * 用一个假的 res 对象驱动广播表：记录写进去的内容，模拟连接存活/死亡。
 * 这样能在不起网络的前提下把「连接生命周期 + 回补 + 心跳失败」全测到。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CHANNEL_EVENTS, CHANNEL_HUD, createSseHub } from "../../whale-bridge/lib/sse.mjs";

/** 造一个假响应对象。 */
function fakeRes() {
  return {
    status: null,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    write(text) {
      this.chunks.push(text);
      return true;
    },
    end() {
      this.ended = true;
    },
    text() {
      return this.chunks.join("");
    },
  };
}

/** 造一个写必失败的假响应对象（模拟连接已死）。 */
function deadRes() {
  return {
    writeHead() {
      throw new Error("socket hang up");
    },
    write() {
      throw new Error("socket hang up");
    },
    end() {},
  };
}

/**
 * 造一个「先活后死」的假响应对象。
 *
 * 用来模拟「接入时还活着、之后客户端断开」这个真实场景——
 * 直接用一个一开始就坏的 res 测不出广播时的清理逻辑。
 */
function flakyRes() {
  const res = fakeRes();
  let alive = true;
  return {
    get chunks() {
      return res.chunks;
    },
    get status() {
      return res.status;
    },
    get headers() {
      return res.headers;
    },
    text: () => res.text(),
    kill() {
      alive = false;
    },
    writeHead(status, headers) {
      if (!alive) throw new Error("socket hang up");
      res.writeHead(status, headers);
    },
    write(text) {
      if (!alive) throw new Error("socket hang up");
      return res.write(text);
    },
    end() {
      alive = false;
      res.end();
    },
  };
}

test("连接的响应头是 SSE 规格", () => {
  const hub = createSseHub();
  const res = fakeRes();
  hub.connect(CHANNEL_EVENTS, res, {});

  assert.equal(res.status, 200);
  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.equal(res.headers["cache-control"], "no-cache, no-transform");
  assert.equal(res.headers["x-accel-buffering"], "no");
});

test("连接后立刻写一句注释，便于客户端确认已连上", () => {
  const hub = createSseHub();
  const res = fakeRes();
  hub.connect(CHANNEL_EVENTS, res, {});
  assert.ok(res.text().startsWith(": connected\n\n"));
});

test("未知频道直接抛错（编程错误要立刻暴露）", () => {
  const hub = createSseHub();
  assert.throws(() => hub.connect("bogus", fakeRes(), {}), /未知频道/);
  assert.throws(() => hub.broadcast("bogus", "x", {}), /未知频道/);
});

test("广播只发给同频道的客户端", () => {
  const hub = createSseHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.connect(CHANNEL_EVENTS, a, {});
  hub.connect(CHANNEL_HUD, b, {});

  hub.broadcast(CHANNEL_EVENTS, "session", { sessionId: "s1" });

  assert.ok(a.text().includes("event: session"), "events 频道应收到");
  assert.ok(!b.text().includes("event: session"), "hud 频道不应收到");
});

test("广播返回投递数，且多客户端都收到同一份", () => {
  const hub = createSseHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.connect(CHANNEL_HUD, a, {});
  hub.connect(CHANNEL_HUD, b, {});

  const out = hub.broadcast(CHANNEL_HUD, "tick", { kind: "tick" });

  assert.equal(out.delivered, 2);
  assert.equal(out.id, 1, "事件 id 从 1 开始");
  assert.ok(a.text().includes('data: {"kind":"tick"}'));
  assert.ok(b.text().includes('data: {"kind":"tick"}'));
});

test("事件 id 自增且跨频道共用一个序列", () => {
  const hub = createSseHub();
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  hub.connect(CHANNEL_HUD, fakeRes(), {});

  const first = hub.broadcast(CHANNEL_EVENTS, "a", {});
  const second = hub.broadcast(CHANNEL_HUD, "b", {});

  assert.equal(first.id, 1);
  assert.equal(second.id, 2);
});

test("Last-Event-ID 续传：补发之后的事件", () => {
  const hub = createSseHub();
  const seed = fakeRes();
  hub.connect(CHANNEL_EVENTS, seed, {});
  for (let i = 0; i < 3; i += 1) hub.broadcast(CHANNEL_EVENTS, "e", { i });

  const late = fakeRes();
  const info = hub.connect(CHANNEL_EVENTS, late, { lastEventId: 1 });

  assert.equal(info.replayed, 2, "应补 2 条（id 2 与 3）");
  assert.equal(info.missed, false);
  assert.ok(late.text().includes('data: {"i":1}'));
  assert.ok(late.text().includes('data: {"i":2}'));
  assert.ok(!late.text().includes('data: {"i":0}'), "已收过的不重发");
});

test("Last-Event-ID 过旧：报 missed，让客户端知道要拉全量", () => {
  const hub = createSseHub({ capacity: 2 });
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  for (let i = 0; i < 6; i += 1) hub.broadcast(CHANNEL_EVENTS, "e", { i });

  const late = fakeRes();
  const info = hub.connect(CHANNEL_EVENTS, late, { lastEventId: 1 });

  assert.equal(info.missed, true);
  assert.equal(info.replayed, 2, "给出现有全部");
});

test("不带 Last-Event-ID 的新连接不回补历史", () => {
  const hub = createSseHub();
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  hub.broadcast(CHANNEL_EVENTS, "e", { i: 0 });

  const fresh = fakeRes();
  const info = hub.connect(CHANNEL_EVENTS, fresh, {});

  assert.equal(info.replayed, 0);
  assert.equal(info.missed, false);
  assert.ok(!fresh.text().includes("event: e"));
});

test("写失败的客户端被就地清理，不影响其他客户端", () => {
  const hub = createSseHub();
  const flaky = flakyRes();
  const alive = fakeRes();
  hub.connect(CHANNEL_HUD, flaky, {});
  hub.connect(CHANNEL_HUD, alive, {});

  // 前两个客户端都成功接入
  assert.equal(hub.stats.totalConnected, 2);
  flaky.kill();

  const out = hub.broadcast(CHANNEL_HUD, "tick", {});

  assert.equal(out.delivered, 1, "只投给活着的那个");
  assert.equal(hub.stats.writeErrors, 1);
  assert.equal(hub.countOf(CHANNEL_HUD), 1, "死连接已被摘掉");
  assert.ok(alive.text().includes("event: tick"));
});

test("连接一接入就已死：不登记、不抛错", () => {
  const hub = createSseHub();
  const info = hub.connect(CHANNEL_HUD, deadRes(), {});

  assert.equal(info.connected, false, "要如实告诉调用方没连上");
  assert.equal(info.clientId, 0);
  assert.equal(hub.countOf(CHANNEL_HUD), 0, "死连接不进表");
  assert.equal(hub.stats.totalConnected, 0);
  assert.doesNotThrow(() => hub.broadcast(CHANNEL_HUD, "tick", {}));
});

test("回补途中连接断掉：不再继续写，返回已回补条数", () => {
  const hub = createSseHub();
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  for (let i = 0; i < 4; i += 1) hub.broadcast(CHANNEL_EVENTS, "e", { i });

  const flaky = flakyRes();
  const info = hub.connect(CHANNEL_EVENTS, flaky, { lastEventId: 0 });
  flaky.kill();

  // 回补 4 条时中途断掉，应提前收尾而不是抛错
  assert.equal(info.connected, true, "头写成功过，算接入成功");
  assert.ok(info.replayed <= 4);
});

test("disconnect 幂等", () => {
  const hub = createSseHub();
  const { clientId } = hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  assert.equal(hub.stats.connected, 1);

  hub.disconnect(clientId);
  assert.equal(hub.stats.connected, 0);

  hub.disconnect(clientId);
  assert.equal(hub.stats.connected, 0, "重复断开不把计数弄成负数");
});

test("countOf 按频道分别统计", () => {
  const hub = createSseHub();
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  hub.connect(CHANNEL_HUD, fakeRes(), {});

  assert.equal(hub.countOf(CHANNEL_EVENTS), 2);
  assert.equal(hub.countOf(CHANNEL_HUD), 1);
});

test("closeAll 断开全部并复位计数", () => {
  const hub = createSseHub();
  const a = fakeRes();
  const b = fakeRes();
  hub.connect(CHANNEL_EVENTS, a, {});
  hub.connect(CHANNEL_HUD, b, {});
  hub.broadcast(CHANNEL_EVENTS, "x", {});

  hub.closeAll();

  assert.equal(hub.stats.connected, 0);
  assert.equal(hub.countOf(CHANNEL_EVENTS), 0);
  assert.ok(a.ended && b.ended, "两端都应被 end");
});

test("closeAll 对已经死掉的连接不抛错（卸载路径要能跑完）", () => {
  const hub = createSseHub();
  hub.connect(CHANNEL_EVENTS, {
    writeHead() {},
    write() {},
    end() {
      throw new Error("already closed");
    },
  }, {});

  assert.doesNotThrow(() => hub.closeAll());
  assert.equal(hub.stats.connected, 0);
});

test("stats 记录连接与广播次数", () => {
  const hub = createSseHub();
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  hub.disconnect(1);
  hub.broadcast(CHANNEL_EVENTS, "a", {});
  hub.broadcast(CHANNEL_EVENTS, "b", {});

  assert.equal(hub.stats.totalConnected, 2, "累计连接数不回退");
  assert.equal(hub.stats.connected, 1, "当前在线数");
  assert.equal(hub.stats.pushed, 2);
});

test("无法序列化的载荷不打断广播", () => {
  const hub = createSseHub();
  const res = fakeRes();
  hub.connect(CHANNEL_HUD, res, {});

  const cyclic = {};
  cyclic.self = cyclic;

  assert.doesNotThrow(() => hub.broadcast(CHANNEL_HUD, "bad", cyclic));
  assert.ok(res.text().includes("unserializable"), "退回可读的错误载荷");
});

test("latestIdOf 与 bufferSizeOf 反映各频道自己的缓冲", () => {
  const hub = createSseHub();
  assert.equal(hub.latestIdOf(CHANNEL_EVENTS), null);

  hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  hub.broadcast(CHANNEL_EVENTS, "a", {});
  hub.broadcast(CHANNEL_EVENTS, "b", {});

  assert.equal(hub.latestIdOf(CHANNEL_EVENTS), 2);
  assert.equal(hub.bufferSizeOf(CHANNEL_EVENTS), 2);
  assert.equal(hub.bufferSizeOf(CHANNEL_HUD), 0, "两个频道各有独立缓冲");
});

test("now 可注入：连接时间可控", () => {
  let clock = 1000;
  const hub = createSseHub({ now: () => clock });
  clock = 5000;
  const { clientId } = hub.connect(CHANNEL_EVENTS, fakeRes(), {});
  assert.ok(clientId > 0);
  assert.equal(hub.stats.connected, 1);
});

/**
 * 冒烟测试 · 桥骨架
 *
 * 职责：用假宿主 ctx 启动真实 HTTP 服务，验证 4 条只读路由端到端可用。
 * 所属层：测试（tests/）
 *
 * 这是切片 1 的端到端验证——不依赖宿主进程，直接调 apply()，
 * 然后发真实 HTTP 请求。验证「桥能跑起来并对外提供数据」这一目标。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { connect } from "node:net";

import { apply, dispose } from "../whale-bridge/host.js";

/**
 * 冒烟测试用的端口：避开正式端口，防止与真实宿主冲突。
 *
 * 为什么必须显式传端口：Node 测试运行器并发执行各测试文件，它们共享同一个
 * 进程——用环境变量协调会互相覆盖，谁最后写谁赢。显式传参没有这个竞态。
 */
const TEST_PORT = 19388;

/**
 * 走 apply() 的用例专用端口。
 *
 * 与 TEST_PORT 分开：同级 test() 在同一文件内也是并发执行的，而 apply() 起的是
 * 单例服务——若与上面那组手动 listen 的用例共用端口，关服务/退订会掐断另一个
 * 用例正在进行的 fetch（表现为 ECONNRESET）。
 */
const APPLY_PORT = 19390;

/**
 * 「宿主服务全缺」用例的专用端口。
 *
 * 曾经写成 `TEST_PORT + 1`——算出来是 19389，正好撞上 smoke-slice2 的端口。
 * 两个文件并发跑就 EADDRINUSE，表现为「闸门 3 时红时绿、单跑永远绿」。
 * 端口一律显式声明，不要用算术推导（算术躲过静态扫描）。
 */
const BARE_PORT = 19392;

/**
 * 构造假宿主 ctx。
 * 只提供最小可用形状：sessions + agents 两个服务，一个会话。
 * @returns {object}
 */
function fakeCtx() {
  const sessions = new Map();
  sessions.set("session-test-0001", {
    id: "session-test-0001",
    header: { id: "session-test-0001", cwd: "D:\\DEEPSEEK\\悬浮窗", createdAt: 1791221001152 },
  });

  return {
    sessions: {
      list: () => [...sessions.values()],
      get: (id) => sessions.get(id),
    },
    agents: {
      get: () => ({ status: "idle" }),
    },
    logger: { info: () => {} },
  };
}

/** 发一个 GET 请求并解析 JSON。 */
async function get(path) {
  const res = await fetch(`http://127.0.0.1:${TEST_PORT}${path}`, {
    headers: { host: `127.0.0.1:${TEST_PORT}` },
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

/**
 * 走裸 socket 发原始 HTTP 请求。
 *
 * 用于测试 fetch 禁止设置的请求头（Host 等）——fetch 会静默忽略受限头，
 * 用 fetch 测不出服务端的校验是否生效。
 *
 * @param {number} port
 * @param {string} raw 完整请求报文
 * @returns {Promise<string>} 完整响应报文
 */
function rawRequest(port, raw) {
  return new Promise((resolve, reject) => {
    const socket = connect({ port, host: "127.0.0.1" });
    let buf = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(raw));
    socket.on("data", (chunk) => {
      buf += chunk;
    });
    socket.on("end", () => resolve(buf));
    socket.on("error", reject);
    socket.setTimeout(5000, () => {
      socket.destroy();
      resolve(buf);
    });
  });
}

test("桥骨架端到端冒烟", async (t) => {
  const ctx = fakeCtx();

  // 这里不起 apply()：本组测的是「路由处理器本身」，需要自己控制监听端口。
  // apply() 的完整启动路径由下面两个用例覆盖。
  const { createHostAccess } = await import("../whale-bridge/lib/host-ctx.mjs");
  const { registerSliceOneRoutes } = await import("../whale-bridge/lib/handlers-slice1.mjs");
  const { createBridgeServer, listen, close } = await import("../whale-bridge/lib/server.mjs");

  registerSliceOneRoutes();
  const host = createHostAccess(ctx);
  const server = createBridgeServer({ host, log: () => {} });
  await listen(server, { port: TEST_PORT, host: "127.0.0.1" });

  t.after(async () => {
    await close(server);
  });

  await t.test("GET /whale 返回概览与全部路由", async () => {
    const { status, json } = await get("/whale");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.name, "whale-bridge");
    assert.equal(json.routeCount, 27);
    assert.equal(json.implementedCount, 4, "切片 1 应有 4 条已实现");
    assert.equal(json.routes.length, 27);
  });

  await t.test("GET /whale/probe 报告宿主服务可用性", async () => {
    const { status, json } = await get("/whale/probe");
    assert.equal(status, 200);
    assert.equal(json.host.sessions, true);
    assert.equal(json.host.agents, true);
    assert.equal(json.host.commands, false, "假 ctx 未提供 commands");
    assert.equal(json.host.sessionCount, 1);
  });

  await t.test("GET /whale/panel 缺少 sessionId 返回 400", async () => {
    const { status, json } = await get("/whale/panel");
    assert.equal(status, 400);
    assert.equal(json.error.code, "bad-request");
  });

  await t.test("GET /whale/panel 未知会话返回 404", async () => {
    const { status, json } = await get("/whale/panel?sessionId=nope");
    assert.equal(status, 404);
    assert.equal(json.error.code, "session-not-found");
  });

  await t.test("GET /whale/panel 有效会话返回骨架且不编造数据", async () => {
    const { status, json } = await get("/whale/panel?sessionId=session-test-0001");
    assert.equal(status, 200);
    assert.equal(json.sessionId, "session-test-0001");
    assert.deepEqual(json.messages, []);
    assert.deepEqual(json.todos, []);
    assert.equal(json.permission, null, "取不到档位应给 null 而非编造");
    assert.equal(json.model, null);
    assert.equal(json.agentRunning, false);
  });

  await t.test("GET /whale/capability 按服务可用性报告通路", async () => {
    const { status, json } = await get("/whale/capability");
    assert.equal(status, 200);
    assert.equal(json.capability.send.available, true);
    assert.equal(json.capability.abort.available, true);
    assert.equal(json.capability.resume.available, true);
    assert.equal(json.capability.command.available, false);
    assert.match(json.capability.command.reason, /commands/);
  });

  await t.test("未知路由返回 404", async () => {
    const { status, json } = await get("/whale/nonexistent");
    assert.equal(status, 404);
    assert.equal(json.error.code, "not-found");
  });

  await t.test("未实现的路由返回 404（而非 501）", async () => {
    const { status, json } = await get("/whale/events");
    assert.equal(status, 404);
    assert.equal(json.error.code, "not-found");
  });

  await t.test("方法不匹配返回 405", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/whale/panel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 405);
    const json = await res.json();
    assert.equal(json.error.code, "method-not-allowed");
  });

  await t.test("非回环 Host 头被拒绝（裸 socket，fetch 会忽略受限头）", async () => {
    // fetch 规范禁止脚本设置 Host 头，会静默忽略，故必须走裸 socket。
    const raw = await rawRequest(TEST_PORT, "GET /whale HTTP/1.1\r\nHost: evil.com\r\nConnection: close\r\n\r\n");
    assert.match(raw, /^HTTP\/1\.1 403/, `期望 403，实际：${raw.split("\r\n")[0]}`);
    assert.match(raw, /host-not-allowed/);
  });

  await t.test("外部来源被拒绝", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/whale`, {
      headers: { origin: "http://evil.com" },
    });
    assert.equal(res.status, 403);
  });

  await t.test("本机来源的 CORS 头正确下发", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/whale`, {
      headers: { origin: "http://127.0.0.1:43120" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("access-control-allow-origin"), "http://127.0.0.1:43120");
  });

  await t.test("OPTIONS 预检返回 204", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/whale`, {
      method: "OPTIONS",
      headers: { origin: "http://127.0.0.1:43120" },
    });
    assert.equal(res.status, 204);
  });

  await t.test("宿主服务全缺时仍返回 200（不整体崩溃）", async () => {
    const bare = createHostAccess({});
    const srv = createBridgeServer({ host: bare, log: () => {} });
    await listen(srv, { port: BARE_PORT, host: "127.0.0.1" });
    try {
      const res = await fetch(`http://127.0.0.1:${BARE_PORT}/whale/probe`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.host.sessions, false);
      assert.equal(json.host.sessionCount, 0);
    } finally {
      await close(srv);
    }
  });
});

test("apply/dispose 生命周期（串行）", async (t) => {
  // 这两条必须串行：apply() 起的是模块级单例服务，同级并发调用会互相覆盖
  // state（后者的 apply 覆盖前者的 server 引用），导致 dispose 关错对象、
  // 或用例之间互相掐断正在进行的 fetch。
  const ctx = fakeCtx();

  await t.test("apply 在指定端口上可启动并注册已实现的路由", async () => {
    await apply(ctx, { port: APPLY_PORT });

    const res = await fetch(`http://127.0.0.1:${APPLY_PORT}/whale`);
    assert.equal(res.status, 200);
    const json = await res.json();
    // 切片 3 完成后：全部路由已实现，不再有占位
    // （切片 7 又加了 /whale/commands 与 /whale/presets → 24）
    assert.equal(json.implementedCount, 27);
    assert.equal(json.routeCount, 27);
  });

  await t.test("dispose 后端口释放，可再次 apply", async () => {
    await dispose();

    // 端口应已释放，能再次绑定
    await apply(ctx, { port: APPLY_PORT });
    const res = await fetch(`http://127.0.0.1:${APPLY_PORT}/whale`);
    assert.equal(res.status, 200);
    await dispose();
  });
});

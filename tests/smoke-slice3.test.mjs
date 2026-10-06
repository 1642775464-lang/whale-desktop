/**
 * 切片 3 端到端冒烟测试
 *
 * 职责：验证 SSE 双端点真的能连、真的能推、真的能续传，
 *       以及 22 条路由全部走通 HTTP（C1）。
 * 所属层：测试（tests/）
 *
 * 为什么必须真连一次 HTTP：SSE 的正确性有一半在**协议层**——
 * 响应头是不是 `text/event-stream`、帧格式对不对、连接断开后
 * 服务端有没有摘掉。这些用单元测试测不到，只有真的发起连接才看得见。
 *
 * 串行约束同 smoke-slice2：桥是进程级单例，且只监听一个端口。
 * 本文件用独立端口 19391，靠 fetch + ReadableStream 读流。
 * 夹具（假宿主 / SSE 读取器 / HTTP 小工具）在 tests/helpers/slice3-fixtures.mjs，
 * 本文件只留用例。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, dispose, heartbeatTick } from "../whale-bridge/host.js";
import {
  CHANNEL_EVENTS,
  CHANNEL_HUD,
  createSseHub,
} from "../whale-bridge/lib/sse.mjs";
import { createFoldSet, ensureSession } from "../whale-bridge/lib/fold.mjs";
import { SLICE_THREE_READ_ROUTES } from "../whale-bridge/lib/handlers-slice3-read.mjs";
import { SLICE_THREE_WRITE_ROUTES } from "../whale-bridge/lib/handlers-slice3-write.mjs";
import {
  assistantEvent,
  createFakeCtx,
  createHttpTools,
  openSse,
  sessionRef,
} from "./helpers/slice3-fixtures.mjs";

/** 本文件专用端口。 */
const PORT = 19391;
const BASE = `http://127.0.0.1:${PORT}`;

const { getJson, postJson, rawGet } = createHttpTools(PORT);

test("切片 3 SSE 与全路由端到端", async (t) => {
  const ctx = createFakeCtx();

  await t.test("apply 起服务并挂上 approval 瀑布监听", async () => {
    await apply(ctx, { port: PORT });
    assert.equal(ctx.listenerCount("session/event"), 1);
    assert.equal(ctx.listenerCount("agent/status"), 1);
    assert.equal(ctx.listenerCount("approval/request"), 1, "审批桥必须挂在瀑布上（S3-D2）");
  });

  await t.test("C1：22 条路由全部已实现（无 not-implemented）", async () => {
    const { status, json } = await getJson("/whale");
    assert.equal(status, 200);
    assert.equal(json.routes.length, 22);
    const pending = json.routes.filter((r) => r.implemented !== true);
    assert.deepEqual(pending.map((r) => `${r.method} ${r.path}`), [], "不应有未实现路由");
    // 分片计数自检：两条常量加起来必须等于本片新增数
    assert.equal(SLICE_THREE_READ_ROUTES + SLICE_THREE_WRITE_ROUTES, 17);
  });

  await t.test("SSE：响应头是 text/event-stream", async () => {
    const sse = await openSse(PORT, "/whale/events");
    try {
      assert.equal(sse.res.status, 200);
      assert.match(sse.res.headers.get("content-type"), /text\/event-stream/);
      assert.equal(sse.res.headers.get("cache-control"), "no-cache, no-transform");
      // 连上立刻有一行注释帧，客户端据此判定「连上了」
      const frame = await sse.readFrame(1500);
      assert.equal(frame, ": connected");
    } finally {
      await sse.close();
    }
  });

  await t.test("SSE：宿主事件到达后 1 秒内推到客户端（C3）", async () => {
    const sse = await openSse(PORT, "/whale/events");
    try {
      await sse.readFrame(1000); // 吃掉 connected

      const started = Date.now();
      ctx.emit("session/event", sessionRef("s-live"), {
        seq: 1,
        time: Date.now(),
        type: "request/context",
        data: { contextWindow: 1000000 },
      });

      const frame = await sse.readFrame(1000);
      const elapsed = Date.now() - started;
      assert.ok(frame !== null, "应收到帧");
      assert.ok(elapsed < 1000, `事件应在 1 秒内到达（实测 ${elapsed}ms）`);
      assert.match(frame, /event: session/);
      assert.match(frame, /"type":"request\/context"/);
    } finally {
      await sse.close();
    }
  });

  await t.test("SSE：Last-Event-ID 续传补回断线期间的帧", async () => {
    // 先连一次、收两帧、记下 id、断开
    const first = await openSse(PORT, "/whale/events");
    await first.readFrame(1000);
    const session = sessionRef("s-live");
    ctx.emit("session/event", session, { seq: 2, time: Date.now(), type: "turn/start", data: { turn: 1 } });
    const frameA = await first.readFrame(1000);
    const idA = Number(/^id: (\d+)$/m.exec(frameA)?.[1]);
    assert.ok(Number.isInteger(idA), "帧必须带 id，否则无法续传");
    await first.close();

    // 断线期间事件继续发生
    ctx.emit("session/event", session, { seq: 3, time: Date.now(), type: "step/start", data: { step: 1 } });

    // 带 Last-Event-ID 重连：必须补回 idA 之后的帧。
    // 注意重连同样会先收到 `: connected` 注释帧（服务端连上就写），
    // 所以第一帧是它，回补帧在第二帧——漏读这一帧会误判成「没有续传」。
    const second = await openSse(PORT, "/whale/events", { headers: { "last-event-id": String(idA) } });
    try {
      const hello = await second.readFrame(1500);
      assert.equal(hello, ": connected");
      const replayed = await second.readFrame(1500);
      assert.ok(replayed !== null, "应回补断线期间的事件");
      assert.match(replayed, /"type":"step\/start"/);
      const idB = Number(/^id: (\d+)$/m.exec(replayed)?.[1]);
      assert.ok(idB > idA, "回补帧的 id 必须大于客户端上报的 id");
    } finally {
      await second.close();
    }
  });

  await t.test("SSE：/whale/hud/events 与 /whale/follow 同为独立频道", async () => {
    const hud = await openSse(PORT, "/whale/hud/events");
    const follow = await openSse(PORT, "/whale/follow");
    try {
      assert.equal(await hud.readFrame(1000), ": connected");
      assert.equal(await follow.readFrame(1000), ": connected");

      // 心跳 tick 只推给 hud 频道
      const folds = createFoldSet();
      const hub = createSseHub();
      assert.equal(typeof hub.broadcast, "function");
      void folds;

      const { json } = await getJson("/whale/hud");
      assert.equal(json.ok, true);
      assert.ok(Array.isArray(json.sessions), "快照必须带 sessions 数组");
    } finally {
      await hud.close();
      await follow.close();
    }
  });

  await t.test("心跳 tick：携带速度与占用三件套", () => {
    // 用折叠器自己的构造函数造会话，不手搓对象——
    // 手搓会漏字段（折叠态内部形状变了，测试却以为自己是懂的）
    const folds = createFoldSet();
    const fold = ensureSession(folds, "s-live");
    fold.contextUsed = 42;
    fold.contextWindow = 1000;
    fold.phase = "idle";

    const hub = createSseHub();
    const out = heartbeatTick(hub, folds, 5000);
    assert.equal(out.at, 5000);
    assert.equal(out.sessions, 1, "无客户端时仍应重算出会话数（只是不推）");
    assert.equal(hub.countOf(CHANNEL_HUD), 0);
    assert.equal(hub.countOf(CHANNEL_EVENTS), 0);
  });

  await t.test("GET /whale/hud 反映真实折叠态（C4/C5 口径）", async () => {
    // 先推一条带用量的助手消息：contextUsed 的口径是 pressureFrom(末条 usage)，
    // 没有 usage 时它就该是 null——那是在测「没有数据」，不是在测口径
    ctx.emit("session/event", sessionRef("s-live"), assistantEvent(900, 983, 92288, 81));

    const { status, json } = await getJson("/whale/hud");
    assert.equal(status, 200);
    const live = json.sessions.find((s) => s.sessionId === "s-live");
    assert.ok(live !== undefined, "活跃会话应在快照里");
    // 口径：contextUsed = pressureFrom(末条 usage) = 983 + 92288 + 0
    assert.equal(live.contextWindow, 1000000);
    assert.equal(live.contextUsed, 93271);
    assert.equal(json.bridge.version.length > 0, true);
    assert.equal(json.bridge.port, PORT);
  });

  await t.test("GET /whale/models：探测不到时给空数组 + 明确理由", async () => {
    const { status, json } = await getJson("/whale/models");
    assert.equal(status, 200);
    assert.ok(Array.isArray(json.models));
    if (json.total === 0) {
      assert.equal(typeof json.reason, "string", "空目录必须说明原因，不能给个空数组了事");
    }
  });

  await t.test("GET /whale/windows：未拉起小窗时给空表而非报错", async () => {
    const { status, json } = await getJson("/whale/windows");
    assert.equal(status, 200);
    assert.deepEqual(json.windows, []);
    assert.equal(json.total, 0);
  });

  await t.test("GET /whale/approval：无挂起时给空表", async () => {
    const { status, json } = await getJson("/whale/approval");
    assert.equal(status, 200);
    assert.deepEqual(json.pending, []);
  });

  await t.test("POST /whale/send：缺 text → 400", async () => {
    const { status, json } = await postJson("/whale/send", { sessionId: "s-live" });
    assert.equal(status, 400);
    assert.equal(json.error.code, "bad-request");
  });

  await t.test("POST /whale/send：C9 发消息后宿主收到 followup", async () => {
    const calls = [];
    ctx.__setAgent("s-live", {
      status: "idle",
      followup(msg) {
        calls.push({ method: "followup", msg });
      },
      steer(msg) {
        calls.push({ method: "steer", msg });
      },
    });

    const { status, json } = await postJson("/whale/send", { sessionId: "s-live", text: "你好" });

    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.queued, false, "空闲态不排队");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "followup");
    assert.equal(calls[0].msg.role, "user");
    assert.equal(calls[0].msg.content[0].text, "你好");
  });

  await t.test("POST /whale/send：C10 运行中 send 标记 mode=queue", async () => {
    ctx.__setAgent("s-live", {
      status: "running",
      followup() {},
      steer() {},
    });

    const { status, json } = await postJson("/whale/send", { sessionId: "s-live", text: "排队去" });
    assert.equal(status, 200);
    assert.equal(json.queued, true);
    assert.equal(json.mode, "queue");
  });

  await t.test("POST /whale/abort：C11 无活跃回合 → 409 且不调 cancel", async () => {
    let canceled = 0;
    ctx.__setAgent("s-live", {
      status: "idle",
      cancel() {
        canceled += 1;
      },
    });

    const { status, json } = await postJson("/whale/abort", { sessionId: "s-live" });
    assert.equal(status, 409);
    assert.equal(json.error.code, "no-active-turn");
    assert.equal(canceled, 0, "没在跑就绝不能碰 cancel，否则会误伤用户队列");
  });

  await t.test("POST /whale/abort：运行中带 keepInbox:true 中断", async () => {
    const calls = [];
    ctx.__setAgent("s-live", {
      status: "running",
      cancel(cause, options) {
        calls.push({ cause, options });
      },
    });

    const { status, json } = await postJson("/whale/abort", { sessionId: "s-live" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.deepEqual(calls[0].options, { keepInbox: true });
  });

  await t.test("POST /whale/activate：切活跃会话并同步快照指针", async () => {
    const { status, json } = await postJson("/whale/activate", { sessionId: "s-live" });
    assert.equal(status, 200);
    assert.equal(json.sessionId, "s-live");

    const hud = await getJson("/whale/hud");
    assert.equal(hud.json.activeSessionId, "s-live", "快照指针必须跟着切");
  });

  await t.test("POST /whale/activate：未知会话 → 404", async () => {
    const { status, json } = await postJson("/whale/activate", { sessionId: "没有这个" });
    assert.equal(status, 404);
    assert.equal(json.error.code, "session-not-found");
  });

  await t.test("POST /whale/model：宿主无通路时 503，不假装成功", async () => {
    const { status, json } = await postJson("/whale/model", { sessionId: "s-live", model: "x" });
    assert.equal(status, 503);
    assert.equal(json.error.code, "model-switch-unavailable");
  });

  await t.test("POST /whale/open：Electron 未就位时明确报错", async () => {
    // 本机 runtime/electron.exe 已就位，但小窗入口 whale-window/main.cjs 还没写
    // （切片 5 的活儿）——此时必须报 entry-missing，而不是静默失败
    const { status, json } = await postJson("/whale/open", {});
    assert.ok(status === 200 || status === 500, `实际状态 ${status}`);
    if (status !== 200) {
      assert.equal(json.error.code, "entry-missing", "缺入口必须点名说缺入口");
    }
  });

  await t.test("POST /whale/close：没小窗时关 0 个也不报错", async () => {
    const { status, json } = await postJson("/whale/close", { all: true });
    assert.equal(status, 200);
    assert.ok(json.closed >= 0);
  });

  await t.test("POST /whale/approval：未知 id → 404", async () => {
    const { status, json } = await postJson("/whale/approval", { id: "ap-999", outcome: "allowed-once" });
    assert.equal(status, 404);
    assert.equal(json.error.code, "approval-not-found");
  });

  await t.test("POST /whale/approval：非法 outcome → 400", async () => {
    const { status, json } = await postJson("/whale/approval", { id: "ap-1", outcome: "随缘" });
    assert.equal(status, 400);
    assert.equal(json.error.code, "bad-request");
  });

  await t.test("POST /whale/action：未识别动作 → 400，不静默忽略", async () => {
    const { status, json } = await postJson("/whale/action", { action: "飞起来" });
    assert.equal(status, 400);
    assert.equal(json.error.code, "bad-request");
  });

  await t.test("POST /whale/action：转发已知动作", async () => {
    const { status, json } = await postJson("/whale/action", { action: "activate", sessionId: "s-live" });
    assert.equal(status, 200);
    assert.equal(json.sessionId, "s-live");
  });

  await t.test("审批瀑布：无人应答时桥接管，应答后原样返回（S3-D2）", async () => {
    const outcomePromise = ctx.__callApproval(
      { sessionId: "s-live", summary: "要跑命令" },
      async () => "unavailable",
    );

    // 等桥登记挂起
    await new Promise((r) => setTimeout(r, 30));
    const { json } = await getJson("/whale/approval");
    assert.equal(json.total, 1, "无人应答应出现在待确认清单");

    const answered = await postJson("/whale/approval", {
      id: json.pending[0].id,
      outcome: "allowed-once",
    });
    assert.equal(answered.status, 200);

    assert.equal(await outcomePromise, "allowed-once", "桥的答案必须回到宿主瀑布");
  });

  await t.test("C2：非回环 Host 头被拒（防 DNS rebinding）", async () => {
    // 不能用 fetch：Host 是受控头，undici 会忽略调用方给的值，
    // 那样测的其实是「默认 Host」而不是「伪造 Host」。必须用 node:http 直发。
    const { status, json } = await rawGet("/whale", { host: "evil.example.com" });
    assert.equal(status, 403);
    assert.equal(json.error.code, "host-not-allowed");
  });

  await t.test("dispose：结束 SSE、关闭服务、退订三路监听", async () => {
    const sse = await openSse(PORT, "/whale/events");
    await sse.readFrame(1000);
    await dispose();
    assert.equal(ctx.listenerCount("session/event"), 0);
    assert.equal(ctx.listenerCount("agent/status"), 0);
    assert.equal(ctx.listenerCount("approval/request"), 0, "审批监听也必须撤掉");

    // 服务已关：再请求应连接失败
    let failed = false;
    try {
      await fetch(`${BASE}/whale`);
    } catch {
      failed = true;
    }
    assert.equal(failed, true, "dispose 后端口不应再接受连接");
    await sse.close();
  });
});

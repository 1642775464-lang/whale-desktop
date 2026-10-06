/**
 * 切片 2 端到端冒烟测试
 *
 * 职责：验证「宿主事件 → 折叠器 → /whale/fold」这条链路真的通。
 * 所属层：测试（tests/）
 *
 * 为什么这条测试重要：三个纯函数模块的单测再多，也只能证明「算得对」，
 * 不能证明「接上了」。本测试用假 ctx 把事件推进 apply 后的真实桥，
 * 再从 HTTP 端口读回来——覆盖的是接线本身。
 *
 * 为什么全部用例套在一个父测试里串行跑：桥是**进程级单例**
 * （host.js 的 state 只有一个服务、一个折叠集），而且只监听一个端口。
 * Node 测试运行器默认让同级 test() 并发执行，多个用例同时 apply() 必然
 * 抢端口、同时写同一个折叠集必然互相污染。串行不是妥协——被测对象本身
 * 就是串行的，测试必须照着它的真实约束来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, dispose } from "../whale-bridge/host.js";

/**
 * 本文件专用端口。
 *
 * 测试运行器并发执行各测试文件且共享一个进程——显式传参而不是设环境变量，
 * 环境变量会被别的测试文件覆盖。
 */
const PORT = 19389;

/** 假宿主 ctx：能 emit 事件，并暴露会话/agents/commands 服务。 */
function fakeCtx() {
  const listeners = new Map();
  return {
    sessions: {
      list: () => [],
      get: () => undefined,
    },
    agents: { get: () => undefined },
    commands: { list: () => [] },
    logger: { info: () => {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    /** 测试用：模拟宿主推一条事件 */
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    listenerCount: (event) => (listeners.get(event) ?? new Set()).size,
  };
}

/** 造一条 assistant/message 事件。 */
function assistantEvent(seq, inputTokens, cacheReadTokens, outputTokens = 10) {
  return {
    seq,
    time: 1000 + seq,
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: `第 ${seq} 条` }] },
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens },
    },
  };
}

/** 发 GET 并解析 JSON。 */
async function getJson(path) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return { status: res.status, json: await res.json() };
}

test("切片 2 事件接线端到端", async (t) => {
  // 所有子用例共享一个 ctx：单例桥在 dispose 后不得再被别的用例用到，
  // 因此把「退订」放到最后一条，其余用例在其之前依次执行。
  const ctx = fakeCtx();

  await t.test("apply 订阅了 session/event 与 agent/status", () => {
    const observed = { session: 0, agent: 0 };
    const disposeProbe = [
      ctx.on("session/event", () => {
        observed.session += 1;
      }),
      ctx.on("agent/status", () => {
        observed.agent += 1;
      }),
    ];
    // 探针只用来数：订阅本身由下面的 listenerCount 判定
    for (const off of disposeProbe) off();
    assert.equal(typeof ctx.on, "function", "假 ctx 具备 on()");
    assert.equal(typeof ctx.emit, "function", "假 ctx 具备 emit()");
  });

  await t.test("apply 后宿主侧有两路订阅", async () => {
    await apply(ctx, { port: PORT });
    assert.equal(ctx.listenerCount("session/event"), 1, "应订阅 session/event");
    assert.equal(ctx.listenerCount("agent/status"), 1, "应订阅 agent/status");
  });

  const session = { id: "session-e2e-1", header: { id: "session-e2e-1" } };

  await t.test("宿主事件经折叠器后可从 /whale/fold 读回", async () => {
    ctx.emit("session/event", session, {
      seq: 1,
      time: 1001,
      type: "request/context",
      data: { contextWindow: 1000000 },
    });
    ctx.emit("session/event", session, { seq: 2, time: 1002, type: "turn/start", data: { turn: 1 } });
    ctx.emit("session/event", session, { seq: 3, time: 1003, type: "step/start", data: { step: 1 } });
    ctx.emit("session/event", session, assistantEvent(4, 983, 92288, 81));

    const { status, json } = await getJson("/whale/fold?sessionId=session-e2e-1");
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.pipeline.eventsReceived, 4);
    assert.equal(json.pipeline.eventsAccepted, 4);

    const fold = json.fold;
    assert.equal(fold.sessionId, "session-e2e-1");
    assert.equal(fold.lastSeq, 4);
    assert.equal(fold.tailCount, 1, "assistant 文本进 tail");
    assert.equal(fold.tail[0].text, "第 4 条");
  });

  await t.test("折叠视图暴露水位、tail 与管线计数", async () => {
    const { json } = await getJson("/whale/fold?sessionId=session-e2e-1");
    const fold = json.fold;
    // 本路由的职责是「折叠器状态可观测」：水位 / tail / 计数。
    // 四桶累计与上下文占用属于 /whale/hud 的投影（切片 3），不在这里断言。
    assert.equal(fold.lastSeq, 4);
    assert.equal(fold.eventsSeen, 4);
    assert.equal(fold.tailLimit, 40);
    assert.equal(fold.tailCount, 1);
    assert.equal(fold.phase, "running");
    assert.equal(json.pipeline.eventsAccepted, 4);
  });

  await t.test("未知事件类型不打断链路，只计数", async () => {
    ctx.emit("session/event", session, { seq: 5, time: 1005, type: "完全没见过的事件", data: {} });

    const { status, json } = await getJson("/whale/fold?sessionId=session-e2e-1");
    // 关键：仍然是 200，没被未知类型打断
    assert.equal(status, 200);
    assert.equal(json.pipeline.eventsReceived, 5);
    assert.equal(json.pipeline.eventsSkipped, 1, "未知类型计入 skipped");
    assert.equal(json.fold.unknownTypes, 1);
  });

  await t.test("重复 seq 被去重，不推进水位", async () => {
    const before = await getJson("/whale/fold?sessionId=session-e2e-1");
    const lastSeqBefore = before.json.fold.lastSeq;
    const tailCountBefore = before.json.fold.tailCount;

    // 重放 seq 4（宿主 Last-Event-ID 续传时会这样）
    ctx.emit("session/event", session, assistantEvent(4, 983, 92288, 81));

    const after = await getJson("/whale/fold?sessionId=session-e2e-1");
    assert.equal(after.json.fold.lastSeq, lastSeqBefore, "水位不得被重复 seq 推进");
    assert.equal(after.json.fold.tailCount, tailCountBefore, "tail 不得重复追加");
  });

  await t.test("agent/status 推进 phase", async () => {
    ctx.emit("agent/status", { agent: { id: "session-e2e-1" }, status: "idle" });
    const { json } = await getJson("/whale/fold?sessionId=session-e2e-1");
    assert.equal(json.fold.phase, "idle");
  });

  await t.test("/whale/fold 未知会话返回 404 降级", async () => {
    const { status, json } = await getJson("/whale/fold?sessionId=不存在的会话");
    assert.equal(status, 404);
    assert.equal(json.error.code, "session-not-found");
  });

  await t.test("dispose 退订事件，宿主不再持桥的回调", async () => {
    await dispose();
    assert.equal(ctx.listenerCount("session/event"), 0, "dispose 后应无订阅");
    assert.equal(ctx.listenerCount("agent/status"), 0, "dispose 后应无订阅");
  });
});

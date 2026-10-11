/**
 * 双折叠器单测
 *
 * 职责：验证 seq 去重、tail 上限、未知类型容忍、phase 流转、快照口径。
 * 所属层：测试（tests/unit）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createFoldSet,
  createSessionFold,
  ensureSession,
  applyEvent,
  applyEvents,
} from "../../whale-bridge/lib/fold.mjs";

import {
  TAIL_LIMIT,
  snapshotOf,
  hudSnapshot,
  foldViewOf,
} from "../../whale-bridge/lib/fold-view.mjs";

const SID = "session-test-1";

/** 造一条 assistant/message 事件。 */
function assistantEvent(seq, { inputTokens = 100, outputTokens = 10, cacheReadTokens = 0 } = {}, text = "") {
  return {
    seq,
    time: 1000 + seq,
    type: "assistant/message",
    data: {
      usage: { inputTokens, outputTokens, cacheReadTokens },
      message: text.length === 0 ? { content: [] } : { role: "assistant", content: [{ type: "text", text }] },
    },
  };
}

test("TAIL_LIMIT 为 40", () => {
  assert.equal(TAIL_LIMIT, 40);
});

test("createSessionFold 初值合理", () => {
  const fold = createSessionFold(SID);
  assert.equal(fold.sessionId, SID);
  assert.equal(fold.lastSeq, -1);
  assert.equal(fold.contextUsed, null, "未收到 usage 时为 null，不是 0");
  assert.equal(fold.phase, "unknown");
  assert.deepEqual(fold.tail, []);
});

test("applyEvent 接受事件并推进水位", () => {
  const foldSet = createFoldSet();
  const r = applyEvent(foldSet, { seq: 5, type: "step/start", data: {} }, { sessionId: SID });
  assert.equal(r.accepted, true);
  assert.equal(foldSet.sessions.get(SID).lastSeq, 5);
});

test("applyEvent 按 seq 去重，重复事件被拒", () => {
  const foldSet = createFoldSet();
  applyEvent(foldSet, assistantEvent(10, { inputTokens: 100 }), { sessionId: SID });
  const again = applyEvent(foldSet, assistantEvent(10, { inputTokens: 100 }), { sessionId: SID });
  assert.equal(again.accepted, false);
  assert.equal(again.reason, "duplicate-seq");
  // 累计不应翻倍
  assert.equal(foldSet.sessions.get(SID).totals.totalInput, 100);
});

test("applyEvent 拒绝乱序回退的旧 seq", () => {
  const foldSet = createFoldSet();
  applyEvent(foldSet, assistantEvent(20, { inputTokens: 5 }), { sessionId: SID });
  const old = applyEvent(foldSet, assistantEvent(15, { inputTokens: 999 }), { sessionId: SID });
  assert.equal(old.accepted, false);
  assert.equal(foldSet.sessions.get(SID).totals.totalInput, 5);
});

test("applyEvent 对非对象事件返回 invalid-event", () => {
  const foldSet = createFoldSet();
  assert.equal(applyEvent(foldSet, null).accepted, false);
  assert.equal(applyEvent(foldSet, "x").reason, "invalid-event");
});

test("未知事件类型被跳过并计数，绝不抛错", () => {
  const foldSet = createFoldSet();
  const r = applyEvent(foldSet, { seq: 1, type: "brand/new/type", data: {} }, { sessionId: SID });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "unknown-type");
  const fold = foldSet.sessions.get(SID);
  assert.equal(fold.unknownTypes, 1);
  assert.equal(foldSet.unknownTypes, 1);
  // 水位仍应推进，避免同一条未知事件被反复拒绝
  assert.equal(fold.lastSeq, 1);
});

test("四桶按 assistant/message 累加", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      assistantEvent(1, { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 }),
      { seq: 2, type: "step/start", data: {} },
      assistantEvent(3, { inputTokens: 200, outputTokens: 20, cacheReadTokens: 2000 }),
    ],
    { sessionId: SID },
  );
  const fold = foldSet.sessions.get(SID);
  assert.equal(fold.totals.totalInput, 300);
  assert.equal(fold.totals.totalOutput, 30);
  assert.equal(fold.totals.totalCacheRead, 3000);
  assert.equal(fold.totals.totalCacheWrite, 0, "落盘无此字段，恒 0");
});

test("contextUsed 取最后一条 usage 的口径值", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      assistantEvent(1, { inputTokens: 1, cacheReadTokens: 1 }),
      assistantEvent(2, { inputTokens: 983, cacheReadTokens: 92288 }),
    ],
    { sessionId: SID },
  );
  assert.equal(foldSet.sessions.get(SID).contextUsed, 93271);
});

test("contextWindow 从 request/context 取", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      { seq: 1, type: "request/context", data: { contextWindow: 1000000 } },
      assistantEvent(2, { inputTokens: 10 }),
    ],
    { sessionId: SID },
  );
  assert.equal(foldSet.sessions.get(SID).contextWindow, 1000000);
});

test("steps 与 turns 分别计数", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      { seq: 1, type: "turn/start", data: { turn: 1 } },
      { seq: 2, type: "step/start", data: { step: 1 } },
      { seq: 3, type: "step/end", data: { step: 1 } },
      { seq: 4, type: "step/start", data: { step: 2 } },
    ],
    { sessionId: SID },
  );
  const fold = foldSet.sessions.get(SID);
  assert.equal(fold.turns, 1);
  assert.equal(fold.steps, 3);
});

test("phase 随 turn/start 与 turn/end 流转", () => {
  const foldSet = createFoldSet();
  applyEvents(foldSet, [{ seq: 1, type: "turn/start", data: { turn: 1 } }], { sessionId: SID });
  let fold = foldSet.sessions.get(SID);
  assert.equal(fold.phase, "running");
  assert.equal(fold.running, true);
  assert.equal(fold.frozen, false);

  applyEvents(foldSet, [{ seq: 2, type: "turn/end", data: { reason: { kind: "completed" } } }], {
    sessionId: SID,
  });
  fold = foldSet.sessions.get(SID);
  assert.equal(fold.phase, "idle");
  assert.equal(fold.running, false);
  assert.equal(fold.frozen, true, "回合结束即冻结");
});

test("新回合开始清空速度采样", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [assistantEvent(1, { outputTokens: 500 }), { seq: 2, type: "turn/end", data: {} }],
    { sessionId: SID, now: 1000 },
  );
  assert.equal(foldSet.sessions.get(SID).samples.length, 1);
  applyEvents(foldSet, [{ seq: 3, type: "turn/start", data: {} }], { sessionId: SID });
  assert.equal(foldSet.sessions.get(SID).samples.length, 0);
});

test("tail 保留上限 40，超出从头部丢弃", () => {
  const foldSet = createFoldSet();
  const events = [];
  for (let i = 1; i <= 60; i += 1) {
    events.push({
      seq: i,
      time: 1000 + i,
      type: "user/message",
      data: { content: [{ type: "text", text: `第 ${i} 条` }] },
    });
  }
  applyEvents(foldSet, events, { sessionId: SID });
  const fold = foldSet.sessions.get(SID);
  assert.equal(fold.tail.length, 40);
  assert.equal(fold.tail[0].text, "第 21 条", "应保留最近 40 条");
  assert.equal(fold.tail[39].text, "第 60 条");
});

test("user/message 进 tail", () => {
  const foldSet = createFoldSet();
  applyEvent(
    foldSet,
    { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "你好" }] } },
    { sessionId: SID },
  );
  const fold = foldSet.sessions.get(SID);
  assert.equal(fold.tail[0].kind, "user");
  assert.equal(fold.tail[0].text, "你好");
});

/*
 * 「真人说的话 vs 系统注入」的测试在 fold-injection.test.mjs
 * （本文件顶到 500 行上限后按职责拆出去：那一块是**来源甄别**，
 *   与折叠器的 seq 去重 / tail 容量 / phase 流转不是一回事）
 */

test("tool/call 与 tool/result **不进 tail**（界面不显示工具，别占显示位）", () => {
  /*
   * ⚠️ 用户报「为什么只展示一条消息？历史消息都没了」——实测那 40 条 tail 里
   * **38 条是 tool**，真正的对话（1 assistant + 1 user）被挤出去了。
   *
   * 呈现层明确不显示工具调用（用户要求「小窗不需要展示工具调用过程」），
   * 所以它们占着尾巴却不显示，等于把对话挤没了。尾巴是给用户看的，
   * 应当只放用户能看到的东西。
   */
  const foldSet = createFoldSet();
  const out = applyEvents(
    foldSet,
    [
      { seq: 1, type: "tool/call", data: { name: "pwsh" } },
      { seq: 2, type: "tool/result", data: { isError: false } },
    ],
    { sessionId: SID },
  );
  const fold = foldSet.sessions.get(SID);
  assert.equal(fold.tail.length, 0, "工具事件不该占消息尾巴");
  assert.equal(out.skipped, 0, "仍然被接受，只是不进 tail —— 不是「不认识的事件」");
});

test("对话消息仍然进 tail（工具不占位之后，对话才留得住）", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      { seq: 1, type: "tool/call", data: { name: "pwsh" } },
      { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "你好" }] } },
      { seq: 3, type: "tool/call", data: { name: "edit" } },
      { seq: 4, type: "assistant/message", data: { message: { content: [{ type: "text", text: "在的" }] } } },
    ],
    { sessionId: SID },
  );
  const fold = foldSet.sessions.get(SID);
  assert.deepEqual(fold.tail.map((t) => t.kind), ["user", "assistant"]);
  assert.deepEqual(fold.tail.map((t) => t.text), ["你好", "在的"]);
});

test("todo/write 进 tail", () => {
  const foldSet = createFoldSet();
  applyEvent(
    foldSet,
    { seq: 1, type: "todo/write", data: { todos: [{ content: "做A", status: "pending" }] } },
    { sessionId: SID },
  );
  const item = foldSet.sessions.get(SID).tail[0];
  assert.equal(item.kind, "todo");
  assert.equal(item.todos[0].content, "做A");
});

test("session/title 更新标题", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      { seq: 1, type: "session/title", data: { title: "从PRD与原型重新实施项目" } },
      { seq: 2, type: "session/title", data: { title: "新标题" } },
    ],
    { sessionId: SID },
  );
  assert.equal(foldSet.sessions.get(SID).title, "新标题");
});

test("snapshotOf 取不到时给 null 不给 0", () => {
  const foldSet = createFoldSet();
  ensureSession(foldSet, SID);
  const snap = snapshotOf(foldSet, SID, 5000);
  assert.equal(snap.contextUsed, null);
  assert.equal(snap.contextWindow, null);
  assert.equal(snap.lastUsageAt, null);
  assert.equal(snap.totalInput, 0, "累计量是真实 0，可以给 0");
});

test("snapshotOf 对未知会话返回 null", () => {
  assert.equal(snapshotOf(createFoldSet(), "nope", 0), null);
});

test("snapshotOf 的 running 与速度：运行中才报速度", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      { seq: 1, type: "turn/start", data: {} },
      assistantEvent(2, { outputTokens: 400 }),
    ],
    { sessionId: SID, now: 10_000 },
  );
  const snap = snapshotOf(foldSet, SID, 14_000);
  assert.equal(snap.speed.phase, "running");
  assert.equal(snap.speed.tokPerSec, 100, "400 token / 4 秒");
});

test("回合结束后速度报 0，累计数字不动", () => {
  const foldSet = createFoldSet();
  applyEvents(
    foldSet,
    [
      { seq: 1, type: "turn/start", data: {} },
      assistantEvent(2, { inputTokens: 100, outputTokens: 400 }),
      { seq: 3, type: "turn/end", data: {} },
    ],
    { sessionId: SID, now: 10_000 },
  );
  const snap = snapshotOf(foldSet, SID, 12_000);
  assert.equal(snap.speed.tokPerSec, 0, "静止时不假装能动");
  assert.equal(snap.speed.frozen, true);
  assert.equal(snap.totalOutput, 400, "累计不变");
  assert.equal(snap.totalInput, 100);
});

test("hudSnapshot 汇总桥元信息与会话列表", () => {
  const foldSet = createFoldSet();
  foldSet.activeSessionId = SID;
  applyEvent(foldSet, assistantEvent(1, { inputTokens: 7 }), { sessionId: SID });
  const hud = hudSnapshot(foldSet, { version: "0.2.0", port: 19387, startedAt: 1000, now: 3000 });
  assert.equal(hud.bridge.version, "0.2.0");
  assert.equal(hud.bridge.port, 19387);
  assert.equal(hud.bridge.uptimeMs, 2000);
  assert.equal(hud.sessions.length, 1);
  assert.equal(hud.activeSessionId, SID);
});

test("foldViewOf 暴露 tail 与水位", () => {
  const foldSet = createFoldSet();
  applyEvent(
    foldSet,
    { seq: 42, type: "user/message", data: { content: [{ type: "text", text: "hi" }] } },
    { sessionId: SID },
  );
  const view = foldViewOf(foldSet, SID);
  assert.equal(view.lastSeq, 42);
  assert.equal(view.tailLimit, 40);
  assert.equal(view.tailCount, 1);
  assert.equal(view.tail[0].text, "hi");
});

test("foldViewOf 对未知会话返回 null", () => {
  assert.equal(foldViewOf(createFoldSet(), "nope"), null);
});

test("foldViewOf 返回的是副本，外部改它不影响折叠态", () => {
  const foldSet = createFoldSet();
  applyEvent(
    foldSet,
    { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "a" }] } },
    { sessionId: SID },
  );
  const view = foldViewOf(foldSet, SID);
  view.tail.push({ kind: "user", text: "篡改", seq: 99 });
  assert.equal(foldSet.sessions.get(SID).tail.length, 1, "折叠态不应被外部改动");
});

test("applyEvents 统计接受与跳过数", () => {
  const foldSet = createFoldSet();
  const r = applyEvents(
    foldSet,
    [
      { seq: 1, type: "step/start", data: {} },
      { seq: 2, type: "unknown/a", data: {} },
      { seq: 3, type: "unknown/b", data: {} },
    ],
    { sessionId: SID },
  );
  assert.equal(r.accepted, 1);
  assert.equal(r.skipped, 2);
});

test("多会话互不干扰", () => {
  const foldSet = createFoldSet();
  applyEvents(foldSet, [assistantEvent(1, { inputTokens: 100 })], { sessionId: "s1" });
  applyEvents(foldSet, [assistantEvent(1, { inputTokens: 999 })], { sessionId: "s2" });
  assert.equal(foldSet.sessions.get("s1").totals.totalInput, 100);
  assert.equal(foldSet.sessions.get("s2").totals.totalInput, 999);
});

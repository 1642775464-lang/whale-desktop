/**
 * panel-data 单测
 *
 * 纯投影函数，用构造好的折叠态驱动，不起网络。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { messagesOf, panelPayload, todosOf } from "../../whale-bridge/lib/panel-data.mjs";

/** 造一个最小折叠态。 */
function foldOf(tail) {
  return { sessionId: "s1", title: "标题", workspace: "D:\\x", tail, phase: "idle" };
}

/** 造折叠集。 */
function setOf(fold) {
  return { sessions: new Map([[fold.sessionId, fold]]), activeSessionId: "s1", unknownTypes: 0 };
}

test("panelPayload：会话不在折叠器里返回 null", () => {
  const foldSet = setOf(foldOf([]));
  assert.equal(panelPayload({ foldSet, sessionId: "nope" }), null);
});

test("panelPayload：基础字段来自折叠态", () => {
  const fold = foldOf([]);
  const out = panelPayload({ foldSet: setOf(fold), sessionId: "s1" });

  assert.equal(out.sessionId, "s1");
  assert.equal(out.title, "标题");
  assert.equal(out.workspace, "D:\\x");
  assert.equal(out.phase, "idle");
});

test("panelPayload：档位取不到给 null 而不是猜", () => {
  const out = panelPayload({ foldSet: setOf(foldOf([])), sessionId: "s1" });
  assert.equal(out.permission, null);
  assert.equal(out.model, null);
});

test("panelPayload：档位可由调用方注入", () => {
  const out = panelPayload({
    foldSet: setOf(foldOf([])),
    sessionId: "s1",
    gates: { permission: "ask", model: "m1" },
  });
  assert.equal(out.permission, "ask");
  assert.equal(out.model, "m1");
});

test("panelPayload：agentRunning 跟随 agent 状态", () => {
  const running = panelPayload({
    foldSet: setOf(foldOf([])),
    sessionId: "s1",
    agent: { status: "running" },
  });
  const idle = panelPayload({
    foldSet: setOf(foldOf([])),
    sessionId: "s1",
    agent: { status: "idle" },
  });
  assert.equal(running.agentRunning, true);
  assert.equal(idle.agentRunning, false);
});

test("messagesOf：用户与助手消息各成一条", () => {
  const out = messagesOf(foldOf([
    { kind: "user", text: "你好", seq: 1 },
    { kind: "assistant", text: "在的", seq: 2 },
  ]));

  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { kind: "user", text: "你好", seq: 1 });
  assert.deepEqual(out[1], { kind: "assistant", text: "在的", seq: 2 });
});

test("messagesOf：空文本消息被跳过（纯工具占位）", () => {
  const out = messagesOf(foldOf([
    { kind: "assistant", text: "", seq: 1 },
    { kind: "user", text: "有内容", seq: 2 },
  ]));
  assert.equal(out.length, 1);
  assert.equal(out[0].text, "有内容");
});

test("messagesOf：工具调用保留名字与状态", () => {
  const out = messagesOf(foldOf([
    { kind: "tool", name: "pwsh", state: "running", seq: 5 },
    { kind: "tool", name: "read", state: "done", seq: 6 },
  ]));

  assert.deepEqual(out[0], { kind: "tool", name: "pwsh", state: "running", seq: 5 });
  assert.deepEqual(out[1], { kind: "tool", name: "read", state: "done", seq: 6 });
});

test("messagesOf：工具缺字段时给安全默认值", () => {
  const out = messagesOf(foldOf([{ kind: "tool", seq: 1 }]));
  assert.equal(out[0].name, null);
  assert.equal(out[0].state, "done");
});

test("messagesOf：todo 不属于消息流", () => {
  const out = messagesOf(foldOf([{ kind: "todo", todos: [], seq: 1 }]));
  assert.deepEqual(out, []);
});

test("messagesOf：脏元素被跳过而不是抛错", () => {
  const out = messagesOf(foldOf([
    null,
    "string",
    42,
    { kind: "user", text: "好", seq: 1 },
  ]));
  assert.equal(out.length, 1);
});

test("todosOf：取最近一次 todo/write（整体覆盖语义）", () => {
  const out = todosOf(foldOf([
    { kind: "todo", todos: [{ content: "旧的", status: "pending" }], seq: 1 },
    { kind: "user", text: "x", seq: 2 },
    { kind: "todo", todos: [{ content: "新的", status: "completed" }], seq: 3 },
  ]));

  assert.equal(out.length, 1);
  assert.equal(out[0].content, "新的");
  assert.equal(out[0].status, "completed");
});

test("todosOf：没有 todo 事件返回空数组", () => {
  assert.deepEqual(todosOf(foldOf([{ kind: "user", text: "x", seq: 1 }])), []);
});

test("todosOf：条目缺字段时给安全默认值", () => {
  const out = todosOf(foldOf([{ kind: "todo", todos: [{}, { content: "有" }], seq: 1 }]));
  assert.equal(out[0].content, "");
  assert.equal(out[0].status, "pending");
  assert.equal(out[1].content, "有");
  assert.equal(out[1].status, "pending");
});

test("todosOf：todos 字段不是数组时返回空", () => {
  const out = todosOf(foldOf([{ kind: "todo", todos: "坏数据", seq: 1 }]));
  assert.deepEqual(out, []);
});

/**
 * host-actions 单测
 *
 * 用假的 host 封装驱动，重点验证**与宿主通路的对齐**——
 * 尤其是 cancel 的 keepInbox、steer 的运行态守卫、send 的排队语义。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHostActions, textContent } from "../../whale-bridge/lib/host-actions.mjs";

/** 造一个录音的假 agent。 */
function fakeAgent(status = "idle") {
  const calls = [];
  return {
    status,
    calls,
    followup(msg) {
      calls.push({ method: "followup", msg });
    },
    steer(msg) {
      calls.push({ method: "steer", msg });
    },
    cancel(cause, options) {
      calls.push({ method: "cancel", cause, options });
    },
  };
}

/** 造一个假 host 封装。 */
function fakeHost({ agent, attachments, commands, sessions } = {}) {
  return {
    getAgent: () => agent,
    getSession: () => ({ id: "s1" }),
    attachments,
    commands,
    sessions,
    raw: {},
  };
}

test("send：缺 sessionId 返回 bad-request", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.send({ text: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad-request");
});

test("send：缺 text 返回 bad-request", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.send({ sessionId: "s1" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad-request");
});

test("send：agent 不可用返回 session-not-found", () => {
  const actions = createHostActions({ host: fakeHost({ agent: undefined }) });
  const out = actions.send({ sessionId: "s1", text: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "session-not-found");
});

test("send：空闲态走 followup 且不排队", () => {
  const agent = fakeAgent("idle");
  const actions = createHostActions({ host: fakeHost({ agent }) });

  const out = actions.send({ sessionId: "s1", text: "hi" });

  assert.equal(out.ok, true);
  assert.equal(out.queued, false);
  assert.equal(out.mode, "queue");
  assert.equal(agent.calls[0].method, "followup");
});

test("send：运行中默认走 followup 并标记排队（S3-D1）", () => {
  const agent = fakeAgent("running");
  const actions = createHostActions({ host: fakeHost({ agent }) });

  const out = actions.send({ sessionId: "s1", text: "hi" });

  assert.equal(out.ok, true);
  assert.equal(out.queued, true, "运行中的 followup 等于排队下一回合");
  assert.equal(agent.calls[0].method, "followup");
});

test("send：运行中显式 steer 走 steer 且不排队", () => {
  const agent = fakeAgent("running");
  const actions = createHostActions({ host: fakeHost({ agent }) });

  const out = actions.send({ sessionId: "s1", text: "hi", mode: "steer" });

  assert.equal(out.ok, true);
  assert.equal(out.queued, false);
  assert.equal(out.mode, "steer");
  assert.equal(agent.calls[0].method, "steer");
});

test("send：空闲态 steer 被守卫拒绝（对齐宿主 session/steer-unavailable）", () => {
  const agent = fakeAgent("idle");
  const actions = createHostActions({ host: fakeHost({ agent }) });

  const out = actions.send({ sessionId: "s1", text: "hi", mode: "steer" });

  assert.equal(out.ok, false);
  assert.equal(out.code, "session/steer-unavailable");
  assert.equal(agent.calls.length, 0, "被拒绝就不该调宿主");
});

test("send：消息形状对齐 createUserMessage（role/content/source）", () => {
  const agent = fakeAgent("idle");
  const actions = createHostActions({ host: fakeHost({ agent }) });

  actions.send({ sessionId: "s1", text: "hi" });
  const msg = agent.calls[0].msg;

  assert.equal(msg.role, "user");
  assert.deepEqual(msg.content, [{ type: "text", text: "hi" }]);
  assert.equal(typeof msg.id, "string");
  assert.ok(msg.source.kind);
});

test("send：纯文本不走 admission（它是 async，且纯文本本就不需要）", () => {
  // 宿主的 admitPromptContent 是 **async**（dsh-attachment/lib/index.js:242）。
  // 曾经桥同步调用它、把返回的 Promise 当内容块数组塞进消息 ——
  // 宿主 session.append 做 snapshotJsonValue 时遇到 Promise 返回 undefined，
  // 抛 `carries non-JSON-serializable data`，发一条消息就 500。
  //
  // 而且宿主注释写明：没有 image 部分的 prompt "performs no storage operation"，
  // 纯文本根本不需要 admission。所以这里断言**不调用**它。
  const agent = fakeAgent("idle");
  let admitted = false;
  const host = fakeHost({
    agent,
    attachments: {
      async admitPromptContent(content) {
        admitted = true;
        return content;
      },
    },
  });
  const actions = createHostActions({ host });

  const out = actions.send({ sessionId: "s1", text: "hi" });

  assert.equal(out.ok, true);
  assert.equal(admitted, false, "纯文本不该走 admission（它返回 Promise，会污染消息）");
  // 内容块是同步可用的数组，不是 Promise
  assert.ok(Array.isArray(agent.calls[0].msg.content));
  assert.equal(agent.calls[0].msg.content[0].text, "hi");
});

test("send：消息内容必须可 JSON 序列化（宿主会强制校验）", () => {
  // 宿主 session.append → snapshotJsonValue(data)，不可序列化就直接抛。
  // 这条是那次 500 的最小复现防线：断言 content 绝不是 Promise。
  const agent = fakeAgent("idle");
  const actions = createHostActions({ host: fakeHost({ agent }) });
  actions.send({ sessionId: "s1", text: "hi" });

  const msg = agent.calls[0].msg;
  assert.equal(typeof msg.content.then, "undefined", "content 不能是 Promise");
  assert.doesNotThrow(() => JSON.stringify(msg), "整条消息必须能序列化");
  const parsed = JSON.parse(JSON.stringify(msg));
  assert.equal(parsed.content[0].text, "hi");
  assert.equal(parsed.role, "user");
});

test("send：admission 抛错时不影响发送（纯文本本就不走它）", () => {
  const agent = fakeAgent("idle");
  const host = fakeHost({
    agent,
    attachments: {
      admitPromptContent() {
        throw new Error("admission 炸了");
      },
    },
  });
  const actions = createHostActions({ host });

  const out = actions.send({ sessionId: "s1", text: "hi" });

  assert.equal(out.ok, true);
  assert.equal(agent.calls[0].msg.content[0].text, "hi");
});

test("send：agent 抛错被转成可读结果", () => {
  const agent = {
    status: "idle",
    followup() {
      throw Object.assign(new Error("队列满了"), { code: "queue-full" });
    },
  };
  const actions = createHostActions({ host: fakeHost({ agent }) });

  const out = actions.send({ sessionId: "s1", text: "hi" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "queue-full");
  assert.equal(out.message, "队列满了");
});

test("abort：必须带 keepInbox:true（对齐宿主自己的停止键）", () => {
  const agent = fakeAgent("running");
  const actions = createHostActions({ host: fakeHost({ agent }) });

  const out = actions.abort({ sessionId: "s1" });

  assert.equal(out.ok, true);
  const call = agent.calls[0];
  assert.equal(call.method, "cancel");
  assert.deepEqual(call.options, { keepInbox: true }, "不得清空用户的待发队列");
  assert.deepEqual(call.cause, { kind: "user" });
});

test("abort：无活跃回合返回 409 语义（C11 不误伤）", () => {
  const agent = fakeAgent("idle");
  const actions = createHostActions({ host: fakeHost({ agent }) });

  const out = actions.abort({ sessionId: "s1" });

  assert.equal(out.ok, false);
  assert.equal(out.code, "no-active-turn");
  assert.equal(out.status, 409);
  assert.equal(agent.calls.length, 0, "没在跑就不该调 cancel");
});

test("abort：缺 sessionId 返回 bad-request", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent("running") }) });
  assert.equal(actions.abort({}).code, "bad-request");
});

test("command：缺 commands 服务时明确报不可用", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.command({ sessionId: "s1", line: "/help" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "commands-unavailable");
});

test("command：同步返回结果", () => {
  const agent = fakeAgent();
  const host = fakeHost({ agent, commands: { execute: () => ({ text: "帮助内容" }) } });
  const actions = createHostActions({ host });

  const out = actions.command({ sessionId: "s1", line: "/help" });
  assert.equal(out.ok, true);
  assert.equal(out.result.text, "帮助内容");
});

test("command：异步返回结果", async () => {
  const agent = fakeAgent();
  const host = fakeHost({ agent, commands: { execute: async () => ({ text: "ok" }) } });
  const actions = createHostActions({ host });

  const out = await actions.command({ sessionId: "s1", line: "/help" });
  assert.equal(out.ok, true);
  assert.equal(out.result.text, "ok");
});

test("command：执行抛错被转成可读结果", async () => {
  const agent = fakeAgent();
  const host = fakeHost({
    agent,
    commands: {
      execute: async () => {
        throw new Error("命令不存在");
      },
    },
  });
  const actions = createHostActions({ host });

  const out = await actions.command({ sessionId: "s1", line: "/nope" });
  assert.equal(out.ok, false);
  assert.equal(out.message, "命令不存在");
});

test("activate：会话不存在时 session-not-found", () => {
  const actions = createHostActions({
    host: { getAgent: () => undefined, getSession: () => undefined, raw: {} },
  });
  assert.equal(actions.activate({ sessionId: "s1" }).code, "session-not-found");
});

test("activate：会话存在时返回 sessionId", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.activate({ sessionId: "s1" });
  assert.equal(out.ok, true);
  assert.equal(out.sessionId, "s1");
});

test("setModel：宿主没有通路时明确拒绝，不假装成功", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.setModel({ sessionId: "s1", model: "x" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "model-switch-unavailable");
});

test("resume：已加载的会话直接返回 loaded", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.resume({ sessionId: "s1" });
  assert.equal(out.ok, true);
  assert.equal(out.loaded, true);
});

test("resume：未加载且无 sessions 服务时报不可用", () => {
  const actions = createHostActions({
    host: { getAgent: () => undefined, getSession: () => undefined, raw: {} },
  });
  const out = actions.resume({ sessionId: "s1" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "sessions-unavailable");
});

test("resume：走 prepare + enter 恢复历史会话", () => {
  const calls = [];
  const actions = createHostActions({
    host: {
      getAgent: () => undefined,
      getSession: () => undefined,
      sessions: {
        prepare(id) {
          calls.push(["prepare", id]);
          return { id };
        },
        enter(s) {
          calls.push(["enter", s.id]);
        },
      },
      raw: {},
    },
  });

  const out = actions.resume({ sessionId: "old-1" });
  assert.equal(out.ok, true);
  assert.deepEqual(calls, [["prepare", "old-1"], ["enter", "old-1"]]);
});

test("setApprovalPolicy：拒绝非法策略值", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.setApprovalPolicy({ sessionId: "s1", policy: "maybe" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad-request");
});

test("setApprovalPolicy：宿主无 approval 服务时明确报不可用", () => {
  const actions = createHostActions({ host: fakeHost({ agent: fakeAgent() }) });
  const out = actions.setApprovalPolicy({ sessionId: "s1", policy: "ask" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "approval-unavailable");
});

test("setApprovalPolicy：有服务时调 setPolicy", () => {
  const agent = fakeAgent();
  const calls = [];
  const host = fakeHost({ agent });
  host.raw = {
    approval: {
      setPolicy(a, p) {
        calls.push([a, p]);
      },
    },
  };
  const actions = createHostActions({ host });

  const out = actions.setApprovalPolicy({ sessionId: "s1", policy: "never" });
  assert.equal(out.ok, true);
  assert.equal(out.policy, "never");
  assert.equal(calls[0][1], "never");
});

test("textContent：包成标准内容块", () => {
  assert.deepEqual(textContent("hi"), [{ type: "text", text: "hi" }]);
});

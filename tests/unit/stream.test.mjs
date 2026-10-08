/**
 * 小窗：增量事件折成本地消息流（纯函数）
 *
 * 职责：钉住「宿主事件 → 内部统一消息形状」的折叠规则。
 * 所属层：测试（tests/unit）
 *
 * 最要紧的一条是**两种封套都要兜住**：
 *   - `assistant/message`：内容在 `data.message.content`
 *   - `user/message`：内容直接在 `data.content`（没有 message 包裹）
 * 只认一种的话，另一种会静默变成空文本被丢掉——
 * 表现就是「用户发的消息在小窗里根本不出现」。
 *
 * stream.js 是浏览器 script，用 node:vm 造沙箱加载。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = join(ROOT, "whale-window", "renderer", "stream.js");

/** 在沙箱里加载 stream.js。 */
function load() {
  const sandbox = { window: {} };
  const w = sandbox.window;
  w.Array = Array;
  w.Object = Object;
  createContext(sandbox);
  runInContext(readFileSync(FILE, "utf8"), sandbox, { filename: FILE });
  return sandbox.window.WhaleStream;
}

/** 造一份最小快照。 */
function freshState() {
  return {
    messages: [], running: false, steps: 0, turns: 0,
    toolName: null, contextWindow: null,
  };
}

test("user/message：内容直接在 data.content（没有 message 包裹）", () => {
  const state = freshState();
  load().applyEventTo(state, {
    seq: 1, type: "user/message",
    data: { content: [{ type: "text", text: "用户说的话" }] },
  });
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].kind, "user");
  assert.equal(state.messages[0].text, "用户说的话", "漏了这个封套，用户消息就整个消失");
});

test("assistant/message：内容在 data.message.content", () => {
  const state = freshState();
  load().applyEventTo(state, {
    seq: 2, type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "助手的回复" }] } },
  });
  assert.equal(state.messages[0].kind, "assistant");
  assert.equal(state.messages[0].text, "助手的回复");
});

test("turn/start 与 turn/end 管住 running 与 turns", () => {
  const s = freshState();
  const stream = load();
  stream.applyEventTo(s, { seq: 1, type: "turn/start", data: {} });
  assert.equal(s.running, true);
  assert.equal(s.turns, 1);

  stream.applyEventTo(s, { seq: 2, type: "turn/end", data: {} });
  assert.equal(s.running, false, "回合结束了不该还显示运行中");
  assert.equal(s.toolName, null, "回合结束时工具名要清掉，否则状态条一直挂着上个工具");
});

test("step/start 累加步数；tool/call 推工具消息并记住工具名", () => {
  const s = freshState();
  const stream = load();
  stream.applyEventTo(s, { seq: 1, type: "step/start", data: {} });
  assert.equal(s.steps, 1);

  stream.applyEventTo(s, { seq: 2, type: "tool/call", data: { name: "读文件" } });
  assert.equal(s.toolName, "读文件");
  assert.equal(s.messages[0].kind, "tool");
  assert.equal(s.messages[0].name, "读文件");
});

test("request/context 更新上下文窗口", () => {
  const s = freshState();
  const changed = load().applyEventTo(s, { seq: 1, type: "request/context", data: { contextWindow: 128000 } });
  assert.equal(s.contextWindow, 128000);
  assert.equal(changed, true);
});

test("消息条数超上限丢最旧（窗口不能无限涨）", () => {
  const s = freshState();
  const stream = load();
  for (let i = 0; i < stream.MESSAGE_LIMIT + 5; i += 1) {
    stream.pushMessage(s, { kind: "user", text: `第${i}条`, seq: i });
  }
  assert.equal(s.messages.length, stream.MESSAGE_LIMIT);
  assert.equal(s.messages[0].text, "第5条", "该丢的是最旧的几条");
});

test("只认 text 块：tool-call 的 JSON 不能混进消息流", () => {
  // 混进界面会把小窗冲垮（原实现注释里就记着这个坑）
  const text = load().textOf({
    type: "assistant/message",
    data: { message: { content: [
      { type: "text", text: "正文" },
      { type: "tool-call", arguments: "{\"一大坨\":123}" },
    ] } },
  });
  assert.equal(text, "正文", "非 text 块必须被滤掉");
});

test("坏输入不崩：null / 非对象 / 缺 data", () => {
  const stream = load();
  const s = freshState();
  assert.equal(stream.applyEventTo(s, null), false);
  assert.equal(stream.applyEventTo(s, "不是事件"), false);
  assert.equal(stream.applyEventTo(s, { type: "user/message" }), true, "缺 data 也要能折（文本为空而已）");
  assert.equal(s.messages[0].text, "");
  assert.equal(stream.textOf({}), "");
});

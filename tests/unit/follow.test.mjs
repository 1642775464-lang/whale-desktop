/**
 * 活跃会话跟随规则（纯函数）
 *
 * 职责：钉住「该跟、该留、该拒」三种判定，以及「id 没变就不算切」。
 * 所属层：测试（tests/unit）
 *
 * 这是**用户裁定的行为**：小窗启动时默认绑上「最近一次会话」（冷会话种子），
 * 之后在宿主里开新会话时**小窗要跟着过去**。
 *
 * follow.js 是浏览器 script，用 node:vm 造沙箱加载（与 hud-bridge-client 同一套做法）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = join(ROOT, "whale-window", "renderer", "follow.js");

/** 在沙箱里加载 follow.js。 */
function load() {
  const sandbox = { window: {} };
  const w = sandbox.window;
  w.Array = Array;
  w.Object = Object;
  createContext(sandbox);
  runInContext(readFileSync(FILE, "utf8"), sandbox, { filename: FILE });
  return sandbox.window.WhaleFollow;
}

test("活跃指针变到另一条在册会话 → 跟过去", () => {
  const out = load().decideFollow({
    sessions: [{ sessionId: "b" }, { sessionId: "a" }],
    activeSessionId: "b",
    currentSessionId: "a",
  });
  assert.equal(out.sessionId, "b", "用户要的行为：跟着走");
  assert.equal(out.changed, true);
  assert.equal(out.idle, false);
});

test("活跃指针没变 → 不算切换（5 秒轮询不能每次都重建面板）", () => {
  const out = load().decideFollow({
    sessions: [{ sessionId: "a" }],
    activeSessionId: "a",
    currentSessionId: "a",
  });
  assert.equal(out.sessionId, "a");
  assert.equal(out.changed, false, "id 没变就不该触发重建");
});

test("待机（指针为空）→ 保持当前会话，不清空", () => {
  // 待机是**会过去**的状态（用户随后就开了会话）。清空会让消息流闪白、
  // 用户以为自己点坏了。
  const out = load().decideFollow({
    sessions: [],
    activeSessionId: null,
    currentSessionId: "a",
  });
  assert.equal(out.sessionId, "a", "待机不该把已绑会话清掉");
  assert.equal(out.idle, true);
  assert.equal(out.changed, false);
});

test("待机且本来就没会话 → 老实说没有", () => {
  const out = load().decideFollow({ sessions: [], activeSessionId: null, currentSessionId: null });
  assert.equal(out.sessionId, null);
  assert.equal(out.idle, true);
});

test("清单里没有指针指向的会话 → 不盲从，留在当前", () => {
  // 盲从会切到一个拉不到面板的会话上，表现是「窗口突然空了」。
  const out = load().decideFollow({
    sessions: [{ sessionId: "a" }],
    activeSessionId: "幽灵",
    currentSessionId: "a",
  });
  assert.equal(out.sessionId, "a", "清单里没有的 id 不该跟过去");
  assert.equal(out.changed, false);
});

test("首次进来（没有当前会话）→ 直接用指针", () => {
  const out = load().decideFollow({
    sessions: [{ sessionId: "a" }],
    activeSessionId: "a",
    currentSessionId: null,
  });
  assert.equal(out.sessionId, "a");
  assert.equal(out.changed, true);
});

test("桥没给指针但有清单 → 退回清单第一项（与「默认最近一次」同口径）", () => {
  const out = load().decideFollow({
    sessions: [{ sessionId: "first" }, { sessionId: "second" }],
    activeSessionId: null,
    currentSessionId: null,
  });
  assert.equal(out.sessionId, "first");
});

test("乱七八糟的输入不崩（sessions 不是数组 / 整体 undefined）", () => {
  const f = load().decideFollow;
  assert.equal(f(undefined).sessionId, null);
  assert.equal(f({}).sessionId, null);
  assert.equal(f({ sessions: "不是数组" }).sessionId, null);
});

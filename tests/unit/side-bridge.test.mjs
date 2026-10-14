/**
 * 侧窗桥客户端的响应规整
 *
 * 职责：钉住「桥给的字段真的透传到渲染层」——
 *       用户报「继承下拉里出现很多已归档的不存在的会话」，
 *       根因就是这里**没把 `archived` 带出来**，过滤条件形同虚设。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得单独测：这类「字段没透传」的 bug 在**面板层看不到** ——
 * 面板代码写得好好的，只是拿到的对象里少了一个键。
 * 只有真的走一遍客户端才能发现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 在沙箱里加载 side-bridge.js，并注入一个假 fetch。
 *
 * @param {(url: string) => object} route 按 URL 返回响应体
 */
function load(route) {
  const calls = [];
  const sandbox = {
    window: {},
    console: { warn: () => {} },
    Object, Array, String, Promise, Number, URLSearchParams, JSON, Error,
  };
  sandbox.window.location = { search: "?port=19387" };
  sandbox.window.fetch = (url) => {
    calls.push(url);
    const body = route(url);
    return Promise.resolve({
      json: () => Promise.resolve(body),
    });
  };
  sandbox.window.console = sandbox.console;
  createContext(sandbox);
  const file = join(ROOT, "whale-window", "renderer", "side-bridge.js");
  runInContext(readFileSync(file, "utf8"), sandbox, { filename: "side-bridge.js" });
  return { client: sandbox.window.WhaleSideBridge.createSideClient(), calls };
}

test("sessionList：**archived 必须透传**（下拉要靠它滤掉归档会话）", async () => {
  const { client } = load(() => ({
    ok: true,
    sessions: [
      { sessionId: "a", title: "在用", archived: false },
      { sessionId: "b", title: "归档了", archived: true },
      { sessionId: "c", title: "没给字段" },
    ],
  }));

  const out = await client.sessionList();
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.sessions.map((s) => [s.sessionId, s.archived]),
    [["a", false], ["b", true], ["c", false]],
    "archived 要如实带出来；缺字段按 false（保守：不把活会话当归档滤掉）",
  );
});

test("sessionList：缺 title 给占位，不让下拉出现空白项", async () => {
  const { client } = load(() => ({
    ok: true,
    sessions: [{ sessionId: "x" }, { sessionId: "y", title: "" }],
  }));
  const out = await client.sessionList();
  assert.deepEqual(out.sessions.map((s) => s.title), ["(未命名会话)", "(未命名会话)"]);
});

test("sessionList：桥报错时如实返回 code，不假装成功", async () => {
  const { client } = load(() => ({ ok: false, error: { code: "session-query-conflict" } }));
  const out = await client.sessionList();
  assert.equal(out.ok, false);
  assert.equal(out.code, "session-query-conflict");
});

test("activeContext：取活跃会话与其工作区（侧窗据此列文件）", async () => {
  /*
   * 用户报「文件区域读不到当前工作区」的修法就落在这里：
   * 侧窗不再只依赖建窗时那份可能为空的查询串，而是自己去问桥。
   */
  const { client } = load(() => ({
    ok: true,
    activeSessionId: "s-1",
    sessions: [{ sessionId: "s-1", workspace: "D:/proj" }],
  }));
  const out = await client.activeContext();
  // ⚠️ 沙箱跨 realm，deepEqual 会因「结构相同但不同引用」失败 —— 用 JSON 比
  assert.equal(JSON.stringify(out), JSON.stringify({ ok: true, sessionId: "s-1", workspace: "D:/proj" }));
});

test("activeContext：活跃会话不在清单里时仍给 id，工作区为 null", async () => {
  const { client } = load(() => ({ ok: true, activeSessionId: "s-9", sessions: [] }));
  const out = await client.activeContext();
  assert.equal(out.sessionId, "s-9");
  assert.equal(out.workspace, null, "找不到就不编一个工作区路径");
});

test("activeContext：没有活跃会话时给 null（不是空串）", async () => {
  const { client } = load(() => ({ ok: true, activeSessionId: null, sessions: [] }));
  const out = await client.activeContext();
  assert.equal(out.sessionId, null);
});

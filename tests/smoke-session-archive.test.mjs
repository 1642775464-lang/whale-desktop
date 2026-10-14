/**
 * 端到端：会话归档路由
 *
 * 职责：钉住侧边对话「归档」入口背后的桥端行为 —— 成功、缺参、以及
 *       宿主两类特有错误的**分档**。
 * 所属层：测试（smoke）
 *
 * ## 为什么要分档（而不是都报 502）
 *
 * 界面据此给不同的提示：
 *   · 缺 sessionId → 400（调用方写错了）；
 *   · 宿主没有注册表能力 → 503（**能力未接通，不是故障**）；
 *   · 会话不存在 → 404；
 *   · 会话正在活动 → 409（提示「先停下再归档」）。
 *
 * 都报一个「归档失败」会让用户没法判断该做什么。
 *
 * ## 宿主错误按**名字**识别
 *
 * 宿主抛的是它包里的错误类型，跨包 `instanceof` 不可靠，
 * 所以桥按 `constructor.name` 认 —— 用例里也用同名类模拟。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, dispose } from "../whale-bridge/host.js";
import { createFakeCtx, createHttpTools } from "./helpers/slice3-fixtures.mjs";

const PORT = 19385;
const http = createHttpTools(PORT);

/** 造一个同名错误类（对齐宿主 `constructor.name` 的判据）。 */
function namedError(name, message) {
  const cls = { [name]: class extends Error {} }[name];
  return new cls(message);
}

/**
 * 造宿主：带一个可控的 workspaceRegistry。
 *
 * @param {() => Promise<void>} archiveImpl 归档实现（抛错即模拟宿主拒绝）
 */
function ctxWith(archiveImpl) {
  const calls = [];
  const ctx = createFakeCtx({
    liveSessionId: "s-live",
    services: {
      workspaceRegistry: {
        archiveSession: (sessionId, options) => {
          calls.push({ sessionId, options });
          return archiveImpl();
        },
      },
    },
  });
  return { ctx, calls };
}

test("归档：成功路径 —— 调宿主并默认带 stopActivity", async (t) => {
  /*
   * 侧边对话往往是**运行中**的会话，注册表对活动会话会拒绝。
   * 用户的意图是「这一轮聊完了，收起来」，所以默认要停掉活动再归 ——
   * 否则点了只会报错，看着像坏了。
   */
  const { ctx, calls } = ctxWith(async () => {});
  await apply(ctx, { port: PORT });
  t.after(async () => { await dispose(); });

  const out = await http.postJson("/whale/session/archive", { sessionId: "s-x" });
  assert.equal(out.status, 200, `应成功：${JSON.stringify(out.json)}`);
  assert.equal(out.json.ok, true);
  assert.equal(out.json.archived, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sessionId, "s-x");
  assert.equal(calls[0].options.stopActivity, true, "默认要停活动");
});

test("归档：显式 stopActivity=false 时不带该选项", async (t) => {
  const { ctx, calls } = ctxWith(async () => {});
  await apply(ctx, { port: PORT });
  t.after(async () => { await dispose(); });

  const out = await http.postJson("/whale/session/archive", { sessionId: "s-x", stopActivity: false });
  assert.equal(out.status, 200);
  assert.deepEqual(calls[0].options, {}, "不该塞 stopActivity");
});

test("归档：缺 sessionId → 400（调用方写错了，不是宿主的问题）", async (t) => {
  const { ctx } = ctxWith(async () => {});
  await apply(ctx, { port: PORT });
  t.after(async () => { await dispose(); });

  const out = await http.postJson("/whale/session/archive", {});
  assert.equal(out.status, 400, `应报 400：${JSON.stringify(out.json)}`);
  assert.equal(out.json.error.code, "bad-request");
});

test("归档：宿主不认识这个会话 → 404", async (t) => {
  const { ctx } = ctxWith(async () => { throw namedError("WorkspaceUnknownSessionError", "no such"); });
  await apply(ctx, { port: PORT });
  t.after(async () => { await dispose(); });

  const out = await http.postJson("/whale/session/archive", { sessionId: "s-nope" });
  assert.equal(out.status, 404, `应报 404：${JSON.stringify(out.json)}`);
  assert.equal(out.json.error.code, "session-not-found");
});

test("归档：会话正在活动 → 409（界面据此提示「先停下」）", async (t) => {
  const { ctx } = ctxWith(async () => { throw namedError("WorkspaceActiveSessionError", "busy"); });
  await apply(ctx, { port: PORT });
  t.after(async () => { await dispose(); });

  const out = await http.postJson("/whale/session/archive", { sessionId: "s-busy" });
  assert.equal(out.status, 409, `应报 409：${JSON.stringify(out.json)}`);
  assert.equal(out.json.error.code, "session-active");
});

test("归档：宿主没提供注册表能力 → 503（能力未接通，不是故障）", async (t) => {
  const ctx = createFakeCtx({ liveSessionId: "s-live", services: {} });
  await apply(ctx, { port: PORT });
  t.after(async () => { await dispose(); });

  const out = await http.postJson("/whale/session/archive", { sessionId: "s-x" });
  assert.equal(out.status, 503, `应报 503：${JSON.stringify(out.json)}`);
  assert.equal(out.json.error.code, "archive-unavailable");
});

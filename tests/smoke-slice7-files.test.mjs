/**
 * GET /whale/files —— `@` 文件引用候选（切片 7 第四批）
 *
 * 职责：钉住「小窗搜工作区文件」这条 HTTP 链路。
 * 所属层：测试（tests/）
 *
 * 用户报：「小窗的对话框的＋号交互内容和主窗口的没有对齐」。
 * 主窗口的＋号菜单里有「文件」一项 —— 是 `@` 触发的**工作区文件引用**
 * （插入 `@路径`，不是上传）。小窗原先只有拖拽上传。
 *
 * 用户裁定：＋浮层里的「文件」按 **A**：搜索 → 选中后在输入框插入 `@路径`
 * **待发送**（与主窗口的 `@` 语义一致，也不会误发消息）。
 *
 * 为什么打 HTTP 而不只测单元：桥那边接了可选服务、这里要注册路由、
 * 处理器要取 agent —— 三处任一处漏接，单元层都可能全绿。
 * 这一组就是那根线的守门人。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, dispose } from "../whale-bridge/host.js";
import { createFakeCtx, createHttpTools } from "./helpers/slice3-fixtures.mjs";

const PORT = 19380;
const http = createHttpTools(PORT);

/** 造一个带 fileReferences 的假宿主（按宿主真实形状）。 */
function fileCtx(listImpl, liveSessionId = "s-live") {
  const ctx = createFakeCtx({
    liveSessionId,
    services: { fileReferences: { list: listImpl } },
  });
  // 宿主那条路需要**活 agent**：夹具的 agents.get 默认返回 undefined，
  // 不塞一个的话会走「没有活跃 agent」分支，而报错看不出是这个原因。
  ctx.__setAgent(liveSessionId, { id: liveSessionId, status: "idle" });
  return ctx;
}

test("GET /whale/files：带 sessionId 与 q 时返回候选", async () => {
  const calls = [];
  const ctx = fileCtx((agent, query, signal) => {
    calls.push({ agent, query, signal });
    return Promise.resolve([
      { path: "src/app.js", kind: "file" },
      { path: "docs/", kind: "directory" },
    ]);
  });

  await apply(ctx, { port: PORT });
  try {
    const { status, json } = await http.getJson("/whale/files?sessionId=s-live&q=app");
    assert.equal(status, 200);
    assert.ok(json.ok, `应成功，实际 ${JSON.stringify(json)}`);
    assert.equal(json.candidates.length, 2, "两条候选都要给");
    assert.deepEqual(
      json.candidates.map((c) => c.path),
      ["src/app.js", "docs/"],
      "**原样透传**：不改名、不补全（避免两套形状）",
    );
    assert.ok(calls[0].signal instanceof AbortSignal, "要传 AbortSignal 给宿主");
    assert.equal(calls[0].query, "app", "查询串要透传");
  } finally {
    await dispose();
  }
});

test("GET /whale/files：缺 sessionId → 400（不能静默给空）", async () => {
  await apply(fileCtx(() => Promise.resolve([])), { port: PORT });
  try {
    const { status, json } = await http.getJson("/whale/files?q=app");
    assert.equal(status, 400);
    assert.equal(json.error.code, "bad-request", "缺参数要明确拒绝，静默空列表会让界面以为没文件");
  } finally {
    await dispose();
  }
});

test("GET /whale/files：未知会话 → 404", async () => {
  await apply(fileCtx(() => Promise.resolve([])), { port: PORT });
  try {
    const { status, json } = await http.getJson("/whale/files?sessionId=没有这个");
    assert.equal(status, 404);
    assert.equal(json.error.code, "session-not-found");
  } finally {
    await dispose();
  }
});

test("GET /whale/files：宿主没这个服务时给空数组 + 明确原因（不是报错）", async () => {
  // 部署里可能没挂 fileReferences —— 那是「能力未接通」，不是故障。
  await apply(createFakeCtx(), { port: PORT });
  try {
    const { status, json } = await http.getJson("/whale/files?sessionId=s-live&q=x");
    assert.equal(status, 200, "不该把「没这个能力」当成错误");
    assert.deepEqual(json.candidates, []);
    assert.equal(typeof json.reason, "string", "空结果要说明原因，不能只给个空数组了事");
  } finally {
    await dispose();
  }
});

test("GET /whale/files：宿主抛错时给空数组，不把异常冒到 HTTP 层", async () => {
  await apply(fileCtx(() => Promise.reject(new Error("搜索炸了"))), { port: PORT });
  try {
    const { status, json } = await http.getJson("/whale/files?sessionId=s-live&q=x");
    assert.equal(status, 200);
    assert.deepEqual(json.candidates, []);
  } finally {
    await dispose();
  }
});

test("GET /whale/files：q 可省略（空串也要能列，主窗口也是这样）", async () => {
  const queries = [];
  await apply(fileCtx((_a, query) => {
    queries.push(query);
    return Promise.resolve([{ path: "a.ts", kind: "file" }]);
  }), { port: PORT });
  try {
    const { status, json } = await http.getJson("/whale/files?sessionId=s-live");
    assert.equal(status, 200);
    assert.equal(json.candidates.length, 1);
    assert.equal(queries[0], "", "没给 q 时传空串，不是 undefined（宿主会当查询串用）");
  } finally {
    await dispose();
  }
});

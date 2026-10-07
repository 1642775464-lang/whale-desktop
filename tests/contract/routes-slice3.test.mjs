/**
 * 切片 3 路由契约测试
 *
 * 职责：钉死「桥对外承诺的形状」——22 条路由全部落地、路径与 PRD 表格
 *       逐条一致、状态码口径表唯一、续传参数解析规则明确。
 * 所属层：测试（tests/contract）
 *
 * 为什么与 smoke-slice3 分开：冒烟测的是「接线通不通」（要起 HTTP），
 * 契约测的是「承诺长什么样」（不起服务、不发请求）。两者的失败含义不同——
 * 契约坏了意味着**对外文档与实现不一致**，该在改路由表时就被拦住，
 * 而不是等到端到端才暴露。
 *
 * 本文件不发网络请求，因此不受「桥是进程级单例」的串行约束。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ROUTE_DEFS, getHandler } from "../../whale-bridge/lib/routes.mjs";
import { registerSliceOneRoutes } from "../../whale-bridge/lib/handlers-slice1.mjs";
import { registerSliceTwoRoutes } from "../../whale-bridge/lib/handlers-slice2.mjs";
import { registerSliceThreeReadRoutes } from "../../whale-bridge/lib/handlers-slice3-read.mjs";
import { registerSliceThreeWriteRoutes } from "../../whale-bridge/lib/handlers-slice3-write.mjs";
import { parseLastEventId } from "../../whale-bridge/lib/handlers-slice3-read.mjs";
import { statusOf } from "../../whale-bridge/lib/handlers-slice3-write.mjs";

// 注册是副作用：本文件依赖它把 22 条处理器全部填进路由表
registerSliceOneRoutes();
registerSliceTwoRoutes({ foldSet: () => ({}), pipeline: () => ({}), meta: { version: "test", port: 0 } });
registerSliceThreeReadRoutes({ bridge: {} });
registerSliceThreeWriteRoutes();

/**
 * PRD F2 的路由表，按 PRD 表格顺序抄在这里。
 *
 * 为什么要再抄一遍：路由表自己说多少条，只能证明「它自己一致」；
 * 与 PRD 逐条比对才能证明「实现与承诺一致」。这两件事都值得钉死。
 *
 * 切片 7 新增 /whale/commands 时，这条断言的正确做法是
 * **先改 PRD、再改这里** —— 它当时就是这么拦住我的。
 */
const PRD_ROUTES = [
  ["GET", "/whale"],
  ["GET", "/whale/probe"],
  ["GET", "/whale/events"],
  ["GET", "/whale/panel"],
  ["GET", "/whale/capability"],
  ["GET", "/whale/windows"],
  ["GET", "/whale/fold"],
  ["GET", "/whale/follow"],
  ["GET", "/whale/models"],
  ["GET", "/whale/commands"],
  ["GET", "/whale/presets"],
  ["GET", "/whale/approval"],
  ["POST", "/whale/open"],
  ["POST", "/whale/close"],
  ["POST", "/whale/send"],
  ["POST", "/whale/command"],
  ["POST", "/whale/activate"],
  ["POST", "/whale/model"],
  ["POST", "/whale/abort"],
  ["POST", "/whale/resume"],
  ["POST", "/whale/approval"],
  ["POST", "/whale/action"],
  ["POST", "/whale/upload/file"],
  ["POST", "/whale/upload/images"],
  ["GET", "/whale/hud"],
  ["GET", "/whale/hud/events"],
];

test("路由表与 PRD 逐条一致（顺序、方法、路径）", () => {
  assert.deepEqual(
    ROUTE_DEFS.map((d) => [d.method, d.path]),
    PRD_ROUTES,
    "路由表与 PRD F2 不一致——改路由前先改 PRD，否则客户端照 PRD 写就会 404",
  );
});

test("26 条路由全部已实现（C1 的静态侧）", () => {
  const missing = ROUTE_DEFS.filter((d) => getHandler(d.method, d.path) === undefined);
  assert.deepEqual(
    missing.map((d) => `${d.method} ${d.path}`),
    [],
    "路由表里有、处理器却没有 = 运行时 501，属于口径分裂",
  );
});

test("已实现的处理器都是函数", () => {
  for (const [method, path] of PRD_ROUTES) {
    assert.equal(typeof getHandler(method, path), "function", `${method} ${path} 处理器不是函数`);
  }
});

test("切片归属分布：切片 1 有 4 条，切片 2/3 有 18 条，切片 7 有 1 条", () => {
  assert.equal(ROUTE_DEFS.filter((d) => d.slice === 1).length, 4);
  assert.equal(ROUTE_DEFS.filter((d) => d.slice === 2 || d.slice === 3).length, 18);
  // 切片 7（输入框交互全量复刻）新增：命令目录 + 权限档位 + 两条上传
  assert.equal(ROUTE_DEFS.filter((d) => d.slice === 7).length, 4);
});

test("每条路由都标了切片归属（进度可见）", () => {
  // 合法切片：1/2/3（一期六片中的前三个桥切片）+ 7（切片 7 新增）。
  // 新增路由时要**显式把它的切片号加进来**，别让这条例外悄悄扩大。
  const LEGAL = [1, 2, 3, 7];
  for (const def of ROUTE_DEFS) {
    assert.ok(LEGAL.includes(def.slice), `${def.path} 缺合法切片标记（当前只认 ${LEGAL.join("/")}）`);
  }
});

test("状态码口径表：每个已知 code 都有唯一归属", () => {
  const table = {
    "bad-request": 400,
    "session-not-found": 404,
    "approval-not-found": 404,
    "no-active-turn": 409,
    "session/steer-unavailable": 409,
    "approval-not-pending": 409,
    "commands-unavailable": 503,
    "sessions-unavailable": 503,
    "approval-unavailable": 503,
    "model-switch-unavailable": 503,
    "resume-unavailable": 503,
  };
  for (const [code, expected] of Object.entries(table)) {
    assert.equal(statusOf(code), expected, `${code} 的状态码口径变了`);
  }
});

test("未知 code 退化为 500，不静默当成成功", () => {
  assert.equal(statusOf("从来没见过的错"), 500);
  assert.equal(statusOf(""), 500);
});

test("Last-Event-ID：优先取请求头", () => {
  assert.equal(parseLastEventId({ headers: { "last-event-id": "42" } }), 42);
});

test("Last-Event-ID：头缺失时用查询参数（curl 调试友好）", () => {
  const query = new URLSearchParams("lastEventId=7");
  assert.equal(parseLastEventId({ headers: {} }, query), 7);
});

test("Last-Event-ID：非法值一律当没带，不报错", () => {
  assert.equal(parseLastEventId({ headers: { "last-event-id": "abc" } }), null);
  assert.equal(parseLastEventId({ headers: { "last-event-id": "" } }), null);
  assert.equal(parseLastEventId({ headers: {} }), null);
  assert.equal(parseLastEventId(undefined), null);
});

test("Last-Event-ID：头优先于查询参数（不被调试参数盖掉）", () => {
  const query = new URLSearchParams("lastEventId=7");
  assert.equal(parseLastEventId({ headers: { "last-event-id": "9" } }, query), 9);
});

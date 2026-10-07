/**
 * 路由表单测
 *
 * 职责：验证 PRD F2 的路由声明完整、无重复、口径一致。
 * 所属层：测试（tests/）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeRoutes,
  getHandler,
  ROUTE_DEFS,
  validateRouteTable,
} from "../whale-bridge/lib/routes.mjs";

test("路由表共 26 条（PRD F2 的 22 条 + 切片 7 新增四条）", () => {
  // 22 = 切片 1–3 的原始条数（D3）；23 = 加上切片 7 的 /whale/commands。
  // 写死总数是有意的：新增路由时必须显式改这里。
  assert.equal(ROUTE_DEFS.length, 26);
});

test("路由表自检无问题", () => {
  assert.deepEqual(validateRouteTable(), []);
});

test("路由方法分布：14 条 GET + 12 条 POST", () => {
  // 切片 7 加了两条 GET + 两条 POST（commands/presets/upload.file/upload.images）
  const get = ROUTE_DEFS.filter((d) => d.method === "GET").length;
  const post = ROUTE_DEFS.filter((d) => d.method === "POST").length;
  assert.equal(get, 14);
  assert.equal(post, 12);
});

test("全部路由都在 /whale 基础路径下", () => {
  for (const def of ROUTE_DEFS) {
    assert.ok(def.path.startsWith("/whale"), `${def.path} 不在 /whale 下`);
  }
});

test("每条路由都有用途说明与切片归属", () => {
  for (const def of ROUTE_DEFS) {
    assert.ok(typeof def.purpose === "string" && def.purpose.length > 0, `${def.path} 缺用途`);
    // 合法切片：1/2/3（一期桥的三片）+ 7（切片 7 新增）。\n    assert.ok([1, 2, 3, 7].includes(def.slice), `${def.path} 切片归属非法`);
  }
});

test("切片 1 恰好声明 4 条路由", () => {
  assert.equal(ROUTE_DEFS.filter((d) => d.slice === 1).length, 4);
});

test("切片 1 的四条路由都是 GET", () => {
  for (const def of ROUTE_DEFS.filter((d) => d.slice === 1)) {
    assert.equal(def.method, "GET", `${def.path} 应为 GET`);
  }
});

test("概览输出不泄漏处理器函数", () => {
  const routes = describeRoutes();
  assert.equal(routes.length, 26);
  for (const r of routes) {
    assert.deepEqual(
      Object.keys(r).sort(),
      ["implemented", "method", "path", "purpose"],
      `${r.path} 暴露了多余字段`,
    );
  }
});

test("未注册的路由查询处理器返回 undefined", () => {
  assert.equal(getHandler("GET", "/whale/events"), undefined);
  assert.equal(getHandler("POST", "/whale/send"), undefined);
});

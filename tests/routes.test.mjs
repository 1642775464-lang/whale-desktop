/**
 * 路由表单测
 *
 * 职责：验证 PRD F2 的 22 条路由声明完整、无重复、口径一致。
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

test("路由表共 22 条（PRD F2 全量实现，用户决策 D3）", () => {
  assert.equal(ROUTE_DEFS.length, 22);
});

test("路由表自检无问题", () => {
  assert.deepEqual(validateRouteTable(), []);
});

test("路由方法分布：12 条 GET + 10 条 POST", () => {
  const get = ROUTE_DEFS.filter((d) => d.method === "GET").length;
  const post = ROUTE_DEFS.filter((d) => d.method === "POST").length;
  assert.equal(get, 12);
  assert.equal(post, 10);
});

test("全部路由都在 /whale 基础路径下", () => {
  for (const def of ROUTE_DEFS) {
    assert.ok(def.path.startsWith("/whale"), `${def.path} 不在 /whale 下`);
  }
});

test("每条路由都有用途说明与切片归属", () => {
  for (const def of ROUTE_DEFS) {
    assert.ok(typeof def.purpose === "string" && def.purpose.length > 0, `${def.path} 缺用途`);
    assert.ok([1, 2, 3].includes(def.slice), `${def.path} 切片归属非法`);
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
  assert.equal(routes.length, 22);
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

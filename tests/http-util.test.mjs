/**
 * HTTP 工具单测
 *
 * 职责：验证 CORS 判定、Host 校验、URL 解析等无状态逻辑。
 * 所属层：测试（tests/）
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  corsHeaders,
  isAllowedHost,
  isAllowedOrigin,
  parseUrl,
} from "../whale-bridge/lib/http-util.mjs";

test("允许本机回环来源", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:43120"), true);
  assert.equal(isAllowedOrigin("http://localhost:3000"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1"), true);
});

test("拒绝外部来源", () => {
  assert.equal(isAllowedOrigin("http://evil.com"), false);
  assert.equal(isAllowedOrigin("https://127.0.0.1:43120"), false);
  assert.equal(isAllowedOrigin("http://192.168.1.5:3000"), false);
});

test("缺失来源放行（同源请求不带 Origin）", () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(""), true);
});

test("Host 头必须是回环地址（防 DNS rebinding）", () => {
  assert.equal(isAllowedHost("127.0.0.1:19387"), true);
  assert.equal(isAllowedHost("localhost:19387"), true);
  assert.equal(isAllowedHost("evil.com:19387"), false);
  assert.equal(isAllowedHost("0.0.0.0:19387"), false);
});

test("缺失 Host 头放行（HTTP/1.0 客户端）", () => {
  assert.equal(isAllowedHost(undefined), true);
});

test("CORS 头只对允许的来源下发", () => {
  const ok = corsHeaders("http://127.0.0.1:43120");
  assert.equal(ok["access-control-allow-origin"], "http://127.0.0.1:43120");
  assert.ok(ok["access-control-allow-methods"].includes("POST"));

  assert.deepEqual(corsHeaders("http://evil.com"), {});
  assert.deepEqual(corsHeaders(undefined), {});
});

test("URL 解析取出路径与查询参数", () => {
  const { pathname, query } = parseUrl("/whale/panel?sessionId=abc&tail=40");
  assert.equal(pathname, "/whale/panel");
  assert.equal(query.get("sessionId"), "abc");
  assert.equal(query.get("tail"), "40");
});

test("URL 解析对无查询串的路径正常", () => {
  const { pathname, query } = parseUrl("/whale");
  assert.equal(pathname, "/whale");
  assert.equal(query.get("sessionId"), null);
});

test("URL 解析对中文与编码路径正常", () => {
  const { pathname } = parseUrl("/whale/%E4%BC%9A%E8%AF%9D");
  assert.equal(pathname, "/whale/%E4%BC%9A%E8%AF%9D");
});

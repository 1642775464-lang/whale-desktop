/**
 * 注入到侧边栏浏览器（webview 内部网页）的样式
 *
 * 职责：钉住「网页内部的滚动条也要去掉」这条要求。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：webview 里是**另一个独立文档** —— 侧窗自己 CSS 的那条
 * `::-webkit-scrollbar` 管不到它。用户明确提了「浏览器也的滚动条也不需要」，
 * 所以这条规则必须独立存在且成对（缺任一条 Chromium 都仍会占位）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HIDE_SCROLLBAR_CSS } from "../../whale-window/lib/side-web-style.cjs";

test("注入样式：两条规则都在（缺一条 Chromium 仍会占位 ~15px）", () => {
  /*
   * `::-webkit-scrollbar { width: 0 }` 只把轨道压扁；
   * 新版 Chromium 里滚动条**自身仍占位**，必须 `scrollbar-width: none` 才彻底。
   */
  assert.match(HIDE_SCROLLBAR_CSS, /::-webkit-scrollbar\s*\{[^}]*width:\s*0/);
  assert.match(HIDE_SCROLLBAR_CSS, /scrollbar-width:\s*none/);
});

test("注入样式：带 !important（否则会被站点自己的样式压过去）", () => {
  /*
   * 网页是**别人的页面**，它完全可能自己写了滚动条样式 ——
   * 不加 `!important` 时我们的规则优先级不够，结果等于没注入。
   */
  assert.match(HIDE_SCROLLBAR_CSS, /width:\s*0\s*!important/);
  assert.match(HIDE_SCROLLBAR_CSS, /scrollbar-width:\s*none\s*!important/);
});

test("注入样式：**不能**用 overflow: hidden 代替（那会连滚动都没了）", () => {
  /*
   * 用户要的是「不要滚动条，但滚轮能滚」——
   * `overflow: hidden` 会把滚动能力一起去掉，正好相反。
   */
  assert.doesNotMatch(HIDE_SCROLLBAR_CSS, /overflow:\s*hidden/);
});

test("注入样式：是样式不是脚本（不给网页开任何新能力）", () => {
  assert.doesNotMatch(HIDE_SCROLLBAR_CSS, /<script/i);
  assert.doesNotMatch(HIDE_SCROLLBAR_CSS, /javascript:/i);
});

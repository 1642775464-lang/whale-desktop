/**
 * 侧边栏浏览器的 UA 策略
 *
 * 职责：钉住「用平板 UA」这条决定，以及 html 该不该转浏览器。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：UA 写错的唯一表现是「有些站点排版不对」——
 * 不会报错、不会崩，只会在某个具体网站上看起来怪。所以把关键特征钉住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import ua from "../../whale-window/lib/side-ua.cjs";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { TABLET_USER_AGENT, browserUserAgent, shouldOpenInBrowser } = ua;

test("side.html 的 webview useragent 与常量**一字不差**", () => {
  /*
   * ⚠️ 这两处必须一致，而且**必须写在 HTML 属性上**：
   * 只靠主进程 `did-attach-webview` + `setUserAgent` 太晚（那时页面已按
   * 默认桌面 UA 开始加载），百度会返回桌面版 —— 表现为「桌面版缩小图」
   * （用户报「浏览器比例还是不对」）。
   *
   * HTML 是静态文件、引用不到常量，所以只能各写一份，靠这条测试钉住。
   */
  const html = readFileSync(join(ROOT, "whale-window", "renderer", "side.html"), "utf8");
  const m = /useragent="([^"]*)"/.exec(html);
  assert.ok(m !== null, "side.html 的 webview 必须带 useragent 属性");
  assert.equal(m[1], TABLET_USER_AGENT, "HTML 里的 UA 与常量不一致，会各说各话");
});

test("UA 是**平板**口径（含 iPad），不是手机也不是桌面", () => {
  /*
   * 用户要求：「类似 UA 标识平板或者手机的」。
   *
   * 面板内容宽 460：桌面 UA 会让站点按桌面稿排版（多栏、固定宽度）而横向溢出；
   * 手机 UA 会把站点压成「一列大按钮」，信息密度太低。平板档最合适。
   */
  assert.match(TABLET_USER_AGENT, /iPad/, "要能识别成平板");
  assert.doesNotMatch(TABLET_USER_AGENT, /iPhone/, "不是手机");
  assert.doesNotMatch(TABLET_USER_AGENT, /Windows NT|Macintosh; Intel/, "不是桌面");
});

test("UA 是完整可用的 Mozilla 串（缺段落会被站点当成未知浏览器）", () => {
  assert.match(TABLET_USER_AGENT, /^Mozilla\/5\.0 /);
  assert.match(TABLET_USER_AGENT, /AppleWebKit\//);
  assert.match(TABLET_USER_AGENT, /Safari\//);
});

test("browserUserAgent 给的就是那个常量", () => {
  assert.equal(browserUserAgent(), TABLET_USER_AGENT);
});

test("shouldOpenInBrowser：html 类为真，其余为假", () => {
  /*
   * 用户要求：「html 则直接打开侧边栏的浏览器预览」。
   * 判错的表现：html 被当文本渲染 → 用户看到源码而不是页面。
   */
  assert.equal(shouldOpenInBrowser("a.html"), true);
  assert.equal(shouldOpenInBrowser("a.htm"), true);
  assert.equal(shouldOpenInBrowser("x/a.xhtml"), true);
  assert.equal(shouldOpenInBrowser("A.HTML"), true);

  assert.equal(shouldOpenInBrowser("a.md"), false);
  assert.equal(shouldOpenInBrowser("a.js"), false);
  assert.equal(shouldOpenInBrowser("a.htmlx"), false, "后缀要完整匹配");
  assert.equal(shouldOpenInBrowser(""), false);
  assert.equal(shouldOpenInBrowser(null), false);
});

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

const { TABLET_USER_AGENT, browserUserAgent, shouldOpenInBrowser } = ua;

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

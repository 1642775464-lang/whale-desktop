/**
 * 侧边栏浏览器的 UA 策略
 *
 * 职责：钉住「用**手机** UA」这条决定，以及 html 该不该转浏览器。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：UA 写错的唯一表现是「有些站点排版不对」——
 * 不会报错、不会崩，只会在某个具体网站上看起来怪。而这次**正是因为判据
 * 不对才漏了两轮**，所以这里把「站点认不认它是移动端」直接钉成断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import ua from "../../whale-window/lib/side-ua.cjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const { PHONE_USER_AGENT, browserUserAgent, shouldOpenInBrowser } = ua;

test("UA 必须是**手机**口径 —— 站点要把它认成移动端", () => {
  /*
   * ⚠️ 这条改过：原先用 iPad（平板）UA，用户连报两轮「缩放/比例不对」。
   * 实测三种 UA 打开百度：
   *
   *   iPad    → 返回**桌面版**（无 viewport meta、正文字号 12px）
   *   iPhone  → 返回移动版（有 viewport meta、正文字号 16px）
   *   Android → 返回移动版（同上）
   *
   * 也就是说**百度不把 iPad UA 当移动设备**。判据不能只看「有没有被缩放」，
   * 要看「站点给的是哪一版」，所以这里直接断言移动特征。
   */
  assert.match(PHONE_USER_AGENT, /iPhone/, "要能识别成手机（站点才返回移动版）");
  assert.doesNotMatch(PHONE_USER_AGENT, /iPad/, "iPad 会被百度当成桌面版");
  assert.doesNotMatch(PHONE_USER_AGENT, /Windows NT|Macintosh; Intel/, "不能是桌面");
  // Mobile 段：很多站点靠它判断移动端
  assert.match(PHONE_USER_AGENT, /Mobile\//, "缺 Mobile 段会被当成桌面浏览器");
});

test("UA 是完整可用的 Mozilla 串（缺段落会被站点当成未知浏览器）", () => {
  assert.match(PHONE_USER_AGENT, /^Mozilla\/5\.0 /);
  assert.match(PHONE_USER_AGENT, /AppleWebKit\//);
  assert.match(PHONE_USER_AGENT, /Safari\//);
});

test("browserUserAgent 给的就是那个常量", () => {
  assert.equal(browserUserAgent(), PHONE_USER_AGENT);
});

test("side.html 的 webview useragent 与常量**一字不差**", () => {
  /*
   * ⚠️ 这两处必须一致，而且**必须写在 HTML 属性上**：
   * 只靠主进程 `did-attach-webview` + `setUserAgent` 太晚（那时页面已按默认
   * 桌面 UA 开始加载）。HTML 引用不到常量，只能各写一份 → 靠这条钉住。
   */
  const html = readFileSync(join(ROOT, "whale-window", "renderer", "side.html"), "utf8");
  const m = /useragent="([^"]*)"/.exec(html);
  assert.ok(m !== null, "side.html 的 webview 必须带 useragent 属性");
  assert.equal(m[1], PHONE_USER_AGENT, "HTML 里的 UA 与常量不一致，会各说各话");
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

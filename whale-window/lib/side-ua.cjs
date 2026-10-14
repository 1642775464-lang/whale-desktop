/**
 * 侧边栏浏览器的 UA 与视口策略
 *
 * 职责：给 `<webview>` 提供「按平板口径」的 UA，让页面自己走响应式布局。
 * 所属层：小窗（whale-window/lib）
 *
 * ## 为什么要固定 UA
 *
 * 用户要求：「浏览器页面要做成适配当前页面比例的，类似 UA 标识平板或者手机的」。
 *
 * 面板宽度与小窗一致（460 内容宽），比桌面窄得多 —— 用默认桌面 UA 时，
 * 很多站点会按桌面稿排版（多栏、固定宽度），在这么窄的窗口里横向溢出、
 * 要拖来拖去才能看。
 *
 * 报平板 UA 之后，站点会走**平板/响应式**那一套（单列、可伸缩），
 * 在 460px 宽里正好合身。
 *
 * ## 为什么用 iPad 而不是手机
 *
 * 面板宽 460：手机 UA 会把站点压成「一列大按钮」的手机版，
 * 在 460px 里显得过窄、信息密度太低；平板 UA 的布局宽度档次（768 起）更接近，
 * 且多数站点的平板布局是「一列但元素正常大小」，观感最合适。
 *
 * ## 只覆盖 UA，不动别的
 *
 * 不设置 `webview` 的 `partition`（不引入独立会话存储），
 * 也不注入任何脚本 —— 仅 UA 一项，改动面最小。
 */

"use strict";

/**
 * 平板 UA（iPad Safari 口径）。
 *
 * ⚠️ **同一个字符串还写在 `renderer/side.html` 的 `<webview useragent="...">` 上**
 * —— 两处必须一字不差（有契约测试核对）。为什么不能只留一处：
 *
 *   · 只靠主进程 `did-attach-webview` + `setUserAgent` **太晚**：
 *     `src` 写在 HTML 里时页面**已经开始加载**，那时还是默认的桌面 UA，
 *     百度会按桌面版返回 —— 在 460px 宽的侧栏里就是「桌面版缩小图」
 *     （用户报「浏览器比例还是不对」）。
 *   · 而 HTML 是静态文件，没法引用这里的常量，所以只能各写一份 + 契约测试钉住。
 *
 * 版本号取一个被广泛识别的稳定形态：写死很新的小版本反而会让部分站点
 * 落到「未知浏览器」分支、拿不到平板布局。
 */
const TABLET_USER_AGENT =
  "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/**
 * 取 webview 该用的 UA。
 *
 * @returns {string}
 */
function browserUserAgent() {
  return TABLET_USER_AGENT;
}

/**
 * 判断一个地址是否应当交给**侧边栏浏览器**打开（而不是内嵌预览）。
 *
 * 用户要求：「html 则直接打开侧边栏的浏览器预览」。所以 html 不走文件预览，
 * 而是转给浏览器面板（那里有平板 UA，能正常渲染）。
 *
 * @param {string} name 文件名（或路径）
 * @returns {boolean}
 */
function shouldOpenInBrowser(name) {
  return /\.(html?|xhtml)$/i.test(String(name ?? ""));
}

module.exports = { TABLET_USER_AGENT, browserUserAgent, shouldOpenInBrowser };

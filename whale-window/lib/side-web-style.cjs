/**
 * 注入到侧边栏浏览器（`<webview>` 内部网页）的样式
 *
 * 职责：把「无感滚动」这条要求带进网页内部。
 * 所属层：小窗（whale-window/lib）
 *
 * ## 为什么需要单独一份
 *
 * 用户要求「小窗及侧边栏区域，所有的涉及上下滑动查看的，都不需要滚动条」——
 * 但 `<webview>` 里的网页是**另一个独立文档**：侧窗自己 CSS 里
 * `::-webkit-scrollbar` 那条**管不到网页内部**（实测：侧窗占位已为 0，
 * 网页自己的滚动条照旧）。所以必须**注入到 webview 内部**才生效。
 *
 * ## 为什么是 CSS 而不是脚本
 *
 * 这里注入的只是样式字符串，**不执行任何脚本**、不碰页面数据 ——
 * 改动面最小，也不会给网页开任何新能力。
 *
 * ⚠️ 与 `renderer/skin.css` / `renderer/side-skin.css` 的那两条规则
 * 是**同一套**（压成 0 宽 + `scrollbar-width: none`），缺任一条
 * Chromium 都会保留约 15px 的占位。
 */

"use strict";

/**
 * 隐藏滚动条但保留滚动能力的 CSS（注入到 webview 内部页面）。
 *
 * 两条规则缺一不可，理由见文件头；不能用 `overflow: hidden` 代替 ——
 * 那会连滚动都没了，与「滚轮滚动就行」正好相反。
 */
const HIDE_SCROLLBAR_CSS = `
*::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
* { scrollbar-width: none !important; }
`;

module.exports = { HIDE_SCROLLBAR_CSS };

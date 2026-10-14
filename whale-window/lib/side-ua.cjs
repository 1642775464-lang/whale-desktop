/**
 * 侧边栏浏览器的 UA 策略
 *
 * 职责：给 `<webview>` 提供一个**移动端口径**的 UA，让站点自己返回
 *       适合窄屏的那一版布局。
 * 所属层：小窗（whale-window/lib）
 *
 * ## 为什么要固定 UA
 *
 * 用户要求：「浏览器页面要做成适配当前页面比例的，类似 UA 标识平板或者手机的」。
 *
 * 侧栏内容宽 460（与小窗一致），比桌面窄得多 —— 用默认桌面 UA 时，
 * 站点会按桌面稿排版（多栏、固定宽度），在这里挤成一团、要拖来拖去才能看。
 *
 * ## 为什么最终是「手机」而不是「平板」（改过，有实测依据）
 *
 * 用户连报两轮「比例不对 / 缩放不对」。第一轮我改用 `useragent` 属性后
 * 仍被判为不对，于是**不再靠猜，实测三种 UA 打开百度**：
 *
 * | UA | 百度返回 | viewport meta | 正文字号 |
 * |---|---|---|---|
 * | iPad（原方案） | **桌面版** | **无** | 12px |
 * | iPhone | 移动版 | 有 | **16px** |
 * | Android 手机 | 移动版 | 有 | **16px** |
 *
 * 结论：**百度不把 iPad UA 当移动设备** —— 它返回桌面布局（无响应式 meta、
 * 字号 12px、导航挤在顶部），在 460~526px 宽的侧栏里正是用户说的
 * 「桌面版缩小图」。改成手机 UA 后返回真正的移动版（字号 16px、带
 * `width=device-width`），在 460 与 526 两种宽度下均无横向溢出。
 *
 * ⚠️ 教训（判据问题）：我上一轮用「视口宽 == 元素宽」判定「没被缩放」——
 * 那只能证明**没有缩放**，证明不了**站点给的是哪一版布局**。
 * 判据必须换成「页面有没有响应式 viewport meta + 正文字号多大」。
 *
 * ## 只覆盖 UA，不动别的
 *
 * 不设置 `webview` 的 `partition`（不引入独立会话存储），
 * 也不注入任何脚本 —— 仅 UA 一项，改动面最小。
 */

"use strict";

/**
 * 手机 UA（iPhone Safari 口径）。
 *
 * ⚠️ **同一个字符串还写在 `renderer/side.html` 的 `<webview useragent="...">` 上**
 * —— 两处必须一字不差（有契约测试核对）。为什么不能只留一处：
 *
 *   · 只靠主进程 `did-attach-webview` + `setUserAgent` **太晚**：
 *     `src` 一写进 HTML，页面**就已经开始加载**（那时还是默认桌面 UA），
 *     等 webview 附加再设已经晚了。
 *   · 而 HTML 是静态文件，引用不到这里的常量，所以只能各写一份 + 契约测试钉住。
 *
 * 版本号取被广泛识别的稳定形态：写死很新的小版本会让部分站点落到
 * 「未知浏览器」分支、拿不到移动版布局。
 */
const PHONE_USER_AGENT =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 "
  + "(KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

/** 兼容旧名（历史提交里叫 TABLET_USER_AGENT）。当前实际用的是手机 UA。 */
const TABLET_USER_AGENT = PHONE_USER_AGENT;

/**
 * 取 webview 该用的 UA。
 *
 * @returns {string}
 */
function browserUserAgent() {
  return PHONE_USER_AGENT;
}

/**
 * 判断一个地址是否应当交给**侧边栏浏览器**打开（而不是内嵌预览）。
 *
 * 用户要求：「html 则直接打开侧边栏的浏览器预览」。所以 html 不走文件预览，
 * 而是转给浏览器面板（那里是移动端口径，能正常渲染）。
 *
 * @param {string} name 文件名（或路径）
 * @returns {boolean}
 */
function shouldOpenInBrowser(name) {
  return /\.(html?|xhtml)$/i.test(String(name ?? ""));
}

module.exports = { PHONE_USER_AGENT, TABLET_USER_AGENT, browserUserAgent, shouldOpenInBrowser };

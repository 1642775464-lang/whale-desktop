/**
 * 活跃会话跟随规则（纯函数）
 *
 * 职责：给定「桥刚返回的会话清单与活跃指针」和「小窗当前绑的会话」，
 *       判定接下来该用哪个 sessionId。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：
 *   1. 这是一条**规则**（有三种要区分的情况），不是取数过程；
 *      把它从 bridge-client 的网络流程里拿出来，规则本身可以单测，
 *      不必搭一整套假 fetch 环境。
 *   2. bridge-client.js 装不下它了（500 行上限，强制 14）。
 *
 * 用户裁定的行为：小窗启动时默认绑上「最近一次会话」（冷会话种子），
 * 之后在宿主里开新会话时**小窗要跟着过去**。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleFollow。
 * 纯函数：不读时钟、不碰 DOM、不发请求，全部输入由参数给。
 */

(function attachFollow(global) {
  "use strict";

  /**
   * 判定接下来该用哪个会话。
   *
   * 三种情况（各有测试）：
   *   1. 活跃指针变了、且新会话在清单里 → **跟过去**（用户要的行为）
   *   2. 活跃指针为空（待机）→ **保持当前会话**，不清空。
   *      待机是**会过去**的状态（用户随后就开了会话）；清空会让消息流闪白，
   *      用户以为自己点坏了。
   *   3. 活跃指针指向清单里没有的会话 → **不盲从**。
   *      盲从会切到一个拉不到面板的会话上，表现是「窗口突然空了」。
   *
   * @param {object} input
   * @param {Array<{sessionId: string}>|undefined} input.sessions 桥给的会话清单
   * @param {string|null} input.activeSessionId 桥给的活跃指针
   * @param {string|null} input.currentSessionId 小窗当前绑的会话
   * @returns {{sessionId: string|null, changed: boolean, idle: boolean}}
   *          sessionId 为 null 表示「没有可用会话」；changed 表示是否要切；
   *          idle 表示桥当前处于待机
   */
  function decideFollow(input) {
    const raw = input ?? {};
    const list = Array.isArray(raw.sessions) ? raw.sessions : [];
    const current = typeof raw.currentSessionId === "string" && raw.currentSessionId !== ""
      ? raw.currentSessionId
      : null;

    // 桥没给指针时退回清单第一项（与「小窗启动时默认显示最近一次」同一口径）
    let active = null;
    if (typeof raw.activeSessionId === "string" && raw.activeSessionId !== "") {
      active = raw.activeSessionId;
    } else if (list.length > 0 && typeof list[0].sessionId === "string" && list[0].sessionId !== "") {
      active = list[0].sessionId;
    }

    // 情况 2：待机
    if (active === null) {
      return { sessionId: current, changed: false, idle: true };
    }

    // 情况 3：清单里没有这个 id 就不要跟
    const known = list.some(function (s) { return s.sessionId === active; });
    if (!known && current !== null) {
      return { sessionId: current, changed: false, idle: false };
    }

    // 情况 1：跟过去（id 没变时 changed=false，不会引起无谓重建）
    return { sessionId: active, changed: active !== current, idle: false };
  }

  global.WhaleFollow = { decideFollow };
})(typeof window !== "undefined" ? window : globalThis);

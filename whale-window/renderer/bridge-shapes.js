/*
 * 桥响应的形状归一化
 *
 * 职责：把桥返回的 JSON 收成界面直接能用的形状（纯函数，无网络、无 DOM）。
 * 所属层：小窗（whale-window/renderer）
 *
 * ## 为什么单独成文件
 *
 * 这些规则原先散在 `bridge-client.js` 的各个方法里，而那个文件是**闭包**：
 * 里面每加一条归一化就多几行，且**测不到**（要起网络与 DOM）。
 * 拆出来之后：
 *   · `bridge-client.js` 只负责「发请求 + 调这里规整」（那个文件已到行数上限）；
 *   · 归一化规则可以脱离网络单测 —— 而它们恰恰最容易出静默错误
 *     （少剥一层 `data`、字段名写错，表现都是「界面空着但不报错」）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleBridgeShapes。
 */

(function attachBridgeShapes(global) {
  "use strict";

  /**
   * 会话清单：规整成 `{ok, sessions, archivedKnown}`。
   *
   * ⚠️ 调用方（侧边栏）直接消费 `sessions`；让它自己剥一层 `data` 的话，
   * 谁忘了剥就静默拿到 undefined —— 表现为「会话列表是空的」。
   * 真窗口实测踩过：侧边栏显示「没有可见的会话」，而桥其实返回了 55 条。
   *
   * @param {object} json 桥响应体
   * @returns {{ok: boolean, sessions: Array<object>, archivedKnown: boolean}}
   */
  function normalizeSessionList(json) {
    return {
      ok: true,
      sessions: Array.isArray(json?.sessions) ? json.sessions : [],
      // 归档判据有没有拿到：界面据此决定「能不能安全隐藏归档会话」
      archivedKnown: json?.archivedKnown === true,
    };
  }

  /**
   * 工作区目录清单：规整成 `{ok, dir, entries, reason}`。
   *
   * @param {object} json 桥响应体
   * @param {string} fallbackDir 桥没回 dir 时用的目录（就是请求里那个）
   * @returns {{ok: boolean, dir: string, entries: Array<object>, reason: string|null}}
   */
  function normalizeWorkspaceFiles(json, fallbackDir) {
    return {
      ok: true,
      dir: typeof json?.dir === "string" ? json.dir : (typeof fallbackDir === "string" ? fallbackDir : ""),
      entries: Array.isArray(json?.entries) ? json.entries : [],
      /*
       * 宿主那条路「需要活 agent」时会给空清单 + reason。
       * 界面要如实转述 —— 否则会被显示成「这个目录是空的」（含义完全不同）。
       */
      reason: typeof json?.reason === "string" ? json.reason : null,
    };
  }

  /**
   * 技能目录：规整成 `{ok, skills}`。
   *
   * @param {object} json 桥响应体
   * @returns {{ok: boolean, skills: Array<object>}}
   */
  function normalizeSkills(json) {
    return {
      ok: true,
      skills: Array.isArray(json?.skills) ? json.skills : [],
    };
  }

  global.WhaleBridgeShapes = { normalizeSessionList, normalizeSkills, normalizeWorkspaceFiles };
})(typeof window !== "undefined" ? window : globalThis);

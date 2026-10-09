/**
 * 往输入框插入文本（不发送）
 *
 * 职责：把一段文本追加到输入框的值里，并让所有监听输入变化的部件知道
 *       「内容变了」。所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：
 *   1. 这里有一个**真实缺陷**——早先只写 `input.value`，而程序化赋值
 *      **不会触发 `input` 事件**，于是斜杠命令面板（在输入框上监听 `input`）
 *      永远不知道内容变了。现象是「点了 ＋菜单里的指令，文字进去了但候选
 *      面板不弹」，用户的手感就是「点了没用」。
 *   2. 它内联在 app.js 里时**没法单独测**（app.js 是装配层，一跑就要整页 DOM），
 *      所以 665 条测试里没有一条能拦住上面那个缺陷。抽出来才测得到。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleInputInsert。
 */

(function attachInputInsert(global) {
  "use strict";

  /**
   * 把文本插进输入框（**不发送**），并派发 `input` 事件。
   *
   * 插入语义与主窗口的 `@` / `/` 一致：放进输入框等用户补完再发，
   * 不替他发出去。已有内容且不以空白结尾时补一个空格，避免与上一个词粘连。
   *
   * @param {HTMLInputElement} input 目标输入框
   * @param {string} text 要插入的文本（空串/非字符串直接忽略）
   * @returns {string} 插入后的值（便于调用方与测试断言）
   */
  function insertIntoInput(input, text) {
    if (input === null || input === undefined) return "";
    if (typeof text !== "string" || text === "") return input.value;
    const cur = typeof input.value === "string" ? input.value : "";
    // 已有内容且不以空白结尾时补一个空格，避免与上一个词粘在一起
    input.value = cur === "" || /\s$/.test(cur) ? `${cur}${text}` : `${cur} ${text}`;
    // ⚠️ 这一行是修复本身：程序化赋值不会自己派发事件，要模拟「用户刚打了字」。
    // 删掉它，斜杠面板就不会开（有测试守着）。
    input.dispatchEvent(new global.Event("input", { bubbles: true }));
    input.focus();
    return input.value;
  }

  global.WhaleInputInsert = { insertIntoInput };
})(typeof window !== "undefined" ? window : globalThis);

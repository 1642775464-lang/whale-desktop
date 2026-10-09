/**
 * 输入框的文本与提示
 *
 * 职责：往输入框插文本（不发送）、记住并切换占位提示（参数引导）。
 *       所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：
 *   1. 这里有一个**真实缺陷**——早先只写 `input.value`，而程序化赋值
 *      **不会触发 `input` 事件**，于是斜杠命令面板（在输入框上监听 `input`）
 *      永远不知道内容变了。现象是「点了 ＋菜单里的指令，文字进去了但候选
 *      面板不弹」，用户的手感就是「点了没用」。
 *   2. 它内联在 app.js 里时**没法单独测**（app.js 是装配层，一跑就要整页 DOM），
 *      所以 665 条测试里没有一条能拦住上面那个缺陷。抽出来才测得到。
 *   3. 参数引导与插入是同一件事的两半（插了什么 → 接着该写什么），
 *      放在一起才看得清它们的前后依赖（引导必须知道刚插入的文本）。
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

  /**
   * 记住输入框原本的占位提示。
   *
   * 调用一次即可（装配时）。引导用完要还原，所以必须先记下原值。
   *
   * @param {HTMLInputElement} input
   * @returns {string} 原占位提示
   */
  function rememberPlaceholder(input) {
    if (input === null || input === undefined) return "";
    return input.getAttribute("placeholder") ?? "";
  }

  /**
   * 命令需要参数时，用占位提示告诉用户该写什么。
   *
   * 复刻主窗口的做法：点「计划」之后，输入框里提示「描述你的任务以生成计划」，
   * 而不是让用户对着一个光秃秃的 `/计划 ` 发呆。
   *
   * ⚠️ `justInserted` 不是可选的装饰。真实缺陷：这个函数在 `insertIntoInput`
   * **之后**被调用，此时输入框里已经有刚插进去的命令了；若只判断
   * 「输入框非空就不引导」，条件**恒为真**，引导永远不显示（一段看起来
   * 很合理的死代码）。所以要靠「当前内容是否恰好只等于刚插入的那段」
   * 来区分「用户还没补参数」与「用户已经在写了」。
   *
   * @param {HTMLInputElement} input
   * @param {string} hint 宿主给的参数说明（可空）
   * @param {string} justInserted 刚插进输入框的那段文本（可空）
   * @param {string} fallback 还原用的默认占位提示
   */
  function showArgHint(input, hint, justInserted, fallback) {
    if (input === null || input === undefined) return;
    const cur = typeof input.value === "string" ? input.value : "";
    const untouched = justInserted === undefined || cur.trim() === justInserted.trim();
    // 用户已经补了参数，或这条命令本来就不要参数：还原成默认提示
    if (!untouched || hint === "") {
      input.setAttribute("placeholder", fallback);
      return;
    }
    input.setAttribute("placeholder", `接着写：${hint}`);
  }

  global.WhaleInputInsert = { insertIntoInput, rememberPlaceholder, showArgHint };
})(typeof window !== "undefined" ? window : globalThis);

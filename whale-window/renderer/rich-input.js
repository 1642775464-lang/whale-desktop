/**
 * 富文本输入框（与主窗口同一种体验）
 *
 * 职责：给输入框提供「纯文本读写」与「命令 token 着色」两件事，
 *       内部用原生 contenteditable 实现。所属层：小窗（whale-window/renderer）
 *
 * 为什么要富文本（用户明确要求「小窗要和主窗口一样是富文本输入框」）：
 *   `<textarea>` 是纯文本控件，**浏览器不支持只给其中一部分字符上色**。
 *   而主窗口点指令后会把命令那一段单独染成蓝色（DSH 的
 *   `TOKEN_STYLE = "color: var(--dsw-alias-state-business-primary)"`，
 *   见 dsh-client-ui-conversation 的 registerClaimDecoration）。
 *   要复刻那个效果，控件本身必须能承载带样式的片段。
 *
 * 为什么不用现成编辑器库：本项目的呈现层不许引第三方包（架构铁律），
 * 而且主窗口那套是它自己的文档模型，抄不进来。所以用原生
 * contenteditable + 一层薄封装。
 *
 * ⚠️ 本模块存在的**首要理由**是把 DOM 结构的复杂度挡在业务之外：
 *   app.js / palette.js / add-menu.js 只跟「读纯文本、写纯文本、插入」
 *   打交道，谁也不该知道 node 树长什么样。改编辑器实现时只动这里。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleRichInput。
 */

(function attachRichInput(global) {
  "use strict";

  /** 命令 token 的颜色，与主窗口同一个语义（业务主色）。 */
  const TOKEN_CLASS = "ri-token";

  /**
   * 把一个元素的内容清空。
   * @param {HTMLElement} el
   */
  function clearElement(el) {
    while (el.firstChild !== null) el.removeChild(el.firstChild);
  }

  /**
   * 建一个富文本输入框包装器。
   *
   * @param {object} deps
   * @param {HTMLElement} deps.el 承载编辑的 contenteditable 元素
   * @param {() => Array<string>} [deps.commandTokens] 取已知的命令写法（用于着色）
   * @param {string} [deps.placeholder] 空内容时显示的占位文字
   * @param {() => void} [deps.onChange] 内容变化（用户输入或程序写入）
   * @returns {object} 编辑器
   */
  function createRichInput(deps) {
    const el = deps.el;
    const commandTokens = typeof deps.commandTokens === "function"
      ? deps.commandTokens
      : function () { return []; };
    const onChange = typeof deps.onChange === "function" ? deps.onChange : function () {};
    const placeholderText = typeof deps.placeholder === "string" ? deps.placeholder : "";

    /** 占位提示当前值（参数引导会临时改写它）。 */
    let placeholder = placeholderText;
    /** 是否有焦点：占位只在空且无焦点时显示（与原生 textarea 一致）。 */
    let focused = false;

    /**
     * 取纯文本。
     *
     * `innerText` 会把 `<div>` 之类的块级换行变成 `\n`，
     * 而 `textContent` 不会 —— 用户在 contenteditable 里按 Shift+Enter
     * 换行会生成块级元素，用 textContent 会丢掉换行。所以优先 innerText。
     *
     * @returns {string}
     */
    function getText() {
      if (typeof el.innerText === "string") return el.innerText;
      return el.textContent ?? "";
    }

    /** 是否为空（只看可见文字）。 */
    function isEmpty() {
      return getText().trim() === "";
    }

    /** 同步占位提示的显示状态（用属性而不是伪元素，便于测试断言）。 */
    function syncPlaceholder() {
      const empty = getText() === "";
      el.setAttribute("data-empty", empty ? "1" : "0");
      el.setAttribute("data-placeholder", empty && !focused ? placeholder : "");
      /*
       * 另外记一份「当前引导文案」，与是否显示**无关**。
       *
       * 为什么要多这一份：占位只在无焦点时显示，而用户点完菜单输入框是
       * 聚焦的 —— 于是 `data-placeholder` 为空，外部（探针/测试）就没法
       * 区分「没有引导」与「有引导但此刻不显示」。
       * 这份记录让「引导是什么」始终可查。
       */
      el.setAttribute("data-guide", placeholder);
    }

    /**
     * 把纯文本写进去，并重建命令着色。
     *
     * @param {string} text
     */
    function setText(text) {
      const value = typeof text === "string" ? text : "";
      clearElement(el);
      if (value !== "") el.appendChild(global.document.createTextNode(value));
      paint();
      syncPlaceholder();
      onChange();
    }

    /** 清空。 */
    function clear() {
      setText("");
    }

    /**
     * 找出文本开头是否是一条已知命令，返回它的长度。
     *
     * 只认开头，且要求命令后面紧跟空白或就是结尾 ——
     * 否则 `/压缩包` 这种会被误判成「压缩」命令而被染色。
     *
     * @param {string} text
     * @returns {number} 命中的命令长度（0 表示没有）
     */
    function leadingCommandLength(text) {
      if (text.charAt(0) !== "/") return 0;
      let best = 0;
      for (const token of commandTokens()) {
        if (typeof token !== "string" || token === "") continue;
        const full = `/${token}`;
        if (!text.startsWith(full)) continue;
        const next = text.charAt(full.length);
        if (next !== "" && !/\s/.test(next)) continue;
        if (full.length > best) best = full.length;
      }
      return best;
    }

    /**
     * 重建命令着色。
     *
     * 做法是「按纯文本重建」而不是「记住节点树」：每次内容变化都从当前
     * 文本重新算出该给哪一段上色。这样用户怎么编辑（包括粘贴、全选删除、
     * 浏览器自动插入的块级元素）都不会把状态搞乱 —— 唯一的真相是文本本身。
     */
    function paint() {
      const text = getText();
      const len = leadingCommandLength(text);
      clearElement(el);
      if (text === "") { syncPlaceholder(); return; }

      if (len > 0) {
        const tokenSpan = global.document.createElement("span");
        tokenSpan.className = TOKEN_CLASS;
        tokenSpan.setAttribute("data-token", "1");
        tokenSpan.textContent = text.slice(0, len);
        el.appendChild(tokenSpan);
        if (text.length > len) el.appendChild(global.document.createTextNode(text.slice(len)));
      } else {
        el.appendChild(global.document.createTextNode(text));
      }
      syncPlaceholder();
    }

    /**
     * 把一段文本插到末尾（**不发送**），并保证命令着色与焦点就位。
     *
     * 与原生 textarea 的插入语义保持一致：已有内容且不以空白结尾时补一个空格。
     *
     * @param {string} text
     * @returns {string} 插入后的纯文本
     */
    function insert(text) {
      if (typeof text !== "string" || text === "") return getText();
      const cur = getText();
      const next = cur === "" || /\s$/.test(cur) ? `${cur}${text}` : `${cur} ${text}`;
      setText(next);
      moveCaretToEnd();
      return next;
    }

    /** 把光标放到末尾（插入之后用户接着打字，不该跳回开头）。 */
    function moveCaretToEnd() {
      const sel = global.getSelection === undefined ? null : global.getSelection();
      if (sel === null) return;
      const range = global.document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }

    /** 取焦点。 */
    function focus() {
      if (typeof el.focus === "function") el.focus();
      moveCaretToEnd();
    }

    /** 改占位提示（参数引导用）。 */
    function setPlaceholder(text) {
      placeholder = typeof text === "string" ? text : "";
      syncPlaceholder();
    }

    /** 取当前占位提示。 */
    function getPlaceholder() {
      return placeholder;
    }

    /* 用户输入：重新着色 + 通知 + 更新占位 */
    el.addEventListener("input", function () {
      paint();
      onChange();
    });
    /* 焦点进出决定占位是否显示（与原生控件的 placeholder 行为一致） */
    el.addEventListener("focus", function () { focused = true; syncPlaceholder(); });
    el.addEventListener("blur", function () { focused = false; syncPlaceholder(); });

    /*
     * 构造时先同步一次。
     *
     * 真实踩过：只在 setText / 事件里同步，那么「页面刚打开、用户还没输入」
     * 这个最常见的状态反而没有占位提示 —— 因为谁都没触发过同步。
     */
    paint();

    return {
      clear,
      el,
      focus,
      getPlaceholder,
      getText,
      insert,
      isEmpty,
      /** 内容变化时重新着色（供外部在程序化改动后调用）。 */
      repaint: paint,
      setPlaceholder,
      setText,
      /** 当前是否为「已进入命令模式」（命令在开头）。 */
      commandMode() { return leadingCommandLength(getText()) > 0; },
    };
  }

  global.WhaleRichInput = { TOKEN_CLASS, createRichInput };
})(typeof window !== "undefined" ? window : globalThis);

/**
 * 输入区（富文本输入框 + 参数引导）
 *
 * 职责：装配输入框，并给出「读文本 / 写文本 / 插入 / 清空 / 参数引导」这几个动作。
 *       所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：
 *   1. 这已是**一个独立的业务域**：输入框从 `<textarea>` 换成富文本
 *      （contenteditable）之后，需要维护的东西变多了 —— 取值、写入、
 *      清空、占位提示、参数引导，它们互相依赖同一份状态，散在 app.js 里
 *      既难看清也顶破了 500 行上限（开发规范 强制 14）。
 *   2. app.js 是装配层，应该只做接线；输入区的细节收在这一处。
 *
 * ⚠️ **输入框没有 `value`**（那是纯文本控件的属性）。业务侧一律走这里，
 * 谁残留 `value` 谁就读到 undefined，表现为「发出空消息」，很难定位。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleInputArea。
 */

(function attachInputArea(global) {
  "use strict";

  /** 默认占位提示：未进入任何命令时的引导文案。 */
  const DEFAULT_PLACEHOLDER = "问点什么…  Enter 发送 / Shift+Enter 换行";

  /**
   * 建输入区。
   *
   * @param {object} deps
   * @param {HTMLElement} deps.el 承载编辑的元素（contenteditable）
   * @param {() => Promise<Array<object>>} [deps.listCommands] 取宿主命令表（用于补齐写法）
   * @param {Array<string>} [deps.initialTokens] 起始的已知写法（主窗口的中文写法）
   * @param {() => void} [deps.onTextChange] 文本变化（斜杠面板靠它同步）
   * @returns {object} 输入区
   */
  function createInputArea(deps) {
    const onTextChange = typeof deps.onTextChange === "function" ? deps.onTextChange : function () {};

    /*
     * 已知的命令写法（决定哪一段会被染成命令色）。
     *
     * 两类都要有，缺一不可：
     *   1. **主窗口的中文写法**（目标 / 计划 / 压缩 …）——＋菜单点内置命令插的就是它；
     *   2. **宿主的真实命令名**（btw / mnemon / goal …）——点未列进分组的宿主命令插的是它。
     *
     * 真实缺陷：只收第 1 类时，用户点「btw」插入 `/btw ` 却**不变蓝** ——
     * 而 btw 正是最常用的那条。教训是「写法表必须是**可增长**的」：
     * 宿主命令名要等一次网络往返才拿到，启动时拍个快照必然漏掉。
     */
    const tokens = new Set(
      Array.isArray(deps.initialTokens) ? deps.initialTokens.filter((t) => typeof t === "string" && t !== "") : [],
    );
    /** 待重绘的标记：写法表在编辑器建好之前就可能被补充。 */
    let editorRef = null;

    /**
     * 登记一个命令写法为「已知」，必要时重绘让已输入的命令立刻变蓝。
     * @param {string} name
     */
    function rememberToken(name) {
      if (typeof name !== "string" || name === "") return;
      if (tokens.has(name)) return;
      tokens.add(name);
      if (editorRef !== null) editorRef.repaint();
    }

    const editor = global.WhaleRichInput.createRichInput({
      el: deps.el,
      commandTokens: () => Array.from(tokens),
      placeholder: DEFAULT_PLACEHOLDER,
      onChange() {
        // 清空之后参数引导也该退场（否则它会一直黏着，
        // 让人以为输入框里已经有东西了）
        if (editor.isEmpty()) editor.setPlaceholder(DEFAULT_PLACEHOLDER);
        onTextChange();
      },
    });
    editorRef = editor;

    /**
     * 从宿主命令表补齐写法。
     *
     * ⚠️ 要**等会话就绪**再调（启动那一刻 sessionId 还是空的，
     * 直接问宿主会老实返回空表）。调用方负责时机。
     */
    function rememberHostCommands() {
      if (typeof deps.listCommands !== "function") return Promise.resolve();
      return Promise.resolve(deps.listCommands()).then((list) => {
        if (!Array.isArray(list)) return;
        for (const cmd of list) rememberToken(cmd?.name);
      }).catch(function () { /* 拿不到就算了，不影响插入与着色 */ });
    }

    /**
     * 命令需要参数时，用占位提示告诉用户该写什么。
     *
     * 复刻主窗口的做法：点「计划」之后输入框提示「描述你的任务以生成计划」，
     * 而不是让用户对着一个光秃秃的 `/计划 ` 发呆。
     *
     * ⚠️ `justInserted` 不是可选装饰。真实缺陷：这个函数在插入**之后**才
     * 被调用，输入框里必然已有内容；若只判断「非空就不引导」，条件恒为真、
     * 引导永不显示（一段看起来很合理的死代码）。
     *
     * @param {string} hint 宿主给的参数说明（可空）
     * @param {string} [justInserted] 刚插进输入框的那段文本
     */
    function showArgHint(hint, justInserted) {
      const untouched = justInserted === undefined
        || editor.getText().trim() === justInserted.trim();
      if (!untouched || hint === "") {
        editor.setPlaceholder(DEFAULT_PLACEHOLDER);
        return;
      }
      editor.setPlaceholder(`接着写：${hint}`);
    }

    /**
     * 接管粘贴。
     *
     * 富文本化的**必要防线**：contenteditable 默认把外部 HTML 原样插进来，
     * 于是从网页粘一段带颜色的文字就会把样式带进输入框 ——
     * 命令着色被外来颜色盖掉，输入框里出现一段「洗不掉」的样式。
     * 所以图片之外的粘贴一律只取纯文本。
     *
     * @param {(files: Array<File>) => void} [onImageFiles] 粘贴的图片走附件
     */
    function bindPaste(onImageFiles) {
      deps.el.addEventListener("paste", function (ev) {
        const items = ev.clipboardData?.items;
        if (items) {
          const imageFiles = [];
          for (const item of items) {
            if (item.kind === "file") {
              const f = item.getAsFile();
              if (f) imageFiles.push(f);
            }
          }
          if (imageFiles.length > 0) {
            ev.preventDefault();
            if (typeof onImageFiles === "function") onImageFiles(imageFiles);
            return;
          }
        }
        // 纯文本粘贴：拦掉浏览器默认的「带样式插入」
        ev.preventDefault();
        const text = ev.clipboardData?.getData?.("text/plain") ?? "";
        if (text !== "") editor.insert(text);
      });
    }

    return {
      /** 接管粘贴（图片走附件，文本按纯文本）。 */
      bindPaste,
      /** 清空（发送成功后）。 */
      clear: () => editor.clear(),
      /** 是否为空（发送前判断用）。 */
      isEmpty: () => editor.isEmpty(),
      /** 取纯文本（发给宿主的正文）。 */
      getText: () => editor.getText(),
      /** 写入纯文本（发送失败后还原）。 */
      setText: (text) => editor.setText(text),
      /** 把文本插进输入框（**不发送**）。 */
      insert(text) {
        /*
         * 插进来的是命令（`/写法 `）时先登记写法 —— 这样它立刻会被染色。
         * 用户点菜单时命令名是**已知的事实**，比等宿主命令表回来更可靠。
         */
        const m = /^\/(\S+)/.exec(typeof text === "string" ? text : "");
        if (m !== null) rememberToken(m[1]);
        return editor.insert(text);
      },
      /**
       * 重新着色。
       *
       * 命令写法是异步补齐的（宿主命令表要等一次网络往返），
       * 新写法到达后要重绘一次，否则已经在输入框里的那条命令不会立刻变蓝。
       */
      repaint: () => editor.repaint(),
      /** 登记一个命令写法（供上层在拿到宿主命令表后补）。 */
      rememberToken,
      /** 从宿主命令表补齐全部写法（要在会话就绪后调）。 */
      rememberHostCommands,
      /**
       * 选中一条命令：**按类型分流**，不是一律执行。
       *
       * 复刻主窗口的决策表（见 DSH 命令包）：
       *   带参数声明的 → 进入等待参数态（插进输入框，等用户补完再发）；
       *   其余         → 交回上层去执行。
       *
       * 用户报「选择某个指令就直接被发送出去了」——他点的是候选面板里的条目。
       * 原先一律执行，于是 `/btw` 这种要填参数的命令一点就被执行掉了；
       * 主窗口不是这个行为。
       *
       * @param {string} command 命令行（含前导斜杠）
       * @param {{hint?: (string|null)}|undefined} item 面板条目（带参数声明）
       * @param {(cmd: string) => void} run 真正执行命令的回调（上层注入）
       * @returns {"inserted"|"executed"}
       */
      pick(command, item, run) {
        if (typeof item?.hint === "string" && item.hint !== "") {
          /*
           * 需要参数：把命令**认领**进输入框（带尾空格），并提示该写什么。
           *
           * ⚠️ 用 `claimCommand` 而不是 `insert`：用户是从候选面板选中的，
           * 草稿开头那个 `/` 是他敲来唤出面板的**命令引导符**，不是正文。
           * 用追加会得到 `//btw`（用户报的就是这个），主窗口是替换。
           */
          const claimed = editor.claimCommand(`${command} `);
          editor.focus();
          showArgHint(item.hint, claimed);
          return "inserted";
        }
        if (typeof run === "function") run(command);
        return "executed";
      },
      showArgHint,
    };
  }

  global.WhaleInputArea = { DEFAULT_PLACEHOLDER, createInputArea };
})(typeof window !== "undefined" ? window : globalThis);

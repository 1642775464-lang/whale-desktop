/*
 * 斜杠命令面板
 *
 * 职责：输入框里敲 `/` 时弹出命令面板、实时过滤、Esc 关闭；
 *       并保证「面板打开时 Enter 不发送」（避免误把命令发出去）。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：它是**唯一一个会拦截键盘输入的浮层**。
 * 输入区的 Enter 语义、面板的 Esc 语义、以及「删掉 / 就关闭」三者
 * 互相牵制，混在 app.js 里最容易出现「按了没反应」或「命令被当消息发出去」。
 *
 * 命令清单是**本地固定表**，不从宿主拉（《页面框架》4.3 列的就是固定项）。
 * 灰色项（如语音）刻意置灰且**点击无任何静默效果** —— 不假装能用
 * （《前端设计规范》2：灰 = 能力未接通）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhalePalette。
 */

(function attachPalette(global) {
  "use strict";

  /**
   * 命令清单。
   *
   * `command` 为 null 表示「能力未接通」→ 渲染成灰色、点击无效果。
   * 这与规范里「灰 = 能力未接通，不假装能用」是同一条纪律。
   */
  const COMMANDS = [
    { icon: "⚡", label: "插件·技能·伙伴", command: "/sk" },
    { icon: "⚡", label: "技能管理", command: "/skills" },
    { icon: "🎤", label: "语音", suffix: "（暂不可用）", command: null },
  ];

  /**
   * 按已输入内容过滤命令。
   *
   * 匹配规则：把已输入（含前导 `/`）与命令名、标签做**不区分大小写的包含**判断。
   * 用包含而不是前缀：用户常记得「技能」而不是 `/skills`。
   *
   * @param {string} typed 已输入内容（含前导 /）
   * @returns {Array<object>}
   */
  function filterCommands(typed) {
    const q = String(typed ?? "").replace(/^\//, "").trim().toLowerCase();
    if (q === "") return COMMANDS.slice();
    return COMMANDS.filter(function (c) {
      return (
        c.command !== null &&
        (c.command.toLowerCase().includes(q) || c.label.toLowerCase().includes(q))
      );
    });
  }

  /**
   * 建一个面板控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {panel, query, list, input}
   * @param {(command: string) => void} deps.onPick 选中一条可用命令时回调
   * @param {(msg: string) => void} [deps.onUnavailable] 点了灰色项时回调（用于如实提示）
   * @returns {object} 控制器
   */
  function createPalette(deps) {
    const dom = deps.dom;
    const onPick = deps.onPick;
    const onUnavailable = typeof deps.onUnavailable === "function" ? deps.onUnavailable : function () {};

    /** 面板是否打开。 */
    let open = false;
    /** 当前渲染出来的条目（点选时按下标取）。 */
    let items = [];

    /** 渲染清单。 */
    function render(typed) {
      items = filterCommands(typed);
      dom.query.textContent = typed;

      dom.list.innerHTML = "";
      if (items.length === 0) {
        const none = global.document.createElement("div");
        none.className = "mi grey";
        none.textContent = "没有匹配的命令";
        dom.list.appendChild(none);
        return;
      }

      items.forEach(function (c) {
        const row = global.document.createElement("div");
        // 灰色项用 .grey：规范要求它没有 hover 反馈
        row.className = c.command === null ? "mi grey" : "mi";
        row.textContent = `${c.icon} ${c.label}${c.suffix ?? ""}`;
        row.addEventListener("click", function () {
          if (c.command === null) {
            // 不假装能用：明确告诉调用方，由它决定怎么如实提示
            onUnavailable(`${c.label}${c.suffix ?? ""}`);
            return;
          }
          close();
          onPick(c.command);
        });
        dom.list.appendChild(row);
      });
    }

    /**
     * 输入变化时调用：决定开还是关。
     *
     * 规则（页面框架 4.3）：敲 `/` 弹出、删掉 `/` 关闭、继续打字实时过滤。
     */
    function sync() {
      const value = dom.input.value;
      // 只在「以 / 开头且还没输入空格」时开面板：
      // 输入空格说明用户在写正文，不是选命令
      const shouldOpen = value.startsWith("/") && !value.includes(" ");

      if (!shouldOpen) {
        if (open) close();
        return;
      }
      open = true;
      dom.panel.hidden = false;
      render(value.split(" ")[0]);
    }

    /** 关闭面板。 */
    function close() {
      open = false;
      dom.panel.hidden = true;
      items = [];
    }

    /**
     * 键盘处理。
     *
     * @param {KeyboardEvent} ev
     * @returns {boolean} 是否已消费该事件（true = 调用方不要再处理）
     */
    function onKeyDown(ev) {
      if (!open) return false;
      if (ev.key === "Escape") {
        ev.preventDefault();
        close();
        return true;
      }
      // 面板开着时 Enter **不发送**（避免误把命令发出去），
      // 而是选中第一条可用命令
      if (ev.key === "Enter") {
        ev.preventDefault();
        const first = items.filter(function (c) { return c.command !== null; })[0];
        if (first !== undefined) {
          close();
          onPick(first.command);
        }
        return true;
      }
      return false;
    }

    /** 面板当前是否打开（测试与调用方判断用）。 */
    function isOpen() {
      return open;
    }

    return { close, isOpen, onKeyDown, render, sync };
  }

  global.WhalePalette = {
    COMMANDS,
    createPalette,
    filterCommands,
  };
})(typeof window !== "undefined" ? window : globalThis);

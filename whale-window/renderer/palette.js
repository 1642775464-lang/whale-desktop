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
   * 兜底命令清单（**仅当桥拿不到真命令表时**使用）。
   *
   * 切片 7 起，命令表一律问宿主（`GET /whale/commands`）。
   * 这份本地表只在桥不可用时顶上，避免面板整个空掉。
   *
   * `command` 为 null 表示「能力未接通」→ 渲染成灰色、点击无效果，
   * 与规范里「灰 = 能力未接通，不假装能用」同一条纪律。
   */
  const FALLBACK_COMMANDS = [
    { icon: "⚡", label: "插件·技能·伙伴", command: "/sk" },
    { icon: "⚡", label: "技能管理", command: "/skills" },
    { icon: "🎤", label: "语音", suffix: "（暂不可用）", command: null },
  ];

  /**
   * 把宿主返回的命令条目转成面板条目。
   *
   * 宿主 descriptor 形状：`{name, description, hint, definitionId}`。
   * - `name` 是**不含斜杠**的命令名（如 `permission`）→ 补上 `/` 才能当命令用
   * - `hint` 是参数占位（如 `<preset>`）→ 显示在描述里，用户才知道还要填什么
   *
   * @param {Array<object>} list 宿主命令表
   * @returns {Array<object>}
   */
  function fromHost(list) {
    return list.map(function (c) {
      const name = String(c.name);
      // 描述后面缀上参数提示（若有）：图上「权限 permission / 切换权限预设」那样
      const desc = c.hint ? `${c.description}  ${c.hint}` : c.description;
      return {
        icon: "⌘",
        label: name,
        desc: desc || "",
        command: `/${name}`,
      };
    });
  }

  /**
   * 按已输入内容过滤命令。
   *
   * 匹配规则：把已输入（含前导 `/`）与命令名、描述做**不区分大小写的包含**判断。
   * 用包含而不是前缀：用户常记得「权限」而不是 `/permission`。
   *
   * @param {string} typed 已输入内容（含前导 /）
   * @param {Array<object>} [commands] 命令表；不传用兜底表
   * @returns {Array<object>}
   */
  function filterCommands(typed, commands) {
    const source = Array.isArray(commands) && commands.length > 0 ? commands : FALLBACK_COMMANDS;
    const q = String(typed ?? "").replace(/^\//, "").trim().toLowerCase();
    if (q === "") return source.slice();
    return source.filter(function (c) {
      return (
        c.command !== null &&
        (String(c.command).toLowerCase().includes(q)
          || String(c.label).toLowerCase().includes(q)
          || String(c.desc ?? "").toLowerCase().includes(q))
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
    const onNeedCommands = typeof deps.onNeedCommands === "function" ? deps.onNeedCommands : null;

    /** 面板是否打开。 */
    let open = false;
    /** 当前渲染出来的条目（点选时按下标取）。 */
    let items = [];
    /** 宿主的真命令表；还没拉到或用兜底表时为 null。 */
    let hostCommands = null;
    /** 正在拉命令表（避免连打几个字符触发多次请求）。 */
    let loading = false;

    /** 渲染清单。 */
    function render(typed) {
      items = filterCommands(typed, hostCommands);
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
        // 左名右描述（对齐宿主面板的排版）：有描述就分两栏
        const name = global.document.createElement("span");
        name.className = "mi-name";
        name.textContent = `${c.icon ?? "⌘"} ${c.label}${c.suffix ?? ""}`;
        row.appendChild(name);
        if (typeof c.desc === "string" && c.desc !== "") {
          const desc = global.document.createElement("span");
          desc.className = "mi-desc";
          desc.textContent = c.desc;
          row.appendChild(desc);
        }
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
     * 拉一次宿主的命令表。
     *
     * 只在面板首次打开时拉，并缓存——命令表在一次会话里基本不变，
     * 每次打字都请求会让面板闪烁且白耗带宽。
     *
     * @returns {Promise<void>}
     */
    function ensureCommands() {
      if (hostCommands !== null || loading || onNeedCommands === null) return Promise.resolve();
      loading = true;
      return Promise.resolve(onNeedCommands())
        .then(function (list) {
          loading = false;
          if (Array.isArray(list) && list.length > 0) {
            hostCommands = fromHost(list);
            // 拉到之后立刻重画：用户可能已经打了一半
            if (open) render(dom.query.textContent);
          }
        })
        .catch(function () { loading = false; });
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
      // 首次打开时去拉宿主的真命令表；拉到会自动重画
      void ensureCommands();
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
    FALLBACK_COMMANDS,
    createPalette,
    filterCommands,
    fromHost,
  };
})(typeof window !== "undefined" ? window : globalThis);

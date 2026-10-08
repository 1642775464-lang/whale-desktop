/**
 * ＋ 菜单（与主窗口的＋号菜单对齐）
 *
 * 职责：渲染 ＋ 浮层的内容 —— 上传拖拽区、文件引用（`@`）、宿主指令列表；
 *       以及文件搜索。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：
 *   1. 这是**独立的业务域**（主窗口把＋号做成一份分组菜单，
 *      而「引用文件 / 插入指令」与权限、模型那几个浮层是两类操作）。
 *   2. overlays.js 装不下它了（500 行上限，强制 14）。
 *
 * 两条纪律：
 *   · **内容全部来自宿主**：指令走 `/whale/commands`（宿主真命令表），
 *     文件走 `/whale/files`（即宿主 fileReferences）。一条都不硬编码，
 *     宿主加了命令/换目录自动跟着变。
 *   · 点击一律**插进输入框待发送**（用户裁定 A），不是立即执行——
 *     与主窗口的 `@` / `/` 语义一致，也不会误发消息。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleAddMenu。
 */

(function attachAddMenu(global) {
  "use strict";

  /**
   * 建 ＋ 菜单渲染器。
   *
   * @param {object} deps
   * @param {object} deps.dom {ovTitle, ovBody}
   * @param {() => object} deps.clientOf 取当前客户端（延迟取值）
   * @param {() => (string|null)} deps.currentOf 取当前打开的浮层名（用于「切走了就别再塞」）
   * @param {(text: string) => void} deps.insertIntoInput 插进输入框（不发送）
   * @param {() => void} deps.onPickFiles 打开文件选择器
   * @param {(files: Array<File>) => void} deps.onFiles 收到文件
   * @param {() => void} [deps.close] 关闭浮层
   * @param {(text: string) => object} deps.row 用共享的两栏行渲染
   * @param {(text: string) => object} deps.note 用共享的空态行渲染
   * @returns {{ renderAdd: Function, renderFileSearch: Function }}
   */
  function createAddMenu(deps) {
    const dom = deps.dom;
    const clientOf = deps.clientOf;
    const currentOf = deps.currentOf;
    const insertIntoInput = deps.insertIntoInput;
    const row = deps.row;
    const note = deps.note;
    const close = typeof deps.close === "function" ? deps.close : function () {};

    /** 建一个分组标题（与主窗口菜单的分组一致）。 */
    function groupLabel(text) {
      const el = global.document.createElement("div");
      el.className = "ov-group";
      el.textContent = text;
      return el;
    }

    /**
     * 上传拖拽区。
     *
     * 独立成函数是因为它与「菜单」是两条通路：菜单是插入引用/指令，
     * 这里是**真上传**。加菜单不能把它挤掉（有测试守着）。
     */
    function uploadZone() {
      const drop = global.document.createElement("div");
      drop.className = "upl-drop";
      drop.textContent = "把文件拖到这里，或点击选择上传";
      drop.addEventListener("click", function () {
        if (typeof deps.onPickFiles === "function") deps.onPickFiles();
      });
      drop.addEventListener("dragover", function (ev) {
        ev.preventDefault();
        drop.classList.add("over");
      });
      drop.addEventListener("dragleave", function () {
        drop.classList.remove("over");
      });
      drop.addEventListener("drop", function (ev) {
        ev.preventDefault();
        drop.classList.remove("over");
        const files = ev.dataTransfer && ev.dataTransfer.files;
        if (files && files.length > 0) deps.onFiles(Array.from(files));
      });
      return drop;
    }

    /**
     * ＋ 浮层：与主窗口的＋号菜单对齐。
     *
     * 主窗口那份是分组菜单（文件 / 目标 / 计划 / 反馈 /（指令组）…），
     * 而小窗原先只有一个拖拽上传区 —— 用户报「＋号交互内容和主窗口没有对齐」。
     */
    async function renderAdd() {
      dom.ovTitle.textContent = "添加";
      dom.ovBody.innerHTML = "";
      dom.ovBody.appendChild(uploadZone());

      // 「文件」：进搜索（插入 @路径 待发送）
      dom.ovBody.appendChild(row("文件", "引用工作区文件", null, {
        onClick() { renderFileSearch(""); },
      }));

      // 指令组：走宿主真命令表
      const commands = await clientOf().listCommands();
      // 判据是「已经切到**别的**浮层」而不是「必须等于 add」——
      // renderAdd 也可能被直接调用（测试、或将来别的入口），
      // 要求必须是 add 会让它在没 toggle 过的场景下静默什么都不渲染。
      const now = currentOf();
      if (now !== null && now !== "add") return;

      const list = Array.isArray(commands) ? commands : [];
      if (list.length === 0) {
        dom.ovBody.appendChild(note("读不到指令清单（宿主未提供或该会话没有可用命令）"));
        return;
      }
      dom.ovBody.appendChild(groupLabel("指令"));
      list.forEach(function (cmd) {
        const name = cmd?.name;
        if (typeof name !== "string" || name === "") return;
        // 右侧显示宿主的说明；有 hint 时补上「要填什么」，用户才知道后面接参数
        const desc = `${cmd.description ?? ""}${cmd.hint ? `（${cmd.hint}）` : ""}`;
        dom.ovBody.appendChild(row(name, desc, null, {
          onClick() { insertIntoInput(`/${name}`); close(); },
        }));
      });
    }

    /**
     * 文件搜索：列出工作区文件，点一条**插入 `@路径` 待发送**。
     *
     * 与主窗口的 `@` 补全同一语义（插入引用，等用户补完再发）。
     * 搜不到要如实说，**不编造候选**（编出来的路径点了会拿到不存在的文件）。
     *
     * @param {string} [query]
     */
    async function renderFileSearch(query = "") {
      dom.ovTitle.textContent = "引用文件";
      dom.ovBody.innerHTML = "";
      dom.ovBody.appendChild(row("‹ 返回", "", null, { onClick() { renderAdd(); } }));

      const box = global.document.createElement("input");
      box.className = "ov-search";
      box.setAttribute("placeholder", "输入文件名筛选…");
      box.value = query;
      let timer = null;
      box.addEventListener("input", function () {
        // 防抖：每敲一个字都搜一次会把宿主敲爆
        if (timer !== null) global.clearTimeout(timer);
        timer = global.setTimeout(function () { renderFileSearch(box.value); }, 200);
      });
      dom.ovBody.appendChild(box);

      const candidates = await clientOf().fileReferences(query);
      const now = currentOf();
      if (now !== null && now !== "add") return;

      const list = Array.isArray(candidates) ? candidates : [];
      if (list.length === 0) {
        dom.ovBody.appendChild(note(query === "" ? "工作区里没有可引用的文件" : `没有匹配「${query}」的文件`));
        return;
      }
      list.forEach(function (item) {
        const path = item?.path;
        if (typeof path !== "string" || path === "") return;
        const isDir = item?.kind === "directory";
        dom.ovBody.appendChild(row(path, isDir ? "目录" : "", null, {
          onClick() {
            // 目录再进一层；文件才插入引用（主窗口也是这个行为）
            if (isDir) renderFileSearch(path);
            else { insertIntoInput(`@${path}`); close(); }
          },
        }));
      });
    }

    return { renderAdd, renderFileSearch };
  }

  global.WhaleAddMenu = { createAddMenu };
})(typeof window !== "undefined" ? window : globalThis);

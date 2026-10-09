/**
 * ＋ 菜单（与主窗口的＋号菜单对齐）
 *
 * 职责：渲染 ＋ 浮层的内容 —— 上传拖拽区、分组菜单（添加 / 指令，带图标）、
 *       以及文件搜索。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：
 *   1. 这是**独立的业务域**（主窗口把＋号做成一份分组菜单，
 *      而「引用文件 / 插入指令」与权限、模型那几个浮层是两类操作）。
 *   2. overlays.js 装不下它了（500 行上限，强制 14）。
 *
 * 三条纪律：
 *   · **命令本体全部来自宿主**：走 `/whale/commands`（宿主真命令表），
 *     文件走 `/whale/files`（即宿主 fileReferences）。宿主加了命令会自动
 *     出现在「指令」末尾，一条都不硬编码。
 *   · **分组与图标来自 menu-icons.js**（机械提取的 DSH 主窗口数据）：
 *     宿主 RPC 不返回分组与图标（那是 DSH 客户端按 definitionId 绑的），
 *     所以这两样必须另有来源，不能靠猜。
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
   * @param {() => void} [deps.onOpenModel] 打开模型浮层（「模型」行用）
   * @param {(hint: string) => void} [deps.onNeedArgs] 命令需要参数时的引导（hint 可能为空）
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
     * 主窗口那份是分组菜单：「添加」（文件 / 目标 / 计划 / 反馈）
     * +「指令」（压缩 / 权限 / 模型 / 下载日志 / …），每行带图标、
     * 本地化的标题与说明。小窗原先只有一个拖拽上传区，后来补了「文件」
     * 与平铺的指令列表 —— 用户报「目标/计划还是缺失的，而且也没有图标」。
     *
     * 为什么不能只平铺宿主命令表：
     *   主窗口把 goal / plan / feedback 这三条从「指令」里**提出来**
     *   放进「添加」组，还给了中文标题和图标。而宿主的 `/whale/commands`
     *   返回的是扁平的 `{name, description, hint}`，既没有分组也没有图标
     *   （图标与中文标题是宿主 GUI 按内置命令标识绑定的，不在 RPC 里）。
     *   所以分组与图标必须由 menu-icons.js 提供，命令本体仍走宿主表。
     *
     * @param {string[]} list 宿主返回的命令清单
     */
    function renderSections(list) {
      const icons = global.WhaleMenuIcons;
      const byName = new Map();
      list.forEach(function (cmd) {
        if (typeof cmd?.name === "string" && cmd.name !== "") byName.set(cmd.name, cmd);
      });

      const sections = Array.isArray(icons?.SECTIONS) ? icons.SECTIONS : [];
      if (sections.length === 0) {
        // 图标模块没到（脚本加载顺序被改动、或那一行被删）时的降级路径：
        // 退回「文件 + 平铺指令」。宁可少图标，也不能让整个＋菜单变空——
        // 那会表现为「点＋什么都没出来」，比缺图标难查得多。
        dom.ovBody.appendChild(row("文件", "引用工作区文件", null, {
          onClick() { renderFileSearch(""); },
        }));
        if (list.length > 0) {
          dom.ovBody.appendChild(groupLabel("指令"));
          list.forEach(function (cmd) { dom.ovBody.appendChild(menuRow(cmd.name, cmd, undefined)); });
        }
        return;
      }

      // 「文件」不是宿主命令（它是引用工作区文件的入口，走本地文件搜索）
      if (!byName.has("file")) byName.set("file", null);

      const placed = new Set();
      sections.forEach(function (section) {
        const rows = Array.isArray(section.rows) ? section.rows : [];
        const present = rows.filter(function (name) {
          return byName.has(name) || name === "model";
        });
        if (present.length === 0) return;
        dom.ovBody.appendChild(groupLabel(section.label));
        present.forEach(function (name) {
          placed.add(name);
          dom.ovBody.appendChild(menuRow(name, byName.get(name), icons));
        });
      });

      // 宿主里还有、但主窗口没列进这两个分组的命令（btw / mnemon / 将来新增的）
      // 统一收在「指令」末尾 —— 用户此前裁定：不硬编码，宿主加了命令要自动跟出来。
      const rest = list.filter(function (cmd) {
        return typeof cmd?.name === "string" && !placed.has(cmd.name);
      });
      if (rest.length > 0) {
        if (!sections.some(function (s) { return s.name === "commands"; })) {
          dom.ovBody.appendChild(groupLabel("指令"));
        }
        rest.forEach(function (cmd) {
          dom.ovBody.appendChild(menuRow(cmd.name, cmd, null));
        });
      }
    }

    /**
     * 渲染一个菜单行。
     *
     * 标题优先用主窗口的中文标题（icons.LABELS），没有才退回命令名；
     * 说明优先用中文说明，退回宿主给的描述（btw / mnemon 这类宿主自带中文的
     * 命令就落在这条路上）。
     *
     * ⚠️ **内置命令（有中文说明的那几条）不拼 hint**。主窗口对它们只显示
     * 本地化说明——「反馈」右边是「发送关于当前会话的反馈」，不是
     * 「…（<text>）」；「权限」也不带 `<preset>`。早先一律拼 hint，
     * 于是小窗比主窗口多出一截 `（<text>）`，看着像两边的文案对不上。
     * 其余命令没有中文说明，hint 是用户唯一能知道「后面要填什么」的来源，保留。
     *
     * @param {string} name 命令名（也是菜单行标识）
     * @param {{description?: string, hint?: string}|null} cmd 宿主命令（file 行为 null）
     * @param {object|undefined} icons 图标模块（可能未加载）
     */
    function menuRow(name, cmd, icons) {
      const localizedLabel = icons?.LABELS?.[name];
      const localizedDesc = icons?.DESCRIPTIONS?.[name];
      const label = localizedLabel ?? name;
      const isBuiltin = typeof localizedDesc === "string";
      const base = localizedDesc ?? cmd?.description ?? "";
      const desc = `${base}${!isBuiltin && cmd?.hint ? `（${cmd.hint}）` : ""}`;

      const opts = {};
      const icon = typeof icons?.iconOf === "function" ? icons.iconOf(name) : "";
      if (icon !== "") opts.icon = icon;

      if (name === "file") {
        opts.onClick = function () { renderFileSearch(""); };
      } else if (name === "model") {
        // 模型不走斜杠命令（它是客户端浮层），点开交给上层
        opts.onClick = function () {
          if (typeof deps.onOpenModel === "function") deps.onOpenModel();
          else close();
        };
      } else {
        opts.onClick = function () { insertCommand(name, cmd, icons); close(); };
      }
      return row(label, desc, null, opts);
    }

    /**
     * 把一条命令插进输入框（**不发送**）。
     *
     * 复刻主窗口的 `leadingClaim` 语义（见 DSH 命令包）：
     *   1. 插进去的是**本地化写法**（`/计划` 而不是 `/plan`）——
     *      宿主用一张别名表把中英文写法都解析回真实命令名，所以两种都对；
     *   2. **末尾必须带一个空格**。主窗口插的是 `/${shown} `（尾随空格），
     *      这样用户接着打参数不会与命令名粘成一个词。早先插 `/plan` 不带空格，
     *      用户接着打字就得到 `/plan描述…`，看着像「点了没用」。
     *   3. 有参数声明的命令要把「该写什么」告诉用户（见 notifyNeedArgs）。
     *
     * @param {string} name 真实命令名
     * @param {{hint?: string}|null} cmd 宿主命令
     * @param {object|undefined} icons 图标模块
     */
    function insertCommand(name, cmd, icons) {
      const token = icons?.TOKENS?.[name] ?? name;
      const inserted = `/${token} `;
      insertIntoInput(inserted);
      // 有参数声明的命令：把宿主的参数说明交给上层显示（主窗口也是这个行为，
      // 它把 hint 当作输入引导而不是菜单旁的说明文字）。
      //
      // 把「刚插进去的文本」一起传过去：上层要靠它判断用户是否已经补了参数
      // （否则「输入框非空就不引导」这个条件会恒为真 —— 刚插入的命令本身就是内容）。
      if (typeof deps.onNeedArgs === "function") {
        deps.onNeedArgs(cmd?.hint ?? "", inserted);
      }
    }

    async function renderAdd() {
      dom.ovTitle.textContent = "添加";
      dom.ovBody.innerHTML = "";
      dom.ovBody.appendChild(uploadZone());

      // 指令走宿主真命令表
      const commands = await clientOf().listCommands();
      // 判据是「已经切到**别的**浮层」而不是「必须等于 add」——
      // renderAdd 也可能被直接调用（测试、或将来别的入口），
      // 要求必须是 add 会让它在没 toggle 过的场景下静默什么都不渲染。
      const now = currentOf();
      if (now !== null && now !== "add") return;

      const list = Array.isArray(commands) ? commands : [];
      const icons = global.WhaleMenuIcons;
      if (list.length === 0 && icons === undefined) {
        dom.ovBody.appendChild(note("读不到指令清单（宿主未提供或该会话没有可用命令）"));
        return;
      }
      renderSections(list);
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

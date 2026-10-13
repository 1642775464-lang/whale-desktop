/*
 * 侧边栏的文件面板（列表 + 预览）
 *
 * 职责：展示当前会话工作区的文件，逐层进入，点文件在窗内预览。
 * 所属层：小窗（whale-window/renderer）
 *
 * ## 用户要求
 *
 * > 取消小窗顶栏的文件图标、侧边栏的文件列表，默认展示当前会话工作区的
 * > 文件列表及文件内容，需要支持点击进行预览（md 文件、js 文件、图片、视频、
 * > 音频、word、txt，html 则直接打开侧边栏的浏览器预览）
 *
 * 所以这里是「列表 → 点进去 → 出内容」的一条链，而不是原来那种纯列表。
 *
 * ## 分类判定放在主进程侧（lib/file-preview.cjs）
 *
 * 扩展名表与「哪种方式预览」的规则是**纯逻辑**，放在 `lib/file-preview.cjs`
 * 里可脱 DOM 单测；本文件只负责「按判定结果去取数据、渲染出来」。
 *
 * ## html 要转给浏览器面板
 *
 * 判定为 `browser` 的文件不在这里渲染，而是回调 `onOpenInBrowser(path)` ——
 * 由装配层切到浏览器面板去打开（那里有平板 UA，能正常渲染）。
 *
 * ## 降级纪律
 *
 * 读不到就显示**原因**（含桥给的 code），不显示空白 ——
 * 「文件是空的」与「读不到」含义完全不同。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSideFiles。
 */

(function attachSideFiles(global) {
  "use strict";

  /** 预览方式 → 需要向桥要 base64 的方式（文本类不要）。 */
  const BINARY_MODES = new Set(["image", "video", "audio"]);

  /** 预览方式 → 中文标签（顶栏显示当前在看什么）。 */
  const MODE_LABEL = {
    text: "文本",
    image: "图片",
    video: "视频",
    audio: "音频",
    browser: "网页",
    system: "文档",
  };

  /**
   * 把桥的失败 code 翻成**用户能看懂的一句话**（附 code 便于排查）。
   *
   * 为什么值得单列：`bad-request` 这种串对用户毫无意义，而它恰恰最容易
   * 出现在「会话还没就绪」这种可自愈的场景里 —— 说清楚用户就知道
   * 「不是坏了，是还在连」。
   *
   * @param {string} code
   * @returns {string}
   */
  function explainCode(code) {
    const table = {
      "bad-request": "还没拿到当前会话，稍等一下再试（或先让小窗连上会话）",
      "session-not-found": "当前会话已不存在，换一个会话再试",
      "no-workspace": "这个会话没有工作区路径",
      "not-found": "这个目录读不到",
      network: "连不上桥，稍后重试",
    };
    const human = table[code];
    return human === undefined
      ? `读不到这个目录（${code}）`
      : `${human}（${code}）`;
  }

  /**
   * 建文件面板。
   *
   * @param {object} deps
   * @param {object} deps.dom 元素引用
   * @param {object} deps.client 侧窗桥客户端
   * @param {object} deps.preview 主进程侧的分类函数（file-preview.cjs 的导出）
   * @param {(path: string) => void} deps.onOpenInBrowser html 转给浏览器面板
   * @param {(msg: string) => void} [deps.onNotify]
   * @returns {object} 控制器
   */
  function createSideFiles(deps) {
    const dom = deps.dom;
    const client = deps.client;
    const preview = deps.preview;
    const onNotify = typeof deps.onNotify === "function" ? deps.onNotify : function () {};

    /** 当前目录前缀（空串 = 工作区根）。 */
    let dir = "";
    /** 是否正在看某个文件的内容（true 时「返回」回列表而不是回首页）。 */
    let viewing = null;

    /** 造元素。 */
    function el(tag, cls, text) {
      const e = global.document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    }

    /** 更新面包屑。 */
    function renderCrumb() {
      dom.sfCrumb.textContent = viewing !== null
        ? viewing
        : (dir === "" ? "工作区" : `工作区 / ${dir.replace(/\/$/, "")}`);
    }

    /** 显示失败（与「空目录」区分开）。 */
    function showFailure(message) {
      dom.sfBody.innerHTML = "";
      dom.sfCount.textContent = "–";
      dom.sfBody.appendChild(el("div", "sf-empty", message));
    }

    // ── 列表 ────────────────────────────────────────

    /** 渲染条目列表。 */
    function renderList(entries, reason) {
      dom.sfBody.innerHTML = "";
      dom.sfCount.textContent = String(entries.length);
      if (entries.length === 0) {
        dom.sfBody.appendChild(el("div", "sf-empty",
          typeof reason === "string" && reason !== "" ? reason : "这个目录是空的"));
        return;
      }
      entries.forEach(function (e) {
        const row = el("div", e.kind === "directory" ? "sf-row sf-dir" : "sf-row");
        row.appendChild(el("span", "sf-icon", e.kind === "directory" ? "▸" : "·"));
        const name = el("span", "sf-name", e.name);
        name.title = e.path;
        row.appendChild(name);
        // 右侧标一个「能不能预览」，省得点进去才发现不支持
        if (e.kind !== "directory") {
          const info = preview.previewModeOf(e.name);
          row.appendChild(el("span", "sf-tag", MODE_LABEL[info.mode] ?? ""));
        }
        row.addEventListener("click", function () {
          if (e.kind === "directory") {
            void gotoDir(`${e.path}/`);
            return;
          }
          void openFile(e.path, e.name);
        });
        dom.sfBody.appendChild(row);
      });
    }

    /** 切到某目录。 */
    function gotoDir(next) {
      viewing = null;
      return client.workspaceFiles(next).then(function (out) {
        renderCrumb();
        if (out.ok !== true) {
          dir = "";
          /*
           * ⚠️ 错误要**说人话**。
           * 用户报「文件区域读不到当前工作区」，界面当时显示的是
           * 「读不到这个目录：bad-request」—— 那串 code 对用户毫无意义，
           * 也让人没法判断是「会话没选上」还是「桥挂了」。
           * 这里把最常见的那种翻成人话，并保留 code 便于排查。
           */
          showFailure(explainCode(out.code));
          return out;
        }
        dir = typeof out.dir === "string" ? out.dir : "";
        renderCrumb();
        renderList(out.entries, out.reason);
        return out;
      });
    }

    // ── 预览 ────────────────────────────────────────

    /** 渲染文本类（md 出排版，其余按纯文本）。 */
    function renderText(info, text, size) {
      if (info.markdown) {
        const box = el("div", "sf-md");
        // renderMarkdown 内部已转义，可安全 innerHTML
        box.innerHTML = preview.renderMarkdown(text);
        dom.sfBody.appendChild(box);
        return;
      }
      const pre = el("pre", "sf-text", text);
      dom.sfBody.appendChild(pre);
      // 大文件给个提示：内容是全的，只是滚动很长
      if (size !== null && size > 200 * 1024) {
        dom.sfBody.appendChild(el("div", "sf-hint", `（完整内容，${Math.round(size / 1024)} KB）`));
      }
    }

    /** 渲染图片 / 音视频（拼 data URL）。 */
    function renderBinary(info, base64, size) {
      const mime = preview.mimeOf(info.ext);
      const url = `data:${mime};base64,${base64}`;
      if (info.mode === "image") {
        const img = global.document.createElement("img");
        img.className = "sf-image";
        img.src = url;
        img.alt = viewing ?? "";
        dom.sfBody.appendChild(img);
      } else if (info.mode === "video") {
        const v = global.document.createElement("video");
        v.className = "sf-media";
        v.src = url;
        v.controls = true;
        dom.sfBody.appendChild(v);
      } else {
        const a = global.document.createElement("audio");
        a.className = "sf-audio";
        a.src = url;
        a.controls = true;
        dom.sfBody.appendChild(a);
      }
      if (size !== null) {
        dom.sfBody.appendChild(el("div", "sf-hint", `${Math.round(size / 1024)} KB`));
      }
    }

    /** 打开一个文件（预览）。 */
    function openFile(path, name) {
      const info = preview.previewModeOf(name ?? path);

      /*
       * html 转给浏览器面板（那里有平板 UA）。
       * 用 file:// 绝对地址：桥给的是工作区相对路径，浏览器面板要能直接加载。
       */
      if (info.mode === "browser") {
        deps.onOpenInBrowser(path);
        return Promise.resolve({ ok: true, delegated: true });
      }

      viewing = path;
      renderCrumb();
      dom.sfBody.innerHTML = "";
      dom.sfCount.textContent = MODE_LABEL[info.mode] ?? "";

      // 不能内嵌预览的（word/excel/未知二进制）给一条明确出路
      if (info.mode === "system") {
        const box = el("div", "sf-empty");
        box.textContent = `「.${info.ext || "?"}」不能在窗内预览`;
        const btn = el("button", "sf-open", "用系统默认程序打开");
        btn.addEventListener("click", function () {
          client.openWorkspacePath(path).then(function (out) {
            if (out.ok === true) return;
            onNotify(`打开失败（${out.code}）`);
          });
        });
        box.appendChild(el("div", "sf-gap"));
        box.appendChild(btn);
        dom.sfBody.appendChild(box);
        return Promise.resolve({ ok: true, mode: "system" });
      }

      const loading = el("div", "sf-empty", "读取中…");
      dom.sfBody.appendChild(loading);

      const wantBinary = BINARY_MODES.has(info.mode);
      return client.readWorkspaceFile(path, wantBinary).then(function (out) {
        dom.sfBody.innerHTML = "";
        if (out.ok !== true) {
          // 读不到就说原因（含桥的 code），不留空白
          dom.sfBody.appendChild(el("div", "sf-empty", `读不到这个文件：${out.code}`));
          onNotify(`读不到文件（${out.code}）`);
          return out;
        }
        if (wantBinary) {
          if (typeof out.base64 !== "string") {
            dom.sfBody.appendChild(el("div", "sf-empty", "桥没有返回文件内容"));
            return out;
          }
          renderBinary(info, out.base64, out.size);
          return out;
        }
        renderText(info, out.text ?? "", out.size);
        return out;
      });
    }

    /**
     * 「返回」：看文件时回列表，在列表时回首页。
     *
     * 用户报过「浏览器点击返回不回初始页面」，所以这条规则要明确：
     * **一层一层退**，不是一步跳回首页。
     */
    function back() {
      if (viewing !== null) {
        viewing = null;
        renderCrumb();
        return gotoDir(dir);
      }
      deps.onHome("files");
      return Promise.resolve(null);
    }

    dom.sfBack.addEventListener("click", function () { void back(); });

    return {
      /** 进入面板（默认列当前工作区根）。 */
      enter() {
        viewing = null;
        return gotoDir("");
      },
      gotoDir,
      isViewing: () => viewing !== null,
      openFile,
    };
  }

  global.WhaleSideFiles = { BINARY_MODES, MODE_LABEL, createSideFiles, explainCode };
})(typeof window !== "undefined" ? window : globalThis);

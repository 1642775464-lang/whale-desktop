/*
 * 侧窗装配
 *
 * 职责：把三个入口按钮、三块内容面板、关闭按钮接到一起 ——
 *       谁控制显示、谁负责收起、以及「首页 ⇄ 面板」的切换。
 * 所属层：小窗（whale-window/renderer）
 *
 * ## 切换规则（只有一处实现）
 *
 *   · 首页显示三个入口；点任一个 → 隐藏首页、显示对应面板；
 *   · 面板里的「返回」→ 停掉该面板（停轮询）→ 回到首页；
 *   · 顶栏 ×（以及主窗再次点按钮）→ **收起整个侧窗**（由主进程做动画）。
 *
 * 「同一时刻只显示一块」是这里唯一的共同逻辑，三块面板不各写一遍。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSideApp。
 */

(function attachSideApp(global) {
  "use strict";

  /** 面板名 → 元素 id。 */
  const PANEL_IDS = {
    browser: "pBrowser",
    files: "pFiles",
    chat: "pChat",
  };

  function start() {
    const $ = (id) => global.document.getElementById(id);

    const dom = {
      home: $("sHome"),
      title: $("sbTitle"),
      sClose: $("sClose"),
      sBrowser: $("sBrowser"),
      sFiles: $("sFiles"),
      sChat: $("sChat"),
      sbBack: $("sbBack"),
      sbUrl: $("sbUrl"),
      sbGo: $("sbGo"),
      sbWeb: $("sbWeb"),
      sfBack: $("sfBack"),
      sfCrumb: $("sfCrumb"),
      sfCount: $("sfCount"),
      sfList: $("sfList"),
      scBack: $("scBack"),
      scTitle: $("scTitle"),
      scState: $("scState"),
      scStream: $("scStream"),
      scInput: $("scInput"),
      scSend: $("scSend"),
    };

    const client = global.WhaleSideBridge.createSideClient();

    /** 面板名 → 中文标题（顶栏显示当前在哪一块）。 */
    const TITLES = { browser: "浏览器", files: "文件", chat: "侧边对话" };

    /** 当前显示的面板名；null = 首页。 */
    let current = null;

    const panels = global.WhaleSidePanels.createSidePanels({
      dom,
      client,
      onHome() { goHome(); },
      onNotify(msg) { global.console.warn(msg); },
    });

    /** 显示某块面板。 */
    function showPanel(name) {
      if (current !== null && current !== name) panels.leave(current);
      Object.keys(PANEL_IDS).forEach(function (key) {
        const el = $(PANEL_IDS[key]);
        if (el !== null) el.hidden = key !== name;
      });
      dom.home.hidden = true;
      current = name;
      dom.title.textContent = TITLES[name] ?? "侧边栏";
      void panels.enter(name);
    }

    /** 回到首页（并停掉上一个面板的后台工作）。 */
    function goHome() {
      if (current !== null) panels.leave(current);
      Object.keys(PANEL_IDS).forEach(function (key) {
        const el = $(PANEL_IDS[key]);
        if (el !== null) el.hidden = true;
      });
      dom.home.hidden = false;
      current = null;
      dom.title.textContent = "侧边栏";
    }

    /** 三个入口按钮。 */
    const ENTRIES = [
      [dom.sBrowser, "browser"],
      [dom.sFiles, "files"],
      [dom.sChat, "chat"],
    ];
    ENTRIES.forEach(function (pair) {
      const btn = pair[0];
      const name = pair[1];
      if (btn === null) return;
      btn.addEventListener("click", function () { showPanel(name); });
    });

    /*
     * 顶栏 × → 收起整个侧窗。
     *
     * 走主进程（窗口位移动画在那里做）：`sideAction("close")`。
     * 失败要**如实报**，不静默 —— 否则用户以为关掉了，窗口还在。
     */
    if (dom.sClose !== null) {
      dom.sClose.addEventListener("click", function () {
        const api = global.whale;
        if (api === undefined || typeof api.sideAction !== "function") {
          global.console.warn("侧窗无法收起：preload 未暴露 sideAction");
          return;
        }
        api.sideAction("close").then(function (out) {
          if (out !== null && out !== undefined && out.ok === true) return;
          global.console.warn(`收起失败：${out?.code ?? "unknown"}`);
        });
      });
    }

    // 键盘 Esc 也能收起（面板里没有别的输入焦点时）
    global.document.addEventListener("keydown", function (ev) {
      if (ev.key !== "Escape") return;
      const api = global.whale;
      if (api !== undefined && typeof api.sideAction === "function") api.sideAction("close");
    });

    goHome();
  }

  global.WhaleSideApp = { start };

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof window !== "undefined" ? window : globalThis);

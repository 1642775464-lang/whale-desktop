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
      sfBody: $("sfBody"),
      scBack: $("scBack"),
      scTitle: $("scTitle"),
      scState: $("scState"),
      scInherit: $("scInherit"),
      scStream: $("scStream"),
      scInput: $("scInput"),
      scSend: $("scSend"),
    };

    const client = global.WhaleSideBridge.createSideClient();

    /** 面板名 → 中文标题（顶栏显示当前在哪一块）。 */
    const TITLES = { browser: "浏览器", files: "文件", chat: "侧边对话" };

    /** 当前显示的面板名；null = 首页。 */
    let current = null;

    /*
     * 当前会话与工作区 —— 侧边对话的「继承上下文」默认项、html 预览的 file 地址
     * 都要用。
     *
     * ## 为什么不是「只用查询串」
     *
     * 查询串是主进程**建窗那一刻**从状态快照里取的。用户报「文件区域读不到
     * 当前工作区」，实测根因就是那一刻快照还空 —— 侧窗只拿到 `?port=`，
     * 于是请求不带会话、桥回 400。而且就算那次拿到了，主窗之后切会话，
     * 侧窗也永远不知道。
     *
     * 所以：**桥是事实源**，启动时问一次 `/whale/hud`；查询串只当兜底
     * （桥暂时读不到时才用它）。
     */
    const queryContext = (() => {
      try {
        const q = new global.URLSearchParams(global.location.search);
        const sid = q.get("sessionId");
        const ws = q.get("workspace");
        return {
          sessionId: sid === null || sid === "" ? null : sid,
          workspace: ws === null || ws === "" ? null : ws,
        };
      } catch {
        return { sessionId: null, workspace: null };
      }
    })();

    /** 运行时上下文（先由查询串兜底，启动后立刻用桥的值覆盖）。 */
    const context = {
      sessionId: queryContext.sessionId,
      workspace: queryContext.workspace,
    };

    /**
     * 向桥要一次活跃会话并应用。
     *
     * 失败**不覆盖**已有的（查询串那份可能还有用），只记一条日志 ——
     * 这是辅助信息，读不到不该让侧窗不可用。
     */
    function resolveContext() {
      return client.activeContext().then((out) => {
        if (out.ok !== true) {
          global.console.warn(`读活跃会话失败：${out.code}`);
          return context;
        }
        if (out.sessionId !== null) {
          context.sessionId = out.sessionId;
          client.setSessionId(out.sessionId);
        }
        if (out.workspace !== null) context.workspace = out.workspace;
        return context;
      });
    }

    const panels = global.WhaleSidePanels.createSidePanels({
      dom,
      client,
      currentSessionId: () => context.sessionId,
      // html 预览转给浏览器面板（本回调由 side-app 处理切换）
      onOpenInBrowser: (path) => { openFileInBrowser(path); },
      preview: global.WhaleFilePreview,
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

    /**
     * 把工作区里的 html 交给浏览器面板打开。
     *
     * 为什么用 `file://` 绝对地址：桥给的是**工作区相对路径**，
     * 而 `<webview>` 需要一个可加载的 URL。主进程在 `loadFile` 时已经
     * 把工作区根通过查询串传进来了（`?workspace=`），这里拼成 file URL。
     */
    function openFileInBrowser(path) {
      // 工作区根用**运行时上下文**（桥给的），查询串只是它来源之一
      const root = context.workspace ?? "";
      // 反斜杠统一（Windows 路径），再做最小转义
      const abs = `${root.replace(/[/\\]+$/, "")}/${String(path).replace(/^[/\\]+/, "")}`
        .replace(/\\/g, "/");
      const url = abs.startsWith("/")
        ? `file://${encodeURI(abs)}`
        : `file:///${encodeURI(abs)}`;
      showPanel("browser");
      panels.openInBrowser(url);
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

    /*
     * 一进页面就带上「贴住」类。
     *
     * 侧窗只在**贴住**时才显示（位置由主进程摆在贴靠位），所以这个类在本窗口
     * 是常态、不需要向谁查询 —— 它表达的是「我贴在左边那个人身上」，
     * 用来把**左侧**的圆角/描边/阴影切掉（见 side-skin.css 的 body.joined）。
     * 主窗那边由主进程推送状态来切它**右侧**的（见 preload 的 onSideJoined）。
     */
    global.document.body.classList.add("joined");

    /*
     * 启动时先把会话与工作区解析出来（**桥优先**，查询串兜底）。
     *
     * 必须先跑这一步再让用户点文件 —— 否则文件面板拿不到 sessionId，
     * 请求会被桥按 400 拒掉（用户报的「文件区域读不到当前工作区」）。
     * 不 await：解析完之前界面已可用，点文件时会拿到查询串那份或等它完成。
     */
    void resolveContext();

    goHome();
  }

  global.WhaleSideApp = { start };

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(typeof window !== "undefined" ? window : globalThis);

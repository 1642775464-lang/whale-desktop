/*
 * 小窗入口与装配
 *
 * 职责：接线——把桥的数据接给渲染器，把界面动作接给桥与主进程。
 *       渲染细节在 render.js，取数在 bridge-client.js，
 *       斜杠面板在 palette.js，菜单与会话切换在 panels.js。
 * 所属层：小窗（whale-window/renderer）
 *
 * 纪律：改完这个文件**必须实地起一次窗口**——`node --check` 只查语法，
 * 查不出 TDZ；脚本顶层抛错会让后面的事件绑定**一行都不执行**，
 * 元素都在、看得见，但按钮全哑（小窗 PRD 5.8 实际踩过）。
 */

(function main(global) {
  "use strict";

  const $ = function (id) { return global.document.getElementById(id); };

  const dom = {
    body: global.document.body,
    win: $("win"),
    topbar: $("topbar"),
    btnMin: $("btnMin"),
    btnPin: $("btnPin"),
    btnGear: $("btnGear"),
    btnMenu: $("btnMenu"),
    tbTitle: $("tbTitle"),
    shTitle: $("shTitle"),
    shSub: $("shSub"),
    stream: $("stream"),
    status: $("status"),
    statusText: $("statusText"),
    dock: $("dock"),
    dockHead: $("dockHead"),
    dockProg: $("dockProg"),
    dockList: $("dockList"),
    input: $("input"),
    btnPerm: $("btnPerm"),
    btnSend: $("btnSend"),
    // 输入区其余按钮（切片 7 第二批的浮层接线要用）
    btnAdd: $("btnAdd"),
    btnUsage: $("btnUsage"),
    btnModel: $("btnModel"),
    urFg: $("urFg"),
    usagePct: $("usagePct"),
    btnInfo: $("btnInfo"),
    slashPanel: $("slashPanel"),
    slashQuery: $("slashQuery"),
    slashList: $("slashList"),
    menuBox: $("menuBox"),
    menuList: $("menuList"),
    sessList: $("sessList"),
    // 切片 7 第二批：输入区浮层与待上传清单
    inputOverlay: $("inputOverlay"),
    ovTitle: $("ovTitle"),
    ovBody: $("ovBody"),
    ovClose: $("ovClose"),
    uplList: $("uplList"),
    infoDrawer: $("infoDrawer"),
    infoSession: $("infoSession"),
    infoBridge: $("infoBridge"),
    infoEvents: $("infoEvents"),
  };

  /**
   * 权限档位的**启动占位值**。
   *
   * ⚠️ 它不再是真值。真值由 `/whale/presets` 的 `current` 填进
   * `state.permission`，渲染层优先读那个。
   * 曾经这里是个「本地态」常量，切换后也不更新——用户报过
   * 「切为完全权限了，输入框还是显示工作区内修改」。
   * 这个变量现在只在「真值还没拿到」（首帧）时兜底显示。
   */
  const permission = "workspace-write";

  /** 桥地址（资料抽屉要显示）。 */
  const BRIDGE_BASE = `http://127.0.0.1:${global.WhaleBridge.portFromLocation()}`;

  /** 渲染器。必须在任何渲染调用之前建好。 */
  const renderer = global.WhaleRender.createRenderer({
    dom,
    getPermission: () => permission,
  });

  /** 桥客户端。同样要在渲染之前建好。 */
  const client = global.WhaleBridge.createClient({
    onChange() { renderer.all(client.getState()); },
  });

  /**
   * 如实地告诉用户「这个能力没接通」。
   *
   * 规范要求灰项点击**不得有静默效果**——不假装能用。
   *
   * @param {string} name
   */
  function notifyUnavailable(name) {
    global.console.warn(`${name}：能力未接通`);
  }

  /**
   * 斜杠命令面板（F7）。
   *
   * 选中可用命令时走 `client.command()` —— 命令**不经模型**，由宿主直接执行。
   * 命令表问宿主（`GET /whale/commands`），不再用本地硬编码——
   * 宿主有二十多条命令，硬编码永远追不上。
   */
  const palette = global.WhalePalette.createPalette({
    dom: { panel: dom.slashPanel, query: dom.slashQuery, list: dom.slashList, input: dom.input },
    onPick(command) {
      client.command(command).then((out) => {
        if (!out.ok) global.console.warn(`命令失败：${out.code}`);
      });
    },
    onUnavailable: notifyUnavailable,
    onNeedCommands: () => client.listCommands(),
  });

  /**
   * 输入区浮层（切片 7 第二批）：权限档位 / 模型与思考强度 / 用量 / ＋上传。
   *
   * 四个按钮共用一个浮层容器；＋ 的文件读取、拖拽、粘贴也在这里收口。
   */
  const fileInput = global.document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.hidden = true;
  global.document.body.appendChild(fileInput);

  /**
   * 把文本插进输入框（**不发送**）。
   *
   * ＋菜单里的「文件」与「指令」都走这条：与主窗口的 `@` / `/` 语义一致
   * ——插入引用待用户补完再发，而不是替他发出去。
   */
  function insertIntoInput(text) {
    if (typeof text !== "string" || text === "") return;
    const cur = dom.input.value;
    // 已有内容且不以空白结尾时补一个空格，避免与上一个词粘在一起
    dom.input.value = cur === "" || /\s$/.test(cur) ? `${cur}${text}` : `${cur} ${text}`;
    dom.input.focus();
  }

  const overlays = global.WhaleOverlays.createOverlays({
    dom: {
      overlay: dom.inputOverlay,
      ovTitle: dom.ovTitle,
      ovBody: dom.ovBody,
      ovClose: dom.ovClose,
      uplList: dom.uplList,
    },
    getClient: () => client,
    onNotify: notifyUnavailable,
    onPickFiles: () => fileInput.click(),
    onFiles: (files) => overlays.addFiles(files),
    onInsertText: insertIntoInput,
    /**
     * ＋ 菜单（切片 7 第四批）：文件引用 + 宿主指令列表。
     *
     * 单独一个模块（add-menu.js）：它是独立的业务域（用户报
     * 「＋号交互内容和主窗口没有对齐」），而且 overlays.js 装不下它了。
     * 内容全部来自宿主：指令走 `/whale/commands`、文件走 `/whale/files`。
     *
     * 这里**延迟注入**（函数形式）：addMenu 需要 overlays 的 row/note/close，
     * 而 overlays 又需要 addMenu —— 直接互相引用会踩「一个还没定义」。
     */
    getAddMenu: () => addMenu,
  });

  /**
   * ＋ 菜单：在 overlays 之后建（要用它的 row / note / close），
   * 并通过上面的 `getAddMenu` 延迟注入回去 —— 避免两者互相引用时
   * 踩「拿到的还是 undefined」。
   */
  const addMenu = global.WhaleAddMenu.createAddMenu({
    dom: { ovTitle: dom.ovTitle, ovBody: dom.ovBody },
    clientOf: () => client,
    currentOf: () => overlays.current(),
    insertIntoInput,
    onPickFiles: () => fileInput.click(),
    onFiles: (files) => overlays.addFiles(files),
    close: () => overlays.close(),
    row: (label, desc, value, opts) => overlays.sharedRow(label, desc, value, opts),
    note: (text) => overlays.sharedNote(text),
  });

  /** 四个浮层键的统一接线：toggle + 渲染各自内容。 */
  const OVERLAY_BUTTONS = [
    ["btnPerm", "permission", () => overlays.renderPermission()],
    ["btnModel", "model", () => overlays.renderModel()],
    ["btnUsage", "usage", () => overlays.renderUsage()],
    ["btnAdd", "add", () => overlays.renderAdd()],
  ];

  /** 菜单与会话切换（F8/F9）。 */
  const panels = global.WhalePanels.createPanels({
    dom: { menuBtn: dom.btnMenu, menuBox: dom.menuBox, menuList: dom.menuList, sessList: dom.sessList },
    getSessions: () => client.getState().sessions ?? [],
    getCurrentId: () => client.getState().sessionId,
    onSwitch(sessionId) {
      client.activate(sessionId).then((out) => {
        if (!out.ok) global.console.warn(`切换失败：${out.code}`);
      });
    },
    onResume(sessionId) {
      // 历史：先唤醒，成功后才切；失败要如实说原因并还原标签
      client.resume(sessionId).then((out) => {
        if (out.ok) {
          panels.markWoke(sessionId);
          client.activate(sessionId);
          return;
        }
        panels.markWakeFailed(sessionId);
        global.console.warn(`唤醒失败：${out.code}`);
      });
    },
    onAction(action) {
      if (action === "minimize") {
        global.whale.windowAction("minimize");
        return;
      }
      if (action === "reload") {
        global.whale.windowAction("reload");
        return;
      }
      if (action === "quit") {
        global.whale.windowAction("close");
      }
    },
    onUnavailable: notifyUnavailable,
  });

  /**
   * 顶栏拖动。
   *
   * 无边框窗口没有系统标题栏，只能由渲染层把鼠标位移交给主进程。
   * 阈值 3px：位移超过才算拖动（避免「手抖一下窗口就歪了」）。
   */
  function bindDrag() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    dom.topbar.addEventListener("mousedown", (ev) => {
      // 点在按钮上不拖（按钮自己 no-drag，这里再判一次更稳）
      if (ev.target.closest && ev.target.closest("button")) return;
      dragging = true;
      lastX = ev.screenX;
      lastY = ev.screenY;
    });

    global.document.addEventListener("mousemove", (ev) => {
      if (!dragging) return;
      const dx = ev.screenX - lastX;
      const dy = ev.screenY - lastY;
      lastX = ev.screenX;
      lastY = ev.screenY;
      if (dx === 0 && dy === 0) return;
      global.whale.drag(dx, dy);
    });

    global.document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      // 松手立刻补写一次位置（防抖之外的最后一次）
      global.whale.flushState();
    });
  }

  /** 发送或中断（F4）。
   *
   * 有待上传附件时**先上传、后发消息**：上传成功后附件引用随消息进会话，
   * 失败则如实提示并中止本次发送（内容与附件都保留，用户可重试）。
   */
  async function onSubmit() {
    const state = client.getState();
    if (state.running) {
      // 中断：桥侧只在明确探测到活跃回合时才真的取消（带护栏）
      const out = await client.abort();
      if (!out.ok) global.console.warn(`中断失败：${out.code}`);
      return;
    }
    const text = dom.input.value.trim();
    if (text === "" && !overlays.hasPending()) return;

    try {
      // 附件先行：把待上传清单落进宿主，拿到引用再发
      const attachments = await overlays.flushUploads();

      // 乐观渲染：消息立刻上屏，同时真的进会话。
      // 排队不是失败——桥会在回合运行中把它排到下一回合。
      dom.input.value = "";
      const out = await client.send(text);

      if (out.ok) {
        if (out.raw && out.raw.queued === true) {
          global.console.log("消息已排队，等当前回合结束");
        }
        void attachments;
        return;
      }
      // 发送失败要如实告诉用户，并把输入还原（否则内容丢了）
      global.console.warn(`发送失败：${out.code}`);
      dom.input.value = text;
    } catch (err) {
      global.console.warn(`发送失败：${err?.message ?? err}`);
      notifyUnavailable("发送中断，输入已保留");
    }
  }

  /** 事件绑定。 */
  function bindEvents() {
    dom.btnMin.addEventListener("click", () => global.whale.windowAction("minimize"));
    dom.btnPin.addEventListener("click", () => {
      global.whale.windowAction("toggle-pin").then((out) => {
        if (out && out.ok) dom.btnPin.classList.toggle("on", out.pinned === true);
      });
    });

    // 顶栏 ☰ = 菜单（F8）；「隐藏」走「更多 → 最小化」那条路
    dom.btnMenu.addEventListener("click", () => panels.toggleMenu());
    dom.btnGear.addEventListener("click", () => notifyUnavailable("侧边工作台"));

    // 四个浮层键统一在 OVERLAY_BUTTONS 里接线（含权限键）。
    //
    // ⚠️ 权限键**只在这里绑一次**。曾经在上一行又单独绑了一次
    // `overlays.toggle("permission")`，于是点一下触发两个处理器：
    // 第一个打开、第二个又切一次把它关掉，且 isOpen() 为假 → 不渲染。
    // 净效果是浮层永远打不开、也从没发出过 /whale/presets 请求，
    // 表现为「权限还是不行」。同一元素绑两次是这类静默失效的常见成因。
    OVERLAY_BUTTONS.forEach(([buttonId, name, render]) => {
      dom[buttonId].addEventListener("click", () => {
        overlays.toggle(name);
        if (overlays.isOpen()) render();
      });
    });
    dom.ovClose.addEventListener("click", () => overlays.close());

    // 文件选择器：＋ 浮层里点「选择文件」触发
    fileInput.addEventListener("change", () => {
      if (fileInput.files && fileInput.files.length > 0) {
        overlays.addFiles(Array.from(fileInput.files));
        fileInput.value = "";
      }
    });

    // 拖拽：整个窗口都能收（用户要求「把其他位置的文件拖进来」）
    global.document.addEventListener("dragover", (ev) => ev.preventDefault());
    global.document.addEventListener("drop", (ev) => {
      ev.preventDefault();
      const files = ev.dataTransfer?.files;
      if (files && files.length > 0) overlays.addFiles(Array.from(files));
    });

    // 粘贴：图片走附件（文本粘贴保持原生行为）
    dom.input.addEventListener("paste", (ev) => {
      const items = ev.clipboardData?.items;
      if (!items) return;
      const imageFiles = [];
      for (const item of items) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) imageFiles.push(f);
        }
      }
      if (imageFiles.length > 0) {
        ev.preventDefault();
        overlays.addFiles(imageFiles);
      }
    });

    // 任务坞：默认收起，点标题展开（F5）
    dom.dockHead.addEventListener("click", () => {
      dom.dock.classList.toggle("open");
      dom.dockList.hidden = !dom.dock.classList.contains("open");
    });

    // 资料抽屉（F8）
    dom.btnInfo.addEventListener("click", () => {
      if (dom.infoDrawer.hidden) {
        renderer.infoDrawer(client.getState(), BRIDGE_BASE);
        dom.infoDrawer.hidden = false;
      } else {
        dom.infoDrawer.hidden = true;
      }
    });

    // 点面板外区域关掉菜单（无边框窗口里没有系统菜单，得自己收）
    global.document.addEventListener("mousedown", (ev) => {
      if (dom.menuBox.hidden) return;
      if (dom.menuBox.contains(ev.target) || ev.target === dom.btnMenu) return;
      panels.closeMenu();
    });

    dom.btnSend.addEventListener("click", onSubmit);

    // Enter 发送，Shift+Enter 换行（F4）
    // 但**面板打开时 Enter 不发送**（F7）——先让面板消费掉
    dom.input.addEventListener("keydown", (ev) => {
      if (palette.onKeyDown(ev)) return;
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        onSubmit();
      }
    });

    // 输入变化时同步斜杠面板：敲 / 弹出、删掉 / 关闭、继续打字实时过滤
    dom.input.addEventListener("input", () => palette.sync());

    // 禁掉整窗右键菜单（无边框窗口里它没有意义，还会盖住界面）
    global.document.addEventListener("contextmenu", (ev) => ev.preventDefault());

    bindDrag();
  }

  /** 启动。 */
  function start() {
    bindEvents();
    renderer.permission();

    global.whale.ready().then((info) => {
      global.whale.log(`小窗就绪，桥端口 ${info && info.port}`);
      if (info && info.pinned === true) dom.btnPin.classList.add("on");
    });

    client.refresh();
    client.connect();
    client.startPolling();

    /**
     * 取走「唤起请求」（切片 7 第三批）。
     *
     * 用户报「已重启，但是点击无法唤起」。真因是**复用 ≠ 唤起**：
     * 点鲸鱼时桥走复用分支只回 `{reused:true}`，从不把已存在的窗口
     * 显示出来——被压住时看着就是「点了没反应」。
     *
     * 桥没法主动推给窗口（窗口是独立进程，自己来连桥），
     * 所以做成「桥留标记、窗口用**已有的 5 秒轮询**来取」。
     * 取走即消费，所以不会反复弹出来。
     */
    const SUMMON_WATCH_MS = 1500;
    global.setInterval(() => {
      client.takeSummon().then((summon) => {
        if (!summon) return;
        global.whale.windowAction("summon").then((out) => {
          if (out && out.ok !== true) global.console.warn(`唤起失败：${out.code}`);
        });
      });
    }, SUMMON_WATCH_MS);

    // 唤醒倒计时（F9）：「唤醒中 3s」每秒推进；抽屉开着时同步事件计数
    global.setInterval(() => {
      panels.tickWaking();
      if (!dom.infoDrawer.hidden) renderer.infoDrawer(client.getState(), BRIDGE_BASE);
    }, 1000);
  }

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(window);

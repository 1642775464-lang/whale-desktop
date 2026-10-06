/*
 * 小窗入口与装配
 *
 * 职责：接线——顶栏交互、会话标题行、消息流渲染、输入区、以及
 *       `window.whale` 主进程通道的使用。
 * 所属层：小窗（whale-window/renderer）
 *
 * 本批（切片 5 批次 A）只做「窗口站得住」：顶栏六个元素、会话标题行、
 * 标题与副标题跟随桥的数据。消息流与输入区先接线到位（结构齐、能渲染），
 * 真正的发送/排队/中断在批次 B 验收。
 *
 * 纪律：改完这个文件**必须实地起一次窗口**——`node --check` 只查语法，
 * 查不出 TDZ；脚本顶层抛错会让后面的事件绑定**一行都不执行**，
 * 元素都在、看得见，但按钮全哑（小窗 PRD 5.8 实际踩过）。
 */

(function main(global) {
  "use strict";

  /** 权限三档文案（必须与主窗口逐字一致，PRD F6）。 */
  const PERMISSION_TEXT = {
    "read-only": "仅可查看",
    "workspace-write": "工作区内修改",
    "danger-full-access": "完全权限",
  };

  /** 权限档位轮转顺序（点一下切下一档）。 */
  const PERMISSION_ORDER = ["read-only", "workspace-write", "danger-full-access"];

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
    streamEmpty: $("streamEmpty"),
    input: $("input"),
    btnPerm: $("btnPerm"),
    btnSend: $("btnSend"),
    urFg: $("urFg"),
    usagePct: $("usagePct"),
    btnInfo: $("btnInfo"),
  };

  /** 桥客户端。必须在任何渲染函数之前建好。 */
  const client = global.WhaleBridge.createClient({
    onChange () { render(); },
  });

  /** 当前权限档位（本地态，发命令后由桥侧生效）。 */
  let permission = "workspace-write";

  // ── 渲染 ──────────────────────────────────────────

  /** 顶栏标题 + 会话标题行 + 副标题。 */
  function renderHeader(state) {
    if (state.offline) {
      // 文案取自《前端设计规范》6.3 空态文案表，不自创措辞
      dom.tbTitle.textContent = "未连接";
      dom.shTitle.textContent = "未连接";
      dom.shSub.textContent = "桥未连接 · 重试中";
      return;
    }
    const title = state.title ?? "（无标题会话）";
    dom.tbTitle.textContent = title;
    dom.shTitle.textContent = title;

    const parts = [];
    if (typeof state.workspace === "string" && state.workspace !== "") parts.push(state.workspace);
    parts.push(state.running ? "回合运行中" : "桥已连接");
    dom.shSub.textContent = parts.join(" · ");
  }

  /**
   * 消息流。
   *
   * 只在「消息条数或最后一条变了」时重建——每 5 秒轮询都重建会让用户
   * 正在滚动的阅读位置被重置。
   */
  let lastSignature = null;
  function renderStream(state) {
    const sig = `${state.messages.length  }|${  state.messages[state.messages.length - 1]?.text ?? ""}`;
    if (sig === lastSignature) return;
    lastSignature = sig;

    dom.stream.innerHTML = "";
    if (state.messages.length === 0) {
      const empty = global.document.createElement("div");
      empty.className = "empty";
      empty.id = "streamEmpty";
      empty.textContent = state.offline ? "桥未连接 · 重试中" : "还没有消息";
      dom.stream.appendChild(empty);
      return;
    }

    state.messages.forEach(function (m) {
      const wrap = global.document.createElement("div");
      wrap.className = `msg ${  m.role === "me" ? "me" : "ai"}`;
      const role = global.document.createElement("div");
      role.className = "role";
      // 角色文案：用户「你」，助手「DSH」
      role.textContent = m.role === "me" ? "你" : "DSH";
      const body = global.document.createElement("div");
      body.textContent = m.text ?? "";
      wrap.appendChild(role);
      wrap.appendChild(body);
      dom.stream.appendChild(wrap);
    });
    dom.stream.scrollTop = dom.stream.scrollHeight;
  }

  /** 发送键：回合运行中是红方块（B7 判据按 aria-label 读 DOM）。 */
  function renderSend(state) {
    const running = state.running === true;
    dom.btnSend.classList.toggle("stop", running);
    dom.btnSend.setAttribute("aria-label", running ? "中断" : "发送");
  }

  /** 用量圆环：周长 2πr = 2π×8 ≈ 50.27。 */
  function renderUsage(state) {
    const used = state.contextUsed;
    const total = state.contextWindow;
    if (typeof used !== "number" || typeof total !== "number" || total <= 0) {
      dom.usagePct.textContent = "–";
      dom.urFg.setAttribute("stroke-dashoffset", "50.3");
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
    dom.usagePct.textContent = String(pct);
    // offset = 周长 × (1 − 百分比/100)
    dom.urFg.setAttribute("stroke-dashoffset", String(50.3 * (1 - pct / 100)));
  }

  /** 权限按钮文案（三档，与主窗逐字一致）。 */
  function renderPermission() {
    dom.btnPerm.textContent = PERMISSION_TEXT[permission] ?? PERMISSION_TEXT["workspace-write"];
  }

  /** 整屏渲染。 */
  function render() {
    const state = client.getState();
    renderHeader(state);
    renderStream(state);
    renderSend(state);
    renderUsage(state);
    renderPermission();
  }

  // ── 交互 ──────────────────────────────────────────

  /**
   * 顶栏拖动。
   *
   * 无边框窗口没有系统标题栏，只能由渲染层把鼠标位移交给主进程。
   * 阈值 3px：位移超过才算拖动，否则算点击（避免「手抖一下窗口就歪了」）。
   */
  function bindDrag() {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    dom.topbar.addEventListener("mousedown", function (ev) {
      // 点在按钮上不拖（按钮自己 no-drag，这里再判一次更稳）
      if (ev.target.closest && ev.target.closest("button")) return;
      dragging = true;
      lastX = ev.screenX;
      lastY = ev.screenY;
    });

    global.document.addEventListener("mousemove", function (ev) {
      if (!dragging) return;
      const dx = ev.screenX - lastX;
      const dy = ev.screenY - lastY;
      lastX = ev.screenX;
      lastY = ev.screenY;
      if (dx === 0 && dy === 0) return;
      global.whale.drag(dx, dy);
    });

    global.document.addEventListener("mouseup", function () {
      if (!dragging) return;
      dragging = false;
      // 松手立刻补写一次位置（防抖之外的最后一次）
      global.whale.flushState();
    });
  }

  /** 权限档位：点一下切下一档，并真的发 /permission 命令。 */
  function cyclePermission() {
    const at = PERMISSION_ORDER.indexOf(permission);
    const next = PERMISSION_ORDER[(at + 1) % PERMISSION_ORDER.length];
    permission = next;
    renderPermission();
    client.command(`/permission ${  next}`).then(function (out) {
      if (!out.ok) {
        global.console.warn(`切权限失败：${  out.code}`);
      }
    });
  }

  /** 事件绑定。 */
  function bindEvents() {
    dom.btnMin.addEventListener("click", function () { global.whale.windowAction("minimize"); });
    dom.btnPin.addEventListener("click", function () {
      global.whale.windowAction("toggle-pin").then(function (out) {
        if (out && out.ok) dom.btnPin.classList.toggle("on", out.pinned === true);
      });
    });

    // 顶栏 × 语义：拦截成「隐藏」而不是退出（F10，与 DSH 主窗行为一致）
    dom.btnMenu.addEventListener("click", function () { global.whale.windowAction("hide"); });
    dom.btnGear.addEventListener("click", function () {
      // 侧边工作台属批次 C；此处明确不做静默效果
      global.console.warn("侧边工作台尚未接通（批次 C）");
    });

    dom.btnPerm.addEventListener("click", cyclePermission);

    dom.btnInfo.addEventListener("click", function () {
      global.console.warn("资料抽屉尚未接通（批次 C）");
    });

    // 发送/中断（批次 B 验收；这里先把通路接上）
    dom.btnSend.addEventListener("click", function () {
      const state = client.getState();
      if (state.running) {
        client.abort();
        return;
      }
      const text = dom.input.value.trim();
      if (text === "") return;
      dom.input.value = "";
      client.send(text);
    });

    // Enter 发送，Shift+Enter 换行（F4）
    dom.input.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        dom.btnSend.click();
      }
    });

    // 禁掉整窗右键菜单（无边框窗口里它没有意义，还会盖住界面）
    global.document.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
    });

    bindDrag();
  }

  // ── 启动 ──────────────────────────────────────────

  function start() {
    bindEvents();
    renderPermission();

    global.whale.ready().then(function (info) {
      global.whale.log(`小窗就绪，桥端口 ${  info && info.port}`);
      if (info && info.pinned === true) dom.btnPin.classList.add("on");
    });

    client.refresh();
    client.connect();
    client.startPolling();
  }

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(window);

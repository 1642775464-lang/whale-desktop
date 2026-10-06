/*
 * 悬浮条渲染与交互
 *
 * 职责：把桥给的快照画成五元素，并处理悬停详情、收展、拖动、右键菜单、完成提醒。
 *       取数在 bridge-client.js，滚筒在 carousel.js。
 * 所属层：悬浮条（whale-hud/renderer）
 *
 * 两条纪律：
 *   1. 取不到数就显示 `–`，**不显示上一个读数**（宁可显示 – 不显示错的数）。
 *   2. 改完这个文件必须**实地起一次窗口**：`node --check` 只查语法，查不出 TDZ。
 *      脚本顶层抛错会让后面的事件绑定**一行都不执行**——元素都在、看得见，
 *      但单击/右键全哑，而且几乎没有报错（PRD 5.5 实际踩过）。
 */

(function main(global) {
  "use strict";

  /** 拖动判定阈值：位移**超过** 3px 才算拖动，否则算单击（A10）。 */
  const DRAG_THRESHOLD_PX = 3;

  /** 完成提醒震动时长（规范 1.6）。 */
  const SHAKE_MS = 2000;

  /** 悬停移出后浮层隐藏延迟，与主进程的 180ms 缩回保持一致。 */
  const DETAIL_HIDE_MS = 180;

  /** 双击判定窗口：两次点击间隔小于它就当双击（展开成条）。 */
  const DOUBLE_CLICK_MS = 300;

  const grouped = new Intl.NumberFormat("zh-CN");

  const $ = function (id) { return global.document.getElementById(id); };

  const dom = {
    body: global.document.body,
    bar: $("bar"),
    whale: $("whaleBtn"),
    dot: $("dot"),
    reel: $("reel"),
    faceB: $("faceB"),
    faceF: $("faceF"),
    segSpeed: $("segSpeed"),
    segCtx: $("segCtx"),
    spdVal: $("spdVal"),
    ctxVal: $("ctxVal"),
    collapseBtn: $("collapseBtn"),
    popover: $("hudDetail"),
    detail: { ctx: $("dCtx"), out: $("dOut"), inp: $("dIn"), cache: $("dCache"), steps: $("dSteps") },
  };

  /** 当前形态（bar / ball）。 */
  let form = "bar";

  /** 收起时图标被挪到 body 下，这里记住原位以便还原。 */
  let whaleHome = null;

  /** 记录每个会话上一次的 phase，用于识别「回合刚结束」。 */
  const lastPhase = Object.create(null);

  /**
   * 桥客户端。
   *
   * 位置很关键：**必须在任何会用到它的函数之前建好**。
   * 放在后面虽然因 var 提升而不报错，但一旦有更早的调用路径就会炸，
   * 而这类问题 `node --check` 查不出来（PRD 5.5 踩过 TDZ 导致全交互失效）。
   */
  const client = global.WhaleBridge.createClient({
    onChange () { render(); },
  });

  /** 滚筒实例。同样要在渲染函数之前建好。 */
  const reel = global.WhaleCarousel.createReel({
    getSessions () { return client.getState().sessions; },
    dom: { reel: dom.reel, faceB: dom.faceB, faceF: dom.faceF },
    onSelect (sessionId) { client.activate(sessionId); },
  });

  // ── 数字格式化 ────────────────────────────────────────

  /**
   * 上下文占用显示简短形式：≥1000 用 k（规范 3.6）。
   *
   * @param {number|null} n
   * @returns {string}
   */
  function shortNumber(n) {
    if (typeof n !== "number" || !isFinite(n)) return "–";
    if (n >= 1000) return `${String(Math.round(n / 1000))  }k`;
    return String(n);
  }

  /**
   * 千分位。
   *
   * @param {number|null} n
   * @returns {string}
   */
  function fullNumber(n) {
    if (typeof n !== "number" || !isFinite(n)) return "–";
    return grouped.format(n);
  }

  /**
   * 速度：一位小数。
   *
   * @param {number|null} n
   * @returns {string}
   */
  function speedText(n) {
    if (typeof n !== "number" || !isFinite(n)) return "–";
    return n.toFixed(1);
  }

  // ── 会话选择 ──────────────────────────────────────────

  /**
   * 挑出要显示的那个会话：优先桥给的活跃会话，其次列表首个。
   *
   * @returns {object|null}
   */
  function currentSession() {
    const state = client.getState();
    const list = state.sessions;
    if (list.length === 0) return null;
    for (let i = 0; i < list.length; i += 1) {
      if (list[i].sessionId === state.activeSessionId) return list[i];
    }
    return list[0];
  }

  // ── 五元素渲染 ────────────────────────────────────────

  /**
   * ② 状态点：桥断 → 红；回合在跑 → 绿呼吸；否则灰。
   *
   * 判据是 `speed.phase`，**不是**「最近有没有出 token」：工具执行阶段不产 token，
   * 但回合明显在跑（规范 3.4）。
   */
  function renderDot(session) {
    let cls = "dot";
    if (client.getState().offline) cls += " bad";
    else if (session !== null && session.speed && session.speed.phase === "running") cls += " run";
    else cls += " idle";
    dom.dot.className = cls;
  }

  /**
   * ④ 速度段。回合结束后加灰（数值本身由桥冻结，我们只照显示）。
   */
  function renderSpeed(session) {
    const offline = client.getState().offline;
    if (offline || session === null) {
      dom.spdVal.textContent = "–";
      dom.segSpeed.classList.add("grey");
      return;
    }
    const speed = session.speed || {};
    dom.spdVal.textContent = speedText(speed.tokPerSec);
    dom.segSpeed.classList.toggle("grey", speed.phase !== "running");
  }

  /** ⑤ 上下文段。 */
  function renderCtx(session) {
    dom.ctxVal.textContent = client.getState().offline || session === null
      ? "–"
      : shortNumber(session.contextUsed);
  }

  /** 悬停浮层的五行（顺序固定，规范 3.6）。 */
  function renderDetail(session) {
    const d = dom.detail;
    if (client.getState().offline || session === null) {
      d.ctx.textContent = "–";
      d.out.textContent = "–";
      d.inp.textContent = "–";
      d.cache.textContent = "–";
      d.steps.textContent = "–";
      return;
    }
    d.ctx.textContent = fullNumber(session.contextUsed);
    d.out.textContent = fullNumber(session.totalOutput);
    d.inp.textContent = fullNumber(session.totalInput);
    d.cache.textContent = fullNumber(session.totalCacheRead);
    d.steps.textContent = `${fullNumber(session.steps)  } / ${  fullNumber(session.turns)}`;
  }

  /** ③ 标题：交给滚筒（单会话静止、多会话翻转）。 */
  function renderTitle() {
    const state = client.getState();
    if (state.offline) {
      // 文案取自《前端设计规范》6.3 空态文案表，不自创措辞
      reel.invalidate();
      dom.faceF.textContent = "桥未连接 · 重试中";
      dom.faceB.textContent = "";
      return;
    }
    if (state.sessions.length === 0) {
      reel.invalidate();
      dom.faceF.textContent = "待机中";
      dom.faceB.textContent = "";
      return;
    }
    reel.update();
  }

  // ── 完成提醒（F6）────────────────────────────────────

  /**
   * 某会话从 running 变成非 running → 标题跳出来 + 条震 2 秒。
   *
   * 震动是**位移类**，不是脉冲——脉冲已被用户否决，不得改回（PRD 2.3）。
   *
   * @param {Array<object>} sessions
   */
  function detectTurnEnd(sessions) {
    let ended = null;
    sessions.forEach(function (s) {
      const phase = s.speed && s.speed.phase ? s.speed.phase : "unknown";
      if (lastPhase[s.sessionId] === "running" && phase !== "running") ended = s;
      lastPhase[s.sessionId] = phase;
    });
    if (ended === null) return;

    // 标题框显示**对应会话**的标题，不是当前显示的那个
    dom.faceF.textContent = ended.title || ended.sessionId;

    dom.bar.classList.remove("shake");
    void dom.bar.offsetWidth; // 强制重排，让同一个动画能连着播两次
    dom.bar.classList.add("shake");
    global.setTimeout(function () { dom.bar.classList.remove("shake"); }, SHAKE_MS);
  }

  // ── 整屏渲染 ──────────────────────────────────────────

  /** 按最新快照重画全部元素。 */
  function render() {
    const state = client.getState();
    const session = currentSession();
    renderDot(session);
    renderSpeed(session);
    renderCtx(session);
    renderDetail(session);
    renderTitle();
    if (!state.offline) detectTurnEnd(state.sessions);
  }

  // ── 悬停详情（F3）────────────────────────────────────

  /**
   * 进入详情。
   *
   * 只在条形态响应：球形态下鼠标划过不该弹详情，那会让一个 88×88 的球
   * 突然变成 588×340 的高窗口。
   */
  function enterDetail() {
    if (form !== "bar") return;
    dom.popover.hidden = false;
    global.hud.hover(true);
  }

  /** 离开详情。主进程在 180ms 后缩回，浮层同宽隐藏。 */
  function leaveDetail() {
    if (form !== "bar") return;
    global.hud.hover(false);
    global.setTimeout(function () {
      if (form === "bar") dom.popover.hidden = true;
    }, DETAIL_HIDE_MS);
  }

  // ── 收展（F5）────────────────────────────────────────

  /**
   * 收起成球。
   *
   * **图标必须物理挪到 document.body**：条的 `transform: scaleX(0)` 会让条
   * 成为后代的包含块，把图标压成 0 宽（实测 `whale.w = 0`），
   * 此时 `position:fixed` / `z-index` / `overflow:visible` 全都救不了（陷阱 3）。
   */
  function collapse() {
    if (form === "ball") return;

    // 记原位：还原要用 insertBefore 而不是 appendChild，否则图标位置会跑到末尾
    whaleHome = { parent: dom.whale.parentElement, next: dom.whale.nextSibling };

    dom.popover.hidden = true;
    form = "ball";
    dom.body.classList.add("collapsed");
    reel.invalidate();

    global.hud.setForm("ball").then(() => {
      // 窗口必须先到位——窗口是裁剪边界，动画先播会被 88px 的窗口裁掉
      dom.body.appendChild(dom.whale);
    });
  }

  /** 展开成条。 */
  function expand() {
    if (form === "bar") return;
    form = "bar";
    dom.body.classList.remove("collapsed");

    global.hud.setForm("bar").then(function () {
      restoreWhale();
      render();
    });
  }

  /**
   * 把图标插回条里。
   *
   * `whaleHome` 是内存态：页面 reload 后它丢失，但 DOM 不复原（图标还挂在 body 下）。
   * 所以必须处理「已经在 body 里」的情况——按**首位**插回条内。
   */
  function restoreWhale() {
    if (whaleHome !== null && whaleHome.parent !== null && dom.whale.parentElement !== whaleHome.parent) {
      whaleHome.parent.insertBefore(dom.whale, whaleHome.next);
      return;
    }
    if (dom.whale.parentElement !== dom.bar) {
      dom.bar.insertBefore(dom.whale, dom.bar.firstChild);
    }
  }

  // ── 鲸鱼点击：唤起小窗（F2①）────────────────────────

  /**
   * 唤起 / 收起小窗。
   *
   * 切片 5 之前 `whale-window/` 不存在，桥会返回 `entry-missing`。
   * 这时**红闪并落原因**，不静默、不假装成功（规范 2「灰色项不得有静默效果」同源）。
   */
  function toggleSmallWindow() {
    client.openSmallWindow().then((out) => {
      if (out.ok) {
        dom.whale.classList.add("on");
        return;
      }
      global.console.warn(`唤起小窗失败：${out.code}`);
      flashFail();
      dom.whale.classList.remove("on");
    });
  }

  /** 操作失败的红闪。 */
  function flashFail() {
    dom.whale.classList.remove("fail");
    void dom.whale.offsetWidth;
    dom.whale.classList.add("fail");
    global.setTimeout(function () { dom.whale.classList.remove("fail"); }, 450);
  }

  // ── 拖动（A10）───────────────────────────────────────

  /**
   * 球的拖动。
   *
   * 阈值 3px：`mousedown` → `mouseup` 之间位移**超过** 3px 算拖动，否则算单击。
   * 放在渲染层是因为只有它看得到完整的鼠标序列。
   */
  function bindDrag() {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    /** 上一次球单击时刻：用于把「单击唤起小窗」与「双击展开」分开。 */
    let lastBallClickAt = 0;

    dom.whale.addEventListener("mousedown", function (ev) {
      // 只在球形态下允许拖动：条形态是「状态栏」语义，位置固定（PRD 已知限制）
      if (form !== "ball" || ev.button !== 0) return;
      ev.preventDefault();
      dragging = true;
      startX = ev.screenX;
      startY = ev.screenY;
      global.hud.dragStart();
    });

    global.document.addEventListener("mousemove", function (ev) {
      if (!dragging) return;
      global.hud.dragMove(ev.screenX - startX, ev.screenY - startY);
    });

    global.document.addEventListener("mouseup", (ev) => {
      if (!dragging) return;
      dragging = false;
      const moved = Math.abs(ev.screenX - startX) > DRAG_THRESHOLD_PX
        || Math.abs(ev.screenY - startY) > DRAG_THRESHOLD_PX;
      global.hud.dragEnd();

      // 位移超过阈值 = 拖动，不算点击
      if (moved) return;

      // 球的单击 / 双击全在这里判：拖动逻辑本来就掌握完整的鼠标序列，
      // 再挂一个 click 监听会与这里的判定打架（一次点击被处理两遍）。
      const now = Date.now();
      if (now - lastBallClickAt < DOUBLE_CLICK_MS) {
        lastBallClickAt = 0;
        expand();
        return;
      }
      lastBallClickAt = now;
      toggleSmallWindow();
    });
  }

  // ── 事件绑定 ─────────────────────────────────────────

  /** 把界面上的交互接起来。 */
  function bindEvents() {
    dom.collapseBtn.addEventListener("click", collapse);
    dom.whale.addEventListener("click", () => {
      // 条形态：单击唤起小窗（F2①）。
      // 球形态的点击由拖动逻辑统一判定（那里才拿得到 3px 位移与双击间隔）。
      if (form === "bar") toggleSmallWindow();
    });

    dom.segCtx.addEventListener("mouseenter", enterDetail);
    dom.segCtx.addEventListener("mouseleave", leaveDetail);
    dom.popover.addEventListener("mouseenter", enterDetail);
    dom.popover.addEventListener("mouseleave", leaveDetail);

    dom.reel.addEventListener("click", function () {
      reel.toggleLock();
    });

    // 右键菜单（F7）——托盘已移除，这是关掉悬浮条的唯一途径
    global.document.addEventListener("contextmenu", function (ev) {
      ev.preventDefault();
      global.hud.showMenu();
    });

    // 键盘可达性：回车 / 空格等同单击
    dom.whale.addEventListener("keydown", function (ev) {
      if (ev.key === "Enter" || ev.key === " ") {
        ev.preventDefault();
        toggleSmallWindow();
      }
    });

    bindDrag();
  }

  // ── 启动 ─────────────────────────────────────────────

  /** 启动：装事件、拉数据、接增量流。 */
  function start() {
    bindEvents();

    global.hud.ready().then(function (info) {
      global.console.log(`悬浮条就绪，桥端口 ${  info && info.port}`);
    });

    client.refresh();
    client.connect();
    // 兜底轮询：SSE 静默失效（网络层不报错但也不再推）时把数字拉回真实值
    client.startPolling();
  }

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(window);

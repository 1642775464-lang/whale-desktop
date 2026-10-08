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

  // 拖动阈值与双击窗口都在 drag.js 里（那里是唯一处理鼠标序列的地方），
  // 不再在这里各放一份——两处各一份时改一处忘一处，行为会静默不一致。

  /** 完成提醒震动时长（规范 1.6）。 */
  const SHAKE_MS = 2000;

  /** 悬停移出后浮层隐藏延迟，与主进程的 180ms 缩回保持一致。 */
  const DETAIL_HIDE_MS = 180;

  /**
   * 小窗运行态的核对间隔。
   *
   * 取 2s：与桥心跳同频，用户从小窗自己退出后最迟 2 秒绿环就灭。
   * 再快没有意义（人感知不到），再慢会让指示显得「卡住」。
   */
  const RING_WATCH_MS = 2000;

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

  /**
   * 定期核对小窗运行态，让绿环跟着现实走；顺带取走「唤起请求」。
   *
   * 为什么不能只在点击时更新：用户可能从小窗自己的「更多 → 退出小窗」关掉它，
   * 那样本地标记会一直停在「在跑」，绿环亮着但再点却是唤起——
   * 指示与语义不一致，比没有指示更糟。
   *
   * 唤起请求为什么在这里取：桥**没法主动推**给窗口（窗口是独立进程，
   * 只靠环境变量拿到桥端口后自己来连），所以做成「桥留标记、
   * 窗口用已有的轮询来取」。取走即消费，拿到才唤起。
   * 具体轮询逻辑收在客户端（`watchSummon`），这里只负责挂上。
   */
  function startRingWatch() {
    const check = function () {
      const running = client.isSmallWindowRunning;
      running().then((value) => {
        if (value === smallWindowRunning) return;
        smallWindowRunning = value;
        renderWhaleRing();
      });
    };
    check();
    global.setInterval(check, RING_WATCH_MS);
    client.watchSummon();
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

  // ── 鲸鱼点击：唤起 / 收起小窗（F2①）──────────────────

  /** 小窗是否在跑（决定鲸鱼外圈绿环与点击语义）。 */
  let smallWindowRunning = false;

  /**
   * 唤起 / 收起小窗。
   *
   * **PRD F2① 是切换语义**：单击唤起；小窗已在跑时再点**收起**。
   * 曾经只实现了「唤起」那一半——函数名叫 toggle、实现却只调 open，
   * 表现就是「点几次都只是重新唤起，永远关不掉」。
   *
   * 失败时红闪并落原因，不静默（规范 2「灰色项不得有静默效果」同源）。
   */
  function toggleSmallWindow() {
    // 先问桥小窗在不在跑，而不是靠本地猜：
    // 小窗可能被用户用 ⌘ 更多→退出 关掉，本地标记会过期
    client.isSmallWindowRunning().then((running) => {
      smallWindowRunning = running;
      renderWhaleRing();

      const action = running ? client.closeSmallWindow() : client.openSmallWindow();
      return action.then((out) => {
        if (out.ok) {
          // 关掉后状态立刻变（不等下一轮轮询）
          smallWindowRunning = !running;
          renderWhaleRing();
          return;
        }
        global.console.warn(`${running ? "收起" : "唤起"}小窗失败：${out.code}`);
        flashFail();
        // 失败时按实际情况刷新绿环，别停在错的指示上
        client.isSmallWindowRunning().then((now) => {
          smallWindowRunning = now;
          renderWhaleRing();
        });
      });
    });
  }

  /**
   * 鲸鱼外圈绿环：小窗在跑时亮。
   *
   * PRD F2①：**外圈绿环 = 小窗在跑**。它不只是装饰——
   * 它是「再点一下会收起」的唯一提示，缺了用户就不知道当前是哪一半语义。
   */
  function renderWhaleRing() {
    dom.whale.classList.toggle("on", smallWindowRunning);
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
   * 绑定拖动与单击/双击手势。
   *
   * 鼠标序列的处理在 `drag.js`（那是唯一看得到完整 mousedown→up 的地方，
   * 且三种手势互相牵制）。这里只提供「当前形态能不能拖」与三个回调。
   */
  function bindDrag() {
    global.WhaleDrag.bindDrag({
      handle: dom.whale,
      // 只在球形态下允许拖动：条形态是「状态栏」语义，位置固定（PRD 已知限制）
      canDrag () { return form === "ball"; },
      onDragStart () { global.hud.dragStart(); },
      onDragMove (dx, dy) { global.hud.dragMove(dx, dy); },
      onDragEnd () { global.hud.dragEnd(); },
      onClick: toggleSmallWindow,
      onDoubleClick: expand,
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
    // 鲸鱼绿环跟随小窗真实运行态（F2①）
    startRingWatch();
  }

  if (global.document.readyState === "loading") {
    global.document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})(window);

/*
 * 多会话滚筒
 *
 * 职责：≥2 个会话在跑时，让标题每 3 秒翻一次，单程 0.5 秒；
 *       并提供锁定、下拉选择所需的会话排序。
 * 所属层：悬浮条（whale-hud/renderer）
 *
 * 为什么单独成文件：滚筒是整份代码里最容易出错的一段——两个定时器 + DOM 双缓冲
 * + 一把防重入锁，任何一种时序问题都表现为「标题再也不动」或「闪一下假标题」，
 * 而且**都不报错**。单独成文件才能让它的单测只盯时序，不被渲染逻辑干扰。
 *
 * 三个防御机制（规范第七节陷阱 7/8/9，踩过之后加的，不得删）：
 *   1. **文字只在 front 侧立时写入**：rotateX ±90° 时肉眼看不见，
 *      此时改文字不会被看见，因此不会闪出「下一个的下一个」（A7）。
 *   2. **`reelGen` 代际号**：翻转由两个定时器驱动，中途若重建 DOM，
 *      旧定时器会去改**已脱离文档的孤儿节点**，表现为翻转卡住且无报错。
 *   3. **`rolling` 看门狗**：`rolling` 是防重入互斥锁，只有两个翻身定时器会放掉它。
 *      万一有路径绕过（定时器降频、异常中断），它会永久停在 true，
 *      表现为「标题再也不动且毫无报错」。看门狗强制放掉。
 *
 * 本文件是浏览器 script（不能 import），可测的部分挂在 window.WhaleCarousel 上，
 * 由 tests/unit/hud-carousel.test.mjs 用 node:vm 加载后取出来单测。
 */

(function attachCarousel(global) {
  "use strict";

  /** 每个标题停留时长（规范 1.6）。 */
  const DWELL_MS = 3000;

  /** 单程翻转时长。 */
  const FLIP_HALF_MS = 250;

  /** 整周期 = 停留 + 两个半程。 */
  const FLIP_PERIOD_MS = DWELL_MS + FLIP_HALF_MS * 2;

  /** 看门狗：超过一个完整周期还没放锁，就强制放掉。 */
  const WATCHDOG_MS = FLIP_PERIOD_MS * 2;

  /**
   * 从会话列表里挑出「进行中」的。
   *
   * 判据是 `speed.phase === 'running'`，**不是**「最近有没有出 token」：
   * 工具执行阶段（跑命令、读文件）根本不产 token，但回合明显在跑。
   * 实测一条回合里 tool/call 有 309 次，用 token 判会把这类活跃会话误判成空闲。
   *
   * @param {Array<object>} sessions
   * @returns {Array<object>}
   */
  function runningSessions(sessions) {
    if (!Array.isArray(sessions)) return [];
    return sessions.filter(function (s) {
      return s !== null && typeof s === "object" && s.speed && s.speed.phase === "running";
    });
  }

  /**
   * 决定「该显示哪一个会话」。
   *
   * 规则：只有 ≥2 个进行中会话才轮播；锁定后永远停在锁定项；
   * 锁定的会话掉出列表时**自动清锁**——否则会出现「只剩一个会话、🔒 还挂着」，
   * 那个锁既无法解释、点了也没反应。
   *
   * @param {Array<object>} sessions
   * @param {{lockedId?: string|null, index?: number}} [state]
   * @returns {{list: Array<object>, index: number, current: object|null, shouldRoll: boolean, lockedId: string|null}}
   */
  function planReel(sessions, state) {
    const list = runningSessions(sessions);
    let lockedId = state && state.lockedId ? state.lockedId : null;

    // 锁定的会话已经不在了 → 清锁（会话掉到 1 个时同样走到这里）
    if (lockedId !== null && !list.some(function (s) { return s.sessionId === lockedId; })) {
      lockedId = null;
    }

    if (list.length === 0) {
      return { list, index: -1, current: null, shouldRoll: false, lockedId };
    }

    const raw = state && typeof state.index === "number" ? state.index : 0;
    let index = ((raw % list.length) + list.length) % list.length;

    if (lockedId !== null) {
      const lockedIndex = list.findIndex(function (s) { return s.sessionId === lockedId; });
      if (lockedIndex >= 0) index = lockedIndex;
    }

    return {
      list,
      index,
      current: list[index],
      // 单会话不翻转：标题静止
      shouldRoll: list.length >= 2 && lockedId === null,
      lockedId,
    };
  }

  /**
   * 建一个滚筒控制器。
   *
   * @param {object} deps
   * @param {() => Array<object>} deps.getSessions
   * @param {object} deps.dom 滚筒相关的 DOM（front/back/reel）
   * @param {(sessionId: string) => void} [deps.onSelect] 下拉点选后的跳转
   * @param {object} [deps.clock] 可注入的时钟（测试用）：{setTimeout, clearTimeout, now}
   * @returns {object} 控制器
   */
  function createReel(deps) {
    const getSessions = deps.getSessions;
    const dom = deps.dom;
    const onSelect = typeof deps.onSelect === "function" ? deps.onSelect : function () {};
    const clock = deps.clock || {
      setTimeout (fn, ms) { return global.setTimeout(fn, ms); },
      clearTimeout (h) { global.clearTimeout(h); },
    };

    let index = 0;
    let lockedId = null;
    /** 防重入互斥锁。 */
    let rolling = false;
    /** DOM 代际号：重建 DOM 后，旧定时器据此作废。 */
    let reelGen = 0;
    /** 当前已经写进 front 的文字，避免重复写入触发无谓的重排。 */
    let shownTitle = null;

    let dwellHandle = null;
    let flipHandle = null;
    let watchdogHandle = null;

    function clearTimers() {
      if (dwellHandle !== null) { clock.clearTimeout(dwellHandle); dwellHandle = null; }
      if (flipHandle !== null) { clock.clearTimeout(flipHandle); flipHandle = null; }
      if (watchdogHandle !== null) { clock.clearTimeout(watchdogHandle); watchdogHandle = null; }
    }

    function releaseRolling() {
      rolling = false;
      if (watchdogHandle !== null) { clock.clearTimeout(watchdogHandle); watchdogHandle = null; }
    }

    /** 把某段文字写进 front。只在 front 不可见时调用。 */
    function paintFront(text) {
      if (dom.faceF.textContent !== text) dom.faceF.textContent = text;
      shownTitle = text;
    }

    /** 直接把当前项画出来（不带动画），用于首次渲染与会话数变化。 */
    function renderNow() {
      const plan = planReel(getSessions(), { lockedId, index });
      lockedId = plan.lockedId;
      index = plan.index;

      if (plan.current === null) {
        paintFront("–");
        dom.reel.classList.remove("locked");
        return plan;
      }

      paintFront(plan.current.title || plan.current.sessionId);
      dom.reel.classList.toggle("locked", lockedId !== null);
      return plan;
    }

    /**
     * 翻一次。
     *
     * 上半程把 front 翻下去；到 250ms 时 front 已侧立（看不见），
     * 这时才改文字，然后下半程翻回来。**文字从不在可见面上被改写**。
     */
    function flipOnce() {
      const plan = planReel(getSessions(), { lockedId, index });
      lockedId = plan.lockedId;

      if (!plan.shouldRoll) {
        releaseRolling();
        renderNow();
        schedule();
        return;
      }

      index = (plan.index + 1) % plan.list.length;
      const next = plan.list[index];

      rolling = true;
      const gen = reelGen;

      dom.faceF.classList.remove("in", "primed");
      dom.faceF.classList.add("out");

      flipHandle = clock.setTimeout(function () {
        flipHandle = null;
        // 代际号不符说明 DOM 已重建，这个回调属于孤儿节点，直接作废
        if (gen !== reelGen) { releaseRolling(); return; }

        // 前后面分工：back 只作暂存，真正显示的是 front
        dom.faceB.textContent = next.title || next.sessionId;

        dom.faceF.classList.remove("out");
        dom.faceF.classList.add("primed");
        // 此刻 front 侧立（不可见），写文字不会被看见——A7 的关键
        paintFront(dom.faceB.textContent);

        // 强制重排，让 primed 的无过渡状态生效，否则下一帧不会走过渡
        void dom.faceF.offsetWidth;

        dom.faceF.classList.remove("primed");
        dom.faceF.classList.add("in");

        flipHandle = clock.setTimeout(function () {
          flipHandle = null;
          if (gen !== reelGen) { releaseRolling(); return; }
          dom.faceF.classList.remove("in");
          dom.faceF.classList.add("in");
          releaseRolling();
          schedule();
        }, FLIP_HALF_MS);
      }, FLIP_HALF_MS);

      // 看门狗：就算上面任何一条路径没放锁，也会在这里被强制放掉
      watchdogHandle = clock.setTimeout(function () {
        watchdogHandle = null;
        rolling = false;
      }, WATCHDOG_MS);
    }

    /** 安排下一次翻转。 */
    function schedule() {
      clearTimers();
      const plan = planReel(getSessions(), { lockedId, index });
      if (!plan.shouldRoll) return;
      dwellHandle = clock.setTimeout(function () {
        dwellHandle = null;
        if (rolling) { schedule(); return; }
        flipOnce();
      }, DWELL_MS);
    }

    /** 数据变了：重算并（必要时）重新排期。 */
    function update() {
      const plan = planReel(getSessions(), { lockedId, index });
      lockedId = plan.lockedId;
      index = plan.index;

      if (!plan.shouldRoll) {
        // 回到单会话 / 全空闲：停掉轮播，直接显示静态标题
        clearTimers();
        releaseRolling();
        renderNow();
        return;
      }

      // 轮播中：先把当前项画出来，再保证定时器在跑。
      // **必须先画**：否则首帧永远停在 HTML 里的占位符上——
      // 元素在、宽度也对，就是文字不变，属于最难发现的一类假通过。
      // 正在翻转时不打断（那会把 front 上的过渡踩掉）。
      if (!rolling && flipHandle === null) {
        paintFront(plan.current ? plan.current.title || plan.current.sessionId : "–");
      }
      if (dwellHandle === null && flipHandle === null) schedule();
    }

    /** 单击标题：锁定 / 解锁。 */
    function toggleLock() {
      const plan = planReel(getSessions(), { lockedId, index });
      if (plan.list.length < 2) return { locked: false, reason: "single-session" };

      if (lockedId === null) {
        lockedId = plan.current ? plan.current.sessionId : null;
        clearTimers();
        releaseRolling();
        renderNow();
        return { locked: true, sessionId: lockedId };
      }

      lockedId = null;
      update();
      return { locked: false, sessionId: null };
    }

    /**
     * 选一个会话并**顺手锁定**。
     *
     * 不锁定的话，3 秒后标题又翻走了，用户会以为自己点错了。
     *
     * @param {string} sessionId
     */
    function select(sessionId) {
      const plan = planReel(getSessions(), { lockedId: null, index: 0 });
      const at = plan.list.findIndex(function (s) { return s.sessionId === sessionId; });
      if (at < 0) return { ok: false, code: "session-not-running" };

      index = at;
      lockedId = sessionId;
      clearTimers();
      releaseRolling();
      renderNow();
      onSelect(sessionId);
      return { ok: true, sessionId };
    }

    /** DOM 被重建：代际号 +1，让所有在飞的定时器作废。 */
    function invalidate() {
      reelGen += 1;
      clearTimers();
      rolling = false;
      shownTitle = null;
    }

    return {
      flipOnce,
      invalidate,
      isRolling () { return rolling; },
      lockedId () { return lockedId; },
      currentTitle () { return shownTitle; },
      renderNow,
      schedule,
      select,
      toggleLock,
      update,
      /** 测试用：把看门狗之外的所有定时器清掉。 */
      stop () { clearTimers(); releaseRolling(); },
    };
  }

  global.WhaleCarousel = {
    DWELL_MS,
    FLIP_HALF_MS,
    FLIP_PERIOD_MS,
    WATCHDOG_MS,
    createReel,
    planReel,
    runningSessions,
  };
})(typeof window !== "undefined" ? window : globalThis);

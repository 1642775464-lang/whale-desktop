/**
 * 小窗崩溃自愈
 *
 * 职责：渲染进程崩溃时决定「重载还是落兜底页」，并管住重载退避。
 * 所属层：小窗（whale-window/lib）
 *
 * 状态机（《小窗-PRD》F11/F13）：
 *
 *   运行 ──render-process-gone──→ 计数+1
 *                                   │
 *                     计数 ≤ 3 ─────┴──── 计数 > 3
 *                       │                   │
 *                    reload()         加载 crashed.html
 *                       │                   │
 *                    加载成功 → 计数清零   提供「再试一次」
 *
 * **重载上限取 3**（`RENDERER_RELOAD_MAX = 3`）：PRD 写 3，而
 * references/electron-patterns.md 的示例写 `crashCount <= 2`（即最多两次）。
 * 两处不一致时按**冲突裁决顺序**取 PRD（PRD > ARCHITECTURE > STATUS），
 * 即「前 3 次重载、第 4 次落兜底页」。这处取舍已在切片 5 范围声明 S5-D4 记录。
 *
 * **只有 `did-finish-load` 才算「回来」**：重载请求发出不等于页面起来了，
 * 若在发出时就清零，一个必崩的页面会无限重载下去。
 */

"use strict";

/** 重载上限（PRD F11）。 */
const RENDERER_RELOAD_MAX = 3;

/** 退避基数：第 n 次重载等 400ms × n（PRD F11）。 */
const BACKOFF_MS = 400;

/** 兜底页文件名（相对 renderer/）。 */
const CRASHED_PAGE = "crashed.html";

/** 形态。 */
const PHASE = Object.freeze({
  RUNNING: "running",
  RECOVERING: "recovering",
  FALLBACK: "fallback",
});

/**
 * 建一个崩溃自愈状态机。
 *
 * @param {object} deps
 * @param {() => void} deps.reload 重载页面
 * @param {() => void} deps.loadFallback 加载兜底页
 * @param {(msg: string) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {number} [deps.maxReloads]
 * @param {(fn: () => void, ms: number) => number} [deps.schedule]
 * @param {(h: number) => void} [deps.cancel]
 * @returns {object} 状态机
 */
function createRecovery(deps) {
  const reload = deps.reload;
  const loadFallback = deps.loadFallback;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const maxReloads = Number.isInteger(deps.maxReloads) ? deps.maxReloads : RENDERER_RELOAD_MAX;
  const schedule = typeof deps.schedule === "function" ? deps.schedule : defaultSchedule;
  const cancel = typeof deps.cancel === "function" ? deps.cancel : defaultCancel;

  /** 连续崩溃次数（一次成功加载就清零）。 */
  let crashCount = 0;
  let phase = PHASE.RUNNING;
  let pendingHandle = null;

  const stats = { gone: 0, reloaded: 0, fallbackShown: 0, recovered: 0, reloadFailed: 0 };

  /**
   * 渲染进程没了。
   *
   * @param {{reason?: string, exitCode?: number}} [details]
   * @returns {{action: "reload"|"fallback", delayMs: number, attempt: number}}
   */
  function onRendererGone(details = {}) {
    stats.gone += 1;
    crashCount += 1;
    phase = PHASE.RECOVERING;

    const why = details.reason ?? "unknown";
    log(`[小窗] 渲染进程退出（第 ${crashCount} 次，原因 ${why}）`);

    if (crashCount > maxReloads) {
      phase = PHASE.FALLBACK;
      stats.fallbackShown += 1;
      log(`[小窗] 连续崩溃 ${crashCount} 次，超过上限 ${maxReloads}，加载兜底页`);
      loadFallback();
      return { action: "fallback", delayMs: 0, attempt: crashCount };
    }

    // 退避：第 n 次等 400 × n
    const delayMs = BACKOFF_MS * crashCount;
    if (pendingHandle !== null) cancel(pendingHandle);
    pendingHandle = schedule(() => {
      pendingHandle = null;
      stats.reloaded += 1;
      log(`[小窗] 第 ${crashCount} 次重载（退避 ${delayMs}ms）`);
      reload();
    }, delayMs);

    return { action: "reload", delayMs, attempt: crashCount };
  }

  /**
   * 页面加载成功。
   *
   * **只有走到这里才算恢复**——重载请求发出不等于页面起来了。
   *
   * @returns {{wasRecovering: boolean, crashCountBefore: number}}
   */
  function onLoaded() {
    const before = crashCount;
    const wasRecovering = phase === PHASE.RECOVERING || phase === PHASE.FALLBACK;
    if (wasRecovering && before > 0) stats.recovered += 1;

    crashCount = 0;
    phase = PHASE.RUNNING;
    if (pendingHandle !== null) {
      cancel(pendingHandle);
      pendingHandle = null;
    }
    return { wasRecovering, crashCountBefore: before };
  }

  /** 加载失败（did-fail-load）。只落日志，不计入崩溃——它不是渲染进程崩溃。 */
  function onLoadFailed(info = {}) {
    stats.reloadFailed += 1;
    log(`[小窗] 页面加载失败：code=${info.errorCode ?? "?"} ${info.errorDescription ?? ""}`);
  }

  /** 「再试一次」：兜底页上的按钮。把计数清零并重载。 */
  function retry() {
    log("[小窗] 用户在兜底页点了「再试一次」");
    crashCount = 0;
    phase = PHASE.RECOVERING;
    stats.reloaded += 1;
    reload();
    return { ok: true };
  }

  return {
    /** 当前形态。 */
    phase: () => phase,
    crashCount: () => crashCount,
    stats,
    onLoaded,
    onLoadFailed,
    onRendererGone,
    retry,
    /** 是否有待触发的重载。 */
    hasPending: () => pendingHandle !== null,
    /** 卸下：取消待触发的重载。 */
    dispose: () => {
      if (pendingHandle !== null) {
        cancel(pendingHandle);
        pendingHandle = null;
      }
    },
  };
}

/** 默认定时器。 */
function defaultSchedule(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

/** 默认取消器。 */
function defaultCancel(handle) {
  clearTimeout(handle);
}

module.exports = {
  BACKOFF_MS,
  CRASHED_PAGE,
  PHASE,
  RENDERER_RELOAD_MAX,
  createRecovery,
};

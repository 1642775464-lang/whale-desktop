/**
 * 小窗窗口状态持久化
 *
 * 职责：记住窗口的位置、尺寸、置顶状态，下次启动恢复；
 *       并判定记忆位置是否仍然有效（屏幕可能被拔掉）。
 * 所属层：小窗（whale-window/lib）
 *
 * 两条判据都来自《小窗-PRD》F12，且都是「换一种写法就会出错」的地方：
 *
 * 1. **位置有效性 = 与任一显示器工作区的交集面积 ≥ 窗口自身的 25%**
 *    - 不用「完全包含」：窗口允许略微超出边缘（用户故意贴边），
 *      全包含判据会把这些合理位置判成无效、反复重置；
 *    - 不用「左上角在屏幕内」：左上角在屏内但窗口 90% 在屏外的很常见
 *      （拖到边缘），那种位置对用户没意义。
 *
 * 2. **写盘 400ms 防抖，但退出时立即补写一次**
 *    - `move`/`resize` 高频触发，不防抖会疯狂写盘；
 *    - 只防抖不补写的话，「拖完马上关」的最后一次位置会丢。
 *
 * 文件 IO 与时钟**由外部注入**，因此本模块可脱离 Electron 与真实磁盘单测。
 */

"use strict";

/** 防抖时长（PRD F12）。 */
const DEBOUNCE_MS = 400;

/** 位置有效性的交集面积占比下限（PRD F12）。 */
const MIN_VISIBLE_RATIO = 0.25;

/** 状态文件名（落在 .userdata 下）。 */
const STATE_FILENAME = "window-state.json";

/**
 * 计算两个矩形的交集面积。
 *
 * @param {{x:number,y:number,width:number,height:number}} a
 * @param {{x:number,y:number,width:number,height:number}} b
 * @returns {number}
 */
function intersectionArea(a, b) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  return (right - left) * (bottom - top);
}

/**
 * 判定窗口矩形是否落在某块屏上「足够可见」。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds
 * @param {Array<{x:number,y:number,width:number,height:number}>} workAreas
 * @param {number} [minRatio]
 * @returns {{valid: boolean, bestRatio: number, bestAreaIndex: number}}
 */
function isPositionUsable(bounds, workAreas, minRatio = MIN_VISIBLE_RATIO) {
  if (!isRect(bounds)) return { valid: false, bestRatio: 0, bestAreaIndex: -1 };
  const areas = Array.isArray(workAreas) ? workAreas.filter(isRect) : [];
  if (areas.length === 0) return { valid: false, bestRatio: 0, bestAreaIndex: -1 };

  const selfArea = bounds.width * bounds.height;
  if (selfArea <= 0) return { valid: false, bestRatio: 0, bestAreaIndex: -1 };

  let best = 0;
  let bestIndex = -1;
  areas.forEach((area, index) => {
    const ratio = intersectionArea(bounds, area) / selfArea;
    if (ratio > best) {
      best = ratio;
      bestIndex = index;
    }
  });

  return { valid: best >= minRatio, bestRatio: best, bestAreaIndex: bestIndex };
}

/** 矩形校验。 */
function isRect(r) {
  if (r === null || typeof r !== "object") return false;
  const nums = [r.x, r.y, r.width, r.height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return false;
  return r.width > 0 && r.height > 0;
}

/**
 * 规整读进来的状态。
 *
 * 读文件不能信内容（可能被手改坏、可能版本变更）。任何一个字段不合法
 * 就整条丢弃，而不是「尽量用」——半对不对的位置比没有位置更糟：
 * 窗口会出现在屏幕外或尺寸错乱，用户还得自己去修。
 *
 * @param {unknown} raw
 * @returns {{x:number,y:number,width:number,height:number,pinned?:boolean} | null}
 */
function normalizeState(raw) {
  if (raw === null || typeof raw !== "object") return null;
  const { x, y, width, height } = raw;
  const nums = [x, y, width, height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (width <= 0 || height <= 0) return null;
  const out = {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
  if (typeof raw.pinned === "boolean") out.pinned = raw.pinned;
  return out;
}

/**
 * 建一个状态存储器。
 *
 * @param {object} deps
 * @param {(text: string) => void} deps.write 写文件（注入，便于测）
 * @param {() => string} deps.read 读文件（注入；读不到返回空串）
 * @param {() => Array<object>} deps.workAreas 当前所有显示器工作区
 * @param {(bounds: object) => void} [deps.onPersist] 每次写盘后的回调（诊断用）
 * @param {() => number} [deps.now]
 * @param {(fn: () => void, ms: number) => number} [deps.schedule]
 * @param {(h: number) => void} [deps.cancel]
 * @returns {object} 存储器
 */
function createStateStore(deps) {
  const write = deps.write;
  const read = deps.read;
  const workAreas = deps.workAreas;
  const onPersist = typeof deps.onPersist === "function" ? deps.onPersist : () => {};
  const schedule = typeof deps.schedule === "function" ? deps.schedule : defaultSchedule;
  const cancel = typeof deps.cancel === "function" ? deps.cancel : defaultCancel;

  /** 最近一次已知的窗口矩形。 */
  let last = null;
  /** 防抖句柄。 */
  let pending = null;

  /** 把当前状态立刻写盘（绕过防抖）。 */
  function flush() {
    if (pending !== null) {
      cancel(pending);
      pending = null;
    }
    if (last === null) return false;
    write(JSON.stringify(last));
    onPersist(last);
    return true;
  }

  /**
   * 记下新位置。高频调用（move/resize），故走防抖。
   *
   * @param {object} bounds
   */
  function remember(bounds) {
    const clean = normalizeState(bounds);
    if (clean === null) return;
    if (typeof bounds.pinned === "boolean") clean.pinned = bounds.pinned;
    last = clean;

    if (pending !== null) cancel(pending);
    pending = schedule(() => {
      pending = null;
      if (last === null) return;
      write(JSON.stringify(last));
      onPersist(last);
    }, DEBOUNCE_MS);
  }

  /**
   * 读回记忆位置。
   *
   * 返回 `{bounds, reason}`：
   *   - 没有记忆 / 内容不合法 → bounds null，reason 说明原因
   *   - 记忆位置已不在任何屏上（拔了外接屏）→ bounds null，reason 'off-screen'
   *   - 正常 → bounds 为该矩形
   *
   * @returns {{bounds: object|null, reason: string, ratio?: number}}
   */
  function restore() {
    let raw;
    try {
      raw = read();
    } catch (err) {
      return { bounds: null, reason: `read-failed: ${err?.message ?? err}` };
    }
    if (typeof raw !== "string" || raw.trim() === "") {
      return { bounds: null, reason: "no-memory" };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { bounds: null, reason: "corrupt-json" };
    }

    const state = normalizeState(parsed);
    if (state === null) return { bounds: null, reason: "invalid-fields" };

    const check = isPositionUsable(state, workAreas());
    if (!check.valid) {
      // 关键：位置失效要**明确落日志**（B13 判据），不能静默回默认值
      return { bounds: null, reason: "off-screen", ratio: check.bestRatio };
    }

    return { bounds: state, reason: "ok", ratio: check.bestRatio };
  }

  /** 是否还有未落盘的改动（退出时用来判断要不要补写）。 */
  function hasPending() {
    return pending !== null;
  }

  return {
    flush,
    hasPending,
    remember,
    restore,
    /** 诊断：当前记住的状态 */
    peek: () => (last === null ? null : { ...last }),
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
  DEBOUNCE_MS,
  MIN_VISIBLE_RATIO,
  STATE_FILENAME,
  createStateStore,
  intersectionArea,
  isPositionUsable,
  normalizeState,
};

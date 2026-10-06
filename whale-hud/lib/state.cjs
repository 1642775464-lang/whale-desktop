/**
 * 悬浮条状态机
 *
 * 职责：记「现在是哪种形态」（条 / 球 / 悬停详情），以及定「什么事件能从
 *       哪个形态走到哪个形态」；悬停缩回的 180ms 与 3 秒兜底也归这里。
 * 所属层：悬浮条（whale-hud/lib）
 *
 * 为什么单独成文件：这里的每条规则都是**踩过坑的结论**，不是随手写的分支——
 *   1. 悬停详情只能在「条」形态进入，球形态下鼠标划过不该弹层；
 *   2. 详情态必须有一个 3 秒兜底：鼠标快速飞出窗口时浏览器可能不派发
 *      mouseleave，窗口就会一直高着，屏幕下方凭空多出一片隐形点击陷阱；
 *   3. 收起时要把挂着的定时器全部撤掉，否则「缩回」会在球形态里
 *      把窗口改回 72 高，球形态窗口跟着变形。
 *
 * 时间来源与定时器**由外部注入**，因此本模块可脱离 Electron 与真实时钟单测。
 * 这是它值得单独存在的关键：靠真实 setTimeout 测状态机，测试要么慢要么飘。
 */

"use strict";

/** 悬停移出后缩回窗口的延迟（《前端设计规范》1.6）。 */
const HOVER_RETRACT_MS = 180;

/** 详情态的兜底缩回定时器（防止漏收 mouseleave 导致窗口一直高着）。 */
const DETAIL_FALLBACK_MS = 3000;

/** 收起动画时长（PRD F5）——主进程按它决定何时允许下一次形态切换日志。 */
const COLLAPSE_MS = 275;

/** 展开动画时长（PRD F5）。 */
const EXPAND_MS = 335;

/** 合法形态。 */
const FORMS = ["bar", "ball", "detail"];

/**
 * 建立一个悬浮条状态机。
 *
 * @param {object} [deps]
 * @param {(form: string, reason: string) => void} [deps.onChange] 形态变化回调（含原因，便于排查）
 * @param {(fn: () => void, ms: number) => number} [deps.schedule] 注入的定时器（测试用假实现）
 * @param {(handle: number) => void} [deps.cancel] 注入的取消器
 * @returns {object} 状态机
 */
function createHudState(deps = {}) {
  const onChange = typeof deps.onChange === "function" ? deps.onChange : () => {};
  const schedule = typeof deps.schedule === "function" ? deps.schedule : defaultSchedule;
  const cancel = typeof deps.cancel === "function" ? deps.cancel : defaultCancel;

  /** @type {string} */
  let form = "bar";

  /** 缩回定时器句柄（悬停移出后 180ms 触发）。 */
  let retractHandle = null;

  /** 兜底定时器句柄（进入详情后 3 秒强制缩回）。 */
  let fallbackHandle = null;

  /** 清掉所有挂着的定时器。 */
  function clearTimers() {
    if (retractHandle !== null) {
      cancel(retractHandle);
      retractHandle = null;
    }
    if (fallbackHandle !== null) {
      cancel(fallbackHandle);
      fallbackHandle = null;
    }
  }

  /**
   * 切形态。
   *
   * 相同形态不回调——上层据此跳过 setBounds，
   * 否则每分钟几十次重复 setBounds 会让窗口闪烁。
   *
   * @param {string} next
   * @param {string} reason
   */
  function setForm(next, reason) {
    if (!FORMS.includes(next)) throw new TypeError(`未知形态：${next}`);
    if (next === form) return;
    form = next;
    onChange(form, reason);
  }

  /** 收起成球。详情态也能直接收起。 */
  function collapse() {
    clearTimers();
    setForm("ball", "collapse");
  }

  /** 展开成条。 */
  function expand() {
    clearTimers();
    setForm("bar", "expand");
  }

  /**
   * 鼠标进入上下文段。
   *
   * 只有「条」形态才响应：球形态下鼠标划过不该弹详情，
   * 那会让一个 88×88 的球突然变成 588×340 的高窗口。
   */
  function hoverEnter() {
    if (form === "ball") return;
    clearTimers();
    setForm("detail", "hover-enter");
    fallbackHandle = schedule(() => {
      fallbackHandle = null;
      setForm("bar", "detail-fallback");
    }, DETAIL_FALLBACK_MS);
  }

  /**
   * 鼠标离开上下文段。
   *
   * 延迟 180ms 再缩回而不是立刻缩：鼠标从段上移到浮层上时会先离开段，
   * 立刻缩回会让浮层在鼠标到达之前就消失，用户永远点不到它。
   */
  function hoverLeave() {
    if (form !== "detail") return;
    if (retractHandle !== null) cancel(retractHandle);
    retractHandle = schedule(() => {
      retractHandle = null;
      setForm("bar", "hover-leave");
    }, HOVER_RETRACT_MS);
  }

  /** 当前是否有挂着的定时器（诊断用，测试也用它证明「收起时确实清干净了」）。 */
  function pendingTimers() {
    return {
      retract: retractHandle !== null,
      fallback: fallbackHandle !== null,
    };
  }

  /**
   * 恢复到指定形态。
   *
   * F7 的「重新加载界面」会重载渲染进程，重载后主进程必须把窗口摆回
   * 用户当时看到的那个形态——否则用户收起的球，一重新加载就弹回长条。
   * 这个入口也是形态合法性校验的唯一真实调用点。
   *
   * @param {string} next
   * @param {string} [reason]
   */
  function restore(next, reason = "restore") {
    clearTimers();
    setForm(next, reason);
  }

  /** 卸下状态机：清定时器，不再回调。 */
  function dispose() {
    clearTimers();
  }

  return {
    collapse,
    dispose,
    expand,
    form: () => form,
    hoverEnter,
    hoverLeave,
    pendingTimers,
    restore,
  };
}

/**
 * 默认定时器：真实时钟。
 *
 * unref 的理由：悬浮条退出时不该被一个 3 秒的兜底定时器拖住。
 *
 * @param {() => void} fn
 * @param {number} ms
 * @returns {number}
 */
function defaultSchedule(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (typeof handle.unref === "function") handle.unref();
  return handle;
}

/**
 * 默认取消器。
 *
 * @param {number} handle
 */
function defaultCancel(handle) {
  clearTimeout(handle);
}

module.exports = {
  COLLAPSE_MS,
  DETAIL_FALLBACK_MS,
  EXPAND_MS,
  FORMS,
  HOVER_RETRACT_MS,
  createHudState,
};

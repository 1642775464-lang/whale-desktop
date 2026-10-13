/**
 * 小窗 preload
 *
 * 职责：向渲染层暴露**白名单**的 `window.whale`——**只含必须由主进程做的事**
 *       （窗口动作、拖动、日志、退出前补写状态）。
 * 所属层：小窗（whale-window）
 *
 * 为什么这里**没有** send / abort / command / activate / resume：
 * 那些是往桥发的 HTTP 请求，渲染层自己 `fetch` 就能做（悬浮条就是这么做的，
 * 且实测 file:// 页面访问回环 HTTP 完全可行）。把它们塞进 IPC 只会多一层
 * 转发、多一份可能不同步的签名，没有任何收益。
 *
 * 纪律（开发规范强制 32/34）：只暴露具名方法，**绝不暴露 `ipcRenderer` 本体**，
 * 也不提供「任意 channel 转发」的万能口子——那等于把整个主进程开放给页面。
 *
 * 通道名必须与 lib/ipc.cjs 的 CHANNELS 一一对应：
 * 多暴露一个而主进程没注册，调用就是一个永远挂起的 Promise（不报错，最难查）。
 * 这层对应关系由 tests/contract/window-renderer.test.mjs 钉死。
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** 与主进程 lib/ipc.cjs 的 CHANNELS 严格一致。 */
const CHANNELS = {
  READY: "whale:ready",
  WINDOW: "whale:window",
  DRAG: "whale:drag",
  LOG: "whale:log",
  FLUSH_STATE: "whale:flush-state",
  SIDE: "whale:side",
};

/**
 * 窗口动作白名单的**权威定义在 lib/ipc.cjs**（那里负责拒绝越界动作）。
 * 这里不重复一份——重复的常量迟早会不同步，而不同步的表现是
 * 「界面点了没反应」这种最难查的故障。
 */

contextBridge.exposeInMainWorld("whale", {
  /** 渲染层就绪：主进程据此回一行自检信息（含窗口尺寸与置顶态）。 */
  ready: () => ipcRenderer.invoke(CHANNELS.READY),

  /**
   * 窗口动作（白名单，越界由主进程拒绝并回错误码）。
   *
   * @param {"minimize"|"hide"|"close"|"toggle-pin"} action
   * @returns {Promise<{ok: boolean, code?: string, pinned?: boolean}>}
   */
  windowAction: (action) => ipcRenderer.invoke(CHANNELS.WINDOW, { action }),

  /**
   * 无边框拖动：把鼠标位移交给主进程（顶栏是拖拽区）。
   *
   * @param {number} dx
   * @param {number} dy
   */
  drag: (dx, dy) => ipcRenderer.invoke(CHANNELS.DRAG, { dx, dy }),

  /**
   * 渲染层日志落盘。
   *
   * 为什么要它：小窗是「没人看着的窗口」，出了错不写下来等于没发生。
   *
   * @param {string} message
   */
  log: (message) => ipcRenderer.invoke(CHANNELS.LOG, { message }),

  /**
   * 退出前立刻补写窗口状态（F12：防抖之外的最后一次位置）。
   */
  flushState: () => ipcRenderer.invoke(CHANNELS.FLUSH_STATE),

  /**
   * 右侧附带窗：开 / 关 / 切换 / 查状态。
   *
   * 白名单在 lib/ipc.cjs（越界由主进程拒绝并回错误码）。
   *
   * @param {"open"|"close"|"toggle"|"state"} action
   * @returns {Promise<{ok: boolean, opened?: boolean, code?: string}>}
   */
  sideAction: (action) => ipcRenderer.invoke(CHANNELS.SIDE, { action }),
});

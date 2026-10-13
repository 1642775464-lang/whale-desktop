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
  /*
   * 主进程 → 渲染层：侧窗「贴住」状态变化。
   * 这是**单向推送**，不在下面的 invoke 清单里（它不是渲染层主动调的）。
   */
  SIDE_JOINED: "whale:side-joined",
  /* 渲染层 → 主进程：上报当前会话与工作区（建侧窗时要用）。 */
  STATE: "whale:state",
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

  /**
   * 订阅侧窗「贴住」状态变化（主进程单向推送）。
   *
   * 主窗据此去掉自己右侧的圆角、边框与阴影，与侧窗连成一个面板
   * （用户报「中间不要显示成两个图层」）。
   *
   * ⚠️ **只传布尔值进去**，不把事件对象交给渲染层 —— 事件对象上带着
   * `sender` 等能力，交出去等于开了一条回到主进程的路。
   *
   * @param {(joined: boolean) => void} handler
   * @returns {() => void} 取消订阅
   */
  onSideJoined: (handler) => {
    if (typeof handler !== "function") return () => {};
    const listener = (_event, payload) => handler(payload?.joined === true);
    ipcRenderer.on(CHANNELS.SIDE_JOINED, listener);
    return () => ipcRenderer.removeListener(CHANNELS.SIDE_JOINED, listener);
  },

  /**
   * 上报当前状态（会话 id / 工作区路径）给主进程。
   *
   * 主进程建侧窗时要把这两个值交给页面：
   *   · 会话 id → 侧边对话「继承上下文」的默认项；
   *   · 工作区路径 → html 预览要拼 `file://` 地址。
   *
   * ⚠️ 只传两个字符串，不把整个 state 丢过去 —— 主进程不需要知道别的，
   * 传多了等于把渲染层的内部结构耦合进主进程。
   *
   * @param {{sessionId?: string, workspace?: string}} state
   */
  reportState: (state) => ipcRenderer.invoke(CHANNELS.STATE, {
    sessionId: typeof state?.sessionId === "string" ? state.sessionId : "",
    workspace: typeof state?.workspace === "string" ? state.workspace : "",
  }),
});

/**
 * 悬浮条 preload
 *
 * 职责：向渲染层暴露**白名单**的 `window.hud` 通道。
 * 所属层：悬浮条（whale-hud）
 *
 * 纪律（开发规范强制 34）：只暴露具名方法，**绝不暴露 `ipcRenderer` 本体**，
 * 也不提供「任意 channel 转发」这种万能口子——那等于把整个主进程开放给页面。
 *
 * 通道名必须与 lib/ipc.cjs 的 CHANNELS 一一对应：
 * 多暴露一个而主进程没注册，调用就是一个永远挂起的 Promise（不报错，最难查）。
 * 这层对应关系由 tests/contract/hud-renderer.test.mjs 钉死。
 */

"use strict";

const { contextBridge, ipcRenderer } = require("electron");

/** 与主进程 lib/ipc.cjs 的 CHANNELS 严格一致。 */
const CHANNELS = {
  FORM: "hud:form",
  HOVER: "hud:hover",
  HIDE: "hud:hide",
  QUIT: "hud:quit",
  RELOAD: "hud:reload",
  MENU: "hud:menu",
  READY: "hud:ready",
  DRAG_START: "hud:drag-start",
  DRAG_MOVE: "hud:drag-move",
  DRAG_END: "hud:drag-end",
  /** 唤起：显示 + 展开成条 + 聚焦（桥留标记、渲染层轮询来取） */
  SUMMON: "hud:summon",
};

contextBridge.exposeInMainWorld("hud", {
  /** 渲染层就绪：主进程据此回一行自检信息。 */
  ready: () => ipcRenderer.invoke(CHANNELS.READY),

  /**
   * 切形态。
   *
   * @param {"bar"|"ball"} form
   */
  setForm: (form) => ipcRenderer.invoke(CHANNELS.FORM, { form }),

  /** 悬停上下文段：进入/离开详情。 */
  hover: (entering) => ipcRenderer.invoke(CHANNELS.HOVER, { entering: entering === true }),

  /** 拖动（仅球形态）：起点 → 累计位移 → 结束。 */
  dragStart: () => ipcRenderer.invoke(CHANNELS.DRAG_START),
  dragMove: (dx, dy) => ipcRenderer.invoke(CHANNELS.DRAG_MOVE, { dx, dy }),
  dragEnd: () => ipcRenderer.invoke(CHANNELS.DRAG_END),

  /** F7 右键菜单。 */
  showMenu: () => ipcRenderer.invoke(CHANNELS.MENU),

  /**
   * 唤起：显示 + 展开成条 + 聚焦。
   *
   * 由渲染层在轮询发现「桥留了唤起请求」时调用
   * （桥无法主动推给窗口，所以走「桥留标记、窗口来取」）。
   */
  summon: () => ipcRenderer.invoke(CHANNELS.SUMMON),

  /** 隐藏 / 退出 / 重载界面。 */
  hide: () => ipcRenderer.invoke(CHANNELS.HIDE),
  quit: () => ipcRenderer.invoke(CHANNELS.QUIT),
  reload: () => ipcRenderer.invoke(CHANNELS.RELOAD),
});

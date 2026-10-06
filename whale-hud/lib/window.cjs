/**
 * 悬浮条窗口
 *
 * 职责：创建那条无边框透明窗口，按形态切换 bounds，并实现球的拖动；
 *       状态机与几何计算都不在这里。
 * 所属层：悬浮条（whale-hud/lib）
 *
 * 为什么单独成文件：这是唯一**真的碰到 Electron 窗口对象**的地方。
 * 把它隔离出来，几何与状态机就都能脱离 Electron 单测；
 * 而这一层薄到只剩调用，出错时一眼能看出是「参数给错了」还是「Electron 行为如此」。
 *
 * 窗口安全口径对齐宿主（开发规范强制 33 / references §一）：
 * contextIsolation 开、nodeIntegration 关、sandbox 开、webviewTag 关，不得放宽。
 *
 * 关于锚点：球可拖动。拖动后图标离开居中位置，所以这里记住「图标屏幕 x」，
 * 之后任何形态切换都按这个锚点定位——否则展开时图标会跳回屏幕中央。
 */

"use strict";

const geometry = require("./geometry.cjs");

/**
 * 建悬浮条窗口。
 *
 * @param {object} deps
 * @param {object} deps.BrowserWindow Electron 的 BrowserWindow 构造器
 * @param {object} deps.screen Electron 的 screen 模块（须在 app ready 之后使用）
 * @param {string} deps.preloadFile  preload.cjs 的绝对路径
 * @param {object} deps.log
 * @returns {object} 窗口句柄封装
 */
function createHudWindow(deps) {
  const { BrowserWindow, screen, preloadFile, log } = deps;

  const win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    roundedCorners: false,
    // 透明窗口必须给透明底色，否则 Windows 上会出现一块不透明底
    backgroundColor: "#00000000",
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });

  // screen-saver 层级才能压过最大化的前台窗口标题栏（PRD F1）
  win.setAlwaysOnTop(true, "screen-saver");
  // 所有虚拟桌面可见，含全屏应用之上（PRD F1）
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // Windows 上仅靠构造参数有时不生效，再显式设一次（A3）
  win.setSkipTaskbar(true);

  /** 图标左边缘的屏幕 x；null 表示「还没被拖过，按居中算」。 */
  let anchorIconX = null;

  /** 本次拖动的起点（窗口坐标 + 锚点）。 */
  let dragOrigin = null;

  /** 页面加载完成（验收脚本据此判断「首帧到了」）。 */
  const loaded = new Promise((resolve) => {
    win.webContents.once("did-finish-load", () => resolve(true));
  });

  /** 取当前工作区（DIP）。每次都重新取：任务栏挪位置时工作区会变。 */
  function workArea() {
    return screen.getPrimaryDisplay().workArea;
  }

  /**
   * 按形态摆窗口，并落日志。
   *
   * 日志是 A1 的取证手段：把 bounds 与 workArea 放同一行，
   * 事后一对就能算居中误差，不必再加调试代码。
   *
   * @param {string} form
   * @returns {{x: number, y: number, width: number, height: number}}
   */
  function applyForm(form) {
    const area = workArea();
    const bounds = geometry.boundsFor(form, area, anchorIconX);
    if (!win.isDestroyed()) win.setBounds(bounds);
    log.info(`形态=${form} bounds=${JSON.stringify(bounds)} workArea=${JSON.stringify(area)}`);
    return bounds;
  }

  /** 当前窗口矩形（验收脚本用）。 */
  function bounds() {
    return win.isDestroyed() ? null : win.getBounds();
  }

  /**
   * 由当前矩形反推锚点。
   *
   * 拖动之后必须把锚点更新成「图标现在在哪」，否则下一次切换形态会跳回原位。
   */
  function refreshAnchorFromBounds(currentForm) {
    const b = bounds();
    if (b === null) return;
    anchorIconX =
      currentForm === "ball"
        ? b.x + geometry.GEOMETRY.BALL_INSET_X
        : b.x + geometry.GEOMETRY.ICON_IN_WINDOW_X;
  }

  /** 显示但不抢焦点（A2）。 */
  function show() {
    if (win.isDestroyed()) return;
    win.showInactive();
    // showInactive 之后 Windows 偶尔会把 skipTaskbar 重置，再压一次
    win.setSkipTaskbar(true);
  }

  /** 记下拖动起点。 */
  function dragStart() {
    const b = bounds();
    dragOrigin = b === null ? null : { x: b.x, y: b.y, w: b.width, h: b.height };
    return dragOrigin !== null;
  }

  /**
   * 按累计位移移动窗口。
   *
   * 用**累计位移**而不是逐帧增量：逐帧增量会把每一次 setBounds 的取整误差
   * 累加起来，拖久了窗口会明显漂移。
   *
   * @param {number} dx
   * @param {number} dy
   * @returns {boolean} 是否真的移动了
   */
  function dragMove(dx, dy) {
    if (dragOrigin === null || win.isDestroyed()) return false;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    win.setBounds({
      x: Math.round(dragOrigin.x + dx),
      y: Math.round(dragOrigin.y + dy),
      width: dragOrigin.w,
      height: dragOrigin.h,
    });
    return true;
  }

  /**
   * 结束拖动，并把锚点更新到图标的新位置。
   *
   * @param {string} currentForm
   */
  function dragEnd(currentForm) {
    refreshAnchorFromBounds(currentForm);
    dragOrigin = null;
  }

  /** 重载界面（F7「重新加载界面」）。 */
  function reload() {
    if (!win.isDestroyed()) win.webContents.reload();
  }

  /** 关掉窗口。 */
  function destroy() {
    if (!win.isDestroyed()) win.destroy();
  }

  return {
    applyForm,
    bounds,
    destroy,
    dragEnd,
    dragMove,
    dragStart,
    loaded,
    reload,
    show,
    win,
    workArea,
    /** 当前锚点（诊断用）。 */
    anchor: () => anchorIconX,
  };
}

module.exports = { createHudWindow };

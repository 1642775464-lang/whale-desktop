/**
 * 小窗窗口
 *
 * 职责：创建那扇无边框透明窗口（真圆角 + CSS 阴影），并管住关闭语义与置顶。
 * 所属层：小窗（whale-window/lib）
 *
 * 三条实测得出的窗口口径（《小窗-PRD》5.4，每条都有代价）：
 *
 *   1. `transparent: true` + `roundedCorners: false` + `hasShadow: false`
 *      圆角必须由「窗口透明 + CSS 裁角」共同实现。曾用 `transparent: false`
 *      + 实底 backgroundColor，结果窗口永远是方角。
 *
 *   2. `hasShadow` 必须保持 false
 *      Windows 对无边框透明窗基本不画原生阴影；而 CSS 的 box-shadow 只画在
 *      窗口矩形内部，`.win` 又贴着四边 —— 外阴影的可见部分全在窗口外，被裁掉。
 *      所以窗口要比内容大一圈 SHADOW_PAD，再由 CSS 用等量 padding 收回。
 *
 *   3. `roundedCorners: false`
 *      透明窗下必须关掉原生圆角，否则原生裁角 + CSS 裁角两次裁切，
 *      半径叠加会让边缘发虚。
 *
 * 窗口安全口径对齐宿主（开发规范强制 33）：contextIsolation 开、
 * nodeIntegration 关、sandbox 开、webviewTag 关。不得放宽。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const geometry = require("./geometry.cjs");

/** 等页面加载的上限（与悬浮条同因：loadFile 漏了会让等待者永久挂住）。 */
const LOAD_TIMEOUT_MS = 8000;

/** 小窗所在目录（本文件在 lib/ 下，往上一层）。 */
const WINDOW_DIR = path.resolve(__dirname, "..");

/**
 * 建小窗。
 *
 * @param {object} deps
 * @param {object} deps.BrowserWindow Electron 的 BrowserWindow 构造器
 * @param {string} [deps.rendererFile] 页面路径（默认 renderer/index.html）
 * @param {string} [deps.preloadFile] preload 路径（默认 preload.cjs）
 * @param {{x:number,y:number,width:number,height:number}} deps.bounds 初始窗口矩形
 * @param {boolean} [deps.pinned] 是否置顶
 * @param {Record<string,string>} [deps.query] 传给页面的查询串
 * @param {object} deps.log
 * @returns {object} 窗口封装
 */
function createWindow(deps) {
  const { BrowserWindow, log } = deps;
  const rendererFile = deps.rendererFile ?? path.join(WINDOW_DIR, "renderer", "index.html");
  const preloadFile = deps.preloadFile ?? path.join(WINDOW_DIR, "preload.cjs");
  const bounds = deps.bounds;

  // 入口必须存在。漏了或路径写错时，loadFile 只会抛一个
  // UnhandledPromiseRejectionWarning，**窗口照样建出来但是空的**——
  // 外面看到「窗口在、一片白」，极难归因（悬浮条那边踩过两次）。
  if (!fs.existsSync(rendererFile)) {
    throw new Error(`渲染层入口不存在：${rendererFile}`);
  }

  const win = new BrowserWindow({
    show: false,
    ...bounds,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    roundedCorners: false,
    hasShadow: false,
    // F1：可缩放、可拖动；不占任务栏、不进全屏
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: deps.pinned !== false,
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

  // 置顶层级用 floating（PRD F1）——小窗是「常用工具窗」，
  // 不该像悬浮条那样压过一切
  win.setAlwaysOnTop(deps.pinned !== false, "floating");
  win.setSkipTaskbar(true);

  /** 页面加载完成（带超时兜底，理由同悬浮条）。 */
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
    if (typeof timer.unref === "function") timer.unref();
    win.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

  /** 加载页面。这是窗口里「有东西」的唯一来源。 */
  win.loadFile(rendererFile, deps.query ? { query: deps.query } : undefined);

  /** 当前窗口矩形。 */
  function currentBounds() {
    return win.isDestroyed() ? null : win.getBounds();
  }

  /** 当前可见内容尺寸（窗口减去四周投影边距）。 */
  function contentSize() {
    const b = currentBounds();
    return b === null ? null : geometry.toContentSize(b);
  }

  /** 显示但不抢焦点。 */
  function show() {
    if (win.isDestroyed()) return;
    win.show();
  }

  /** 切换置顶。返回切换后的状态。 */
  function togglePin() {
    if (win.isDestroyed()) return false;
    const next = !win.isAlwaysOnTop();
    win.setAlwaysOnTop(next, "floating");
    log.info(`置顶 → ${next ? "开" : "关"}`);
    return next;
  }

  /** 最小化（F10：临时收起）。 */
  function minimize() {
    if (!win.isDestroyed()) win.minimize();
  }

  /**
   * 隐藏（F10：顶栏 × 拦截成隐藏而不是退出，与 DSH 主窗行为一致）。
   */
  function hide() {
    if (!win.isDestroyed()) win.hide();
  }

  /** 真正退出。 */
  function close() {
    if (!win.isDestroyed()) win.close();
  }

  /** 重载界面（F10：不动会话）。 */
  function reload() {
    if (!win.isDestroyed()) win.webContents.reload();
  }

  /** 加载兜底页（F13）。 */
  function loadFallback(file = "crashed.html") {
    if (win.isDestroyed()) return;
    win.loadFile(path.join(WINDOW_DIR, "renderer", file));
  }

  /** 关掉窗口。 */
  function destroy() {
    if (!win.isDestroyed()) win.destroy();
  }

  return {
    bounds: currentBounds,
    close,
    contentSize,
    destroy,
    hide,
    loadFallback,
    loaded,
    minimize,
    reload,
    show,
    togglePin,
    win,
  };
}

module.exports = { LOAD_TIMEOUT_MS, WINDOW_DIR, createWindow };

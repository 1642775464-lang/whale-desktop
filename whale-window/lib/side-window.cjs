/**
 * 右侧附带窗
 *
 * 职责：管理「贴在小窗右侧」的附加窗口 —— 创建、贴靠跟随、抽屉拉开/收起。
 * 所属层：小窗（whale-window/lib）
 *
 * ## 为什么是独立窗口而不是窗内面板
 *
 * 用户初始说法是「小窗内的右侧面板」，但随即更正为「拉出然后贴在小窗右侧」。
 * 独立窗口才能真正**不影响小窗尺寸**，也才谈得上「抽屉拉开」——
 * 窗内面板要么盖住对话、要么把小窗撑宽，两者都与「不影响小窗」冲突。
 *
 * ## 尺寸与贴合
 *
 * 与小窗**等宽等高**（用户要求「大小和现有小窗窗口一致」）；
 * 位置由 `side-geometry.cjs` 算（纯函数、可单测）：两个窗口的**可见区**边缘相接。
 *
 * ## 抽屉动画
 *
 * 用户要求「类似抽屉拉开的匀速拉开」。窗口动画由主进程逐帧 `setBounds` 完成
 * （CSS 做不到移动整个窗口），按 `drawerFrame` 的匀速插值给每一帧位置。
 *
 * ## ⚠️ 安全口径（经用户明确授权放宽，仅此窗口）
 *
 * 本项目窗口的安全口径是 `contextIsolation 开 / nodeIntegration 关 /
 * sandbox 开 / webviewTag 关`，`window.cjs` 的注释写明「不得放宽」。
 * 本轮用户明确要求「浏览器按钮要真在窗内渲染网页」，因此**仅在本窗口**
 * 开启 `webviewTag`，其余三项保持不变，且：
 *   · 主小窗的 `webviewTag` 仍为关（不放宽它的口径）；
 *   · 本窗口没有 IPC 通道（不注册任何 `ipcMain.handle`）；
 *   · `<webview>` 只用于展示网页，不允许它访问本窗口的 preload 能力。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const sideGeometry = require("./side-geometry.cjs");
const geometry = require("./geometry.cjs");

/** 等页面加载的上限（与 window.cjs 同因：漏了会让等待者永久挂住）。 */
const LOAD_TIMEOUT_MS = 8000;

/** 小窗所在目录（本文件在 lib/ 下，往上一层）。 */
const WINDOW_DIR = path.resolve(__dirname, "..");

/**
 * 建右侧附带窗管理器。
 *
 * @param {object} deps
 * @param {object} deps.BrowserWindow Electron 的 BrowserWindow 构造器
 * @param {object} deps.screen Electron 的 screen
 * @param {object} deps.log
 * @param {() => object|null} deps.mainBounds 取小窗当前窗口矩形
 * @param {number} [deps.port] 桥端口（传给页面，侧窗也要连桥读数据）
 * @param {string} [deps.rendererFile] 页面路径（默认 renderer/side.html）
 * @param {string} [deps.preloadFile] preload 路径
 * @returns {object} 管理器
 */
function createSideWindow(deps) {
  const { BrowserWindow, screen, log } = deps;
  const rendererFile = deps.rendererFile ?? path.join(WINDOW_DIR, "renderer", "side.html");
  const preloadFile = deps.preloadFile ?? path.join(WINDOW_DIR, "preload.cjs");

  if (!fs.existsSync(rendererFile)) {
    // 入口缺失时 Electron 只会留个白窗口（window.cjs 也为此显式检查）
    throw new Error(`侧窗渲染层入口不存在：${rendererFile}`);
  }

  /** 侧窗实例；null 表示尚未创建。 */
  let win = null;
  /** 是否已拉开（用于幂等切换）。 */
  let opened = false;
  /** 动画定时器，null 表示当前没有动画。 */
  let animTimer = null;

  /** 小窗矩形；拿不到时给 null（调用方据此跳过跟随）。 */
  function mainBounds() {
    const b = typeof deps.mainBounds === "function" ? deps.mainBounds() : null;
    return b === null || typeof b !== "object" ? null : b;
  }

  /** 侧窗应有多宽（与小窗窗口矩形等宽）。 */
  function sideWidth() {
    const m = mainBounds();
    return m === null ? geometry.toWindowSize(geometry.defaultContentSize()).width : m.width;
  }

  /** 本机工作区（用于「贴到屏外时回退」）。 */
  function workArea() {
    try {
      return screen.getPrimaryDisplay().workArea;
    } catch {
      return undefined;
    }
  }

  /** 停掉正在播放的动画。 */
  function stopAnim() {
    if (animTimer !== null) {
      clearInterval(animTimer);
      animTimer = null;
    }
  }

  /**
   * 确保窗口存在（延迟创建：不点按钮就不占资源）。
   *
   * @returns {object} BrowserWindow 实例
   */
  function ensure() {
    if (win !== null && !win.isDestroyed()) return win;
    const m = mainBounds();
    const width = sideWidth();
    const height = m === null ? geometry.toWindowSize(geometry.defaultContentSize()).height : m.height;
    const docked = m === null
      ? { x: 0, y: 0 }
      : sideGeometry.dockedPosition(m, width, workArea());

    win = new BrowserWindow({
      show: false,
      x: docked.x,
      y: docked.y,
      width,
      height,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      roundedCorners: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      // 与小窗同一层级，互相之间不抢前台
      alwaysOnTop: true,
      webPreferences: {
        preload: preloadFile,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        /*
         * ⚠️ 经用户明确授权放宽（见文件头「安全口径」）：
         * 只有本窗口开 webviewTag；主小窗仍为关。
         */
        webviewTag: true,
        spellcheck: false,
      },
    });
    win.setAlwaysOnTop(true, "floating");
    win.setSkipTaskbar(true);
    win.loadFile(rendererFile, { query: { port: String(deps.port ?? 19387) } });

    /*
     * 等页面加载（带超时兜底，与 window.cjs 同因）：
     * loadFile 漏了或路径写错时，窗口会**建出来但是空的** ——
     * 外面看到「窗口在、一片白」，且没有任何报错，极难归因。
     */
    win.webContents.once("did-finish-load", () => {
      log.info("侧窗界面已加载");
    });
    const loadTimer = setTimeout(() => {
      if (!win.isDestroyed()) log.warn(`侧窗界面加载超时（${LOAD_TIMEOUT_MS}ms）`);
    }, LOAD_TIMEOUT_MS);
    if (typeof loadTimer.unref === "function") loadTimer.unref();

    win.on("closed", () => {
      stopAnim();
      win = null;
      opened = false;
    });
    log.info(`侧窗已创建 ${width}x${height} @ (${docked.x}, ${docked.y})`);
    return win;
  }

  /**
   * 把小窗当前的贴靠位置算出来。
   *
   * @returns {{x:number,y:number}|null}
   */
  function wantDocked() {
    const m = mainBounds();
    if (m === null) return null;
    return sideGeometry.dockedPosition(m, m.width, workArea());
  }

  /** 立刻把侧窗摆到贴靠位（无动画）。 */
  function snap() {
    if (win === null || win.isDestroyed()) return null;
    const pos = wantDocked();
    if (pos === null) return null;
    win.setBounds({ x: pos.x, y: pos.y, width: sideWidth(), height: win.getBounds().height });
    return pos;
  }

  /**
   * 播放抽屉动画到目标进度（**匀速**）。
   *
   * @param {0|1} target 1 = 拉开，0 = 收起
   * @param {(opened: boolean) => void} [done] 结束回调
   */
  function animateTo(target, done) {
    stopAnim();
    const w = ensure();
    const m = mainBounds();
    if (m === null) {
      if (typeof done === "function") done(target === 1);
      return;
    }

    const width = m.width;
    const total = sideGeometry.DRAWER_MS;
    const stepMs = 16;                     // ≈60fps
    const steps = Math.max(1, Math.round(total / stepMs));
    let i = 0;
    const from = opened ? 1 : 0;
    const span = target - from;

    if (span === 0) {
      // 已经在目标态：直接摆好，不动画（避免无意义闪烁）
      const pos = target === 1 ? wantDocked() : sideGeometry.hiddenPosition(m, width, workArea());
      if (pos !== null) w.setBounds({ x: pos.x, y: pos.y, width, height: m.height });
      if (typeof done === "function") done(target === 1);
      return;
    }

    animTimer = setInterval(() => {
      if (w.isDestroyed()) {
        stopAnim();
        return;
      }
      i += 1;
      const t = i / steps;
      const progress = from + span * t;
      const pos = sideGeometry.drawerFrame(m, width, progress, workArea());
      w.setBounds({ x: pos.x, y: pos.y, width, height: m.height });
      if (i >= steps) {
        stopAnim();
        opened = target === 1;
        if (typeof done === "function") done(opened);
      }
    }, stepMs);

    // 先显示：窗口在屏幕外时 setBounds 也能动，但用户会先看到它滑入
    w.showInactive();
  }

  /** 拉开（幂等）。 */
  function open() {
    if (opened && win !== null && !win.isDestroyed()) return { ok: true, opened: true, already: true };
    animateTo(1);
    return { ok: true, opened: true };
  }

  /** 收起（幂等）。 */
  function close() {
    if (!opened || win === null || win.isDestroyed()) {
      opened = false;
      return { ok: true, opened: false, already: true };
    }
    animateTo(0, () => {
      // 收完隐藏：留在屏幕外会让「窗口已存在」的判断变复杂
      if (win !== null && !win.isDestroyed()) win.hide();
    });
    return { ok: true, opened: false };
  }

  /** 切换。 */
  function toggle() {
    return opened ? close() : open();
  }

  /**
   * 小窗移动/缩放后跟随（只在**已拉开**时跟随；收起态不该跟着跑）。
   *
   * @returns {boolean} 是否真的调整了位置
   */
  function follow() {
    if (!opened || win === null || win.isDestroyed()) return false;
    const b = win.getBounds();
    const want = wantDocked();
    if (want === null) return false;
    const m = mainBounds();
    const need = Math.abs(b.x - want.x) > 1
      || Math.abs(b.y - want.y) > 1
      || (m !== null && Math.abs(b.width - m.width) > 1)
      || (m !== null && Math.abs(b.height - m.height) > 1);
    if (!need) return false;
    win.setBounds({
      x: want.x,
      y: want.y,
      width: sideWidth(),
      height: m === null ? b.height : m.height,
    });
    return true;
  }

  /** 当前状态（供 IPC 回读）。 */
  function state() {
    return {
      exists: win !== null && !win.isDestroyed(),
      opened,
      bounds: win !== null && !win.isDestroyed() ? win.getBounds() : null,
    };
  }

  /** 释放（应用退出时）。 */
  function dispose() {
    stopAnim();
    if (win !== null && !win.isDestroyed()) win.destroy();
    win = null;
    opened = false;
  }

  return { close, dispose, ensure, follow, hide: close, open, snap, state, toggle };
}

module.exports = { createSideWindow };

/**
 * 小窗装配
 *
 * 职责：把「建状态存储 → 建窗口 → 装 IPC → 装崩溃自愈 → 显示」这一串装配
 *       收在一个函数里，供产品入口与验收探针**共用同一份代码**。
 * 所属层：小窗（whale-window/lib）
 *
 * 为什么抽出来：悬浮条那边踩过一次——装配写两份（产品一份、探针一份），
 * 产品忘了加载页面，探针却自己加载了，结果**探针全绿、产品全白**。
 * 抽成 boot() 之后，「探针跑的就是产品跑的那条路」变成结构性事实。
 */

"use strict";

const path = require("node:path");
const fs = require("node:fs");

const geometry = require("./geometry.cjs");
const { createWindow } = require("./window.cjs");
const { createStateStore } = require("./persist.cjs");
const { createRecovery } = require("./recovery.cjs");
const { registerIpc } = require("./ipc.cjs");
const { createSideWindow } = require("./side-window.cjs");

/** 小窗所在目录。 */
const WINDOW_DIR = path.resolve(__dirname, "..");

/** 运行数据目录（userData 指向它）。 */
const USER_DATA_DIR = path.join(WINDOW_DIR, ".userdata");

/**
 * 装配并显示小窗。
 *
 * 顺序刻意固定：
 *   1. 先读记忆位置（决定窗口摆哪）
 *   2. 建窗口（内部会 loadFile，页面从这里开始加载）
 *   3. 装崩溃自愈监听
 *   4. 装 IPC
 *   5. **先摆好位置再显示**
 *
 * @param {object} deps
 * @param {object} deps.BrowserWindow
 * @param {object} deps.screen
 * @param {object} deps.ipcMain
 * @param {object} deps.app
 * @param {object} deps.log
 * @param {number} [deps.port] 桥端口
 * @param {boolean} [deps.noRestore] 不读也不写状态记忆（验收脚本用）
 * @param {object} [deps.overrideBounds] 显式尺寸（优先级高于记忆值）
 * @param {(win: object) => void} [deps.onWindowReady] 窗口建好后的钩子
 * @returns {object} 装配结果
 */
function bootWindow(deps) {
  const { BrowserWindow, screen, ipcMain, app, log } = deps;
  const bridgePort = Number.isInteger(deps.port) ? deps.port : 19387;
  const noRestore = deps.noRestore === true;

  const stateFile = path.join(USER_DATA_DIR, "window-state.json");

  /** 状态存储：文件 IO 注入成真实读写。 */
  const store = createStateStore({
    read: () => {
      try {
        return fs.readFileSync(stateFile, "utf8");
      } catch {
        return "";
      }
    },
    write: (text) => {
      if (noRestore) return;
      try {
        fs.mkdirSync(USER_DATA_DIR, { recursive: true });
        fs.writeFileSync(stateFile, text, "utf8");
      } catch (err) {
        log.warn(`写窗口状态失败：${err?.message ?? err}`);
      }
    },
    workAreas: () => screen.getAllDisplays().map((d) => d.workArea),
    onPersist: (bounds) => log.info(`已保存窗口状态 ${JSON.stringify(bounds)}`),
  });

  /** 决定初始位置：显式尺寸 > 记忆值 > 默认。 */
  function initialBounds() {
    if (deps.overrideBounds !== undefined) return deps.overrideBounds;
    if (!noRestore) {
      const restored = store.restore();
      if (restored.bounds !== null) {
        log.info(`恢复窗口位置 ${JSON.stringify(restored.bounds)}（可见比 ${restored.ratio?.toFixed(2)}）`);
        return restored.bounds;
      }
      // 位置失效必须落日志（B13 判据），不能静默回默认值
      if (restored.reason !== "no-memory") {
        log.warn(`记忆的窗口位置不可用（${restored.reason}），回默认位置`);
      }
    }
    return geometry.defaultBounds(
      screen.getPrimaryDisplay().workArea,
      geometry.toWindowSize(geometry.defaultContentSize()),
    );
  }

  const bounds = initialBounds();
  const win = createWindow({
    BrowserWindow,
    bounds,
    pinned: bounds.pinned !== false,
    query: { port: String(bridgePort) },
    log,
  });

  /*
   * 右侧附带窗：**延迟创建**（不点按钮就不建窗口）。
   * 它是独立窗口而非窗内面板 —— 只有独立窗口才能做到「不影响小窗尺寸」
   * 而又有真正的抽屉拉开动画（详见 side-window.cjs 的头注释）。
   *
   * `onJoinedChange` 里用 `ipc.value` 是**延迟绑定**：ipc 在下面才建，
   * 而这个回调只会在用户点按钮之后触发（那时 ipc 早就存在了）。
   * 直接引用 `ipc` 会因为 const TDZ 在极端时序下抛错，故用一层容器。
   */
  const ipcRef = { value: null };
  const side = createSideWindow({
    BrowserWindow,
    screen,
    log,
    port: bridgePort,
    mainBounds: () => {
      const b = win.bounds();
      return b === null ? null : b;
    },
    // 贴住/分开时通知主窗：它据此去掉右侧圆角与阴影，两块才连成一体
    onJoinedChange: (joined) => {
      if (ipcRef.value !== null) ipcRef.value.notifyJoined(joined);
    },
  });

  // 小窗移动/缩放时，已拉开的侧窗要跟着贴住（收起态则不跟随）
  win.win.on("move", () => side.follow());
  win.win.on("resize", () => side.follow());

  if (typeof deps.onWindowReady === "function") deps.onWindowReady(win);

  /** 崩溃自愈。 */
  const recovery = createRecovery({
    reload: () => win.reload(),
    loadFallback: () => win.loadFallback(),
    log: (m) => log.info(m),
  });

  const wc = win.win.webContents;
  wc.on("render-process-gone", (_e, details) => {
    log.error(`渲染进程退出：${details?.reason ?? "unknown"}`);
    recovery.onRendererGone(details ?? {});
  });
  wc.on("did-finish-load", () => {
    const out = recovery.onLoaded();
    if (out.wasRecovering) log.info("界面已恢复");
  });
  wc.on("did-fail-load", (_e, errorCode, errorDescription) => {
    recovery.onLoadFailed({ errorCode, errorDescription });
  });
  wc.on("preload-error", (_e, file, err) => {
    log.error(`preload 加载失败 ${file}：${err?.message ?? err}`);
  });
  wc.on("console-message", (...args) => {
    const first = args[0];
    const asEvent = first !== null && typeof first === "object" && "message" in first;
    const level = asEvent ? first.level : args[1];
    const message = asEvent ? first.message : args[2];
    log.info(`[渲染] level=${level} ${message}`);
  });
  // F11：阻止非 file:// 导航（防页面被劫持成浏览器）
  wc.on("will-navigate", (event, url) => {
    if (!url.startsWith("file://")) {
      event.preventDefault();
      log.warn(`已拦截导航：${url}`);
    }
  });

  const ipc = registerIpc({
    ipcMain,
    win,
    store,
    log,
    port: bridgePort,
    version: app.getVersion(),
    side,
  });
  // 让侧窗的贴住回调能拿到 ipc（见上面的延迟绑定说明）
  ipcRef.value = ipc;

  // 位置/尺寸变化时记忆（400ms 防抖由 store 内部负责）
  if (!noRestore) {
    win.win.on("move", () => {
      const b = win.bounds();
      if (b !== null) store.remember({ ...b, pinned: win.win.isAlwaysOnTop() });
    });
    win.win.on("resize", () => {
      const b = win.bounds();
      if (b !== null) store.remember({ ...b, pinned: win.win.isAlwaysOnTop() });
    });
  }

  win.show();
  win.loaded.then((ok) => {
    if (ok) log.info("界面已加载");
    else log.warn("界面加载超时（可能没有调用 loadFile）");
  });

  return { win, store, recovery, ipc, bounds, storeFile: stateFile, bridgePort, side };
}

module.exports = { USER_DATA_DIR, WINDOW_DIR, bootWindow };

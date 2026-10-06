/**
 * 悬浮条入口
 *
 * 职责：Electron 生命周期编排——定 userData、建日志与状态机、建窗口、
 *       装 IPC、把渲染层的异常收进日志。
 * 所属层：悬浮条（whale-hud）
 *
 * 三条不能在别处改的纪律（都是实测踩出来的，见 PRD 5.1/5.2）：
 *   1. **必须显式 `app.setPath('userData', ...)`**：让 Electron 去解析默认
 *      userData 路径会让进程原生崩溃（`0xFFFF7003`），不抛异常、接不住。
 *   2. **必须在模块顶层就 setPath**，且此后**不在顶层调用任何 `app.getPath()`**——
 *      日志路径一律走惰性解析。
 *   3. **启动必须带 `--no-sandbox`**：否则 GUI 初始化崩 `0x80000003`，
 *      进程只活 15~20ms，连本文件的模块体都执行不到，表现为「双击没反应」。
 *      该开关由 `run.ps1` 与桥的 spawn 负责传。
 *
 * 渲染层的报错全部落日志：悬浮条是个「没人看着的窗口」，
 * 出了错不写下来就等于没发生。这也是 A11（无控制台报错）的取证方式。
 */

"use strict";

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("node:path");

const { createLogger } = require("./lib/log.cjs");
const { bootHud } = require("./lib/boot.cjs");

/** 运行数据目录：日志与 Electron 自身的缓存都放这儿（PRD 七节）。 */
const USER_DATA_DIR = path.join(__dirname, ".userdata");

// 纪律 2：setPath 必须早于任何 getPath，且本文件顶层不再出现 getPath
app.setPath("userData", USER_DATA_DIR);

const log = createLogger({ resolveDir: () => USER_DATA_DIR });

/**
 * 单实例：第二次启动直接退出。
 *
 * 为什么不静默退出：静默退出正是「双击没反应」的形态，用户会以为坏了。
 * 所以先写一行明确日志，再退出——日志在 `.userdata/whale-hud.log`。
 */
if (!app.requestSingleInstanceLock()) {
  log.warn("已有一个悬浮条在运行，本次启动退出（悬浮条单实例）");
  app.exit(0);
}

app.on("second-instance", () => {
  log.info("检测到第二次启动请求：已有实例在运行，忽略");
});

/** 建好之后要留给退出路径用的句柄。 */
const runtime = { hudWindow: null, state: null, ipc: null, logger: log };

/**
 * 把渲染层的报错收进日志。
 *
 * 三种都要收：控制台报错、渲染进程崩溃、preload 加载失败。
 * 漏掉任何一种，故障都会表现成「窗口在、但什么都不工作」——
 * 这是最难查的一类（PRD 5.5 记过同样的现象）。
 *
 * @param {object} win BrowserWindow
 */
function watchRenderer(win) {
  win.webContents.on("console-message", (...args) => {
    // Electron 44 起是单事件对象；旧版是 (event, level, message)。两种都兜住。
    const first = args[0];
    const asEvent = first !== null && typeof first === "object" && "message" in first;
    const level = asEvent ? first.level : args[1];
    const message = asEvent ? first.message : args[2];
    log.info(`[渲染] level=${level} ${message}`);
  });

  win.webContents.on("preload-error", (_event, preloadPath, error) => {
    log.error(`[渲染] preload 加载失败 ${preloadPath}：${error?.message ?? error}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    log.error(`[渲染] 进程退出：${JSON.stringify(details)}`);
  });

  win.webContents.on("unresponsive", () => {
    log.warn("[渲染] 界面无响应");
  });
}

app.whenReady().then(() => {
  log.info("悬浮条启动");

  const { hudWindow, state } = bootHud({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    Menu,
    log,
    port: Number(process.env.WHALE_BRIDGE_PORT ?? 19387),
    onWindowReady: (win) => watchRenderer(win.win),
  });

  runtime.hudWindow = hudWindow;
  runtime.state = state;
});

app.on("window-all-closed", () => {
  log.info("悬浮条退出");
  runtime.state?.dispose();
  app.quit();
});

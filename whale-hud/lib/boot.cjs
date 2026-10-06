/**
 * 悬浮条装配
 *
 * 职责：把「建状态机 → 建窗口 → 装 IPC → 摆位置 → 显示」这一串装配
 *       收在一个函数里，供产品入口与验收探针**共用同一份代码**。
 * 所属层：悬浮条（whale-hud/lib）
 *
 * 为什么要抽出来：装配序列原本写在 main.cjs 里，而验收探针为了能跑，
 * **自己又抄了一份**（自己建状态机、自己装 IPC、自己摆位置、自己显示）。
 * 两份一旦不同步，探针测的就不是产品——真实踩过一次：产品忘了加载页面，
 * 探针却自己加载了，于是产品全白、探针全绿。
 *
 * 抽成一个 boot() 之后，「探针跑的就是产品跑的那条路」变成结构性事实，
 * 不再依赖谁记得同步。
 */

"use strict";

const path = require("node:path");

const { createHudState } = require("./state.cjs");
const { createHudWindow } = require("./window.cjs");
const { registerIpc } = require("./ipc.cjs");

/** 悬浮条所在目录（本文件在 lib/ 下，往上一层）。 */
const HUD_DIR = path.resolve(__dirname, "..");

/**
 * 装配并显示悬浮条。
 *
 * 执行顺序刻意固定：
 *   1. 先建状态机（窗口还没建，onChange 里对窗口的引用是惰性的）
 *   2. 建窗口（内部会 loadFile，页面从这里开始加载）
 *   3. 装 IPC（渲染层就绪后要用）
 *   4. **先摆位置再显示**——反过来会先看到窗口在 (0,0) 闪一下
 *
 * @param {object} deps
 * @param {object} deps.BrowserWindow
 * @param {object} deps.screen
 * @param {object} deps.ipcMain
 * @param {object} deps.app
 * @param {object} [deps.Menu]
 * @param {object} deps.log
 * @param {number} [deps.port] 桥端口（渲染层据此连桥）
 * @param {(win: object) => void} [deps.onWindowReady] 窗口建好后的钩子（探针用它挂报错监听）
 * @returns {{hudWindow: object, state: object, ipc: object, bridgePort: number}}
 */
function bootHud(deps) {
  const { BrowserWindow, screen, ipcMain, app, Menu, log } = deps;
  const bridgePort = Number.isInteger(deps.port) ? deps.port : 19387;

  /** 窗口句柄。状态机的回调是惰性的，所以可以先建状态机。 */
  let hudWindow = null;

  const state = createHudState({
    onChange: (form, reason) => {
      log.info(`形态变化 → ${form}（原因：${reason}）`);
      hudWindow.applyForm(form);
    },
  });

  hudWindow = createHudWindow({
    BrowserWindow,
    screen,
    rendererFile: path.join(HUD_DIR, "renderer", "index.html"),
    preloadFile: path.join(HUD_DIR, "preload.cjs"),
    // 端口通过查询串给渲染层：桥端口可能不是默认值（联调与验收时用）
    query: { port: String(bridgePort) },
    log,
  });

  // 钩子在装 IPC 之前给：探针要尽早挂上 console-message 等监听，
  // 否则会漏掉页面加载早期（最容易出问题的那一段）的报错
  if (typeof deps.onWindowReady === "function") deps.onWindowReady(hudWindow);

  const ipc = registerIpc({
    ipcMain,
    state,
    hudWindow,
    app,
    Menu,
    log,
    port: bridgePort,
    version: app.getVersion(),
  });

  // 先摆好位置再显示
  hudWindow.applyForm(state.form());
  hudWindow.show();

  hudWindow.loaded.then(() => log.info("界面已加载"));

  return { hudWindow, state, ipc, bridgePort };
}

module.exports = { HUD_DIR, bootHud };

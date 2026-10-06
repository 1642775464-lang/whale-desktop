/**
 * 小窗入口
 *
 * 职责：Electron 生命周期编排——定 userData、建日志、装配、退出前补写状态。
 * 所属层：小窗（whale-window）
 *
 * 三条不能在别处改的纪律（都是实测踩出来的，见小窗 PRD 5.1/5.2/5.3）：
 *
 *   1. **必须显式 `app.setPath('userData', ...)`**
 *      让 Electron 去解析默认 userData 路径会让进程**原生崩溃**
 *      （退出码 `-36861` / `0xFFFF7003`），不抛异常、接不住、日志来不及写。
 *      表现就是「小窗双击没反应」：桥的 `/whale/open` 返回了 pid，但进程已死。
 *      顺带好处：状态与日志跟着工程走，不再散落在 `%APPDATA%`。
 *
 *   2. **必须在模块顶层就 setPath**，此后不在顶层调用任何 `app.getPath()`。
 *
 *   3. **启动必须带 `--no-sandbox`**：否则 GUI 初始化崩 `0x80000003`，
 *      进程只活 15~20ms，连本文件的模块体都执行不到。
 *
 * 另外 `ELECTRON_RUN_AS_NODE` 必须被清掉：DSH 宿主给子进程注入它，
 * Electron 看到会退化成纯 node 模式（报 `Cannot find module 'electron'`）。
 * 桥侧 spawn 已经在 env 上删掉了它；`run.ps1` 也再删一次兜底。
 */

"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");

const { createLogger } = require("./lib/log.cjs");
const { bootWindow, USER_DATA_DIR } = require("./lib/boot.cjs");
const geometry = require("./lib/geometry.cjs");

// 纪律 2：setPath 必须早于任何 getPath
app.setPath("userData", USER_DATA_DIR);

const log = createLogger({ resolveDir: () => USER_DATA_DIR });

/** 解析命令行开关（PRD 七节）。 */
function parseArgs(argv) {
  const out = { noRestore: false, width: null, height: null };
  for (const arg of argv) {
    if (arg === "--whale-no-restore") out.noRestore = true;
    const w = /^--whale-width=(\d+)$/.exec(arg);
    if (w !== null) out.width = Number(w[1]);
    const h = /^--whale-height=(\d+)$/.exec(arg);
    if (h !== null) out.height = Number(h[1]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** 留给退出路径用的句柄。 */
const runtime = { win: null, store: null, recovery: null };

app.whenReady().then(() => {
  log.info("小窗启动");

  // 显式尺寸优先级高于记忆值（PRD 七节）
  let overrideBounds;
  if (args.width !== null || args.height !== null) {
    const base = geometry.toWindowSize(geometry.defaultContentSize());
    overrideBounds = geometry.defaultBounds(screen.getPrimaryDisplay().workArea, {
      width: args.width ?? base.width,
      height: args.height ?? base.height,
    });
    log.info(`使用显式尺寸 ${JSON.stringify(overrideBounds)}`);
  }

  const booted = bootWindow({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    log,
    port: Number(process.env.WHALE_BRIDGE_PORT ?? 19387),
    noRestore: args.noRestore,
    overrideBounds,
  });

  runtime.win = booted.win;
  runtime.store = booted.store;
  runtime.recovery = booted.recovery;
});

app.on("window-all-closed", () => {
  log.info("小窗退出");
  // F12：退出时立即补写一次，否则「拖完马上关」的最后一次位置会丢
  runtime.store?.flush();
  runtime.recovery?.dispose();
  app.quit();
});

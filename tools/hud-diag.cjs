/**
 * 悬浮条可见性诊断
 *
 * 职责：起一次悬浮条，把「窗口到底在哪、可不可见、置不置顶、显示器怎么摆」
 *       全量出来，用来判断「用户看不到」到底是窗口跑到屏外、被遮挡、
 *       还是压根没显示。
 * 所属层：工程工具（tools/）
 *
 * 为什么要专门做这个：用户说「看不到」时，靠猜会去改渲染层、改 CSS，
 * 而真实原因往往是几何或显示器（坐标算错、落到了第二块屏、工作区取错）。
 * 直接量比改代码快得多，也不会把好代码改坏。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\hud-diag.cjs
 */

"use strict";

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("node:path");
const os = require("node:os");

const REPO_ROOT = path.resolve(__dirname, "..");

app.setPath("userData", path.join(REPO_ROOT, "_probe", "hud-diag-userdata"));

const report = {};

/** 一次性把结论打出来再退出，避免被 app.exit 截断。 */
function finish() {
  console.log(`DIAG_RESULT ${  JSON.stringify(report, null, 2)}`);
  app.exit(0);
}

app.whenReady().then(async () => {
  const { bootHud } = require(path.join(REPO_ROOT, "whale-hud", "lib", "boot.cjs"));
  const { createLogger } = require(path.join(REPO_ROOT, "whale-hud", "lib", "log.cjs"));

  const log = createLogger({
    resolveDir: () => path.join(REPO_ROOT, "_probe", "hud-diag-userdata"),
    consoleFallback: false,
  });

  // ── 显示器全貌：多屏时最容易「把窗口摆到另一块屏」 ──
  report.displays = screen.getAllDisplays().map((d) => ({
    id: d.id,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    primary: d.id === screen.getPrimaryDisplay().id,
  }));
  report.primaryWorkArea = screen.getPrimaryDisplay().workArea;

  // 走产品的 bootHud，不再自己拼装配。
  //
  // 原先这里自己调 createHudWindow + createHudState + registerIpc，
  // 参数一旦与产品不同步就会漂移——真实踩过：产品后来要求 rendererFile，
  // 这个工具没跟着改，于是 loadFile 收到 undefined，窗口空着。
  // 与探针同一条纪律：**只观察，不代劳**。
  const errors = [];
  const booted = bootHud({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    Menu,
    log,
    port: Number(process.env.WHALE_BRIDGE_PORT ?? 19387),
    onWindowReady: (w) => {
      w.win.webContents.on("console-message", (...a) => {
        const first = a[0];
        const asEvent = first !== null && typeof first === "object" && "message" in first;
        const level = asEvent ? first.level : a[1];
        const message = asEvent ? first.message : a[2];
        errors.push({ level, message });
      });
      w.win.webContents.on("preload-error", (_e, f, err) => {
        errors.push({ level: "preload", message: `${f}: ${err && err.message}` });
      });
      w.win.webContents.on("render-process-gone", (_e, d) => {
        errors.push({ level: "gone", message: JSON.stringify(d) });
      });
    },
  });

  const hudWindow = booted.hudWindow;

  // bootHud 已经把「建状态机 → 建窗口 → 装 IPC → 摆位置 → 显示 → 加载页面」
  // 全做完了。这里**不再重复任何一步**——重复会掩盖产品缺陷
  // （探针纪律：只观察，不代劳）。
  void ipcMain; void Menu;

  await hudWindow.loaded;
  await new Promise((r) => setTimeout(r, 2000));

  // ── 窗口实况 ──
  const win = hudWindow.win;
  report.window = {
    bounds: win.getBounds(),
    isVisible: win.isVisible(),
    isMinimized: win.isMinimized(),
    isAlwaysOnTop: win.isAlwaysOnTop(),
    isDestroyed: win.isDestroyed(),
    opacity: win.getOpacity(),
    skipTaskbar: win.isSkipTaskbar ? win.isSkipTaskbar() : null,
    title: win.getTitle(),
  };

  // 是否落在某块屏的可见范围内
  const b = win.getBounds();
  report.onScreen = screen.getAllDisplays().some((d) => {
    const a = d.bounds;
    return b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y;
  });

  // ── 渲染层实况：条到底有没有画出来 ──
  report.dom = await win.webContents.executeJavaScript(`(() => {
    const bar = document.getElementById("bar");
    const whale = document.getElementById("whaleBtn");
    const r = bar ? bar.getBoundingClientRect() : null;
    return {
      readyState: document.readyState,
      bodyClass: document.body.className,
      innerW: window.innerWidth,
      innerH: window.innerHeight,
      barRect: r ? { x: r.x, y: r.y, w: r.width, h: r.height } : null,
      barBg: bar ? getComputedStyle(bar).backgroundImage.slice(0, 60) : null,
      barOpacity: bar ? getComputedStyle(bar).opacity : null,
      whaleRect: whale ? (() => { const q = whale.getBoundingClientRect(); return { w: q.width, h: q.height }; })() : null,
      title: document.getElementById("faceF") ? document.getElementById("faceF").textContent : null,
      hasHudApi: typeof window.hud === "object" && window.hud !== null,
    };
  })()`);

  // ── 环境 ──
  report.env = {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: `${os.platform()} ${os.release()}`,
    cpuCount: os.cpus().length,
  };

  report.rendererMessages = errors;
  finish();
});

setTimeout(() => {
  report.note = "诊断超时";
  finish();
}, 25000);

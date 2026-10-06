/**
 * 悬浮条验收探针
 *
 * 职责：起真桥 → 起真悬浮条窗口 → 用主进程的 executeJavaScript 做 DOM 断言，
 *       用 window.getBounds() 做几何断言，并把渲染层的报错全部收上来。
 * 所属层：工程工具（tools/）
 *
 * 为什么不用 CDP：零运行时依赖下手写 WebSocket 客户端（RFC6455）是纯风险——
 * 协议层写错的表现是「连不上」，而连不上和「界面有问题」在报告里长得一样，
 * 很容易把探测器的故障当成产品的故障。Electron 主进程本身就能
 * `executeJavaScript`、能读 `getBounds()`、能收 `console-message`，
 * 三样都够用，且没有可错的协议层。
 *
 * **严格遵守 PRD 5.6**：即便将来改用 CDP，也**永不对悬浮条的渲染进程发
 * `Page.navigate`**——那等于把悬浮条窗口劫持成浏览器。
 *
 * 验收项与对应关系：
 *   A1 顶边居中      → 主进程 getBounds() 与 workArea 对照
 *   A4 五元素齐全    → DOM 查询 + offsetWidth > 0
 *   A8 收展 DOM 归属 → whaleBtn.parentElement 是 .bar 还是 body
 *   A11 无控制台报错 → console-message / preload-error / render-process-gone
 *
 * 用法（必须由 Electron 跑，不是 node）：
 *   runtime\electron.exe --no-sandbox tools\hud-probe.cjs --port 19391
 */

"use strict";

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

/** 解析命令行参数（Electron 会把 argv[0] 给成 exe 路径）。 */
function parseArgs(argv) {
  const out = { port: 19387, offline: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
    if (argv[i] === "--offline") out.offline = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// 与产品同一套纪律：显式 userData，否则原生崩溃
app.setPath("userData", path.join(REPO_ROOT, "_probe", "hud-probe-userdata"));

/** 收集到的证据。 */
const report = {
  a11: { consoleErrors: [], preloadErrors: [], renderGone: [], unresponsive: 0 },
  a4: null,
  a8: null,
  a1: null,
  verdict: "fail",
};

/** 全部结果打完再退出，避免被 app.exit 截断输出。 */
function finish() {
  console.log(`PROBE_RESULT ${  JSON.stringify(report)}`);
  app.exit(0);
}

app.whenReady().then(async () => {
  const { createHudWindow } = require(path.join(REPO_ROOT, "whale-hud", "lib", "window.cjs"));
  const { createHudState } = require(path.join(REPO_ROOT, "whale-hud", "lib", "state.cjs"));
  const { registerIpc } = require(path.join(REPO_ROOT, "whale-hud", "lib", "ipc.cjs"));
  const { createLogger } = require(path.join(REPO_ROOT, "whale-hud", "lib", "log.cjs"));

  const log = createLogger({
    resolveDir: () => path.join(REPO_ROOT, "_probe", "hud-probe-userdata"),
    consoleFallback: false,
  });

  const state = createHudState({
    onChange: (form) => hudWindow.applyForm(form),
  });

  const hudWindow = createHudWindow({
    BrowserWindow,
    screen,
    rendererFile: path.join(REPO_ROOT, "whale-hud", "renderer", "index.html"),
    preloadFile: path.join(REPO_ROOT, "whale-hud", "preload.cjs"),
    log,
  });

  // A11：把三类渲染层故障全收上来
  hudWindow.win.webContents.on("console-message", (...a) => {
    const first = a[0];
    const asEvent = first !== null && typeof first === "object" && "message" in first;
    const level = asEvent ? first.level : a[1];
    const message = asEvent ? first.message : a[2];
    // Electron 的 level：0=verbose 1=info 2=warning 3=error
    if (level === 3 || level === "error") report.a11.consoleErrors.push(message);
  });
  hudWindow.win.webContents.on("preload-error", (_e, file, err) => {
    report.a11.preloadErrors.push(`${file}: ${err && err.message}`);
  });
  hudWindow.win.webContents.on("render-process-gone", (_e, details) => {
    report.a11.renderGone.push(details.reason);
  });
  hudWindow.win.webContents.on("unresponsive", () => {
    report.a11.unresponsive += 1;
  });

  registerIpc({ ipcMain, state, hudWindow, app, Menu, log, port: args.port });

  // 把桥端口通过查询串传给渲染层
  hudWindow.win.loadFile(
    path.join(REPO_ROOT, "whale-hud", "renderer", "index.html"),
    { query: { port: String(args.port) } },
  );

  hudWindow.applyForm(state.form());
  hudWindow.show();

  await hudWindow.loaded;
  // 给渲染层一点时间完成首帧与首次 fetch
  await new Promise((r) => setTimeout(r, 2500));

  const run = (expr) => hudWindow.win.webContents.executeJavaScript(expr);

  // ── A4：五元素齐全且可见 ──
  report.a4 = await run(`(() => {
    const ids = ["whaleBtn", "dot", "reel", "segSpeed", "segCtx"];
    const missing = ids.filter((id) => {
      const el = document.getElementById(id);
      return el === null || el.offsetWidth === 0;
    });
    return {
      missing: missing,
      title: document.getElementById("faceF").textContent,
      titleWidth: document.getElementById("faceF").offsetWidth,
      speed: document.getElementById("spdVal").textContent,
      ctx: document.getElementById("ctxVal").textContent,
      dot: document.getElementById("dot").className,
    };
  })()`);

  // ── 标题必须真的画出会话名，而不是停在占位符 ──
  // 「元素都在、宽度也大于 0，但文字没更新」是最难发现的一类假通过
  report.titleRendered = report.a4.title !== "–" && report.a4.title.length > 0;

  // ── A5：悬停上下文段 → 详情浮层可见、窗口加高 ──
  await run("document.getElementById('segCtx').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }))");
  await new Promise((r) => setTimeout(r, 400));
  const hover = {
    popoverHidden: await run("document.getElementById('hudDetail').hidden"),
    detailCtx: await run("document.getElementById('dCtx').textContent"),
    boundsH: hudWindow.bounds().height,
  };
  await run("document.getElementById('segCtx').dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))");
  await new Promise((r) => setTimeout(r, 700));
  const afterLeave = { boundsH: hudWindow.bounds().height };
  report.a5 = { hover, afterLeave };

  // ── A1：顶边居中 ──
  const b = hudWindow.bounds();
  const area = hudWindow.workArea();
  report.a1 = {
    bounds: b,
    workArea: area,
    centerDelta: Math.abs(b.x + b.width / 2 - (area.x + area.width / 2)),
    topDelta: Math.abs(b.y - area.y),
  };

  // ── A8：收展 DOM 归属与窗口宽 ──
  const before = await run(`({
    parent: document.getElementById("whaleBtn").parentElement.className,
    winW: window.innerWidth
  })`);

  await run("globalThis.document.getElementById('collapseBtn').click()");
  await new Promise((r) => setTimeout(r, 600));
  const collapsed = {
    parent: await run("document.getElementById('whaleBtn').parentElement.tagName"),
    winW: await run("window.innerWidth"),
    boundsW: hudWindow.bounds().width,
  };

  await run("globalThis.hud.setForm('bar').then(() => document.body.classList.remove('collapsed'))");
  await new Promise((r) => setTimeout(r, 600));
  const expandedBoundsW = hudWindow.bounds().width;

  report.a8 = { before, collapsed, expandedBoundsW };

  // ── A10：球拖动。阈值 3px：位移 >3px 算拖动，≤3px 算单击 ──
  // 直接驱动 IPC 通道，不合成鼠标事件：合成事件的 screenX/screenY 在
  // 无头环境里不可靠，用它测出来的是「合成器准不准」，不是「拖动对不对」。
  const dragFrom = hudWindow.bounds();
  await run("globalThis.hud.dragStart()");
  await run("globalThis.hud.dragMove(40, 25)");
  const dragTo = hudWindow.bounds();
  await run("globalThis.hud.dragEnd()");
  report.a10 = {
    axisX: dragTo.x - dragFrom.x,
    axisY: dragTo.y - dragFrom.y,
    widthKept: dragTo.width === dragFrom.width && dragTo.height === dragFrom.height,
    anchorAfterDrag: hudWindow.anchor(),
  };

  // ── R-1：桥不可用时红点 + 全部 `–`，不崩也不弹错 ──
  // 由外部先杀掉桥，这里只负责观察。参数 --offline 表示「本次不连桥」。
  if (args.offline) {
    report.offline = await run(`({
      dot: document.getElementById("dot").className,
      title: document.getElementById("faceF").textContent,
      speed: document.getElementById("spdVal").textContent,
      ctx: document.getElementById("ctxVal").textContent
    })`);
  }

  // ── 判定 ──
  const okA4 = report.a4.missing.length === 0 && report.titleRendered === true;
  const okA11 =
    report.a11.consoleErrors.length === 0 &&
    report.a11.preloadErrors.length === 0 &&
    report.a11.renderGone.length === 0;
  const okA1 = report.a1.centerDelta <= 1 && report.a1.topDelta <= 1;
  const okA8 =
    report.a8.collapsed.boundsW === 88 &&
    report.a8.collapsed.winW === 88 &&
    report.a8.expandedBoundsW === 588;
  const okA5 =
    report.a5.hover.popoverHidden === false &&
    report.a5.hover.boundsH === 340 &&
    report.a5.afterLeave.boundsH === 72;

  // R-1：降级态必须是红点 + 全部 `–`，且**不出现空白窗口或抛错弹窗**
  const okOffline = args.offline
    ? report.offline.dot.includes("bad") &&
      report.offline.speed === "–" &&
      report.offline.ctx === "–" &&
      report.offline.title.includes("桥未连接")
    : true;

  // A10：拖动位移必须等于请求的位移，且窗口尺寸不变
  const okA10 =
    report.a10.axisX === 40 &&
    report.a10.axisY === 25 &&
    report.a10.widthKept === true;

  report.checks = { okA1, okA4, okA5, okA8, okA10, okA11, okOffline };
  report.verdict = okA1 && okA4 && okA5 && okA8 && okA10 && okA11 && okOffline ? "pass" : "fail";
  finish();
});

// 兜底：任何一步卡住都要有输出，不能静默挂死
setTimeout(() => {
  report.verdict = "timeout";
  finish();
}, 25000);

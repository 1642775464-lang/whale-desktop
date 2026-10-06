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
 *   A4 五元素齐全    → DOM 查询 + offsetWidth > 0（**且页面真的被加载过**）
 *   A8 收展 DOM 归属 → whaleBtn.parentElement 是 .bar 还是 body
 *   A11 无控制台报错 → console-message / preload-error / render-process-gone
 *
 * ── 铁律：探针只许观察，不许代劳 ──
 *
 * 曾经在这里写了一句 `hudWindow.win.loadFile(...)`，替产品把页面加载了。
 * 结果是：产品 `window.cjs` 因为 lint 把 rendererFile 参数删掉、根本没加载页面，
 * 窗口全白——而**探针 11 项全绿**。绿灯给了虚假的信心，比没有测试更糟。
 *
 * 所以本文件遵守两条：
 *   1. 绝不调用产品该调用的方法（loadFile / applyForm / show / 渲染层的 expand 等）
 *   2. 每个验收项旁边都配一条**反例检查**，证明这个断言真的会红
 *      （例如 A4 额外验「页面已加载」，白窗口必然被抓住）
 *
 * 允许做的只有「模拟用户输入」：点击按钮、派发鼠标事件、调 hud.* 的 IPC 通道。
 * 那是在扮演用户，不是在补产品的功课。
 *
 * 用法（必须由 Electron 跑，不是 node）：
 *   runtime\electron.exe --no-sandbox tools\hud-probe.cjs --port 19500
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
  const { bootHud } = require(path.join(REPO_ROOT, "whale-hud", "lib", "boot.cjs"));
  const { createLogger } = require(path.join(REPO_ROOT, "whale-hud", "lib", "log.cjs"));

  const log = createLogger({
    resolveDir: () => path.join(REPO_ROOT, "_probe", "hud-probe-userdata"),
    consoleFallback: false,
  });

  // A11：把三类渲染层故障全收上来（在 bootHud 里尽早挂，别漏页面加载早期的报错）
  let hudWindow = null;

  const booted = bootHud({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    Menu,
    log,
    port: args.port,
    onWindowReady: (w) => {
      hudWindow = w;
      w.win.webContents.on("console-message", (...a) => {
        const first = a[0];
        const asEvent = first !== null && typeof first === "object" && "message" in first;
        const level = asEvent ? first.level : a[1];
        const message = asEvent ? first.message : a[2];
        // Electron 的 level：0=verbose 1=info 2=warning 3=error
        if (level === 3 || level === "error") report.a11.consoleErrors.push(message);
      });
      w.win.webContents.on("preload-error", (_e, file, err) => {
        report.a11.preloadErrors.push(`${file}: ${err && err.message}`);
      });
      w.win.webContents.on("render-process-gone", (_e, details) => {
        report.a11.renderGone.push(details.reason);
      });
      w.win.webContents.on("unresponsive", () => {
        report.a11.unresponsive += 1;
      });
    },
  });

  // 探针**不调用** applyForm / show / loadFile —— 那些由 bootHud（= 产品同一份代码）做
  hudWindow = booted.hudWindow;

  /** 页面是否真的被加载过：这是 A4 之前的前置条件。 */
  report.pageLoaded = false;
  report.loadedUrl = "";

  await hudWindow.loaded;
  report.pageLoaded = true;
  report.loadedUrl = hudWindow.win.webContents.getURL();

  // 给渲染层一点时间完成首帧与首次 fetch
  await new Promise((r) => setTimeout(r, 2500));

  const run = (expr) => hudWindow.win.webContents.executeJavaScript(expr);

  /**
   * 带超时的脚本执行。
   *
   * 为什么需要：窗口里没有文档时（页面压根没加载）`executeJavaScript`
   * 不会报错，而是**一直挂着**。于是探针会在「检查白窗口」这一步卡死，
   * 最后只报一个 timeout，看不出真因。
   *
   * @param {string} expr
   * @param {number} [ms]
   * @returns {Promise<unknown>}
   */
  const runWithTimeout = (expr, ms = 3000) =>
    Promise.race([
      run(expr),
      new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("executeJavaScript 超时（页面可能没有加载）")), ms).unref();
      }),
    ]);

  // ── 前置条件：页面必须真的加载了 ──
  // 这条是「白窗口」的照妖镜。没有它，界面全白时 A4 只会报「元素找不到」，
  // 看起来像渲染层写错，而真实原因是压根没加载页面（真实踩过）。
  //
  // 检查放在最前面并且**直接结束**：白窗口时后面所有查询都会失败或挂住，
  // 那样报告里只有一串 null 与 timeout，反而看不出真因。
  try {
    report.blankWindow = await runWithTimeout(`(() => {
      const bar = document.getElementById("bar");
      const html = document.documentElement.innerHTML.length;
      return {
        hasBar: bar !== null,
        htmlLength: html,
        bodyChildren: document.body ? document.body.children.length : 0,
        pageLooksRendered: bar !== null && html > 500,
      };
    })()`);
  } catch (err) {
    report.blankWindow = { error: err.message, pageLooksRendered: false };
  }

  if (report.blankWindow.pageLooksRendered !== true) {
    report.checks = { okNotBlank: false };
    report.verdict = "fail";
    report.failureReason =
      "窗口是空白的：页面没有被加载。检查 whale-hud/lib/window.cjs 是否调用了 loadFile。";
    finish();
    return;
  }

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

  // 展开：模拟**用户双击球**，走渲染层真实的 expand() 分支。
  // 曾经这里写的是 `hud.setForm('bar') + 手动移除 collapsed 类`——
  // 那等于探针自己把界面摆回展开态，绕过了 expand() 里「把图标插回条内」
  // 这段逻辑，于是 expand() 坏了也测不出来。
  await run(`(() => {
    const whale = document.getElementById("whaleBtn");
    whale.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    whale.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 800));
  const expandedBoundsW = hudWindow.bounds().width;
  const afterExpand = {
    parent: await run("document.getElementById('whaleBtn').parentElement.className"),
    bodyClass: await run("document.body.className"),
  };

  report.a8 = { before, collapsed, expandedBoundsW, afterExpand };

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
    report.a8.expandedBoundsW === 588 &&
    // 展开后图标必须回到条里（这条能抓住 expand() 只改窗口不改 DOM 的半吊子实现）
    report.a8.afterExpand.parent === "bar" &&
    report.a8.afterExpand.bodyClass === "hud";
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

  // 前置条件：页面真的加载了、条真的画出来了。
  // 「产品忘了加载页面」时窗口全白，而白窗口**不产生任何 console 错误**，
  // 单靠 A11 永远抓不到——必须有这一条（真实踩过：探针全绿、产品全白）。
  const okNotBlank =
    report.pageLoaded === true &&
    report.loadedUrl.includes("index.html") &&
    report.blankWindow.pageLooksRendered === true;

  report.checks = { okA1, okA4, okA5, okA8, okA10, okA11, okOffline, okNotBlank };
  report.verdict = okA1 && okA4 && okA5 && okA8 && okA10 && okA11 && okOffline && okNotBlank
    ? "pass"
    : "fail";
  finish();
});

// 兜底：任何一步卡住都要有输出，不能静默挂死
setTimeout(() => {
  report.verdict = "timeout";
  finish();
}, 25000);

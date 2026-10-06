/**
 * 小窗验收探针
 *
 * 职责：起真桥 → 起真小窗 → 用主进程的 executeJavaScript 做 DOM 断言、
 *       getBounds() 做几何断言，并把渲染层报错全收上来。
 * 所属层：工程工具（tools/）
 *
 * ── 铁律：探针只许观察，不许代劳 ──
 *
 * 悬浮条那边踩过一次：探针自己写了 `loadFile`，替产品把页面加载了；
 * 产品漏了这一步（窗口全白）却 11 项全绿。绿灯给了虚假的信心，
 * 比没有测试更糟。
 *
 * 所以本文件遵守：
 *   1. 走产品的 `bootWindow`，绝不自己 loadFile / setBounds / show
 *   2. 每个断言旁配反例检查（白窗口照妖镜：先验页面真渲染了）
 *   3. `executeJavaScript` 带超时（无文档时会永久挂住，只报 timeout 看不出真因）
 *
 * 允许做的只有「模拟用户输入」：点击按钮、派发事件。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-probe.cjs --port 19500
 */

"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..");
const PROBE_DIR = path.join(REPO_ROOT, "_probe");

/** 解析参数（Electron 会把 argv[0] 给成 exe 路径）。 */
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
app.setPath("userData", path.join(PROBE_DIR, "window-probe-userdata"));

const report = {
  a11: { consoleErrors: [], preloadErrors: [], renderGone: [], loadFailures: [] },
  verdict: "fail",
};

function finish() {
  console.log(`PROBE_RESULT ${JSON.stringify(report)}`);
  app.exit(0);
}

app.whenReady().then(async () => {
  const { bootWindow } = require(path.join(REPO_ROOT, "whale-window", "lib", "boot.cjs"));
  const { createLogger } = require(path.join(REPO_ROOT, "whale-window", "lib", "log.cjs"));

  const log = createLogger({
    resolveDir: () => path.join(PROBE_DIR, "window-probe-userdata"),
    consoleFallback: false,
  });

  let w = null;

  const booted = bootWindow({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    log,
    port: args.port,
    // 探针不改产品行为，但要不读不写记忆（否则会污染用户真实的位置，
    // 且上一条用例的位置会影响下一条，测试相互干扰）
    noRestore: true,
    onWindowReady: (win) => {
      w = win;
      const wc = win.win.webContents;
      wc.on("console-message", (...a) => {
        const first = a[0];
        const asEvent = first !== null && typeof first === "object" && "message" in first;
        const level = asEvent ? first.level : a[1];
        const message = asEvent ? first.message : a[2];
        if (level === 3 || level === "error") report.a11.consoleErrors.push(message);
      });
      wc.on("preload-error", (_e, file, err) => {
        report.a11.preloadErrors.push(`${file}: ${err && err.message}`);
      });
      wc.on("render-process-gone", (_e, details) => {
        report.a11.renderGone.push(details?.reason ?? "unknown");
      });
      wc.on("did-fail-load", (_e, code, desc) => {
        report.a11.loadFailures.push(`${code} ${desc}`);
      });
    },
  });

  w = booted.win;

  await w.loaded;
  report.pageLoaded = true;
  report.loadedUrl = w.win.webContents.getURL();
  await new Promise((r) => setTimeout(r, 2000));

  const run = (expr) => w.win.webContents.executeJavaScript(expr);
  const runWithTimeout = (expr, ms = 3000) =>
    Promise.race([
      run(expr),
      new Promise((_res, rej) => {
        setTimeout(() => rej(new Error("executeJavaScript 超时（页面可能没有加载）")), ms).unref();
      }),
    ]);

  // ── 前置条件：页面真的渲染了（白窗口照妖镜）──
  try {
    report.blankWindow = await runWithTimeout(`(() => {
      const win = document.getElementById("win");
      return {
        hasWin: win !== null,
        htmlLength: document.documentElement.innerHTML.length,
        pageLooksRendered: win !== null && document.documentElement.innerHTML.length > 800,
      };
    })()`);
  } catch (err) {
    report.blankWindow = { error: err.message, pageLooksRendered: false };
  }

  if (report.blankWindow.pageLooksRendered !== true) {
    report.checks = { okNotBlank: false };
    report.failureReason = "窗口是空白的：页面没有被加载。检查 whale-window/lib/window.cjs 是否调用了 loadFile。";
    finish();
    return;
  }

  // ── B1：窗口尺寸 492×710，内容 460×678 ──
  const b = w.bounds();
  const content = w.contentSize();
  report.b1 = { window: b, content };

  // ── B7 前置：发送键 aria-label（回合空闲应为「发送」）──
  report.sendButton = await run(`(() => {
    const el = document.getElementById("btnSend");
    return { ariaLabel: el.getAttribute("aria-label"), cls: el.className };
  })()`);

  // ── B4：拖顶栏能移动窗口（走真实的 drag 通道）──
  const before = w.bounds();
  await run("globalThis.whale.drag(40, 30)");
  await new Promise((r) => setTimeout(r, 300));
  const after = w.bounds();
  report.b4 = { dx: after.x - before.x, dy: after.y - before.y, sizeKept: after.width === before.width };

  // ── 顶栏元素齐全（F2 六元素）──
  report.topbar = await run(`(() => {
    const ids = ["btnMin", "btnPin", "btnGear", "btnMenu", "tbTitle"];
    const missing = ids.filter((id) => {
      const el = document.getElementById(id);
      return el === null || el.offsetWidth === 0;
    });
    return {
      missing,
      brandDot: document.querySelector(".brand-dot") !== null,
      title: document.getElementById("tbTitle").textContent,
    };
  })()`);

  // ── 会话标题行（F3）──
  report.sessionHead = await run(`({
    title: document.getElementById("shTitle").textContent,
    badge: document.querySelector(".sh-badge") ? document.querySelector(".sh-badge").textContent : null,
    sub: document.getElementById("shSub").textContent
  })`);

  // ── 权限三档文案（B9）：连点三次按钮，文案应轮转一整圈 ──
  const permSeq = [];
  for (let i = 0; i < 4; i += 1) {
    permSeq.push(await run("document.getElementById('btnPerm').textContent"));
    await run("document.getElementById('btnPerm').click()");
    await new Promise((r) => setTimeout(r, 200));
  }
  report.permissionSequence = permSeq;

  // ── 崩溃自愈状态机已装上（B11 的静态侧）──
  report.recovery = {
    phase: booted.recovery.phase(),
    crashCount: booted.recovery.crashCount(),
    maxReloads: require(path.join(REPO_ROOT, "whale-window", "lib", "recovery.cjs")).RENDERER_RELOAD_MAX,
  };

  // ── 消息流分流：用户 / 助手 / 工具必须分得开 ──
  // 「读错字段也能跑」的典型：按 role 读而桥给 kind，结果全渲染成助手且不报错。
  report.stream = await run(`(() => {
    const nodes = [...document.querySelectorAll(".stream .msg, .stream .tool-line")];
    const rows = nodes.map((n) => ({
      cls: n.className,
      role: n.querySelector(".role") ? n.querySelector(".role").textContent : null,
      text: n.textContent.slice(0, 40),
    }));
    return {
      count: rows.length,
      rows: rows.slice(0, 6),
      hasUser: rows.some((r) => r.cls.includes("me")),
      hasAi: rows.some((r) => r.cls.includes("ai")),
      hasTool: rows.some((r) => r.cls.includes("tool-line")),
      hasEmpty: document.querySelector(".stream .empty") !== null,
    };
  })()`);

  // ── 发送通路：回合空闲时点发送，桥应收到 user/message ──
  await run(`(() => {
    const input = document.getElementById("input");
    input.value = "来自小窗的测试消息";
    return true;
  })()`);
  await run("document.getElementById('btnSend').click()");
  await new Promise((r) => setTimeout(r, 1200));
  report.afterSend = await run(`({
    inputCleared: document.getElementById("input").value === "",
    sendAria: document.getElementById("btnSend").getAttribute("aria-label")
  })`);

  // ── 判定 ──
  const okNotBlank = true;
  const okB1 =
    b.width === 492 && b.height === 710 &&
    content.width === 460 && content.height === 678;
  const okB4 = report.b4.dx === 40 && report.b4.dy === 30 && report.b4.sizeKept === true;
  const okTopbar = report.topbar.missing.length === 0 && report.topbar.brandDot === true;
  const okHead = report.sessionHead.badge === "同源会话";
  const okPerm =
    report.permissionSequence[0] === "工作区内修改" &&
    report.permissionSequence[1] === "完全权限" &&
    report.permissionSequence[2] === "仅可查看" &&
    report.permissionSequence[3] === "工作区内修改";
  const okSend = report.sendButton.ariaLabel === "发送";
  // 消息流必须能分出「你」与「DSH」：只有助手消息时看不出分流对不对，
  // 而按错字段读的表现正是「全部渲染成助手且不报错」
  const okStream =
    report.stream.count > 0 &&
    report.stream.hasUser === true &&
    report.stream.hasAi === true;
  const okSendPath = report.afterSend.inputCleared === true;
  const okA11 =
    report.a11.consoleErrors.length === 0 &&
    report.a11.preloadErrors.length === 0 &&
    report.a11.renderGone.length === 0;

  report.checks = {
    okNotBlank, okB1, okB4, okTopbar, okHead, okPerm, okSend, okStream, okSendPath, okA11,
  };
  report.verdict =
    okNotBlank && okB1 && okB4 && okTopbar && okHead && okPerm && okSend && okStream && okSendPath && okA11
      ? "pass"
      : "fail";

  // 顺手存一张窗口自身截图，便于人工看
  try {
    const img = await w.win.webContents.capturePage();
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROBE_DIR, "window-shot.png"), img.toPNG());
    report.screenshot = "window-shot.png";
  } catch (err) {
    report.screenshotError = err.message;
  }

  finish();
});

// 兜底：任何一步卡住都要有输出，不能静默挂死
setTimeout(() => {
  report.verdict = "timeout";
  finish();
}, 40000);

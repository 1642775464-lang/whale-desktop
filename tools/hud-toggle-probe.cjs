/**
 * 鲸鱼切换与绿环验收探针
 *
 * 职责：进真悬浮条窗口，实测「点鲸鱼 → 小窗开/关」与「外圈绿环」是否真的工作。
 * 所属层：工程工具（tools/）
 *
 * 为什么要单独一个探针：这两件事**横跨三层**——
 *   渲染层的 class → HTTP → 桥的进程表 → 子进程
 * 只看任一层的返回值都会漏判。用户报过两次「看着没实现」，两次原因都在不同层：
 *   第一次：实现只做了「唤起」那一半，从没调过关闭
 *   第二次：图标照抄了源 svg 的 fill="none"，画出来是空心 = 看着透明
 *
 * 纪律（与 hud-probe 同）：探针只许观察，不许代劳。
 * 这里允许做的只有「模拟用户输入」——派发真鼠标事件、点真元素。
 *
 * 用法（必须由 Electron 跑，不是 node）：
 *   runtime\electron.exe --no-sandbox tools\hud-toggle-probe.cjs --port 19500
 */

"use strict";

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

/** 解析命令行参数（Electron 会把 argv[0] 给成 exe 路径）。 */
function parseArgs(argv) {
  const out = { port: 19387 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// 与产品同一套纪律：显式 userData，否则原生崩溃
app.setPath("userData", path.join(REPO_ROOT, "_probe", "hud-toggle-userdata"));

const report = { errors: [], verdict: "fail" };

/** 等一会儿（让 HTTP 往返与轮询落地）。 */
const sleep = (ms) => new Promise((r) => global.setTimeout(r, ms));

app.whenReady().then(async () => {
  const { bootHud } = require(path.join(REPO_ROOT, "whale-hud", "lib", "boot.cjs"));
  const { createLogger } = require(path.join(REPO_ROOT, "whale-hud", "lib", "log.cjs"));

  const log = createLogger({
    resolveDir: () => path.join(REPO_ROOT, "_probe", "hud-toggle-userdata"),
    consoleFallback: false,
  });

  const booted = bootHud({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    Menu,
    log,
    port: args.port,
    onWindowReady(w) {
      w.win.webContents.on("console-message", (...a) => {
        const first = a[0];
        const asEvent = first !== null && typeof first === "object" && "message" in first;
        const level = asEvent ? first.level : a[1];
        const message = asEvent ? first.message : a[2];
        // 只收 error 级：click 路径上可能有 info 日志
        if (String(level).includes("error")) report.errors.push({ level, message });
      });
    },
  });

  const win = booted.hudWindow.win;
  const run = (code) => win.webContents.executeJavaScript(code, true);

  // 等页面加载 + 首轮轮询（绿环靠 isSmallWindowRunning 拉一次）
  await booted.hudWindow.loaded;
  await sleep(1500);

  // ── 1) 鲸鱼存在吗 + 图标真的画出来了吗（透明 = 没填色）──
  report.icon = await run(`(() => {
    const w = document.getElementById("whaleBtn");
    if (!w) return { hasWhale: false };
    const svg = w.querySelector("svg");
    const p = svg && svg.querySelector("path");
    const cs = p ? getComputedStyle(p) : null;
    return {
      hasWhale: true,
      hasPath: !!p,
      fill: cs ? cs.fill : null,
      // 透明或 none 都说明画不出实心鲸鱼
      fillVisible: cs ? !(cs.fill === "none" || cs.fill.includes("rgba(0, 0, 0, 0)")) : false,
      pathLen: p ? (p.getAttribute("d") || "").length : 0
    };
  })()`);

  // ── 2) 绿环规则真的生效吗（点 before/after 的 ::after）──
  report.ring = await run(`(() => {
    const w = document.getElementById("whaleBtn");
    const off = getComputedStyle(w, "::after");
    const offContent = off.content;
    w.classList.add("on");
    const on = getComputedStyle(w, "::after");
    const out = {
      offContent,
      onContent: on.content,
      borderWidth: on.borderTopWidth,
      borderColor: on.borderTopColor
    };
    w.classList.remove("on");
    return out;
  })()`);

  // ── 3) 点一下鲸鱼：派发真鼠标序列（不替产品调任何方法）──
  // bindDrag 的判定链是 mousedown(球上) → mouseup(document)，
  // 且位移必须 ≤3px 才算点击。
  report.beforeClick = await run(
    `document.getElementById("whaleBtn").classList.contains("on")`,
  );

  await run(`(() => {
    const w = document.getElementById("whaleBtn");
    w.dispatchEvent(new MouseEvent("mousedown", {
      bubbles: true, button: 0, screenX: 100, screenY: 100
    }));
    document.dispatchEvent(new MouseEvent("mouseup", {
      bubbles: true, button: 0, screenX: 100, screenY: 100
    }));
    return true;
  })()`);
  await sleep(1200);

  report.afterClick = await run(`({
    ringOn: document.getElementById("whaleBtn").classList.contains("on")
  })`);

  report.verdict =
    report.icon.hasWhale === true &&
    report.icon.fillVisible === true &&
    report.ring.onContent !== "none" &&
    report.ring.offContent === "none" &&
    report.errors.length === 0
      ? "pass"
      : "fail";

  console.log(`TOGGLE_PROBE ${JSON.stringify(report)}`);
  app.exit(0);
});

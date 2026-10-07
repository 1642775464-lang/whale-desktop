/**
 * 小窗客户端状态诊断
 *
 * 职责：起一个真小窗窗口连**真实桥**，把它的客户端内部状态读出来：
 *       sessionId 有没有、面板拉到几条、标题是什么。
 * 所属层：工程工具（tools/）
 *
 * 为什么要这个：现场现象是「标题空 + 消息空 + 却显示桥已连接」。
 * 这个组合至少有三种成因（sessionId 为空 / sessionId 陈旧 / 折叠器里没该会话），
 * 三者修法不同，靠读代码分不出来 —— 必须把运行时状态打出来。
 *
 * 纪律：探针只观察，不替产品做任何事（不调 refresh、不设 state）。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-diag.cjs --port 19387
 */

"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { port: 19387 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
app.setPath("userData", path.join(REPO_ROOT, "_probe", "window-diag-userdata"));

const report = { consoleErrors: [] };
const sleep = (ms) => new Promise((r) => global.setTimeout(r, ms));

app.whenReady().then(async () => {
  const { bootWindow } = require(path.join(REPO_ROOT, "whale-window", "lib", "boot.cjs"));

  const booted = bootWindow({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    log: () => {},
    port: args.port,
    noRestore: true,
    onWindowReady(w) {
      w.win.webContents.on("console-message", (...a) => {
        const first = a[0];
        const asEvent = first !== null && typeof first === "object" && "message" in first;
        const level = asEvent ? first.level : a[1];
        const message = asEvent ? first.message : a[2];
        report.consoleErrors.push({ level: String(level), message: String(message) });
      });
    },
  });

  // bootWindow 返回 { win, store, ... }，其中 win 是**窗口封装**（自定义对象），
  // 真正的 BrowserWindow 在 win.win 上（boot.cjs:166 就是这么用的）。
  const wrapper = booted.win;
  const win = wrapper.win;
  const run = (code) => win.webContents.executeJavaScript(code, true);

  await wrapper.loaded;
  // 等两轮轮询（桥给数据需要一点时间）
  await sleep(6000);

  // 直接读客户端内部状态（WhaleBridge 把 getState 暴露出来了）
  report.client = await run(`(() => {
    const c = window.__whaleClientForDiag;
    return c ? { hasClient: true } : { hasClient: false };
  })()`);

  // 客户端实例没暴露，就退而从 DOM 与直接探测拿证据
  report.dom = await run(`({
    title: (document.getElementById("shTitle") || {}).textContent,
    sub: (document.getElementById("shSub") || {}).textContent,
    streamRows: document.querySelectorAll("#stream .msg, #stream .tool-line").length,
    empty: !!document.getElementById("streamEmpty"),
    emptyText: (document.getElementById("streamEmpty") || {}).textContent
  })`);

  // 关键：自己复现小窗的两步取数，看每一步拿到什么
  const port = args.port;
  report.probe = await run(`(async () => {
    const out = {};
    try {
      const hud = await (await fetch("http://127.0.0.1:${port}/whale/hud")).json();
      out.hudOk = true;
      out.activeSessionId = hud.activeSessionId;
      out.sessionCount = Array.isArray(hud.sessions) ? hud.sessions.length : -1;
      out.firstTitle = hud.sessions && hud.sessions[0] ? hud.sessions[0].title : null;
    } catch (e) { out.hudError = String(e && e.message); }

    const sid = out.activeSessionId;
    if (sid) {
      try {
        const p = await (await fetch("http://127.0.0.1:${port}/whale/panel?sessionId=" + encodeURIComponent(sid))).json();
        out.panelOk = true;
        out.panelTitle = p.title;
        out.panelMessages = Array.isArray(p.messages) ? p.messages.length : -1;
      } catch (e) { out.panelError = String(e && e.message); }
    }
    return out;
  })()`);

  console.log(`WINDOW_DIAG ${JSON.stringify(report)}`);
  app.exit(0);
});

/**
 * 小窗消息流显示什么（真窗口）
 *
 * 职责：起真窗口，往渲染器喂一组「用户 / 工具 / 助手」消息，
 *       把消息流里**实际渲染出来的每一行**读出来。
 * 所属层：工程工具（tools/）
 *
 * 用户要求：「小窗里不需要展示你的工具调用过程，不需要展示你的思考过程」。
 * 这类「不该显示什么」的要求，单元测试能覆盖渲染逻辑，
 * 但**真实 DOM 里到底出现了哪些节点**只有真窗口能证明 ——
 * 而且能顺带确认没有别的地方（样式表、别的模块）又把它加回来。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-stream-probe.cjs --port 19387
 */

"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const ARGS = (() => {
  const a = process.argv.slice(2);
  const i = a.indexOf("--port");
  return { port: i === -1 ? 19387 : Number(a[i + 1]) };
})();

const say = (m) => process.stdout.write(`[stream-probe] ${m}\n`);

function makeRun(win) {
  return function run(expr, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("executeJavaScript 超时")), ms);
      win.webContents.executeJavaScript(expr, true)
        .then((v) => { clearTimeout(t); resolve(v); })
        .catch((e) => { clearTimeout(t); reject(e); });
    });
  };
}

async function waitFor(run, expr, ms, label) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await run(expr);
    if (last) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  say(`等待超时：${label}（最后 ${JSON.stringify(last)}）`);
  return false;
}

async function main() {
  await app.whenReady();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: 560, height: 760,
    x: Math.max(0, sw - 700), y: Math.max(0, sh - 820),
    show: true, frame: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(REPO_ROOT, "whale-window", "preload.cjs"),
      additionalArguments: [`--whale-bridge-port=${ARGS.port}`],
    },
  });

  ipcMain.handle("whale:ready", () => ({
    ok: true, port: ARGS.port, version: "probe",
    bounds: win.getBounds(), content: win.getContentSize(), pinned: win.isAlwaysOnTop(),
  }));
  ipcMain.handle("whale:log", () => {});

  win.loadFile(path.join(REPO_ROOT, "whale-window", "renderer", "index.html"));
  const run = makeRun(win);

  const pageErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    pageErrors.push(`[L${level}] ${message}`);
  });

  await waitFor(run, "typeof window.WhaleRender === 'object'", 8000, "页面装配");

  /*
   * 直接调渲染器喂一份带工具消息的状态。
   *
   * 这是**观察**而不是替产品干活：渲染器是产品自己的模块，
   * 我们给它一份用户在真实会话里会遇到的数据，然后看它画了什么。
   */
  const rendered = await run(`
    (function () {
      const r = window.WhaleRender.createRenderer({
        dom: {
          tbTitle: document.getElementById("tbTitle"),
          stream: document.getElementById("stream"),
          status: document.getElementById("status"),
          statusText: document.getElementById("statusText"),
          dock: document.getElementById("dock"),
          dockList: document.getElementById("dockList"),
          dockCount: document.getElementById("dockCount"),
          dockProg: document.getElementById("dockProg"),
          input: document.getElementById("input"),
          btnSend: document.getElementById("btnSend"),
          btnPerm: document.getElementById("btnPerm"),
          urFg: document.getElementById("urFg"),
          usagePct: document.getElementById("usagePct"),
          infoSession: document.getElementById("infoSession"),
          infoBridge: document.getElementById("infoBridge"),
          infoEvents: document.getElementById("infoEvents"),
        },
        getPermission: function () { return "workspace-write"; },
      });

      // 刷新一次，然后喂一份「用户问 / 工具跑 / 助手答」的完整回合
      r.all({ offline: false, title: "t", workspace: null, running: false,
              messages: [], todos: [], permission: null, sessionId: "x" });
      r.all({
        offline: false, title: "t", workspace: null, running: false,
        permission: null, todos: [], sessionId: "x",
        messages: [
          { kind: "user", text: "帮我看下这个文件", seq: 1 },
          { kind: "tool", name: "read_file", text: "", seq: 2 },
          { kind: "tool", name: "grep", text: "", seq: 3 },
          { kind: "assistant", text: "看完了，没问题", seq: 4 },
        ],
      });

      const stream = document.getElementById("stream");
      return Array.from(stream.children).map(function (c) {
        return { cls: c.className, text: (c.innerText || c.textContent || "").slice(0, 60) };
      });
    })()
  `);

  say(`消息流渲染出 ${rendered.length} 行：`);
  for (const line of rendered) say(`  [${line.cls}] ${JSON.stringify(line.text)}`);

  const allText = rendered.map((l) => l.text).join(" | ");
  const problems = [];
  if (!allText.includes("帮我看下这个文件")) problems.push("用户的话没显示");
  if (!allText.includes("看完了，没问题")) problems.push("助手的回答没显示");
  if (allText.includes("read_file") || allText.includes("grep")) problems.push("工具名出现在小窗里");
  if (allText.includes("tool")) problems.push("「tool」字样出现在小窗里");
  if (rendered.some((l) => String(l.cls).includes("tool-line"))) problems.push("还有工具行");

  // 状态条：运行中只该说「正在运行」，不报工具名
  const statusText = await run(`
    (function () {
      const r = window.WhaleRender.createRenderer({
        dom: {
          tbTitle: document.getElementById("tbTitle"),
          stream: document.getElementById("stream"),
          status: document.getElementById("status"),
          statusText: document.getElementById("statusText"),
          dock: document.getElementById("dock"),
          dockList: document.getElementById("dockList"),
          dockCount: document.getElementById("dockCount"),
          dockProg: document.getElementById("dockProg"),
          input: document.getElementById("input"),
          btnSend: document.getElementById("btnSend"),
          btnPerm: document.getElementById("btnPerm"),
          urFg: document.getElementById("urFg"),
          usagePct: document.getElementById("usagePct"),
          infoSession: document.getElementById("infoSession"),
          infoBridge: document.getElementById("infoBridge"),
          infoEvents: document.getElementById("infoEvents"),
        },
        getPermission: function () { return "workspace-write"; },
      });
      r.all({ offline: false, title: "t", workspace: null, running: true,
              toolName: "read_file", messages: [], todos: [], permission: null });
      return document.getElementById("statusText").textContent;
    })()
  `);
  say(`状态条（运行中）：${JSON.stringify(statusText)}`);
  if (statusText.includes("read_file")) problems.push("状态条报了工具名");
  if (statusText !== "正在运行") problems.push(`状态条文案不对：${statusText}`);

  say(problems.length === 0 ? "结论：小窗只显示对话，不显示工具调用 ✓" : `结论：${problems.join("；")}`);
  if (pageErrors.length > 0) {
    say(`页面报错 ${pageErrors.length} 条：`);
    for (const e of pageErrors.slice(0, 6)) say(`  ✗ ${e}`);
  }
  app.exit(problems.length === 0 && pageErrors.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`探针出错：${e && e.message}`); app.exit(9); });

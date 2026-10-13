/**
 * 工作区文件列表页探针
 *
 * 职责：起真窗口，点顶栏「文件夹」图标，读出**实际渲染结果**与交互结果。
 * 所属层：工程工具（tools/）
 *
 * 为什么需要它：契约测试只能证明元素写在 HTML 里、纯函数算得对，
 * 证明不了「点图标真的进得去、点目录真的下钻、返回真的回得来」。
 *
 * 纪律：**只模拟用户动作**（点按钮、点行）+ 读 DOM，
 * 不替产品加载页面、不注入状态、不直接调桥。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-files-probe.cjs --port 19387
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

const say = (m) => process.stdout.write(`[files-probe] ${m}\n`);

function makeRun(win) {
  return function run(expr, ms = 15000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("executeJavaScript 超时")), ms);
      win.webContents.executeJavaScript(expr, true)
        .then((v) => { clearTimeout(t); resolve(v); })
        .catch((e) => { clearTimeout(t); reject(e); });
    });
  };
}

/**
 * 读文件页状态。
 *
 * ⚠️ 判可见性要读 **computed display**，不能读 `.hidden` 属性 ——
 * 后者只说明「作者设了这个属性」，不说明「它真的被隐藏了」
 * （`.files-view{display:flex}` 会覆盖 `[hidden]` 的默认样式）。
 *
 * （本段在模板字面量里，**不能出现反引号**。）
 */
const READ = `(() => {
  const view = document.getElementById("filesView");
  const stream = document.getElementById("stream");
  const shown = (el) => el !== null && getComputedStyle(el).display !== "none";
  const rows = Array.from(document.getElementById("fvList").children).map((r) => ({
    text: r.textContent || "",
    cls: r.className || "",
  }));
  const crumb = Array.from(document.getElementById("fvCrumb").children).map((c) => c.textContent);
  return {
    filesOpen: view ? shown(view) : null,
    streamHidden: stream ? !shown(stream) : null,
    rowCount: rows.length,
    rows,
    crumb,
    count: (document.getElementById("fvCount") || {}).textContent,
  };
})()`;

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
    if (level >= 2) pageErrors.push(message);
  });

  // 等 app 起来（顶栏标题不再是初始值）
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const ok = await run(`typeof window.WhaleFilesView === "object"`);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 150));
  }

  say("=== 1) 初始状态 ===");
  let st = await run(READ);
  say(`  文件页打开：${st.filesOpen}（期望 false）`);
  say(`  消息流可见：${!st.streamHidden}（期望 true）`);

  say("");
  say("=== 2) 点顶栏「文件夹」图标 ===");
  await run(`document.getElementById("btnFolder").click()`);
  await new Promise((r) => setTimeout(r, 1800));
  st = await run(READ);
  say(`  文件页打开：${st.filesOpen}（期望 true）`);
  say(`  消息流已隐藏：${st.streamHidden}（期望 true）`);
  say(`  面包屑：${JSON.stringify(st.crumb)}`);
  say(`  条目数：${st.rowCount}（计数显示 ${st.count}）`);
  const rowsSeen = st.rowCount;
  for (const r of st.rows.slice(0, 8)) say(`    - "${r.text}"  [${r.cls}]`);

  // 找到第一个目录行（用于下钻）
  const dirRow = st.rows.find((r) => r.cls.includes("fv-directory"));
  let drillOk = null;
  if (dirRow) {
    say("");
    say(`=== 3) 点第一个目录「${dirRow.text}」下钻 ===`);
    const box = await run(`(() => {
      const rows = Array.from(document.getElementById("fvList").children);
      for (const r of rows) {
        if (r.className.includes("fv-directory")) {
          const b = r.getBoundingClientRect();
          return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
        }
      }
      return null;
    })()`);
    win.webContents.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
    win.webContents.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 1800));
    const after = await run(READ);
    say(`  面包屑：${JSON.stringify(after.crumb)}`);
    say(`  条目数：${after.rowCount}`);
    after.rows.slice(0, 5).forEach((r) => say(`    - "${r.text}"  [${r.cls}]`));
    // 下钻成功 = 面包屑多了一段
    drillOk = after.crumb.length > st.crumb.length;
    say(`  下钻成功：${drillOk}（期望 true）`);
  } else {
    say("");
    say("=== 3) 没有目录行可点（可能读不到数据）===");
  }

  say("");
  say("=== 4) 点「返回」 ===");
  await run(`document.getElementById("fvBack").click()`);
  await new Promise((r) => setTimeout(r, 500));
  st = await run(READ);
  say(`  文件页打开：${st.filesOpen}（期望 false）`);
  say(`  消息流已恢复：${!st.streamHidden}（期望 true）`);

  say("");
  const problems = [];
  if (st.filesOpen !== false) problems.push("返回后文件页仍可见");
  if (st.streamHidden !== false) problems.push("返回后消息流没恢复");
  if (rowsSeen === 0) problems.push("文件列表是空的（读不到或没渲染）");
  if (dirRow && drillOk !== true) problems.push("点目录没有下钻");

  say(`页面错误 ${pageErrors.length} 条：`);
  pageErrors.slice(0, 5).forEach((e) => say(`  ✗ ${String(e).slice(0, 140)}`));
  say("");
  say(problems.length === 0 ? "结论：文件列表页正常 ✓" : `结论：${problems.join("；")}`);
  app.exit(problems.length === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  say(`致命: ${e.message}`);
  app.exit(3);
});

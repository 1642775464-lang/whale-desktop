/**
 * 左侧边栏探针
 *
 * 职责：起真窗口，点开侧边栏并读出**实际渲染结果**与**交互结果**。
 *       所属层：工程工具（tools/）
 *
 * 为什么需要它：侧边栏是新 UI，契约测试只能证明元素写在 HTML 里，
 * 证明不了「点开后真的有内容、点会话真的切了、技能真的读到了」。
 * 这类问题只能在真窗口里取证。
 *
 * 纪律：**只模拟用户动作**（点击按钮）+ 读 DOM，
 * 不替产品加载页面、不注入状态、不直接调桥。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-sidebar-probe.cjs --port 19387
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

const say = (m) => process.stdout.write(`[sidebar-probe] ${m}\n`);

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

async function waitFor(run, expr, ms, label) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await run(expr);
    if (last) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  say(`等待超时：${label}（最后 ${JSON.stringify(last)}）`);
  return false;
}

/** 读侧边栏当前状态。 */
const READ = `(() => {
  const bar = document.getElementById("sidebar");
  const list = document.getElementById("sbSessions");
  const view = document.getElementById("skillsView");
  const rows = list ? Array.from(list.children) : [];
  return {
    sidebarOpen: bar ? !bar.hidden : null,
    rowCount: rows.length,
    rows: rows.map((r) => ({
      text: r.textContent || "",
      cls: r.className || "",
    })),
    skillsOpen: view ? !view.hidden : null,
    skillsCount: (document.getElementById("svCount") || {}).textContent,
    skillsRows: Array.from(document.getElementById("svList") ? document.getElementById("svList").children : []).length,
    streamHidden: document.getElementById("stream") ? document.getElementById("stream").hidden : null,
    sessionId: null,
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
    // 只收错误级，warn 是产品正常的降级提示
    if (level >= 2) pageErrors.push(message);
  });

  // 等桥连上（标题不再是「未连接」）
  await waitFor(
    run,
    `(() => {
      const t = document.getElementById("tbTitle");
      return t && t.textContent && t.textContent !== "未连接";
    })()`,
    15000,
    "桥连上",
  );

  say("=== 1) 初始状态 ===");
  let st = await run(READ);
  say(`  侧边栏打开：${st.sidebarOpen}（期望 false）`);
  say(`  技能页打开：${st.skillsOpen}（期望 false）`);

  say("");
  say("=== 2) 点顶栏「打开左侧边栏」 ===");
  await run(`document.getElementById("btnSideLeft").click()`);
  await new Promise((r) => setTimeout(r, 400));
  st = await run(READ);
  say(`  侧边栏打开：${st.sidebarOpen}（期望 true）`);
  say(`  会话行数：${st.rowCount}`);
  for (const row of st.rows.slice(0, 6)) {
    say(`    - "${row.text}"  [${row.cls}]`);
  }

  say("");
  say("=== 3) 点「技能中心」 ===");
  await run(`document.getElementById("sbSkills").click()`);
  await new Promise((r) => setTimeout(r, 2500));
  st = await run(READ);
  say(`  技能页打开：${st.skillsOpen}（期望 true）`);
  say(`  计数：${st.skillsCount}`);
  say(`  列表行数：${st.skillsRows}`);
  say(`  侧边栏已收起：${!st.sidebarOpen}（期望 true）`);
  say(`  消息流已隐藏：${st.streamHidden}（期望 true）`);

  say("");
  say("=== 4) 点「返回」 ===");
  await run(`document.getElementById("svBack").click()`);
  await new Promise((r) => setTimeout(r, 400));
  st = await run(READ);
  say(`  技能页打开：${st.skillsOpen}（期望 false）`);
  say(`  消息流已恢复：${!st.streamHidden}（期望 true）`);

  // ── 判定 ──
  const problems = [];
  if (st.sidebarOpen !== false && st.sidebarOpen !== true) problems.push("侧边栏状态读不到");
  if (st.skillsOpen !== false) problems.push("返回后技能页没关闭");
  if (st.streamHidden !== false) problems.push("返回后消息流没恢复");

  say("");
  if (pageErrors.length > 0) {
    say(`页面错误 ${pageErrors.length} 条：`);
    for (const e of pageErrors.slice(0, 5)) say(`  ✗ ${e}`);
  }
  say(problems.length === 0 ? "结论：侧边栏与技能中心都正常 ✓" : `结论：${problems.join("；")}`);
  app.exit(problems.length === 0 && pageErrors.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`探针出错：${e && e.message}`); app.exit(9); });

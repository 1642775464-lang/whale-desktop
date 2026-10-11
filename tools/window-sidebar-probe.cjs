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
  /*
   * ⚠️ 判可见性要读 **computed display**，不能读 .hidden 属性。
   *
   * .hidden 只说明「作者设了这个属性」，不说明「它真的被隐藏了」——
   * [hidden] 的默认 display:none 会被元素自己的 display:flex 覆盖。
   * 探针原先读 .hidden，于是在「点 × 关不掉」的真 bug 面前**全绿**。
   * 这正是「程序化全绿、用户点不动」的来源。
   *
   * （注意本段在模板字面量里，**不能出现反引号**，否则会把字符串截断。）
   */
  const shown = (el) => el !== null && getComputedStyle(el).display !== "none";
  return {
    sidebarOpen: bar ? shown(bar) : null,
    sidebarHiddenAttr: bar ? bar.hidden : null,
    rowCount: rows.length,
    rows: rows.map((r) => ({
      text: r.textContent || "",
      cls: r.className || "",
    })),
    /*
     * 提示行（目前只用于降级说明）与工作区分组数。
     * 提示行的判据：正常过滤（空会话 / 归档）**不该**产生它 ——
     * 用户明确要求过「这些不用显示出来」。
     */
    noteCount: rows.filter((r) => r.className === "sb-note").length,
    groupCount: rows.filter((r) => r.className === "sb-group").length,
    skillsOpen: view ? shown(view) : null,
    skillsCount: (document.getElementById("svCount") || {}).textContent,
    skillsRows: Array.from(document.getElementById("svList") ? document.getElementById("svList").children : []).length,
    streamHidden: document.getElementById("stream") ? !shown(document.getElementById("stream")) : null,
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
  /** 后面判定要用的观察值（跨步骤保留）。 */
  let rowsSeen = 0;
  let skillsSeen = 0;
  let notesSeen = 0;
  let realMouseClosed = false;
  let realOutsideClosed = false;
  say(`  侧边栏打开：${st.sidebarOpen}（期望 false）`);
  say(`  技能页打开：${st.skillsOpen}（期望 false）`);

  say("");
  say("=== 2) 点顶栏「打开左侧边栏」 ===");
  await run(`document.getElementById("btnSideLeft").click()`);
  await new Promise((r) => setTimeout(r, 400));
  st = await run(READ);
  rowsSeen = st.rowCount;
  notesSeen = st.noteCount;
  say(`  侧边栏打开：${st.sidebarOpen}（期望 true）`);
  say(`  会话行数：${st.rowCount}（含 ${st.groupCount} 个工作区分组标题）`);
  say(`  提示行数：${st.noteCount}（正常应为 0 —— 过滤不该出提示）`);
  for (const row of st.rows.slice(0, 6)) {
    say(`    - "${row.text}"  [${row.cls}]`);
  }

  say("");
  say("=== 2.2) 用**真鼠标**点侧边栏**外**的区域 → 应关闭（用户要求的交互）===");
  /*
   * 侧边栏打开时点非侧边栏区域直接关闭。
   * 侧边栏宽 224px、顶栏高 55px，右侧消息流区域就是「外部」。
   * 真鼠标点 (400, 300) —— 消息流中间偏右，远离侧边栏与输入区。
   */
  win.webContents.sendInputEvent({ type: "mouseMove", x: 400, y: 300 });
  win.webContents.sendInputEvent({ type: "mouseDown", x: 400, y: 300, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: 400, y: 300, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 500));
  st = await run(READ);
  say(`  点外部后，侧边栏打开：${st.sidebarOpen}（期望 false）`);
  realOutsideClosed = st.sidebarOpen === false;

  // 重新打开，供 2.5 用
  await run(`document.getElementById("btnSideLeft").click()`);
  await new Promise((r) => setTimeout(r, 400));
  st = await run(READ);
  say(`  重新打开：${st.sidebarOpen}（期望 true）`);

  say("");
  say("=== 2.5) 用**真鼠标**点侧边栏右上角「×」 ===");
  /*
   * ⚠️ 必须用真鼠标事件，不能用 element.click()。
   *
   * 这两者的差别正是「程序化全绿、用户点不动」的来源：
   *   · element.click() 直接派发事件，**跳过命中测试**——
   *     元素被别的层盖住、或落在 -webkit-app-region: drag 里，它照样"成功"；
   *   · 真鼠标要经过命中测试与拖拽区判定，问题才会暴露。
   * 用户报「点叉关不上」，而 element.click() 一直是通的 —— 就用这个复现。
   */
  const box = await run(`(() => {
    const r = document.getElementById("sbClose").getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  })()`);
  say(`  × 的屏幕坐标：(${box.x}, ${box.y})  尺寸 ${box.w}×${box.h}`);
  win.webContents.sendInputEvent({ type: "mouseMove", x: box.x, y: box.y });
  win.webContents.sendInputEvent({ type: "mouseDown", x: box.x, y: box.y, button: "left", clickCount: 1 });
  win.webContents.sendInputEvent({ type: "mouseUp", x: box.x, y: box.y, button: "left", clickCount: 1 });
  await new Promise((r) => setTimeout(r, 500));
  st = await run(READ);
  say(`  真鼠标点后，侧边栏打开：${st.sidebarOpen}（期望 false）`);
  realMouseClosed = st.sidebarOpen === false;

  // 重新打开，继续后面的步骤
  await run(`document.getElementById("btnSideLeft").click()`);
  await new Promise((r) => setTimeout(r, 400));
  st = await run(READ);
  say(`  再点顶栏按钮：${st.sidebarOpen}（期望 true）`);

  say("");
  say("=== 3) 点「技能中心」 ===");
  await run(`document.getElementById("sbSkills").click()`);
  await new Promise((r) => setTimeout(r, 2500));
  st = await run(READ);
  skillsSeen = st.skillsRows;
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
  /*
   * ⚠️ 判定要看**真鼠标的结果**（realMouseClosed），不能只看后面程序化步骤的
   * 结果 —— 用户报的就是「点叉关不上」，而那条只有真鼠标才测得出来。
   */
  const problems = [];
  if (realMouseClosed !== true) {
    problems.push("真鼠标点 × 没关上（用户报的「点叉关不上」）");
  }
  if (realOutsideClosed !== true) {
    problems.push("真鼠标点侧边栏外没关闭（用户要求的新交互）");
  }
  if (st.sidebarOpen !== false) problems.push("返回后侧边栏仍可见");
  if (st.skillsOpen !== false) problems.push("返回后技能页没关闭");
  if (st.streamHidden !== false) problems.push("返回后消息流没恢复");
  if (skillsSeen === 0) problems.push("技能列表是空的（读不到或没渲染）");
  if (rowsSeen === 0) problems.push("会话列表是空的（数据没进 state 或没渲染）");
  /*
   * 正常过滤**不该**出提示行。
   * 用户明确要求过「这些不用显示出来」（已略过 N 个空会话 / 已隐藏 N 个归档会话）——
   * 那条断言钉住它，防止以后又被加回来。
   */
  if (notesSeen !== 0) problems.push(`出现了 ${notesSeen} 行提示（正常过滤不该出提示）`);

  say("");
  if (pageErrors.length > 0) {
    say(`页面错误 ${pageErrors.length} 条：`);
    for (const e of pageErrors.slice(0, 5)) say(`  ✗ ${e}`);
  }
  say(problems.length === 0 ? "结论：侧边栏与技能中心都正常 ✓" : `结论：${problems.join("；")}`);
  app.exit(problems.length === 0 && pageErrors.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`探针出错：${e && e.message}`); app.exit(9); });

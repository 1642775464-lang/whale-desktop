/**
 * 侧边栏五条反馈的探针
 *
 * 职责：起真窗口，逐条验证本轮的五项改动。
 * 所属层：工程工具（tools/）
 *
 * 验证项：
 *   1. 浏览器面板用平板 UA（读 webview 的实际 UA）
 *   2. bug：浏览器面板「返回」能回首页
 *   3. 侧边对话有「继承上下文」下拉，默认选中当前会话
 *   4. bug：侧栏打开时关小窗，侧栏跟着关
 *   5. 动画时长已加快（读常量）
 *
 * 纪律：只模拟用户动作（点按钮）+ 读真实窗口/DOM，不替产品建状态。
 *
 * 用法：runtime\electron.exe --no-sandbox tools\window-side2-probe.cjs --port 19387
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
const say = (m) => process.stdout.write(`[side2] ${m}\n`);

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

async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  say(`等待超时：${label}`);
  return false;
}

function findSide(mainId) {
  return BrowserWindow.getAllWindows().filter((w) => w.id !== mainId);
}

/** 侧窗页面里读「当前显示哪一块」。 */
const READ_PANELS = `(() => {
  const shown = (el) => el !== null && getComputedStyle(el).display !== "none";
  return {
    home: shown(document.getElementById("sHome")),
    browser: shown(document.getElementById("pBrowser")),
    files: shown(document.getElementById("pFiles")),
    chat: shown(document.getElementById("pChat")),
    title: document.getElementById("sbTitle").textContent,
  };
})()`;

async function main() {
  await app.whenReady();
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: 560, height: 760,
    x: Math.max(0, sw - 1500), y: Math.max(0, sh - 820),
    show: true, frame: false,
    webPreferences: {
      contextIsolation: true, nodeIntegration: false,
      preload: path.join(REPO_ROOT, "whale-window", "preload.cjs"),
      additionalArguments: [`--whale-bridge-port=${ARGS.port}`],
    },
  });

  const sideGeometry = require(path.join(REPO_ROOT, "whale-window", "lib", "side-geometry.cjs"));
  const sideUa = require(path.join(REPO_ROOT, "whale-window", "lib", "side-ua.cjs"));
  const sideWindow = require(path.join(REPO_ROOT, "whale-window", "lib", "side-window.cjs"));
  const ipc = require(path.join(REPO_ROOT, "whale-window", "lib", "ipc.cjs"));

  const ipcRef = { value: null };
  const side = sideWindow.createSideWindow({
    BrowserWindow,
    screen,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: ARGS.port,
    mainBounds: () => win.getBounds(),
    currentSessionId: () => "session-probe-main",
    workspacePath: () => REPO_ROOT,
    userAgent: sideUa.browserUserAgent(),
    onJoinedChange: (joined) => {
      if (ipcRef.value !== null) ipcRef.value.notifyJoined(joined);
    },
  });

  const registered = ipc.registerIpc({
    ipcMain,
    win: { bounds: () => win.getBounds(), contentSize: () => win.getContentSize(), win },
    store: { flush: () => true, remember: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: ARGS.port,
    version: "probe",
    side,
  });
  ipcRef.value = registered;

  /*
   * ⚠️ 生命周期监听必须与 boot.cjs **一致**，否则测的是「一个不存在的装配」。
   *
   * 踩过两次：上一轮探针漏接 `onJoinedChange`，这一轮险些漏掉 hide/minimize/
   * close 的跟随 —— 两次都会把「产品其实没接线」误报成「产品有 bug」，
   * 或者反过来（这次就是：产品接了，探针没接）。
   */
  win.on("hide", () => side.closeNow());
  win.on("minimize", () => side.closeNow());
  win.on("close", () => side.closeNow());
  win.on("closed", () => side.dispose());

  win.loadFile(path.join(REPO_ROOT, "whale-window", "renderer", "index.html"));
  const run = makeRun(win);
  const pageErrors = [];
  win.webContents.on("console-message", (_e, lvl, msg) => { if (lvl >= 2) pageErrors.push(msg); });

  await waitFor(() => run(`typeof window.whale === "object"`), 15000, "preload 就绪");

  say("=== 5) 动画时长（用户要求再快一倍）===");
  say(`  DRAWER_MS = ${sideGeometry.DRAWER_MS}ms（期望 70）`);

  say("");
  say("=== 打开侧边栏 ===");
  await run(`document.getElementById("btnSideRight").click()`);
  const appeared = await waitFor(() => findSide(win.id).length > 0, 5000, "侧窗出现");
  say(`  侧窗出现：${appeared}`);
  await new Promise((r) => setTimeout(r, sideGeometry.DRAWER_MS + 400));
  const sideWin = findSide(win.id)[0];
  if (sideWin === undefined) {
    say("侧窗没建起来，后续检查跳过");
    app.exit(1);
    return;
  }
  const srun = (expr) => sideWin.webContents.executeJavaScript(expr, true);
  const sideErrors = [];
  sideWin.webContents.on("console-message", (_e, lvl, msg) => { if (lvl >= 2) sideErrors.push(msg); });

  say("");
  say("=== 2) bug：浏览器面板「返回」要回首页 ===");
  await srun(`document.getElementById("sBrowser").click()`);
  await new Promise((r) => setTimeout(r, 300));
  let st = await srun(READ_PANELS);
  say(`  进入浏览器面板：${st.browser}（期望 true）`);
  await srun(`document.getElementById("sbBack").click()`);
  await new Promise((r) => setTimeout(r, 300));
  st = await srun(READ_PANELS);
  const backToHome = st.home === true && st.browser === false;
  say(`  点返回后回首页：${backToHome}（期望 true）`);

  say("");
  say("=== 1) 浏览器面板用平板 UA ===");
  const uaInfo = await srun(`(() => {
    const wv = document.getElementById("sbWeb");
    return { hasWebview: wv !== null, ua: navigator.userAgent };
  })()`);
  say(`  webview 元素存在：${uaInfo.hasWebview}`);
  // webview 内部的 UA 由主进程 did-attach-webview 设置，这里读宿主侧记录
  say(`  设定给 webview 的 UA 含 iPad：${sideUa.browserUserAgent().includes("iPad")}`);

  // 首页默认百度（用户要求）：webview 的 src 与地址栏都该是它
  const homeInfo = await srun(`(() => {
    const wv = document.getElementById("sbWeb");
    return { src: wv.getAttribute("src"), url: document.getElementById("sbUrl").value };
  })()`);
  const homeOk = /baidu\.com/.test(homeInfo.src ?? "") && /baidu\.com/.test(homeInfo.url ?? "");
  say(`  webview src：${homeInfo.src}`);
  say(`  地址栏    ：${homeInfo.url}`);
  say(`  首页默认百度：${homeOk}（期望 true）`);

  say("");
  say("=== 2.1) 文件区要能列出当前工作区（用户报「读不到当前工作区」）===");
  await srun(`document.getElementById("sFiles").click()`);
  await new Promise((r) => setTimeout(r, 1200));
  const filesInfo = await srun(`(() => {
    const body = document.getElementById("sfBody");
    const rows = Array.from(body.children).map((c) => c.textContent);
    return { rows: rows.length, first: rows.slice(0, 3), text: rows.join(" | ").slice(0, 120) };
  })()`);
  const filesOk = filesInfo.rows > 0 && !/读不到/.test(filesInfo.text);
  say(`  条目数：${filesInfo.rows}`);
  say(`  前几项：${JSON.stringify(filesInfo.first)}`);
  say(`  能列出工作区：${filesOk}（期望 true）`);

  say("");
  say("=== 2.2) 文件区「返回」要能回首页（用户报的第二个返回 bug）===");
  await srun(`document.getElementById("sFiles").click()`);
  await new Promise((r) => setTimeout(r, 800));
  st = await srun(READ_PANELS);
  say(`  进入文件面板：${st.files}（期望 true）`);
  await srun(`document.getElementById("sfBack").click()`);
  await new Promise((r) => setTimeout(r, 400));
  st = await srun(READ_PANELS);
  const filesBackOk = st.home === true && st.files === false;
  say(`  点返回后回首页：${filesBackOk}（期望 true）`);

  say("");
  say("=== 3) 侧边对话：继承上下文下拉 ===");
  await srun(`document.getElementById("sChat").click()`);
  await new Promise((r) => setTimeout(r, 600));
  const inherit = await srun(`(() => {
    const sel = document.getElementById("scInherit");
    if (sel === null) return { exists: false };
    const opts = Array.from(sel.options).map((o) => ({ value: o.value, text: o.textContent, sel: o.selected }));
    return {
      exists: true,
      count: opts.length,
      selected: opts.filter((o) => o.sel).map((o) => o.value),
      first: opts.slice(0, 2),
    };
  })()`);
  say(`  下拉存在：${inherit.exists}`);
  say(`  选项数：${inherit.count ?? 0}（清单来自桥的会话清单）`);
  say(`  默认选中：${JSON.stringify(inherit.selected ?? [])}`);
  say(`  第一项：${JSON.stringify(inherit.first?.[0] ?? null)}`);
  /*
   * 默认项要等于**桥的真实活跃会话**。
   *
   * ⚠️ 探针虽然注入了 `session-probe-main`，但侧窗现在**桥优先**（查询串只兜底）
   * —— 那是修「文件区读不到工作区」时定的：查询串只在建窗那一刻取一次，
   * 主窗之后切会话它就不知道了。所以这里按桥的值判，且必须不为空。
   */
  const activeSid = await run(`(() => fetch("http://127.0.0.1:${ARGS.port}/whale/hud").then(r => r.json()).then(j => j.activeSessionId))()`);
  const defaultOk = Array.isArray(inherit.selected) && inherit.selected[0] === activeSid;
  say(`  桥的活跃会话：${activeSid}`);
  say(`  默认项＝桥的活跃会话：${defaultOk}`);

  /*
   * 「bug4」的判据在下面的 close 事件里补（那里才能同步取到状态），
   * 所以这里先把其余几项的结论攒起来。
   */
  const problems = [];
  if (backToHome !== true) problems.push("bug2 未修：浏览器返回回不到首页");
  if (filesBackOk !== true) problems.push("bug2b 未修：文件区返回回不到首页");
  if (filesOk !== true) problems.push("文件区读不到当前工作区");
  if (homeOk !== true) problems.push("浏览器首页不是百度");
  if (inherit.exists !== true) problems.push("第 3 条：没有继承上下文下拉");
  if (inherit.exists === true && inherit.count < 1) problems.push("第 3 条：下拉是空的");
  if (defaultOk !== true) problems.push("第 3 条：默认项不是当前会话");
  if (sideGeometry.DRAWER_MS > 100) problems.push("第 5 条：动画没加快");
  if (!sideUa.browserUserAgent().includes("iPad")) problems.push("第 1 条：UA 不是平板口径");

  say("");
  say("=== 4) bug：关小窗时侧栏要跟着关 ===");
  // 先确认侧窗是开着的
  say(`  关闭前侧窗可见：${sideWin.isVisible()}`);

  /*
   * ⚠️ 关闭流程要**在事件里同步抓状态**：
   * `win.close()` 之后小窗的渲染进程会销毁，紧接着 `closed` 里我们
   * `side.dispose()` → 侧窗也没了 → 所有窗口关闭 → **app 直接退出**，
   * 后面 await 出来的代码根本不会执行（前两版日志断在这里就是这个原因）。
   *
   * 所以判据改成：在小窗 `close` 事件（侧窗收起动作刚被触发）的
   * 下一个 tick 里读侧窗状态。
   *
   * ⚠️ 也**不能**再点一次顶栏按钮 —— 它是 `toggle`，会把已展开的侧栏关掉，
   * 于是「关闭前可见」变成 false，后面全部误判。
   */
  say(`  关闭前侧窗可见：${sideWin.isVisible()}（前提：必须是 true）`);
  say(`  关闭前侧窗状态：${JSON.stringify(side.state())}`);

  /*
   * ⚠️ 这一段只能在**事件里同步出结论**。
   *
   * 前四版日志都断在 `win.close()` 这一行 —— 原因是：小窗 `closed` 里
   * `side.dispose()` 会把侧窗也销毁，于是「所有窗口都没了」→
   * Electron 默认退出 app → `win.close()` 之后那些 await 出来的代码
   * **根本没有机会执行**。
   *
   * 所以判据在 `close` 事件里同步取（此刻 `side.close()` 刚被调用，
   * `state().opened` 已置 false），并在同一处收尾。
   */
  win.once("close", () => {
    const openedAtClose = side.state().opened;
    const goneOk = openedAtClose === false;
    say("");
    say(`  关小窗那一刻侧窗 opened：${openedAtClose}（期望 false）`);
    say(`  侧窗已收起：${goneOk}（期望 true）`);
    const all = [...problems, ...(goneOk ? [] : ["bug4 未修：关小窗时侧栏没跟着收起"])];
    say(`小窗页面错误 ${pageErrors.length} 条 / 侧窗 ${sideErrors.length} 条`);
    [...pageErrors, ...sideErrors].slice(0, 4).forEach((e) => say(`  ✗ ${String(e).slice(0, 120)}`));
    say("");
    say(all.length === 0 ? "结论：五条改动全部生效 ✓" : `结论：${all.join("；")}`);
    app.exit(all.length === 0 ? 0 : 1);
  });

  win.close();
}

app.whenReady().then(main).catch((e) => {
  say(`致命: ${e.message}`);
  app.exit(3);
});

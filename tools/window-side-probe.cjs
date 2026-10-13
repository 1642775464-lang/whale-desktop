/**
 * 右侧附带窗探针
 *
 * 职责：起真窗口，点顶栏「打开右侧边栏」，验证**真窗口**是否拉起、
 *       是否贴在小窗右侧、以及三个入口按钮是否可切换。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须真窗口：
 *   · 「拉出一个新窗口」是主进程行为，纯函数与契约测试都覆盖不到；
 *   · 「贴在小窗右侧」要读**真实窗口矩形**（含投影边距），猜不出来；
 *   · `<webview>` 是 Electron 专有元素，只在真渲染进程里存在。
 *
 * 纪律：只模拟用户动作（点按钮）+ 读真实窗口矩形/ DOM，
 * 不替产品建窗口、不注入状态。
 *
 * 用法：
 *   runtime\electron.exe --no-sandbox tools\window-side-probe.cjs --port 19387
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
const say = (m) => process.stdout.write(`[side-probe] ${m}\n`);

/** 小窗 bounds（含投影边距）。 */
const SHADOW_PAD = 16;

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

/** 等条件成立（带超时）。 */
async function waitFor(fn, ms, label) {
  const end = Date.now() + ms;
  let last = null;
  while (Date.now() < end) {
    last = await fn();
    if (last) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  say(`等待超时：${label}（最后 ${JSON.stringify(last)}）`);
  return false;
}

/** 从所有窗口里找出侧窗（不是小窗的那个）。 */
function findSide(mainId) {
  return BrowserWindow.getAllWindows().filter((w) => w.id !== mainId);
}

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

  /*
   * ⚠️ 通道**统一由 registerIpc 注册**（与产品同一条代码路径）。
   * 探针自己再 handle 一遍会撞车：Electron 不允许同一通道注册两个 handler
   * （实测报「Attempted to register a second handler for 'whale:ready'」）。
   */

  /*
   * ⚠️ 探针自己就是「主进程」，所以必须**替产品建侧窗**吗？不 ——
   * 那等于替产品实现。这里只注册通道，把 side 指向探针自己的最小实现，
   * 从而验证「通道通了、按钮接上了」这一段；
   * 真正的贴靠与动画由 side-window.cjs 的**单测**覆盖。
   */

  const sideGeometry = require(path.join(REPO_ROOT, "whale-window", "lib", "side-geometry.cjs"));
  const sideWindow = require(path.join(REPO_ROOT, "whale-window", "lib", "side-window.cjs"));
  const ipc = require(path.join(REPO_ROOT, "whale-window", "lib", "ipc.cjs"));

  /*
   * ⚠️ 装配顺序必须与 boot.cjs **一致**，否则探针会漏掉产品真实存在的环节。
   *
   * 踩过一次：探针先建侧窗、后建 ipc，且**没接 onJoinedChange**，
   * 于是「小窗右侧圆角没去掉」被判成失败 —— 而那是探针自己漏接的，
   * 不是产品的问题。用 ipcRef 延迟绑定，与 boot.cjs 同一套写法。
   */
  const ipcRef = { value: null };

  const side = sideWindow.createSideWindow({
    BrowserWindow,
    screen,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: ARGS.port,
    mainBounds: () => win.getBounds(),
    onJoinedChange: (joined) => {
      if (ipcRef.value !== null) ipcRef.value.notifyJoined(joined);
    },
  });

  const fakeStore = { flush: () => true, remember: () => {} };
  const registered = ipc.registerIpc({
    ipcMain,
    win: { bounds: () => win.getBounds(), contentSize: () => win.getContentSize(), win },
    store: fakeStore,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: ARGS.port,
    version: "probe",
    side,
  });
  ipcRef.value = registered;

  win.loadFile(path.join(REPO_ROOT, "whale-window", "renderer", "index.html"));
  const run = makeRun(win);

  const pageErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    if (level >= 2) pageErrors.push(message);
  });

  await waitFor(() => run(`typeof window.whale === "object"`), 15000, "preload 就绪");
  say(`小窗 bounds: ${JSON.stringify(win.getBounds())}`);

  say("");
  say("=== 1) 初始：没有侧窗 ===");
  say(`  窗口数：${BrowserWindow.getAllWindows().length}（期望 1）`);

  say("");
  say("=== 2) 点顶栏「打开右侧边栏」 ===");
  await run(`document.getElementById("btnSideRight").click()`);
  const appeared = await waitFor(() => findSide(win.id).length > 0, 5000, "侧窗出现");
  say(`  侧窗出现：${appeared}`);

  // 等展开动画结束（时长 + 余量）
  await new Promise((r) => setTimeout(r, sideGeometry.DRAWER_MS + 500));

  const sideWin = findSide(win.id)[0];
  let dockOk = false;
  if (sideWin !== undefined) {
    const mb = win.getBounds();
    const sb = sideWin.getBounds();
    const want = sideGeometry.dockedPosition(mb, mb.width, screen.getPrimaryDisplay().workArea);
    dockOk = Math.abs(sb.x - want.x) <= 2 && Math.abs(sb.y - want.y) <= 2;
    say(`  侧窗 bounds: ${JSON.stringify(sb)}`);
    say(`  期望贴靠  : ${JSON.stringify(want)}`);
    say(`  尺寸与小窗一致：宽 ${sb.width === mb.width}  高 ${sb.height === mb.height}`);
    say(`  贴上右侧：${dockOk}`);
    // 可见区相接：侧窗可见左缘 == 小窗可见右缘
    const mainRight = mb.x + SHADOW_PAD + (mb.width - SHADOW_PAD * 2);
    const sideLeft = sb.x + SHADOW_PAD;
    say(`  可见区相接：${Math.abs(mainRight - sideLeft) <= 2}（小窗右 ${mainRight} / 侧窗左 ${sideLeft}）`);
  }

  say("");
  say("=== 2.5) 中间的接缝与四周阴影 ===");
  let joinedInfo = null;
  if (sideWin !== undefined) {
    const mainSide = await run(`(() => {
      const box = document.getElementById("win");
      const cs = getComputedStyle(box);
      return { hasClass: box.classList.contains("side-joined"), radius: cs.borderTopRightRadius, shadow: cs.boxShadow };
    })()`);
    const sideSide = await sideWin.webContents.executeJavaScript(`(() => {
      const sw = document.getElementById("swin");
      const cs = getComputedStyle(sw);
      return {
        bodyJoined: document.body.classList.contains("joined"),
        radius: cs.borderTopLeftRadius,
        borderColor: cs.borderLeftColor,
        borderWidth: cs.borderLeftWidth,
        shadow: cs.boxShadow,
      };
    })()`, true);
    joinedInfo = { mainSide, sideSide };

    /*
     * 用户本轮定的三条判据：
     *   1. 相邻侧圆角为 0（否则中间有缝、像两个图层）；
     *   2. **中间要一条分割线** → 侧窗左边框保留可见颜色（不再是透明）；
     *   3. **整体四周阴影要保留** → 两侧都还有投影，但都**朝外**
     *      （小窗偏移为负、侧窗偏移为正），中间相接处不投、不叠影。
     */
    say(`  小窗  右侧圆角：${mainSide.radius}（期望 0px）`);
    say(`  小窗  阴影    ：${mainSide.shadow === "none" ? "无" : mainSide.shadow.slice(0, 46)}（期望 有且朝左）`);
    say(`  侧窗  左侧圆角：${sideSide.radius}（期望 0px）`);
    say(`  侧窗  左边框  ：${sideSide.borderWidth} ${sideSide.borderColor}（期望 1px 且不透明＝分割线）`);
    say(`  侧窗  阴影    ：${sideSide.shadow === "none" ? "无" : sideSide.shadow.slice(0, 46)}（期望 有且朝右）`);
  }

  say("");
  say("=== 3) 侧窗页面：三个入口按钮 ===");
  let btnInfo = null;
  if (sideWin !== undefined) {
    btnInfo = await sideWin.webContents.executeJavaScript(`(() => {
      const ids = ["sBrowser", "sFiles", "sChat"];
      const shown = (el) => el !== null && getComputedStyle(el).display !== "none";
      return {
        homeVisible: shown(document.getElementById("sHome")),
        buttons: ids.map((id) => {
          const b = document.getElementById(id);
          return b === null ? null : { id, visible: shown(b), text: b.textContent.trim().slice(0, 20) };
        }),
        webviewTagPresent: document.getElementById("sbWeb") !== null,
        panelsHidden: ["pBrowser","pFiles","pChat"].map((id) => {
          const el = document.getElementById(id);
          return el === null ? null : !shown(el);
        }),
      };
    })()`, true);
    say(`  首页可见：${btnInfo.homeVisible}`);
    for (const b of btnInfo.buttons) say(`    - ${b === null ? "(缺)" : `${b.id} 可见=${b.visible} "${b.text}"`}`);
    say(`  webview 元素存在：${btnInfo.webviewTagPresent}`);
    say(`  三个面板初始都隐藏：${JSON.stringify(btnInfo.panelsHidden)}`);
  }

  say("");
  say("=== 4) 点「文件」入口 → 切到文件面板 ===");
  let panelOk = null;
  if (sideWin !== undefined) {
    await sideWin.webContents.executeJavaScript(`document.getElementById("sFiles").click()`, true);
    await new Promise((r) => setTimeout(r, 1200));
    panelOk = await sideWin.webContents.executeJavaScript(`(() => {
      const shown = (el) => el !== null && getComputedStyle(el).display !== "none";
      return {
        homeHidden: !shown(document.getElementById("sHome")),
        filesShown: shown(document.getElementById("pFiles")),
        title: document.getElementById("sbTitle").textContent,
      };
    })()`, true);
    say(`  首页已隐藏：${panelOk.homeHidden}`);
    say(`  文件面板显示：${panelOk.filesShown}`);
    say(`  顶栏标题：${panelOk.title}`);
  }

  say("");
  say("=== 5) 点侧窗 × → 收起 ===");
  let closedOk = null;
  let restoredOk = null;
  if (sideWin !== undefined) {
    await sideWin.webContents.executeJavaScript(`document.getElementById("sClose").click()`, true);
    await new Promise((r) => setTimeout(r, sideGeometry.DRAWER_MS + 600));
    closedOk = !sideWin.isVisible();
    say(`  侧窗已隐藏：${closedOk}`);

    // 收完小窗右侧的圆角/阴影必须**还回来**，否则小窗右上角是缺的
    restoredOk = await run(`(() => {
      const box = document.getElementById("win");
      return {
        hasClass: box.classList.contains("side-joined"),
        radius: getComputedStyle(box).borderTopRightRadius,
      };
    })()`);
    say(`  收起后小窗右侧圆角：${restoredOk.radius}（期望 18px，即已恢复）`);
    say(`  连体类已移除：${!restoredOk.hasClass}`);
  }

  say("");
  const problems = [];
  if (!appeared) problems.push("点按钮没有拉起侧窗");
  if (sideWin !== undefined && dockOk !== true) problems.push("侧窗没贴在小窗右侧");
  if (btnInfo !== null && btnInfo.buttons.some((b) => b === null || b.visible !== true)) {
    problems.push("三个入口按钮没都显示");
  }
  if (panelOk !== null && (panelOk.filesShown !== true || panelOk.homeHidden !== true)) {
    problems.push("点「文件」没有切到文件面板");
  }
  if (joinedInfo !== null) {
    /*
     * 本轮三条要求（用户明确）：
     *   1. 整体四周阴影要保留；
     *   2. 中间要一条分割线；
     *   3. 相邻侧不要各自的圆角与朝内的投影。
     */
    if (joinedInfo.mainSide.radius !== "0px") problems.push("小窗右侧圆角没去掉（中间会有一条缝）");
    if (joinedInfo.sideSide.radius !== "0px") problems.push("侧窗左侧圆角没去掉");
    // 中间的分割线：侧窗左边框必须还在且有可见颜色
    if (joinedInfo.sideSide.borderWidth !== "1px") problems.push("中间的分割线没了（边框宽度不是 1px）");
    if (joinedInfo.sideSide.borderColor === "rgba(0, 0, 0, 0)") problems.push("中间的分割线被设成透明了");
    // 四周阴影要保留：两侧都得还有投影
    if (joinedInfo.mainSide.shadow === "none") problems.push("小窗阴影被去干净了（用户要求整体四周阴影保留）");
    if (joinedInfo.sideSide.shadow === "none") problems.push("侧窗阴影被去干净了（用户要求整体四周阴影保留）");
    /*
     * 且必须是**朝外**投：小窗朝左（首个偏移为负）、侧窗朝右（为正）。
     * ⚠️ computed style 里每层的写法是「颜色 偏移X 偏移Y 模糊 扩散」，
     * 颜色在前，所以不能用 startsWith 判偏移，要按「颜色 + 偏移」整段找。
     */
    if (!joinedInfo.mainSide.shadow.includes(" -8px 0px 24px")) {
      problems.push("小窗阴影不是朝左投的（中间可能叠影）");
    }
    if (!joinedInfo.sideSide.shadow.includes(" 8px 0px 24px")) {
      problems.push("侧窗阴影不是朝右投的（中间可能叠影）");
    }
  }
  if (closedOk === false) problems.push("点 × 没有收起侧窗");
  if (restoredOk !== null && restoredOk.hasClass) problems.push("收起后小窗还留着连体类（圆角回不来）");

  say(`小窗页面错误 ${pageErrors.length} 条：`);
  pageErrors.slice(0, 4).forEach((e) => say(`  ✗ ${String(e).slice(0, 120)}`));
  say("");
  say(problems.length === 0 ? "结论：右侧附带窗正常 ✓" : `结论：${problems.join("；")}`);
  app.exit(problems.length === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  say(`致命: ${e.message}`);
  app.exit(3);
});

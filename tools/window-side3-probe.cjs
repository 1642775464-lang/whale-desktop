/**
 * 侧边栏外观与滚动探针
 *
 * 职责：量**真实渲染结果** —— 顶栏高度是否对齐、输入框是否等高、
 *       滚动条是否真的不占位、浏览器是否按平板版渲染（附截图）。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须真窗口量：这些全是**布局结果**（flex 收缩、滚动条占位、
 * 字号行高相乘的高度），CSS 文本能读出来的只有「写了什么值」，
 * 读不出「实际渲染成多少」。用户报的恰恰都是「看着不一致」。
 *
 * 用法：runtime\electron.exe --no-sandbox tools\window-side3-probe.cjs --port 19387
 */

"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..");
const ARGS = (() => {
  const a = process.argv.slice(2);
  const i = a.indexOf("--port");
  return { port: i === -1 ? 19387 : Number(a[i + 1]) };
})();
const say = (m) => process.stdout.write(`[side3] ${m}\n`);

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
  const sideWindow = require(path.join(REPO_ROOT, "whale-window", "lib", "side-window.cjs"));
  const ipc = require(path.join(REPO_ROOT, "whale-window", "lib", "ipc.cjs"));
  const sideUa = require(path.join(REPO_ROOT, "whale-window", "lib", "side-ua.cjs"));

  const ipcRef = { value: null };
  const side = sideWindow.createSideWindow({
    BrowserWindow, screen,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: ARGS.port,
    mainBounds: () => win.getBounds(),
    userAgent: sideUa.browserUserAgent(),
    onJoinedChange: () => {},
  });
  ipcRef.value = ipc.registerIpc({
    ipcMain,
    win: { bounds: () => win.getBounds(), contentSize: () => win.getContentSize(), win },
    store: { flush: () => true, remember: () => {} },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: ARGS.port, version: "probe", side,
  });

  win.loadFile(path.join(REPO_ROOT, "whale-window", "renderer", "index.html"));
  await new Promise((r) => setTimeout(r, 2500));

  say("=== ① 小窗侧的度量 ===");
  const main = await win.webContents.executeJavaScript(`(() => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { h: Math.round(b.height), w: Math.round(b.width) }; };
    const scrollable = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 2 && getComputedStyle(e).overflowY !== "visible");
    return {
      topbar: box(".topbar"),
      composer: box(".composer"),
      // ② 顶栏右上角那个图标应当已去掉
      hasMenuIcon: document.getElementById("btnMenu") !== null,
      // ⑤ 权限标签：真值未到时应是占位「—」，不能是编造的档位
      permText: document.getElementById("btnPerm").textContent,
      // 滚动条占位 = 元素自身宽 - 内容可视宽
      scrollbarGaps: scrollable.slice(0, 6).map((e) => ({
        cls: String(e.className).slice(0, 24),
        gap: e.offsetWidth - e.clientWidth,
      })),
    };
  })()`, true);
  say(`  顶栏高：${main.topbar?.h}px`);
  const iconOk = main.hasMenuIcon === false;
  say(`  ② 右上角图标已去掉：${iconOk}（btnMenu 不存在）`);
  /*
   * ⚠️ 权限标签：这里**不断言必须是某个档位** —— 真值来自宿主，
   * 探针不替宿主做主。只断言它不是「编造的具体档位」：
   * 要么是占位「—」，要么是认识的档位文案之一。
   */
  const KNOWN = ["—", "仅可查看", "工作区内修改", "完全权限", "自动", "auto", "read-only", "workspace-write", "danger-full-access"];
  const permOk = KNOWN.includes(String(main.permText).trim());
  say(`  ⑤ 权限标签「${main.permText}」不是编造值：${permOk}`);
  say(`  输入区高：${main.composer?.h}px`);
  for (const s of main.scrollbarGaps) say(`  可滚动元素 ${s.cls}：滚动条占宽 ${s.gap}px`);

  win.webContents.executeJavaScript(`document.getElementById("btnSideRight").click()`, true);
  await new Promise((r) => setTimeout(r, 1500));
  const sideWin = BrowserWindow.getAllWindows().find((w) => w.id !== win.id);
  if (sideWin === undefined) { say("侧窗没建起来"); app.exit(2); return; }
  const srun = (expr) => sideWin.webContents.executeJavaScript(expr, true);

  say("");
  say("=== ① 侧窗顶栏高度 ===");
  const sbar = await srun(`(() => { const e = document.querySelector(".sbar"); const b = e.getBoundingClientRect(); return Math.round(b.height); })()`);
  const topAligned = Math.abs(sbar - main.topbar.h) <= 1;
  say(`  侧窗顶栏：${sbar}px  小窗顶栏：${main.topbar.h}px`);
  say(`  对齐：${topAligned}（期望 true）`);

  say("");
  say("=== ② 侧边对话的输入区高度 ===");
  await srun(`document.getElementById("sChat").click()`);
  await new Promise((r) => setTimeout(r, 1200));
  const chat = await srun(`(() => {
    const box = (sel) => { const e = document.querySelector(sel); if (!e) return null; const b = e.getBoundingClientRect(); return { h: Math.round(b.height) }; };
    return { compose: box(".sc-compose"), input: box(".sc-input"), fs: getComputedStyle(document.getElementById("scInput")).fontSize };
  })()`);
  say(`  侧窗输入区高：${chat.compose?.h}px（小窗整块 ${main.composer?.h}px）`);
  say(`  侧窗输入框高：${chat.input?.h}px  字号 ${chat.fs}`);
  /*
   * ⚠️ 判据是**输入控件**的高度，不是整块输入区：
   * 主窗那块 168px 里含着工具条、状态条与多行输入，侧窗只有单行 ——
   * 拿整块比永远不可能相等，那不是用户要的「一致」。
   * 用户要的是「输入框看起来一样大」，所以看 `.sc-input` 的高度
   * 是否落在主窗输入框那个量级（约 44px，容差 ±10）。
   */
  const inputH = chat.input?.h ?? 0;
  const composeOk = inputH >= 34 && inputH <= 54;
  say(`  输入框高度在设计量级内（34–54px）：${composeOk}`);

  say("");
  say("=== ⑤ 滚动条是否还占位 ===");
  const sideScroll = await srun(`(() => {
    const scrollable = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 2 && getComputedStyle(e).overflowY !== "visible");
    return scrollable.slice(0, 8).map((e) => ({ cls: String(e.className).slice(0, 24), gap: e.offsetWidth - e.clientWidth }));
  })()`);
  const allZeroSide = sideScroll.every((s) => s.gap === 0);
  for (const s of sideScroll) say(`  可滚动元素 ${s.cls}：占宽 ${s.gap}px`);
  const allZeroMain = main.scrollbarGaps.every((s) => s.gap === 0);
  say(`  小窗全部不占位：${allZeroMain}   侧窗全部不占位：${allZeroSide}`);

  say("");
  say("=== ④ 浏览器渲染（截图复核）===");
  await srun(`document.getElementById("sBrowser").click()`);
  await new Promise((r) => setTimeout(r, 6000));
  /*
   * ⚠️ 判据必须换成「站点给的是哪一版」，不能只看「有没有被缩放」。
   *
   * 上一轮我用「视口宽 == 元素宽」判定「没被缩放」并据此说「已修好」，
   * 但用户**仍然看到桌面版缩小图** —— 因为那个判据只能证明**没有缩放**，
   * 证明不了**站点返回的是哪一版布局**。实测（iPad UA 打开百度）：
   *   视口 526 == 元素 526（没被缩放），但页面无 viewport meta、字号 12px
   *   → 站点给的就是桌面版。
   *
   * 所以这里看两件事：
   *   1. 页面有没有响应式 viewport meta（站点按窄屏出布局才会带）；
   *   2. 正文字号是否达到手机版量级（≥14px；桌面版是 12px）。
   */
  const webInfo = await srun(`(async () => {
    const wv = document.getElementById("sbWeb");
    const r = await wv.executeJavaScript("JSON.stringify({ua: navigator.userAgent, vw: innerWidth, cw: document.documentElement.clientWidth, sw: document.documentElement.scrollWidth, meta: (function(){var t=document.querySelector('meta[name=viewport]');return t?t.getAttribute('content'):null;})(), fs: document.body?getComputedStyle(document.body).fontSize:null})");
    const j = JSON.parse(r);
    return { ...j, box: (() => { const b = wv.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height) }; })() };
  })()`);
  const uaOk = /iPhone|Android/.test(webInfo.ua) && /Mobile/.test(webInfo.ua);
  const hasMeta = webInfo.meta !== null && /width=device-width/.test(webInfo.meta);
  const fsPx = parseFloat(String(webInfo.fs ?? "0"));
  const fsOk = fsPx >= 14;
  const overflowOk = webInfo.sw - webInfo.cw <= 2;

  say(`  webview UA：${String(webInfo.ua).slice(0, 52)}…`);
  say(`  含移动端特征：${uaOk}`);
  say(`  响应式 viewport meta：${hasMeta}（${webInfo.meta ?? "无"}）`);
  say(`  正文字号：${webInfo.fs}（手机版应 ≥14px）→ ${fsOk}`);
  say(`  横向溢出：${webInfo.sw - webInfo.cw}px`);

  /*
   * 网页**内部**的滚动条也要消失（用户追加：「浏览器也的滚动条也不需要」）。
   *
   * ⚠️ webview 里是另一个独立文档，侧窗 CSS 那条管不到它 ——
   * 必须靠注入到 webview 内部的样式。这里直接量网页自己的
   * `innerWidth - clientWidth`（>0 就是还有滚动条占位）。
   */
  const innerGap = webInfo.vw - webInfo.cw;
  const innerBarOk = innerGap <= 1;
  say(`  网页内部滚动条占位：${innerGap}px → ${innerBarOk ? "已去掉" : "还在"}`);

  /*
   * ⚠️ **导航之后**再测一次 —— 这才是这次修的核心。
   *
   * `insertCSS` 注入的样式**跟着文档走**：只在 webview 附加那一刻注入，
   * 很可能落在旧文档（about:blank）上，一旦导航到目标页就失效
   * （用户两次报「滚动条还在」）。修法改成每次 `dom-ready` 都注入。
   * 所以只测初始加载**不够** —— 必须换个页面，看注入是否跟着走。
   */
  await srun(`(() => { const wv = document.getElementById("sbWeb"); wv.loadURL("https://www.baidu.com/s?wd=test"); })()`);
  await new Promise((r) => setTimeout(r, 8000));
  const afterNav = await srun(`(async () => {
    const wv = document.getElementById("sbWeb");
    const r = await wv.executeJavaScript("JSON.stringify({vw: innerWidth, cw: document.documentElement.clientWidth, url: location.href})");
    return JSON.parse(r);
  })()`);
  const navGap = afterNav.vw - afterNav.cw;
  const navBarOk = navGap <= 1;
  say(`  导航后滚动条占位：${navGap}px → ${navBarOk ? "仍已去掉" : "又出现了（注入没跟着导航走）"}`);

  try {
    const img = await sideWin.webContents.capturePage();
    const out = path.join(REPO_ROOT, "tmp-side3-shot.png");
    fs.writeFileSync(out, img.toPNG());
    say(`  截图：${out}`);
  } catch (e) {
    say(`  截图失败：${e.message}`);
  }

  say("");
  const problems = [];
  if (!iconOk) problems.push("② 右上角图标还在");
  if (!composeOk) problems.push("② 输入框高度不在设计量级内");
  if (!permOk) problems.push("⑤ 权限标签是编造值");
  if (!allZeroMain || !allZeroSide) problems.push("⑤ 还有滚动条占位");
  if (!uaOk) problems.push("④ webview UA 不是移动端口径");
  if (!hasMeta) problems.push("④ 站点没返回响应式布局（大概率还是桌面版）");
  if (!fsOk) problems.push(`④ 正文字号只有 ${webInfo.fs}，是桌面版特征`);
  if (!overflowOk) problems.push("④ 页面横向溢出");
  if (!innerBarOk) problems.push("④ 网页内部还有滚动条（注入没生效）");
  if (!navBarOk) problems.push("④ 导航后网页滚动条又出现（注入没跟着导航走）");

  say(problems.length === 0 ? "结论：外观与滚动全部正常 ✓" : `结论：${problems.join("；")}`);
  app.exit(problems.length === 0 ? 0 : 1);
}

app.whenReady().then(main).catch((e) => {
  say(`致命: ${e.message}`);
  app.exit(3);
});

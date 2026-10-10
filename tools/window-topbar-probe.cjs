/**
 * 顶栏布局与图标探针
 *
 * 职责：起真窗口，把顶栏的**实际结构、顺序、每个图标的渲染结果**读出来。
 *       所属层：工程工具（tools/）
 *
 * 为什么要单独一个探针（而不是只跑契约测试）：
 *   契约测试扫的是 HTML 源码 —— 它能证明「元素写在文件里」，
 *   但证明不了「图标真的画出来了」。SVG 在真窗口里可能因为
 *   尺寸为 0、被裁、path 为空而**看起来什么都没画**，
 *   而源码一个字都没错。这类问题只能靠真窗口取证。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-topbar-probe.cjs --port 19387
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

const say = (m) => process.stdout.write(`[topbar-probe] ${m}\n`);

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

  await waitFor(run, "document.querySelector('.topbar') !== null", 8000, "顶栏出现");

  const report = await run(`
    (function () {
      const bar = document.querySelector(".topbar");
      const kids = Array.from(bar.children).map(function (c) {
        return { id: c.id || null, cls: c.className || null, tag: c.tagName };
      });

      const inspect = function (id) {
        const el = document.getElementById(id);
        if (el === null) return { id: id, exists: false };
        const svg = el.querySelector("svg");
        const paths = svg ? Array.from(svg.querySelectorAll("path")) : [];
        const box = svg ? svg.getBoundingClientRect() : null;
        return {
          id: id,
          exists: true,
          visible: el.offsetWidth > 0 && el.offsetHeight > 0,
          hasSvg: svg !== null,
          pathCount: paths.length,
          allPathsHaveD: paths.every(function (p) { return (p.getAttribute("d") || "").length > 0; }),
          svgSize: box ? Math.round(box.width) + "x" + Math.round(box.height) : null,
          stroke: svg ? (svg.getAttribute("stroke") || "") : null,
        };
      };

      return {
        kids: kids,
        icons: [
          inspect("btnSideLeft"),
          inspect("btnFolder"),
          inspect("btnSideRight"),
          inspect("btnMenu"),
          inspect("btnPin"),
        ],
        titleText: document.getElementById("tbTitle").textContent,
        titleFlex: getComputedStyle(document.getElementById("tbTitle")).flex,
      };
    })()
  `);

  say(`顶栏子元素顺序（${report.kids.length} 个）：`);
  for (const k of report.kids) say(`  ${k.id ?? k.cls ?? k.tag}`);
  say("");
  say("图标渲染结果：");
  const problems = [];
  for (const ic of report.icons) {
    if (ic.exists !== true) { problems.push(`${ic.id} 不存在`); say(`  ${ic.id}: 不存在 ✗`); continue; }
    const ok = ic.visible && ic.hasSvg && ic.pathCount > 0 && ic.allPathsHaveD
      && ic.svgSize !== "0x0" && ic.stroke === "currentColor";
    if (!ok) problems.push(`${ic.id} 渲染异常`);
    say(`  ${ic.id}: 可见=${ic.visible} path=${ic.pathCount} d齐全=${ic.allPathsHaveD} 尺寸=${ic.svgSize} stroke=${ic.stroke} ${ok ? "✓" : "✗"}`);
  }
  say("");
  say(`标题文案：${JSON.stringify(report.titleText)}（flex=${report.titleFlex}）`);

  // 顺序校验（用户明确的布局要求）
  const want = ["btnMin", "btnPin", "btnSideLeft", null, "tbTitle", "btnFolder", "btnSideRight", "btnMenu"];
  const got = report.kids.map((k) => k.id);
  const orderOk = JSON.stringify(got) === JSON.stringify(want);
  if (!orderOk) problems.push(`顶栏顺序不符：${JSON.stringify(got)}`);
  const verdict = orderOk ? "✓" : `✗ 期望 ${JSON.stringify(want)}`;
  say(`顶栏顺序：${verdict}`);

  say("");
  say(problems.length === 0 ? "结论：顶栏结构与三个新图标都正常 ✓" : `结论：${problems.join("；")}`);
  if (pageErrors.length > 0) {
    say(`页面报错 ${pageErrors.length} 条：`);
    for (const e of pageErrors.slice(0, 6)) say(`  ✗ ${e}`);
  }
  app.exit(problems.length === 0 && pageErrors.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`探针出错：${e && e.message}`); app.exit(9); });

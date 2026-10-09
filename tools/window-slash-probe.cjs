/**
 * 第二轮诊断：插入指令后，斜杠面板是否应该打开？
 *
 * 主窗口里键入 `/` 会弹出候选面板。小窗的 palette（F7）也监听 input 的
 * `input` 事件。若 insertIntoInput 只改 value、不发事件，面板就不会开。
 */
"use strict";

const { app, BrowserWindow, screen } = require("electron");
const path = require("node:path");

const REPO_ROOT = path.resolve(__dirname, "..");
const ARGS = (() => {
  const a = process.argv.slice(2);
  const i = a.indexOf("--port");
  return { port: i === -1 ? 19387 : Number(a[i + 1]) };
})();

const say = (m) => process.stdout.write(`[probe2] ${m}\n`);

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
  win.loadFile(path.join(REPO_ROOT, "whale-window", "renderer", "index.html"));
  const run = makeRun(win);

  await waitFor(run, "typeof window.WhalePalette === 'object'", 8000, "页面装配");

  // 基线：手打 /compact（经真实 input 事件），面板会不会开？
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.value = "/comp";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  const typed = await run(`
    (function () {
      const p = document.getElementById("slashPanel");
      return { hidden: p.hidden, rows: document.querySelectorAll("#slashList *").length };
    })()
  `);
  say(`手打 "/comp" 后斜杠面板：${JSON.stringify(typed)}`);

  // 清空
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.value = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 300));

  // 对照：走＋菜单点击（内部调 insertIntoInput），面板会不会开？
  await run("document.getElementById('btnAdd').click()");
  await waitFor(run, "document.querySelectorAll('#ovBody .ov-row').length > 0", 8000, "菜单行");
  await run(`
    (function () {
      const rows = Array.from(document.querySelectorAll("#ovBody .ov-row"));
      const r = rows.find(function (x) { return x.textContent.indexOf("压缩") === 0; });
      r.click();
    })()
  `);
  await new Promise((r) => setTimeout(r, 500));
  const viaMenu = await run(`
    (function () {
      const p = document.getElementById("slashPanel");
      return {
        val: document.getElementById("input").value,
        hidden: p.hidden,
        rows: document.querySelectorAll("#slashList *").length,
      };
    })()
  `);
  say(`点＋菜单「压缩」后：${JSON.stringify(viaMenu)}`);

  say(`对照结论：手打会开面板=${typed.hidden === false}；走＋菜单会开=${viaMenu.hidden === false}`);
  app.exit(0);
}

main().catch((e) => { say(`探针出错：${e && e.message}`); app.exit(9); });

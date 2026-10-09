/**
 * 小窗 ＋菜单点击诊断
 *
 * 职责：起一个真小窗窗口，真点开＋菜单、真点某一行，把 `#input` 的 value
 *       读出来 —— 验证「点击是否真的把内容放进输入框」。
 * 所属层：工程工具（tools/）
 *
 * 为什么要这个：单元测试证明的是「点击会调用 insertIntoInput 并传入 /compact」，
 * 那是**替身层**的结论。用户报「点了没用、输入框里不出现」——
 * 这类断口只能靠真窗口读真 value 定位，读代码分不出来。
 *
 * 纪律：探针只观察与点击，不替产品做任何事（不改 state、不调内部函数）。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-add-probe.cjs --port 19387
 */

"use strict";

const { app, BrowserWindow, screen } = require("electron");
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

const ARGS = parseArgs(process.argv.slice(2));

/** 日志：探针必须能自己说清每一步。 */
function say(msg) {
  process.stdout.write(`[add-probe] ${msg}\n`);
}

/**
 * 在页面里执行一段表达式，带超时。
 *
 * 无文档时 executeJavaScript 会永久挂住，只报 timeout 看不出真因，
 * 所以这里显式超时并给出「页面可能没加载」的提示。
 */
function makeRun(win) {
  return function run(expr, ms = 8000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("executeJavaScript 超时（页面可能没有加载）"));
      }, ms);
      win.webContents
        .executeJavaScript(expr, true)
        .then((v) => { clearTimeout(timer); resolve(v); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  };
}

/** 等待窗口内出现某个条件。 */
async function waitFor(run, expr, ms, label) {
  const deadline = Date.now() + ms;
  let last = null;
  while (Date.now() < deadline) {
    last = await run(expr);
    if (last) return true;
    await new Promise((r) => setTimeout(r, 120));
  }
  say(`等待超时：${label}（最后取值 ${JSON.stringify(last)}）`);
  return false;
}

async function main() {
  await app.whenReady();

  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  const win = new BrowserWindow({
    width: 560,
    height: 760,
    x: Math.max(0, sw - 700),
    y: Math.max(0, sh - 820),
    show: true,
    frame: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(REPO_ROOT, "whale-window", "preload.cjs"),
      additionalArguments: [`--whale-bridge-port=${ARGS.port}`],
    },
  });

  win.loadFile(path.join(REPO_ROOT, "whale-window", "renderer", "index.html"));

  const run = makeRun(win);

  // 等页面装配完成（＋键必须已经绑好）
  const ready = await waitFor(
    run,
    "typeof window.WhaleAddMenu === 'object' && document.getElementById('btnAdd') !== null",
    8000,
    "页面装配",
  );
  if (!ready) { app.exit(2); return; }

  // 打开＋菜单（真点按钮）
  await run("document.getElementById('btnAdd').click()");
  const opened = await waitFor(
    run,
    "document.getElementById('ovTitle').textContent === '添加'",
    6000,
    "＋菜单打开",
  );
  if (!opened) { app.exit(3); return; }

  /*
   * ⚠️ 菜单行是**异步**追加的：renderAdd 里要先 await clientOf().listCommands()
   * 才能拿到宿主命令表，在那之前 ovBody 里只有同步渲染的拖拽区。
   * 所以必须等「出现了菜单行」再读，否则会误判成「菜单没渲染」。
   */
  const hasRows = await waitFor(
    run,
    "document.querySelectorAll('#ovBody .ov-row').length > 0",
    8000,
    "菜单行渲染",
  );
  if (!hasRows) { say("＋菜单一行都没渲染出来（不是异步等待问题）"); app.exit(4); return; }

  // 读出菜单行，看分组与行序
  const rows = await run(`
    (function () {
      const body = document.getElementById("ovBody");
      return Array.from(body.children).map(function (c, i) {
        return { i: i, cls: c.className, txt: c.textContent.slice(0, 40) };
      });
    })()
  `);
  say(`＋菜单子节点数：${rows.length}`);
  for (const r of rows) say(`  [${r.i}] ${r.cls} :: ${r.txt}`);

  // 点击前先记录输入框内容
  const before = await run("document.getElementById('input').value");
  say(`点击前 input.value = ${JSON.stringify(before)}`);

  // 找「压缩」行并真点击（用它的文字定位，不写死下标）
  const clicked = await run(`
    (function () {
      const body = document.getElementById("ovBody");
      const row = Array.from(body.children).find(function (c) {
        return c.className.indexOf("ov-row") === 0 && c.textContent.indexOf("压缩") === 0;
      });
      if (!row) return "找不到「压缩」行";
      row.click();
      return "ok";
    })()
  `);
  say(`点击「压缩」：${clicked}`);

  await new Promise((r) => setTimeout(r, 400));

  const after = await run("document.getElementById('input').value");
  say(`点击后 input.value = ${JSON.stringify(after)}`);

  // 再看一眼斜杠面板有没有被打开（它可能是把 value 吃掉的元凶）
  const slash = await run(`
    (function () {
      const p = document.getElementById("slashPanel");
      return { hidden: p === null ? "(无此元素)" : p.hidden, val: document.getElementById("input").value };
    })()
  `);
  say(`斜杠面板状态：${JSON.stringify(slash)}`);

  if (after === before) {
    say("结论：点击没有改变输入框 —— 用户报的现象复现了");
    app.exit(1);
    return;
  }
  if (after.indexOf("/compact") === -1) {
    say(`结论：输入框变了但内容不对（期望含 /compact，实得 ${JSON.stringify(after)}）`);
    app.exit(1);
    return;
  }
  say("结论：点击指令后输入框里出现了 /compact —— 行为正确");
  app.exit(0);
}

main().catch((err) => {
  say(`探针自身出错：${err && err.message}`);
  app.exit(9);
});

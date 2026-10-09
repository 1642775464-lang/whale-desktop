/**
 * ＋菜单点击是否会「直接把指令发出去」的诊断
 *
 * 职责：起真窗口，点一条指令，然后**观察消息流**有没有多出一条 ——
 *       用户报「选择某个指令就直接被发送出去了」。
 * 所属层：工程工具（tools/）
 *
 * 为什么不能靠读代码判断：插入路径改了之后，焦点、光标、keydown 的
 * 相互关系只有真浏览器说了算。必须看「消息流里到底有没有多一条」。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-send-probe.cjs --port 19387
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

const say = (m) => process.stdout.write(`[send-probe] ${m}\n`);

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

/** 消息流里有多少条（发送成功就会多出来）。 */
const STREAM_EXPR = `
  (function () {
    const s = document.getElementById("stream");
    return { count: s ? s.children.length : -1, text: s ? s.innerText.slice(-160) : "" };
  })()
`;

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
  ipcMain.handle("whale:log", (_e, msg) => { say(`  (页面日志) ${msg}`); });

  win.loadFile(path.join(REPO_ROOT, "whale-window", "renderer", "index.html"));
  const run = makeRun(win);

  const pageErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    pageErrors.push(`[L${level}] ${message}`);
  });

  await waitFor(run, "typeof window.WhaleAddMenu === 'object'", 8000, "页面装配");
  await new Promise((r) => setTimeout(r, 1200)); // 等 client.refresh 拿到会话

  /*
   * 装一个「发送计数」。
   *
   * 直接往桥上打一个真消息会污染用户的会话，所以这里拦在客户端：
   * 把 send 换掉，只数调用次数。**这是观察，不是替产品干活** ——
   * 产品的 onSubmit 会照常走到这里，我们只是记账。
   */
  await run(`
    (function () {
      window.__probeSendCalls = [];
      window.__probeExecCalls = [];
      const realFetch = window.fetch;
      window.fetch = function (url, opts) {
        const u = String(url);
        const m = (opts && opts.method) || "GET";
        const post = m.toUpperCase() === "POST";
        if (post && u.indexOf("/whale/send") !== -1) {
          window.__probeSendCalls.push(opts && opts.body ? String(opts.body).slice(0, 120) : "");
        }
        if (post && u.indexOf("/whale/command") !== -1) {
          window.__probeExecCalls.push(opts && opts.body ? String(opts.body).slice(0, 120) : "");
        }
        return realFetch.apply(this, arguments);
      };
      return true;
    })()
  `);

  const before = await run(STREAM_EXPR);
  say(`点击前：消息流 ${before.count} 条`);

  // ── 路径 1：点＋菜单里的「btw」 ─────────────────────────────
  await run("document.getElementById('btnAdd').click()");
  await waitFor(run, "document.querySelectorAll('#ovBody .ov-row').length > 0", 8000, "菜单行");
  const clicked = await run(`
    (function () {
      const rows = Array.from(document.querySelectorAll("#ovBody .ov-row"));
      const r = rows.find(function (x) { return x.textContent.indexOf("btw") === 0; });
      if (!r) return "找不到";
      r.click();
      return "ok";
    })()
  `);
  await new Promise((r) => setTimeout(r, 900));

  const sends = await run("window.__probeSendCalls");
  const after = await run(STREAM_EXPR);
  const input = await run(`
    (function () {
      const i = document.getElementById("input");
      return { text: i.innerText, token: i.querySelector("[data-token]") ? "有" : "无" };
    })()
  `);

  say(`路径1 点＋菜单「btw」：${clicked}`);
  say(`  输入框内容：${JSON.stringify(input.text)}（染色 ${input.token}）`);
  say(`  发送调用：${sends.length} 次 ${sends.length > 0 ? JSON.stringify(sends) : ""}`);
  say(`  消息流：${after.count} 条（+${after.count - before.count}）`);
  const path1Bad = sends.length > 0 || after.count > before.count;

  /*
   * ── 路径 2：手打 `/` 弹出斜杠面板，再按 Enter ────────────
   *
   * 这条是「指令被直接发出去」最可能的来源：面板开着时 Enter 会选中
   * 第一条命令并**直接执行**（F7 的设计）。用户可能把它感受成「被发送了」。
   * 这里要如实区分：「执行命令」与「把文字当消息发出去」是两件事。
   */
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.innerHTML = "";
      i.appendChild(document.createTextNode("/"));
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 700));

  const panelOpen = await run(`
    (function () {
      const p = document.getElementById("slashPanel");
      return p ? !p.hidden : null;
    })()
  `);
  say(`路径2 手打 "/" 后面板：${panelOpen ? "打开" : "关闭"}`);

  const beforeEnter = await run("window.__probeSendCalls.length");
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 900));
  const afterEnter = await run("window.__probeSendCalls");
  const after2 = await run(STREAM_EXPR);
  const input2 = await run("document.getElementById('input').innerText");

  say(`路径2 按 Enter：发送调用 ${afterEnter.length - beforeEnter} 次`);
  say(`  输入框内容：${JSON.stringify(input2)}`);
  say(`  消息流：${after2.count} 条（+${after2.count - after.count}）`);
  const path2Bad = afterEnter.length > beforeEnter || after2.count > after.count;

  /*
   * ── 路径 3：手打 `/` 弹出面板，**点**需要参数的那一条 ───────────
   *
   * 这正是用户报的那条：「我输入 / 后，选择 btw 后，直接弹出了两个 /，
   * 而且鼠标光标位置也不对」。
   *
   * 预期（与主窗口一致）：
   *   · 命令**只插进输入框**，不执行、不发送；
   *   · 那个 `/` 是命令引导符，要被**替换**掉 —— 内容应是 `/btw `，
   *     斜杠只出现一次，不能是 `//btw`；
   *   · 光标落在末尾，用户接着就能写参数。
   *
   * ⚠️ 先把输入框清干净。前一条路径已经插过内容，不清就搜不到条目，
   * 于是这一路会退化成「什么都没点到」却判为通过（假通过）。
   */
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.innerHTML = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 250));
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.innerHTML = "";
      i.appendChild(document.createTextNode("/"));
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 800));

  const execBefore = await run("window.__probeExecCalls.length");
  const sendBefore3 = await run("window.__probeSendCalls.length");
  const panelRows = await run(`
    (function () {
      const p = document.getElementById("slashPanel");
      return { open: p ? !p.hidden : null, rows: document.querySelectorAll("#slashList .mi").length };
    })()
  `);
  say(`路径3 手打 "/btw" 后面板：${panelRows.open ? "打开" : "关闭"}，${panelRows.rows} 行`);

  const clickedRow = await run(`
    (function () {
      const rows = Array.from(document.querySelectorAll("#slashList .mi"));
      /*
       * ⚠️ 用**包含**而不是「以 btw 开头」：面板的行文字前面还有图标字符
       * （palette 渲染成「⌘ btw」）。写成 startsWith 会永远找不到，
       * 于是这一路退化成「什么都没点到」却判为通过 —— 假通过。
       */
      const r = rows.find(function (x) { return x.textContent.indexOf("btw") !== -1; });
      if (!r) return "找不到 btw 行";
      r.click();
      return "ok";
    })()
  `);
  await new Promise((r) => setTimeout(r, 900));

  const execAfter = await run("window.__probeExecCalls.length");
  const sendAfter3 = await run("window.__probeSendCalls.length");
  const input3 = await run(`
    (function () {
      const i = document.getElementById("input");
      // 直接把光标位置读出来（用户报「光标位置也不对」，这一项必须实测）
      const sel = window.getSelection();
      let caretWhere = "无选区";
      if (sel && sel.rangeCount > 0) {
        const r = sel.getRangeAt(0);
        const pre = r.cloneRange();
        pre.selectNodeContents(i);
        pre.setEnd(r.endContainer, r.endOffset);
        const at = pre.toString().length;
        caretWhere = at === i.innerText.length ? "末尾" : ("位置 " + at);
      }
      return { text: i.innerText, caret: caretWhere };
    })()
  `);
  const guide3 = await run("document.getElementById('input').getAttribute('data-guide')");

  const slashCount = (input3.text.match(/\//g) ?? []).length;
  say(`路径3 点面板里的「btw」：${clickedRow}`);
  say(`  执行调用：${execAfter - execBefore} 次（期望 0）`);
  say(`  发送调用：${sendAfter3 - sendBefore3} 次（期望 0）`);
  say(`  输入框内容：${JSON.stringify(input3.text)}（斜杠 ${slashCount} 个，期望 1）`);
  say(`  光标位置：${input3.caret}（期望末尾）`);
  say(`  参数引导：${JSON.stringify(guide3)}`);
  const path3Bad = execAfter > execBefore
    || sendAfter3 > sendBefore3
    || input3.text !== "/btw "
    || slashCount !== 1
    || input3.caret !== "末尾";

  /*
   * ── 路径 4：连续输入时不能把光标甩回开头 ──────────────────────
   *
   * 用户报：「第一个字符可以正常输入，接着光标就直接跳到最前面」
   * （截图里输入框是 `kxxxxxxx/btw x` —— 后面敲的字全插到了开头）。
   *
   * 根因是重绘：`paint()` 每次输入都清空子节点重建，而重建会摧毁选区，
   * 浏览器随后把光标放到重建后的默认位置（开头）。
   *
   * 模拟方式：逐字把内容改成 k、kx、kxx…，每步都**读回光标位置**。
   * 只要有一跳光标不在末尾，就说明重建又发生了。
   */
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.innerHTML = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 250));

  const CARET_EXPR = `
    (function () {
      const i = document.getElementById("input");
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return "无选区";
      const r = sel.getRangeAt(0);
      const pre = r.cloneRange();
      pre.selectNodeContents(i);
      pre.setEnd(r.endContainer, r.endOffset);
      const at = pre.toString().length;
      return at === i.innerText.length ? "末尾" : ("位置 " + at);
    })()
  `;

  const typing = [];
  let text = "";
  for (const ch of "kxxxxxxx") {
    text += ch;
    // 在末尾追加字符（模拟用户接着敲），并把光标停在末尾
    await run(`
      (function () {
        const i = document.getElementById("input");
        const t = ${JSON.stringify(text)};
        const first = i.firstChild;
        if (first && first.nodeType === 3) first.textContent = t;
        else i.appendChild(document.createTextNode(t));
        const r = document.createRange();
        r.selectNodeContents(i);
        r.collapse(false);
        const s = window.getSelection();
        s.removeAllRanges();
        s.addRange(r);
        i.dispatchEvent(new Event("input", { bubbles: true }));
      })()
    `);
    const where = await run(CARET_EXPR);
    typing.push(where);
  }

  const contentAfterTyping = await run("document.getElementById('input').innerText");
  const allAtEnd = typing.every((w) => w === "末尾");
  say(`路径4 连续输入 "kxxxxxxx"：光标轨迹 ${typing.join(" → ")}`);
  say(`  最终内容：${JSON.stringify(contentAfterTyping)}（期望 "kxxxxxxx"）`);
  const path4Bad = !allAtEnd || contentAfterTyping !== "kxxxxxxx";

  const anyBad = path1Bad || path2Bad || path3Bad || path4Bad;
  say(
    anyBad
      ? `结论：有不符预期的路径（路径1=${path1Bad} 路径2=${path2Bad} 路径3=${path3Bad} 路径4=${path4Bad}）`
      : "结论：四条路径都符合预期（插入不发送、认领不重复、连续输入光标不跳）",
  );
  if (pageErrors.length > 0) {
    say(`页面报错 ${pageErrors.length} 条：`);
    for (const e of pageErrors.slice(0, 8)) say(`  ✗ ${e}`);
  }
  app.exit(anyBad ? 1 : 0);
}

main().catch((e) => { say(`探针出错：${e && e.message}`); app.exit(9); });

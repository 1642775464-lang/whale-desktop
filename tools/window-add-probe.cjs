/**
 * ＋菜单点击的端到端验证
 *
 * 职责：起一个真小窗窗口连真桥，真点开＋菜单、真点某几行，
 *       把输入框的**内容**、**占位提示**与**斜杠面板状态**一起读出来。
 * 所属层：工程工具（tools/）
 *
 * 为什么要这三样一起读：
 *   用户报「点了没用」。这三样分别对应三种「没用」——
 *     内容为空        → 插入根本没发生；
 *     内容是 /plan 而面板不弹 → 漏派发 input 事件（已修）；
 *     内容对了但看不出该写什么 → 缺参数引导（主窗口会提示）。
 *   只看其中一样就会漏诊。
 *
 * 纪律：探针只观察与点击，不替产品做任何事。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-add-probe.cjs --port 19387
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

const say = (m) => process.stdout.write(`[add-probe] ${m}\n`);

function makeRun(win) {
  return function run(expr, ms = 8000) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("executeJavaScript 超时（页面可能没加载）")), ms);
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

/**
 * 浮层元素的 id。
 *
 * ⚠️ 是 `inputOverlay`，**不是** `overlay`。真实踩过：探针写成 `overlay`
 * 后 `getElementById` 返回 null，于是「浮层是否开着」恒被判为「关着」，
 * 每轮都多点一次 ＋，把已经开着的浮层 toggle 关掉 ——
 * 现象是「菜单行没渲染出来」，看起来像产品缺陷，其实是探针的 id 写错了。
 *
 * 探针里**每一个写死的 id/选择器都要对着 index.html 核一遍**：
 * 这类错误产出的假象比真缺陷更难查（环境坑 46）。
 */
const OVERLAY_ID = "inputOverlay";

/**
 * 输入框 + 面板的当前状态。
 *
 * ⚠️ 输入框是**富文本**（contenteditable），没有 `value`。
 * 读它一律用 innerText（会保留换行），并顺带把「被染色的命令片段」取出来 ——
 * 用户要的效果就是那一段变蓝，不读它就无法证明效果真的成立。
 */
const STATE_EXPR = `
  (function () {
    const i = document.getElementById("input");
    const p = document.getElementById("slashPanel");
    const token = i.querySelector("[data-token]");
    return {
      value: i.innerText,
      token: token ? token.textContent : "",
      tokenColor: token ? getComputedStyle(token).color : "",
      placeholder: i.getAttribute("data-placeholder") || "",
      guide: i.getAttribute("data-guide") || "",
      panelOpen: p ? !p.hidden : null,
    };
  })()
`;

/**
 * 清空输入框（还原到干净状态再测下一条）。
 *
 * ⚠️ 输入框是富文本，没有 `value` 可赋。这里模拟「全选删除」的效果：
 * 清掉子节点后派发 input，编辑器会据此重算着色与占位 ——
 * 与用户真的删空的等价路径。
 *
 * ⚠️ **不要碰浮层的 DOM**（早期版本把浮层 hidden 与内容清零）。
 * 产品的关闭是一个状态机：`current` 变量与 `hidden` 必须一起变。
 * 探针只改 DOM 会让产品仍以为浮层开着，下一次点 ＋ 被 toggle 成「关上」，
 * 表现为「菜单行没渲染出来」——**看着像产品缺陷，其实是探针伪造状态**。
 */
async function resetInput(run) {
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.innerHTML = "";
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 200));
}

/**
 * 打开＋菜单并等菜单行渲染出来。
 *
 * 两层等待都不能省：
 *   1. renderAdd 要先 await 宿主命令表，行是**异步**追加的；
 *   2. 浮层可能还开着（上一轮点空），此时直接点 ＋ 会被 toggle 成「关上」，
 *      所以先用产品自己的关闭按钮关掉它。
 */
async function openAdd(run) {
  const state = await run(`
    (function () {
      const o = document.getElementById(${JSON.stringify(OVERLAY_ID)});
      return {
        open: o ? !o.hidden : "元素不存在（id 写错了？）",
        rows: document.querySelectorAll("#ovBody .ov-row").length,
      };
    })()
  `);
  if (state.open !== true) {
    await run("document.getElementById('btnAdd').click()");
    await new Promise((r) => setTimeout(r, 150));
  }

  const ok = await waitFor(
    run,
    "document.querySelectorAll('#ovBody .ov-row').length > 0",
    8000,
    "菜单行渲染",
  );
  if (!ok) say(`  ↳ 诊断: 进入时 ${JSON.stringify(state)}`);
  return ok;
}

/** 点菜单里某一行（按显示文字定位）。 */
async function clickRow(run, label) {
  const out = await run(`
    (function () {
      const rows = Array.from(document.querySelectorAll("#ovBody .ov-row"));
      const r = rows.find(function (x) { return x.textContent.indexOf(${JSON.stringify(label)}) === 0; });
      if (!r) return "找不到";
      r.click();
      return "ok";
    })()
  `);
  await new Promise((r) => setTimeout(r, 400));
  return out;
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

  /*
   * 注册 `whale:ready`。
   *
   * ⚠️ **这一步不能省**，否则整个探针会得出错误结论。
   * 渲染层启动时用这个通道问主进程要「桥端口与初始会话」；没人应答时
   * `ready()` 的 promise 失败、初始化中断 → 窗口没有会话 →
   * `/whale/commands` 按会话取不到命令 → 菜单只剩「文件」与「模型」两行。
   *
   * 现象看着像「菜单渲染坏了」，其实是探针缺了这一环
   * （环境坑 46 那一类：**探针的错误假设产出的假象比真缺陷更难查**）。
   * 真窗口由 whale-window/lib/ipc.cjs 注册同一通道并返回同样形状。
   */
  ipcMain.handle("whale:ready", () => ({
    ok: true,
    port: ARGS.port,
    version: "probe",
    bounds: win.getBounds(),
    content: win.getContentSize(),
    pinned: win.isAlwaysOnTop(),
  }));
  // 渲染层还会把日志转到主进程；没人接会报「无 handler」，污染报错清单
  ipcMain.handle("whale:log", (_e, msg) => { say(`  (页面日志) ${msg}`); });

  /*
   * 收集页面里的报错。
   *
   * 这一条是**真实教训**：渲染层某个脚本崩掉时，现象往往是
   * 「界面只渲染了一半」「某个功能没反应」，而探针只会报业务断言失败 ——
   * 完全指不出是脚本崩了。必须把 console 的报错抓出来。
   */
  const pageErrors = [];
  win.webContents.on("console-message", (_e, level, message) => {
    // 不过滤 level：真实教训是「脚本报错」在 level=1（warning）里也出现过，
    // 而漏掉它就等于没有这条防线。
    pageErrors.push(`[L${level}] ${message}`);
  });
  win.webContents.on("render-process-gone", (_e, details) => {
    pageErrors.push(`渲染进程退出：${details?.reason}`);
  });
  win.webContents.on("preload-error", (_e, file, err) => {
    pageErrors.push(`preload 失败 ${file}：${err?.message}`);
  });

  await waitFor(run, "typeof window.WhaleAddMenu === 'object'", 8000, "页面装配");

  /*
   * 先确认窗口拿到了会话。
   *
   * 命令表是**按会话**取的（`/whale/commands?sessionId=…`）；拿不到会话时
   * 客户端会老实返回空表，于是菜单只剩「文件」与「模型」两行 ——
   * 现象看着像「菜单渲染坏了」，其实是窗口没连上桥/没有活跃会话。
   * 探针必须把这一层先排除掉，否则会把环境问题报成产品缺陷。
   */
  const session = await run(`
    (function () {
      const c = window.WhaleBridge;
      if (!c) return { client: "无 WhaleBridge" };
      const s = c.getState ? c.getState() : {};
      return {
        client: "有",
        sessionId: s.sessionId ?? null,
        bridgeBase: document.getElementById("infoBridge")?.textContent ?? null,
        connected: s.connected ?? null,
      };
    })()
  `);
  say(`窗口状态：${JSON.stringify(session)}`);

  // 先看清菜单结构（一次性，便于对照）
  await openAdd(run);
  const rows = await run(`
    (function () {
      return Array.from(document.getElementById("ovBody").children).map(function (c) {
        return c.className + " :: " + c.textContent.slice(0, 30);
      });
    })()
  `);
  say(`＋菜单 ${rows.length} 个节点`);
  for (const r of rows) say(`  ${r}`);

  /*
   * 关于斜杠面板：插入的是**本地化写法**（`/压缩 `），而 palette 的候选
   * 用的是真实命令名（compact），所以面板匹配不到东西、不开是**正常**的。
   * 这里只如实记录，不当成失败 —— 早先我把它写成「必须开」，那是错的期望，
   * 会让人去改没坏的东西（环境坑 46 的同型错误）。
   */
  const cases = [
    { label: "计划", wantValue: "/计划 ", wantToken: "/计划" },
    { label: "压缩", wantValue: "/压缩 ", wantToken: "/压缩" },
    { label: "目标", wantValue: "/目标 ", wantToken: "/目标" },
    { label: "btw", wantValue: "/btw ", wantToken: "/btw" },
  ];

  let bad = 0;
  for (const c of cases) {
    await resetInput(run);
    await openAdd(run);
    const clicked = await clickRow(run, c.label);
    const st = await run(STATE_EXPR);
    const okValue = st.value === c.wantValue;
    const okToken = st.token === c.wantToken;
    if (!okValue || !okToken) bad += 1;
    const vOk = okValue ? "✓" : `✗ 期望 ${JSON.stringify(c.wantValue)}`;
    const tOk = okToken ? "✓" : `✗ 期望 ${JSON.stringify(c.wantToken)}`;
    say(
      `点「${c.label}」(${clicked}) → 内容 ${JSON.stringify(st.value)} ${vOk}` +
      ` | 染色片段 ${JSON.stringify(st.token)} ${tOk}` +
      ` | 颜色 ${st.tokenColor}`,
    );
  }

  /*
   * 用户手打时着色也要跟上（他删掉命令前缀就该退色）——
   * 这是 contenteditable 最容易漏的一半：插入时染了，用户再编辑就没了。
   */
  await resetInput(run);
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.innerHTML = "";
      i.appendChild(document.createTextNode("/btw 我说点什么"));
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 250));
  const typed = await run(STATE_EXPR);
  const typedOk = typed.token === "/btw" && typed.value === "/btw 我说点什么";
  say(`用户手打 "/btw 我说点什么" → 染色 ${JSON.stringify(typed.token)} ${typedOk ? "✓" : "✗"}`);
  if (!typedOk) bad += 1;

  // 删掉斜杠后必须退色
  await run(`
    (function () {
      const i = document.getElementById("input");
      i.innerHTML = "";
      i.appendChild(document.createTextNode("btw 我说点什么"));
      i.dispatchEvent(new Event("input", { bubbles: true }));
    })()
  `);
  await new Promise((r) => setTimeout(r, 250));
  const noSlash = await run(STATE_EXPR);
  const faded = noSlash.token === "";
  say(`去掉斜杠后 → 染色 ${JSON.stringify(noSlash.token)} ${faded ? "✓ 已退色" : "✗ 颜色没退掉"}`);
  if (!faded) bad += 1;

  /*
   * 参数引导：btw 的宿主 hint 是「旁问内容」。
   *
   * ⚠️ 占位提示**只在输入框没有焦点时显示**（与原生控件一致）。
   * 点完菜单后输入框是被聚焦的，所以 `data-placeholder` 会是空串 ——
   * 这时要读的是编辑器自己记着的引导文案（`data-guide`），
   * 而不是「有没有显示」。早先我直接断言显示与否，那是错的期望。
   */
  await resetInput(run);
  await openAdd(run);
  await clickRow(run, "btw");
  const afterBtw = await run(STATE_EXPR);
  const hasHint = typeof afterBtw.guide === "string" && afterBtw.guide.indexOf("旁问内容") !== -1;
  say(`btw 的参数引导：${hasHint ? "✓" : "✗"}（引导 = ${JSON.stringify(afterBtw.guide)}）`);
  if (!hasHint) bad += 1;

  // 没有参数声明的命令：引导应还原默认，不能留着上一条的
  await resetInput(run);
  await openAdd(run);
  await clickRow(run, "压缩");
  const afterCompact = await run(STATE_EXPR);
  const restored = typeof afterCompact.guide === "string" && afterCompact.guide.indexOf("接着写") === -1;
  say(`无参数命令后引导已还原：${restored ? "✓" : "✗"}（引导 = ${JSON.stringify(afterCompact.guide)}）`);
  if (!restored) bad += 1;

  say(bad === 0 ? "结论：全部通过（内容、染色与引导都对）" : `结论：${bad} 项不符`);
  if (pageErrors.length > 0) {
    say(`页面报错 ${pageErrors.length} 条：`);
    for (const e of pageErrors.slice(0, 10)) say(`  ✗ ${e}`);
  }
  app.exit(bad === 0 && pageErrors.length === 0 ? 0 : 1);
}

main().catch((e) => { say(`探针出错：${e && e.message}`); app.exit(9); });

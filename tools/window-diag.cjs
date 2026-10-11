/**
 * 小窗客户端状态诊断
 *
 * 职责：起一个真小窗窗口连**真实桥**，把它的客户端内部状态读出来：
 *       sessionId 有没有、面板拉到几条、标题是什么。
 * 所属层：工程工具（tools/）
 *
 * 为什么要这个：现场现象是「标题空 + 消息空 + 却显示桥已连接」。
 * 这个组合至少有三种成因（sessionId 为空 / sessionId 陈旧 / 折叠器里没该会话），
 * 三者修法不同，靠读代码分不出来 —— 必须把运行时状态打出来。
 *
 * 纪律：探针只观察，不替产品做任何事（不调 refresh、不设 state）。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-diag.cjs --port 19387
 */

"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");
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

const args = parseArgs(process.argv.slice(2));
app.setPath("userData", path.join(REPO_ROOT, "_probe", "window-diag-userdata"));

const report = { consoleErrors: [] };
const sleep = (ms) => new Promise((r) => global.setTimeout(r, ms));

app.whenReady().then(async () => {
  const { bootWindow } = require(path.join(REPO_ROOT, "whale-window", "lib", "boot.cjs"));

  const booted = bootWindow({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    // 探针纪律注记：这里传的假 logger 必须带 info/warn/error——
    // boot.cjs 与 ipc.cjs 都会调 log.info()，传裸函数会在装配期崩掉
    // （探针自己崩了还表现为「无输出」，之前两轮就是这么浪费掉的）。
    log: { info: () => {}, warn: () => {}, error: () => {} },
    port: args.port,
    noRestore: true,
    onWindowReady(w) {
      w.win.webContents.on("console-message", (...a) => {
        const first = a[0];
        const asEvent = first !== null && typeof first === "object" && "message" in first;
        const level = asEvent ? first.level : a[1];
        const message = asEvent ? first.message : a[2];
        report.consoleErrors.push({ level: String(level), message: String(message) });
      });
    },
  });

  // bootWindow 返回 { win, store, ... }，其中 win 是**窗口封装**（自定义对象），
  // 真正的 BrowserWindow 在 win.win 上（boot.cjs:166 就是这么用的）。
  const wrapper = booted.win;
  const win = wrapper.win;
  const run = (code) => win.webContents.executeJavaScript(code, true);

  await wrapper.loaded;
  // 等两轮轮询（桥给数据需要一点时间）
  await sleep(6000);

  // 直接读客户端内部状态（WhaleBridge 把 getState 暴露出来了）
  report.client = await run(`(() => {
    const c = window.__whaleClientForDiag;
    return c ? { hasClient: true } : { hasClient: false };
  })()`);

  // 客户端实例没暴露，就退而从 DOM 与直接探测拿证据
  // 会话标题行（shTitle/shSub）已移除，标题读顶栏 tbTitle
  report.dom = await run(`({
    title: (document.getElementById("tbTitle") || {}).textContent,
    streamRows: document.querySelectorAll("#stream .msg, #stream .tool-line").length,
    empty: !!document.getElementById("streamEmpty"),
    emptyText: (document.getElementById("streamEmpty") || {}).textContent
  })`);

  // 关键：自己复现小窗的两步取数，看每一步拿到什么
  const port = args.port;
  report.probe = await run(`(async () => {
    const out = {};
    try {
      const hud = await (await fetch("http://127.0.0.1:${port}/whale/hud")).json();
      out.hudOk = true;
      out.activeSessionId = hud.activeSessionId;
      out.sessionCount = Array.isArray(hud.sessions) ? hud.sessions.length : -1;
      out.firstTitle = hud.sessions && hud.sessions[0] ? hud.sessions[0].title : null;
    } catch (e) { out.hudError = String(e && e.message); }

    const sid = out.activeSessionId;
    if (sid) {
      try {
        const p = await (await fetch("http://127.0.0.1:${port}/whale/panel?sessionId=" + encodeURIComponent(sid))).json();
        out.panelOk = true;
        out.panelTitle = p.title;
        out.panelMessages = Array.isArray(p.messages) ? p.messages.length : -1;
      } catch (e) { out.panelError = String(e && e.message); }
    }
    return out;
  })()`);

  /**
   * 走真实 UI 交互驱动浮层（探针纪律：只模拟用户输入）。
   *
   * 这一步回答的是「用户点了之后到底发生了什么」：
   *   点模型键 → 浮层里有没有内容 → 点一个档位 → 桥回什么。
   * 之前三轮都卡在「看代码猜」，这里直接把交互结果打出来。
   */
  report.interaction = await run(`(async () => {
    const out = { steps: [] };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const log = (s) => out.steps.push(s);

    // 1) 点权限键，看浮层里出现了什么
    const btnPerm = document.getElementById("btnPerm");
    if (!btnPerm) { log("找不到 btnPerm"); return out; }
    btnPerm.click();
    await sleep(700);
    const overlay = document.getElementById("inputOverlay");
    const body = document.getElementById("ovBody");
    out.overlayOpened = overlay && !overlay.hidden;
    out.permRows = body ? [...body.querySelectorAll(".ov-row")].map((r) => r.textContent.trim()) : null;
    log("点 btnPerm 后浮层 hidden=" + (overlay ? overlay.hidden : "null"));

    // 2) 点最后一个档位（auto），看桥怎么回
    if (body) {
      const rows = [...body.querySelectorAll(".ov-row")];
      const target = rows[rows.length - 1];
      if (target) {
        const before = document.querySelectorAll(".ov-row").length;
        target.click();
        await sleep(900);
        out.clickedLastPermRow = true;
        out.rowsBefore = before;
        out.overlayStillOpen = overlay && !overlay.hidden;
      }
    }

    // 3) 点模型键，看分组与档位
    const btnModel = document.getElementById("btnModel");
    if (btnModel) {
      btnModel.click();
      await sleep(900);
      const b2 = document.getElementById("ovBody");
      out.modelGroups = b2 ? [...b2.querySelectorAll(".ov-group")].map((g) => g.textContent.trim()) : null;
      out.modelRows = b2 ? [...b2.querySelectorAll(".ov-row")].length : 0;
      // 点第一个模型 → 应进入 effort 列表
      const firstRow = b2 ? b2.querySelector(".ov-row") : null;
      if (firstRow) {
        firstRow.click();
        await sleep(900);
        const b3 = document.getElementById("ovBody");
        out.ovTitleAfterPick = (document.getElementById("ovTitle") || {}).textContent;
        out.effortRows = b3 ? [...b3.querySelectorAll(".ov-row")].map((r) => r.textContent.trim()) : null;
      }
    }
    return out;
  })()`);

  /**
   * 拦截真实窗口的 fetch，再模拟点击——看产品 client 实际发出的请求体。
   *
   * 这是「用户点了之后到底发了什么」的直接证据：
   * 之前直打桥都是 200，所以差异只能在渲染层发出去的参数上。
   */
  report.wire = await run(`(async () => {
    const out = { captured: [] };
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const origFetch = window.fetch;
    window.fetch = function (url, opts) {
      const u = String(url);
      const watched = u.includes("/whale/model") || u.includes("/whale/command") || u.includes("/whale/presets");
      if (!watched) return origFetch.apply(this, arguments);
      // 连响应一起抓：只抓请求体只能证明「发得对」，
      // 要证明「桥收下了」必须看响应的 status 与 body。
      return origFetch.apply(this, arguments).then(async function (res) {
        let body = null;
        try { body = await res.clone().text(); } catch (e) { body = "读取失败:" + String(e && e.message); }
        out.captured.push({
          url: u,
          reqBody: opts && opts.body ? String(opts.body) : null,
          status: res.status,
          resBody: body ? body.slice(0, 220) : null,
        });
        return res;
      });
    };

    // 点权限键 → 等渲染 → 点一个档位
    const btnPerm = document.getElementById("btnPerm");
    if (!btnPerm) { out.err = "找不到 btnPerm"; return out; }
    btnPerm.click();
    await sleep(900);
    const body = document.getElementById("ovBody");
    const overlayEl = document.getElementById("inputOverlay");
    out.permOverlayOpen = overlayEl ? !overlayEl.hidden : null;
    out.permTitle = (document.getElementById("ovTitle") || {}).textContent;
    out.permRows = body ? [...body.querySelectorAll(".ov-row")].map((r) => r.textContent.trim()) : null;
    const rows = body ? [...body.querySelectorAll(".ov-row")] : [];
    if (rows.length > 0) {
      rows[rows.length - 1].click();
      await sleep(1200);
    }

    // 点模型键 → 点第一个模型 → 点第一个档位
    const btnModel = document.getElementById("btnModel");
    if (btnModel) {
      btnModel.click();
      await sleep(900);
      const b2 = document.getElementById("ovBody");
      const mrows = b2 ? [...b2.querySelectorAll(".ov-row")] : [];
      out.modelRowCount = mrows.length;
      if (mrows.length > 1) { mrows[1].click(); await sleep(800); }
      const b3 = document.getElementById("ovBody");
      const erows = b3 ? [...b3.querySelectorAll(".ov-row")] : [];
      out.effortTitles = erows.map((r) => r.textContent.trim());
      if (erows.length > 1) { erows[erows.length - 1].click(); await sleep(1500); }
      // 切换后浮层该关掉；没关就是没成功
      const ov3 = document.getElementById("inputOverlay");
      out.overlayOpenAfterModelPick = ov3 ? !ov3.hidden : null;
    }
    window.fetch = origFetch;
    return out;
  })()`);

  console.log(`WINDOW_DIAG ${JSON.stringify(report)}`);
  app.exit(0);
});

/**
 * 小窗渲染层状态探针（最小版）
 *
 * 职责：加载真渲染页面，直接用**产品的客户端**打一次
 *       `/whale/hud` → `/whale/presets`，把每一步的真实结果打出来。
 * 所属层：工程工具（tools/）
 *
 * 为什么要它：用户报「模型能列、权限不行、切换全挂」，
 * 三者共同点只有一个参数 —— sessionId。直打真桥是 200，
 * 所以必须看**渲染进程里**发出去的到底是什么。
 *
 * 纪律：只观察，不改产品状态、不替产品调 refresh。
 *
 * 用法：runtime\electron.exe --no-sandbox tools\state-probe.cjs --port 19387
 */

"use strict";

const { app, BrowserWindow } = require("electron");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const RENDERER = path.join(REPO, "whale-window", "renderer");

function parseArgs(argv) {
  const out = { port: 19387 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
app.setPath("userData", path.join(REPO, "_probe", "state-probe-userdata"));

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 520,
    height: 760,
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });

  const logs = [];
  win.webContents.on("console-message", (...a) => {
    const first = a[0];
    const asEvent = first !== null && typeof first === "object" && "message" in first;
    const level = asEvent ? first.level : a[1];
    const message = asEvent ? first.message : a[2];
    logs.push(`[${level}] ${message}`);
  });

  await win.loadFile(path.join(RENDERER, "index.html"));
  await new Promise((r) => setTimeout(r, 5000));

  // 用**产品自己的客户端**发请求，把每一步的真实结果打出来
  const out = await win.webContents.executeJavaScript(`(async () => {
    const res = { steps: [] };
    const port = ${args.port};
    const base = "http://127.0.0.1:" + port;

    // 第 1 步：/whale/hud（小窗靠它拿 sessionId）
    let sid = null;
    try {
      const hud = await (await fetch(base + "/whale/hud")).json();
      const list = Array.isArray(hud.sessions) ? hud.sessions : [];
      sid = (typeof hud.activeSessionId === "string" && hud.activeSessionId !== "")
        ? hud.activeSessionId
        : (list.length > 0 ? list[0].sessionId : null);
      res.hudSessionId = sid;
      res.hudSessionCount = list.length;
    } catch (e) { res.hudError = String(e && e.message); }

    // 第 2 步：/whale/presets（权限浮层用）
    if (sid) {
      try {
        const r = await fetch(base + "/whale/presets?sessionId=" + encodeURIComponent(sid));
        res.presetsStatus = r.status;
        const j = await r.json();
        res.presets = j.options;
        res.presetsCurrent = j.current;
      } catch (e) { res.presetsError = String(e && e.message); }
    }

    // 第 3 步：/whale/model（切模型用）—— 用真目录里的第一个模型
    let cat = null;
    try {
      cat = await (await fetch(base + "/whale/models")).json();
      res.modelsTotal = cat.total;
    } catch (e) { res.modelsError = String(e && e.message); }

    if (sid && cat && cat.groups && cat.groups[0] && cat.groups[0].models[0]) {
      const g = cat.groups[0];
      const m = g.models[0];
      const eff = (m.reasoning && m.reasoning.efforts && m.reasoning.efforts[0])
        ? m.reasoning.efforts[0].id : undefined;
      const body = { sessionId: sid, provider: g.id, model: m.id };
      if (eff !== undefined) body.reasoningEffort = eff;
      res.modelRequestBody = body;
      try {
        const r = await fetch(base + "/whale/model", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        res.modelStatus = r.status;
        res.modelResponse = await r.json();
      } catch (e) { res.modelError = String(e && e.message); }
    }

    // 第 4 步：读小窗自己渲染出来的状态条文字（用户看到的东西）
    // 会话标题行（shTitle/shSub）已按用户要求移除，标题只读顶栏 tbTitle
    res.dom = {
      title: (document.getElementById("tbTitle") || {}).textContent,
      conn: (document.querySelector(".conn") || {}).textContent,
    };
    return res;
  })()`, true);

  process.stdout.write(`STATE_PROBE ${  JSON.stringify({ out, logs: logs.slice(-8) })  }\n`);
  win.destroy();
  app.exit(0);
});

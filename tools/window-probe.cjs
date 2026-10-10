/**
 * 小窗验收探针
 *
 * 职责：起真桥 → 起真小窗 → 用主进程的 executeJavaScript 做 DOM 断言、
 *       getBounds() 做几何断言，并把渲染层报错全收上来。
 * 所属层：工程工具（tools/）
 *
 * ── 铁律：探针只许观察，不许代劳 ──
 *
 * 悬浮条那边踩过一次：探针自己写了 `loadFile`，替产品把页面加载了；
 * 产品漏了这一步（窗口全白）却 11 项全绿。绿灯给了虚假的信心，
 * 比没有测试更糟。
 *
 * 所以本文件遵守：
 *   1. 走产品的 `bootWindow`，绝不自己 loadFile / setBounds / show
 *   2. 每个断言旁配反例检查（白窗口照妖镜：先验页面真渲染了）
 *   3. `executeJavaScript` 带超时（无文档时会永久挂住，只报 timeout 看不出真因）
 *
 * 允许做的只有「模拟用户输入」：点击按钮、派发事件。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\window-probe.cjs --port 19500
 */

"use strict";

const { app, BrowserWindow, ipcMain, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const REPO_ROOT = path.resolve(__dirname, "..");
const PROBE_DIR = path.join(REPO_ROOT, "_probe");

/** 解析参数（Electron 会把 argv[0] 给成 exe 路径）。 */
function parseArgs(argv) {
  const out = { port: 19387, offline: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
    if (argv[i] === "--offline") out.offline = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

// 与产品同一套纪律：显式 userData，否则原生崩溃
app.setPath("userData", path.join(PROBE_DIR, "window-probe-userdata"));

const report = {
  a11: { consoleErrors: [], preloadErrors: [], renderGone: [], loadFailures: [] },
  verdict: "fail",
};

function finish() {
  console.log(`PROBE_RESULT ${JSON.stringify(report)}`);
  app.exit(0);
}

app.whenReady().then(async () => {
  const { bootWindow } = require(path.join(REPO_ROOT, "whale-window", "lib", "boot.cjs"));
  const { createLogger } = require(path.join(REPO_ROOT, "whale-window", "lib", "log.cjs"));

  const log = createLogger({
    resolveDir: () => path.join(PROBE_DIR, "window-probe-userdata"),
    consoleFallback: false,
  });

  let w = null;

  const booted = bootWindow({
    BrowserWindow,
    screen,
    ipcMain,
    app,
    log,
    port: args.port,
    // 探针不改产品行为，但要不读不写记忆（否则会污染用户真实的位置，
    // 且上一条用例的位置会影响下一条，测试相互干扰）
    noRestore: true,
    onWindowReady: (win) => {
      w = win;
      const wc = win.win.webContents;
      wc.on("console-message", (...a) => {
        const first = a[0];
        const asEvent = first !== null && typeof first === "object" && "message" in first;
        const level = asEvent ? first.level : a[1];
        const message = asEvent ? first.message : a[2];
        if (level === 3 || level === "error") report.a11.consoleErrors.push(message);
      });
      wc.on("preload-error", (_e, file, err) => {
        report.a11.preloadErrors.push(`${file}: ${err && err.message}`);
      });
      wc.on("render-process-gone", (_e, details) => {
        report.a11.renderGone.push(details?.reason ?? "unknown");
      });
      wc.on("did-fail-load", (_e, code, desc) => {
        report.a11.loadFailures.push(`${code} ${desc}`);
      });
    },
  });

  w = booted.win;

  await w.loaded;
  report.pageLoaded = true;
  report.loadedUrl = w.win.webContents.getURL();
  await new Promise((r) => setTimeout(r, 2000));

  const run = (expr) => w.win.webContents.executeJavaScript(expr);
  const runWithTimeout = (expr, ms = 3000) =>
    Promise.race([
      run(expr),
      new Promise((_res, rej) => {
        setTimeout(() => rej(new Error("executeJavaScript 超时（页面可能没有加载）")), ms).unref();
      }),
    ]);

  // ── 前置条件：页面真的渲染了（白窗口照妖镜）──
  try {
    report.blankWindow = await runWithTimeout(`(() => {
      const win = document.getElementById("win");
      return {
        hasWin: win !== null,
        htmlLength: document.documentElement.innerHTML.length,
        pageLooksRendered: win !== null && document.documentElement.innerHTML.length > 800,
      };
    })()`);
  } catch (err) {
    report.blankWindow = { error: err.message, pageLooksRendered: false };
  }

  if (report.blankWindow.pageLooksRendered !== true) {
    report.checks = { okNotBlank: false };
    report.failureReason = "窗口是空白的：页面没有被加载。检查 whale-window/lib/window.cjs 是否调用了 loadFile。";
    finish();
    return;
  }

  // ── B1：窗口尺寸 492×710，内容 460×678 ──
  const b = w.bounds();
  const content = w.contentSize();
  report.b1 = { window: b, content };

  // ── B7 前置：发送键 aria-label（回合空闲应为「发送」）──
  report.sendButton = await run(`(() => {
    const el = document.getElementById("btnSend");
    return { ariaLabel: el.getAttribute("aria-label"), cls: el.className };
  })()`);

  // ── B4：拖顶栏能移动窗口（走真实的 drag 通道）──
  const before = w.bounds();
  await run("globalThis.whale.drag(40, 30)");
  await new Promise((r) => setTimeout(r, 300));
  const after = w.bounds();
  report.b4 = { dx: after.x - before.x, dy: after.y - before.y, sizeKept: after.width === before.width };

  // ── 顶栏元素齐全（F2 五元素：齿轮已按用户要求移除）──
  report.topbar = await run(`(() => {
    const ids = ["btnMin", "btnPin", "btnMenu", "tbTitle"];
    const missing = ids.filter((id) => {
      const el = document.getElementById(id);
      return el === null || el.offsetWidth === 0;
    });
    return {
      missing,
      brandDot: document.querySelector(".brand-dot") !== null,
      title: document.getElementById("tbTitle").textContent,
    };
  })()`);

  // ── 会话标题行（F3）──
  report.sessionHead = await run(`({
    title: document.getElementById("shTitle").textContent,
    badge: document.querySelector(".sh-badge") ? document.querySelector(".sh-badge").textContent : null,
    sub: document.getElementById("shSub").textContent
  })`);

  // ── 权限三档文案（B9）：连点三次按钮，文案应轮转一整圈 ──
  const permSeq = [];
  for (let i = 0; i < 4; i += 1) {
    permSeq.push(await run("document.getElementById('btnPerm').textContent"));
    await run("document.getElementById('btnPerm').click()");
    await new Promise((r) => setTimeout(r, 200));
  }
  report.permissionSequence = permSeq;

  // ── 崩溃自愈状态机已装上（B11 的静态侧）──
  report.recovery = {
    phase: booted.recovery.phase(),
    crashCount: booted.recovery.crashCount(),
    maxReloads: require(path.join(REPO_ROOT, "whale-window", "lib", "recovery.cjs")).RENDERER_RELOAD_MAX,
  };

  // ── 消息流分流：用户 / 助手 / 工具必须分得开 ──
  // 「读错字段也能跑」的典型：按 role 读而桥给 kind，结果全渲染成助手且不报错。
  report.stream = await run(`(() => {
    const nodes = [...document.querySelectorAll(".stream .msg, .stream .tool-line")];
    const rows = nodes.map((n) => ({
      cls: n.className,
      role: n.querySelector(".role") ? n.querySelector(".role").textContent : null,
      text: n.textContent.slice(0, 40),
    }));
    return {
      count: rows.length,
      rows: rows.slice(0, 6),
      hasUser: rows.some((r) => r.cls.includes("me")),
      hasAi: rows.some((r) => r.cls.includes("ai")),
      hasTool: rows.some((r) => r.cls.includes("tool-line")),
      hasEmpty: document.querySelector(".stream .empty") !== null,
    };
  })()`);

  // ── F5 状态条 + 任务坞 ──
  report.f5 = await run(`(() => {
    const status = document.getElementById("status");
    const dock = document.getElementById("dock");
    return {
      statusHidden: status.hidden,
      statusText: document.getElementById("statusText").textContent,
      dockHidden: dock.hidden,
      dockProg: document.getElementById("dockProg").textContent,
      dockRows: document.querySelectorAll("#dockList .task").length,
      dots: [...document.querySelectorAll("#dockList .pd")].map((d) => d.className),
    };
  })()`);

  // 任务坞默认收起，点标题展开
  await run("document.getElementById('dockHead').click()");
  await new Promise((r) => setTimeout(r, 200));
  report.f5.afterExpand = await run("!document.getElementById('dockList').hidden");

  // ── 批次 C：斜杠命令面板（F7）──
  report.palette = { initiallyHidden: await run("document.getElementById('slashPanel').hidden") };

  // 敲 / 应弹出
  await run(`(() => {
    const input = document.getElementById("input");
    input.value = "/";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  report.palette.afterSlash = await run(`({
    hidden: document.getElementById("slashPanel").hidden,
    query: document.getElementById("slashQuery").textContent,
    rows: document.querySelectorAll("#slashList .mi").length
  })`);

  // 继续打字应实时过滤
  await run(`(() => {
    const input = document.getElementById("input");
    input.value = "/sk";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  report.palette.afterType = await run(`({
    rows: document.querySelectorAll("#slashList .mi").length,
    query: document.getElementById("slashQuery").textContent
  })`);

  // Esc 应关闭
  await run(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await new Promise((r) => setTimeout(r, 200));
  report.palette.afterEsc = await run("document.getElementById('slashPanel').hidden");

  // 清空输入后应保持关闭
  await run(`(() => {
    const input = document.getElementById("input");
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()`);
  await new Promise((r) => setTimeout(r, 200));
  report.palette.afterClear = await run("document.getElementById('slashPanel').hidden");

  // ── 批次 C：☰ 菜单（F8）与资料抽屉 ──
  await run("document.getElementById('btnMenu').click()");
  await new Promise((r) => setTimeout(r, 200));
  report.menu = await run(`({
    hidden: document.getElementById("menuBox").hidden,
    items: [...document.querySelectorAll("#menuList .mi")].map((n) => n.textContent.trim())
  })`);

  await run("document.getElementById('btnMenu').click()");
  await new Promise((r) => setTimeout(r, 200));
  report.menu.closedAgain = await run("document.getElementById('menuBox').hidden");

  await run("document.getElementById('btnInfo').click()");
  await new Promise((r) => setTimeout(r, 200));
  report.drawer = await run(`({
    hidden: document.getElementById("infoDrawer").hidden,
    session: document.getElementById("infoSession").textContent,
    bridge: document.getElementById("infoBridge").textContent,
    events: document.getElementById("infoEvents").textContent
  })`);

  // ── 发送 / 中断：两种回合状态要分别验 ──
  //
  // 运行中 → 发送键应是「中断」，点击应发 abort（不是 send）
  // 空闲   → 发送键应是「发送」，点击应清空输入框并发消息
  //
  // 用 --idle 切换桥的种子状态。只验一种会漏掉另一半。
  const running = report.sendButton.ariaLabel === "中断";

  if (running) {
    // 记下点击前的 abort 次数，用桥侧统计间接确认「点了确实去中断」
    await run("document.getElementById('btnSend').click()");
    await new Promise((r) => setTimeout(r, 900));
    report.abortPath = await run(`({
      ariaAfter: document.getElementById('btnSend').getAttribute('aria-label'),
      inputUntouched: document.getElementById('input').value === ''
    })`);
  } else {
    await run(`(() => {
      document.getElementById('input').value = "来自小窗的测试消息";
      return true;
    })()`);
    await run("document.getElementById('btnSend').click()");
    await new Promise((r) => setTimeout(r, 1200));
    report.afterSend = await run(`({
      inputCleared: document.getElementById('input').value === "",
      sendAria: document.getElementById('btnSend').getAttribute('aria-label')
    })`);
  }

  // 发送 / 中断的真正落点：读假桥的取证端口，确认 agent 收到了什么。
  // 只看界面变化不够——「点了有反应」与「真的交给了宿主」是两件事。
  try {
    const callsRes = await fetch(`http://127.0.0.1:${args.port + 1}/probe/calls`);
    report.agentCalls = await callsRes.json();
  } catch (err) {
    report.agentCalls = { error: err.message };
  }

  // ── 判定 ──
  const okNotBlank = true;
  const okB1 =
    b.width === 492 && b.height === 710 &&
    content.width === 460 && content.height === 678;
  const okB4 = report.b4.dx === 40 && report.b4.dy === 30 && report.b4.sizeKept === true;
  const okTopbar = report.topbar.missing.length === 0 && report.topbar.brandDot === true;
  const okHead = report.sessionHead.badge === "同源会话";
  const okPerm =
    report.permissionSequence[0] === "工作区内修改" &&
    report.permissionSequence[1] === "完全权限" &&
    report.permissionSequence[2] === "仅可查看" &&
    report.permissionSequence[3] === "工作区内修改";
  // 发送键的 aria 必须与回合状态一致：
  //   运行中 = "中断"，空闲 = "发送"（B7 判据按此读 DOM）
  const okSend = report.sendButton.ariaLabel === (running ? "中断" : "发送");
  // 消息流必须能分出「你」与「DSH」：只有助手消息时看不出分流对不对，
  // 而按错字段读的表现正是「全部渲染成助手且不报错」
  const okStream =
    report.stream.count > 0 &&
    report.stream.hasUser === true &&
    report.stream.hasAi === true;

  // 发送键与它触发的动作必须一致，而且**真的落到宿主 agent 上**：
  //   运行中点它 → agent.cancel 被调用（且带 keepInbox）
  //   空闲点它   → agent.followup 被调用，输入框清空
  const calls = Array.isArray(report.agentCalls) ? report.agentCalls : [];
  const abortLanded = calls.some((c) => c.method === "cancel" && c.options && c.options.keepInbox === true);
  const sendLanded = calls.some(
    (c) => c.method === "followup" && c.msg && Array.isArray(c.msg.content) &&
      c.msg.content.some((b) => b.text === "来自小窗的测试消息"),
  );

  const okSendPath = running
    ? report.abortPath.inputUntouched === true && abortLanded
    : report.afterSend.inputCleared === true && sendLanded;

  // 状态条：只在回合在跑时出现（F5）。
  // 空闲时必须**隐藏**——一直挂着「正在运行」比没有状态条更糟。
  const okStatus = running
    ? report.f5.statusHidden === false &&
      report.f5.statusText.includes("正在运行") &&
      report.f5.statusText.includes("bash")
    : report.f5.statusHidden === true;
  // 任务坞：有清单就出现，计数正确，三种色点齐全，默认收起、点击可展开
  const okDock =
    report.f5.dockHidden === false &&
    report.f5.dockProg === "1 / 3" &&
    report.f5.dockRows === 3 &&
    report.f5.dots.includes("pd done") &&
    report.f5.dots.includes("pd doing") &&
    report.f5.dots.includes("pd todo") &&
    report.f5.afterExpand === true;
  const okA11 =
    report.a11.consoleErrors.length === 0 &&
    report.a11.preloadErrors.length === 0 &&
    report.a11.renderGone.length === 0;

  // 斜杠面板（F7）：初始隐藏 → 敲 / 弹出 → 打字过滤 → Esc 关闭 → 清空保持关闭
  const okPalette =
    report.palette.initiallyHidden === true &&
    report.palette.afterSlash.hidden === false &&
    report.palette.afterSlash.query === "/" &&
    report.palette.afterSlash.rows >= 2 &&
    report.palette.afterType.query === "/sk" &&
    report.palette.afterType.rows >= 1 &&
    report.palette.afterType.rows <= report.palette.afterSlash.rows &&
    report.palette.afterEsc === true &&
    report.palette.afterClear === true;

  // ☰ 菜单（F8）：点开有项、再点关掉；「按需确认」是灰项
  const okMenu =
    report.menu.hidden === false &&
    report.menu.items.length >= 5 &&
    report.menu.items.some((t) => t.includes("按需确认")) &&
    report.menu.items.some((t) => t.includes("项目")) &&
    report.menu.closedAgain === true;

  // 资料抽屉（F8）：三行齐全，桥地址是回环地址
  const okDrawer =
    report.drawer.hidden === false &&
    report.drawer.session.length > 0 &&
    report.drawer.session !== "–" &&
    report.drawer.bridge.includes("127.0.0.1");

  report.checks = {
    okNotBlank, okB1, okB4, okTopbar, okHead, okPerm, okSend, okStream, okSendPath,
    okStatus, okDock, okPalette, okMenu, okDrawer, okA11,
  };
  report.verdict =
    okNotBlank && okB1 && okB4 && okTopbar && okHead && okPerm && okSend && okStream &&
    okSendPath && okStatus && okDock && okPalette && okMenu && okDrawer && okA11
      ? "pass"
      : "fail";

  // 顺手存一张窗口自身截图，便于人工看
  try {
    const img = await w.win.webContents.capturePage();
    fs.mkdirSync(PROBE_DIR, { recursive: true });
    fs.writeFileSync(path.join(PROBE_DIR, "window-shot.png"), img.toPNG());
    report.screenshot = "window-shot.png";
  } catch (err) {
    report.screenshotError = err.message;
  }

  finish();
});

// 兜底：任何一步卡住都要有输出，不能静默挂死
setTimeout(() => {
  report.verdict = "timeout";
  finish();
}, 40000);

/**
 * 悬浮条垂直居中量测探针
 *
 * 职责：进真窗口，量出五元素各自「内容视觉中心」的 y 坐标，
 *       与条中心（y=26）逐一对照，给出偏差数字。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须量而不是目测改 CSS：
 *   「看着不居中」有至少三种成因——盒子没居中、盒子居中了但内部行高把字顶偏、
 *   基线与汉字字形中心不一致。三者的修法完全不同（改 align-items /
 *   改 line-height / 加补偿），靠估算改 CSS 会反复试错。
 *   量出数字才能一次改对，也能把「改完真的居中了吗」变成可复核的判据。
 *
 * 用法（必须由 Electron 跑）：
 *   runtime\electron.exe --no-sandbox tools\hud-align-probe.cjs --port 19500
 */

"use strict";

const { app, BrowserWindow, ipcMain, Menu, screen } = require("electron");
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
app.setPath("userData", path.join(REPO_ROOT, "_probe", "hud-align-userdata"));

const report = { verdict: "fail" };

const sleep = (ms) => new Promise((r) => global.setTimeout(r, ms));

app.whenReady().then(async () => {
  const { bootHud } = require(path.join(REPO_ROOT, "whale-hud", "lib", "boot.cjs"));
  const { createLogger } = require(path.join(REPO_ROOT, "whale-hud", "lib", "log.cjs"));

  const log = createLogger({
    resolveDir: () => path.join(REPO_ROOT, "_probe", "hud-align-userdata"),
    consoleFallback: false,
  });

  const booted = bootHud({
    BrowserWindow, screen, ipcMain, app, Menu, log, port: args.port,
  });

  const win = booted.hudWindow.win;
  const run = (code) => win.webContents.executeJavaScript(code, true);

  await booted.hudWindow.loaded;
  await sleep(1200);

  // 量每个元素：盒子矩形 + 内部文字的行盒矩形
  report.geometry = await run(`(() => {
    const bar = document.getElementById("bar").getBoundingClientRect();
    const items = {};

    function measure(key, el) {
      if (!el) { items[key] = null; return; }
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      // 用 Range 量「文字实际占据的行盒」，它才反映视觉中心
      let textTop = null, textBottom = null;
      const hasText = el.firstChild && el.firstChild.nodeType === 3;
      if (hasText) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const rr = range.getBoundingClientRect();
        textTop = rr.top - bar.top;
        textBottom = rr.bottom - bar.top;
      } else {
        // 内部有子元素（如速度段的 val + unit），取它们并集
        const kids = [...el.children].map((k) => k.getBoundingClientRect());
        if (kids.length) {
          textTop = Math.min(...kids.map((k) => k.top)) - bar.top;
          textBottom = Math.max(...kids.map((k) => k.bottom)) - bar.top;
        }
      }
      items[key] = {
        boxTop: +(r.top - bar.top).toFixed(1),
        boxBottom: +(r.bottom - bar.top).toFixed(1),
        boxCenterY: +((r.top + r.bottom) / 2 - bar.top).toFixed(1),
        textTop: textTop === null ? null : +textTop.toFixed(1),
        textBottom: textBottom === null ? null : +textBottom.toFixed(1),
        textCenterY: textTop === null ? null : +((textTop + textBottom) / 2).toFixed(1),
        alignItems: cs.alignItems,
        lineHeight: cs.lineHeight,
        fontFamily: cs.fontFamily.split(",")[0],
        display: cs.display
      };
    }

    measure("whale", document.getElementById("whaleBtn"));
    measure("dot", document.getElementById("dot"));
    measure("title", document.getElementById("reel"));
    measure("speedBox", document.getElementById("segSpeed"));
    measure("speedVal", document.getElementById("spdVal"));
    measure("speedUnit", document.getElementById("segSpeed").querySelector(".unit"));
    measure("ctxBox", document.getElementById("segCtx"));
    measure("ctxVal", document.getElementById("ctxVal"));

    return {
      barTop: 0,
      barHeight: +bar.height.toFixed(1),
      barCenterY: +(bar.height / 2).toFixed(1),
      barDisplay: getComputedStyle(document.getElementById("bar")).display,
      barAlignItems: getComputedStyle(document.getElementById("bar")).alignItems,
      items
    };
  })()`);

  // 判定：每个有文字的元素的「文字视觉中心」与条中心的偏差
  const center = report.geometry.barCenterY;
  const checks = {};
  for (const key of ["speedVal", "speedUnit", "ctxVal", "title"]) {
    const it = report.geometry.items[key];
    if (!it || it.textCenterY === null) { checks[key] = null; continue; }
    checks[key] = {
      textCenterY: it.textCenterY,
      deltaFromBarCenter: +(it.textCenterY - center).toFixed(1),
    };
  }
  report.centering = checks;
  report.tolerance = 1.5;
  report.offCenter = Object.entries(checks)
    .filter(([, v]) => v !== null && Math.abs(v.deltaFromBarCenter) > report.tolerance)
    .map(([k, v]) => `${k} 偏 ${v.deltaFromBarCenter}px`);

  report.verdict = report.offCenter.length === 0 ? "pass" : "fail";
  console.log(`ALIGN_PROBE ${JSON.stringify(report)}`);
  app.exit(0);
});

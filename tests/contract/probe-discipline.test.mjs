/**
 * 验收探针纪律测试
 *
 * 职责：保证探针**只观察、不代劳**——它不能调用产品该调用的方法，
 *       也不能自己拼一套界面状态。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得一条测试：真出过一次严重事故。
 * 产品 `window.cjs` 因 lint 把 `rendererFile` 参数删掉、页面压根没加载，
 * 窗口全白；而探针里自己写了一句 `loadFile`，**替产品把页面加载了**，
 * 于是 11 项验收全绿、产品全白。绿灯给了虚假的信心，比没有测试更糟。
 *
 * 光靠注释提醒不够——注释不会拦人。所以把它变成断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PROBE = join(ROOT, "tools", "hud-probe.cjs");

const probeText = existsSync(PROBE) ? readFileSync(PROBE, "utf8") : "";

/** 去掉注释后的代码正文（注释里提到这些名字是允许的，那是解释）。 */
function codeOnly(text) {
  return text
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*");
    })
    .join("\n");
}

const probeCode = codeOnly(probeText);

test("探针文件存在", () => {
  assert.ok(probeText.length > 0, "找不到 tools/hud-probe.cjs");
});

/**
 * 「代劳」调用清单：这些方法的调用权属于产品装配（whale-hud/lib/boot.cjs）。
 * 探针调用它们，就等于替产品把界面拼出来了，产品缺这一步也测不出来。
 */
const FORBIDDEN_CALLS = [
  { pattern: /\.loadFile\s*\(/, why: "页面加载（产品 window.cjs 的职责）" },
  { pattern: /\.loadURL\s*\(/, why: "页面加载（产品 window.cjs 的职责）" },
  { pattern: /\.applyForm\s*\(/, why: "摆窗口位置（产品 boot.cjs 的职责）" },
  { pattern: /\.win\.show\s*\(/, why: "显示窗口（产品 boot.cjs 的职责）" },
  { pattern: /registerIpc\s*\(/, why: "装 IPC（产品 boot.cjs 的职责）" },
  { pattern: /createHudWindow\s*\(/, why: "建窗口（产品 boot.cjs 的职责）" },
  { pattern: /createHudState\s*\(/, why: "建状态机（产品 boot.cjs 的职责）" },
];

test("探针不调用任何「产品装配」方法（只观察，不代劳）", () => {
  const offenders = [];
  for (const { pattern, why } of FORBIDDEN_CALLS) {
    if (pattern.test(probeCode)) offenders.push(`${pattern.source} → 那是${why}`);
  }
  assert.deepEqual(
    offenders,
    [],
    `探针在替产品干活，会让产品缺陷测不出来：\n${offenders.join("\n")}`,
  );
});

test("探针走产品的装配路径（bootHud）", () => {
  assert.match(probeCode, /bootHud\s*\(/, "探针必须调用 bootHud，确保测的就是产品那条路");
});

test("负向验证：代劳调用确实会被规则抓到", () => {
  // 规则若写成空壳（永远通过），上面那条断言毫无意义
  const bad = [
    'hudWindow.win.loadFile("x.html");',
    "booted.hudWindow.applyForm('bar');",
    "registerIpc({ ipcMain });",
  ];
  const good = [
    "const booted = bootHud({ BrowserWindow });",
    "const bounds = hudWindow.bounds();",
    "await run(\"document.getElementById('collapseBtn').click()\");",
  ];
  const violates = (text) => FORBIDDEN_CALLS.some(({ pattern }) => pattern.test(codeOnly(text)));
  for (const s of bad) assert.equal(violates(s), true, `应判违规：${s}`);
  for (const s of good) assert.equal(violates(s), false, `不应判违规：${s}`);
});

test("探针带「白窗口」前置检查（否则界面全白也测不出来）", () => {
  assert.match(probeCode, /pageLooksRendered/, "必须有「页面真的渲染了」的判定");
  assert.match(probeCode, /failureReason/, "失败时必须给出可读真因，而不是只报 timeout");
});

test("探针的 executeJavaScript 带超时（无文档时会永久挂住）", () => {
  assert.match(probeCode, /runWithTimeout|Promise\.race/, "必须给脚本执行加超时");
});

test("产品侧的加载有超时兜底", () => {
  const winText = readFileSync(join(ROOT, "whale-hud", "lib", "window.cjs"), "utf8");
  assert.match(
    winText,
    /LOAD_TIMEOUT_MS/,
    "loadFile 被漏掉时 did-finish-load 永不触发，等它的人会永久挂住——必须带超时",
  );
  assert.match(winText, /win\.loadFile\s*\(/, "产品必须在建窗口时加载页面");
});

test("装配只有一处（main.cjs 与探针共用 boot.cjs）", () => {
  const mainText = readFileSync(join(ROOT, "whale-hud", "main.cjs"), "utf8");
  assert.match(codeOnly(mainText), /bootHud\s*\(/, "产品入口必须走 bootHud");
  assert.ok(
    !/createHudWindow\s*\(/.test(codeOnly(mainText)),
    "main.cjs 不该自己建窗口——装配只允许有一处，否则两份会不同步",
  );
});

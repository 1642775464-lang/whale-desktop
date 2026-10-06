/**
 * 验收探针纪律测试
 *
 * 职责：保证探针**只观察、不代劳**——它不能调用产品该调用的方法，
 *       也不能自己拼一套界面状态。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得一条测试：真出过一次严重事故。
 * 产品 `whale-hud/lib/window.cjs` 因 lint 把 `rendererFile` 参数删掉、
 * 页面压根没加载，窗口全白；而探针里自己写了一句 `loadFile`，
 * **替产品把页面加载了**，于是 11 项验收全绿、产品全白。
 * 绿灯给了虚假的信心，比没有测试更糟。
 *
 * 光靠注释提醒不够——注释不会拦人。所以把它变成断言，
 * 而且**两个探针（悬浮条 / 小窗）都要过同一条线**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 被检查的探针：每个都必须走产品的装配函数。 */
const PROBES = [
  { name: "悬浮条探针", file: join(ROOT, "tools", "hud-probe.cjs"), bootFn: "bootHud", product: "whale-hud" },
  { name: "小窗探针", file: join(ROOT, "tools", "window-probe.cjs"), bootFn: "bootWindow", product: "whale-window" },
];

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

/**
 * 「代劳」调用清单：这些方法的调用权属于产品装配（各产品的 lib/boot.cjs）。
 * 探针调用它们，就等于替产品把界面拼出来了，产品缺这一步也测不出来。
 */
const FORBIDDEN_CALLS = [
  { pattern: /\.loadFile\s*\(/, why: "页面加载（产品 window.cjs 的职责）" },
  { pattern: /\.loadURL\s*\(/, why: "页面加载（产品 window.cjs 的职责）" },
  { pattern: /\.applyForm\s*\(/, why: "摆窗口位置（产品 boot.cjs 的职责）" },
  { pattern: /\.togglePin\s*\(/, why: "切换置顶（产品 window.cjs 的职责）" },
  { pattern: /registerIpc\s*\(/, why: "装 IPC（产品 boot.cjs 的职责）" },
  { pattern: /createHudWindow\s*\(/, why: "建窗口（产品 boot.cjs 的职责）" },
  { pattern: /createHudState\s*\(/, why: "建状态机（产品 boot.cjs 的职责）" },
  { pattern: /createWindow\s*\(/, why: "建窗口（产品 boot.cjs 的职责）" },
  { pattern: /createRecovery\s*\(/, why: "建自愈状态机（产品 boot.cjs 的职责）" },
  { pattern: /createStateStore\s*\(/, why: "建状态存储（产品 boot.cjs 的职责）" },
];

for (const probe of PROBES) {
  const text = existsSync(probe.file) ? readFileSync(probe.file, "utf8") : "";
  const code = codeOnly(text);

  test(`${probe.name}存在`, () => {
    assert.ok(text.length > 0, `找不到 ${probe.file}`);
  });

  test(`${probe.name}不调用任何「产品装配」方法（只观察，不代劳）`, () => {
    const offenders = [];
    for (const { pattern, why } of FORBIDDEN_CALLS) {
      if (pattern.test(code)) offenders.push(`${pattern.source} → 那是${why}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `${probe.name}在替产品干活，会让产品缺陷测不出来：\n${offenders.join("\n")}`,
    );
  });

  test(`${probe.name}走产品的装配路径（${probe.bootFn}）`, () => {
    assert.match(code, new RegExp(`${probe.bootFn}\\s*\\(`), `必须调用 ${probe.bootFn}，确保测的就是产品那条路`);
  });

  test(`${probe.name}带「白窗口」前置检查（否则界面全白也测不出来）`, () => {
    assert.match(code, /pageLooksRendered/, "必须有「页面真的渲染了」的判定");
    assert.match(code, /failureReason/, "失败时必须给出可读真因，而不是只报 timeout");
  });

  test(`${probe.name}的脚本执行带超时（无文档时会永久挂住）`, () => {
    assert.match(code, /runWithTimeout|Promise\.race/, "必须给 executeJavaScript 加超时");
  });
}

test("负向验证：代劳调用确实会被规则抓到", () => {
  // 规则若写成空壳（永远通过），上面那些断言毫无意义
  const bad = [
    'hudWindow.win.loadFile("x.html");',
    "booted.hudWindow.applyForm('bar');",
    "registerIpc({ ipcMain });",
    'win.loadURL("data:text/html,x");',
  ];
  const good = [
    "const booted = bootHud({ BrowserWindow });",
    "const bounds = hudWindow.bounds();",
    "await run(\"document.getElementById('btnSend').click()\");",
  ];
  const violates = (t) => FORBIDDEN_CALLS.some(({ pattern }) => pattern.test(codeOnly(t)));
  for (const s of bad) assert.equal(violates(s), true, `应判违规：${s}`);
  for (const s of good) assert.equal(violates(s), false, `不应判违规：${s}`);
});

test("两个产品侧的加载都有超时兜底", () => {
  for (const product of ["whale-hud", "whale-window"]) {
    const winText = readFileSync(join(ROOT, product, "lib", "window.cjs"), "utf8");
    assert.match(
      winText,
      /LOAD_TIMEOUT_MS/,
      `${product}：loadFile 被漏掉时 did-finish-load 永不触发，等它的人会永久挂住`,
    );
    assert.match(winText, /\.loadFile\s*\(/, `${product}：必须在建窗口时加载页面`);
  }
});

test("装配各只有一处（产品入口与探针共用 boot）", () => {
  const cases = [
    { product: "whale-hud", entry: "main.cjs", bootFn: "bootHud", forbidden: /createHudWindow\s*\(/ },
    { product: "whale-window", entry: "main.cjs", bootFn: "bootWindow", forbidden: /createWindow\s*\(/ },
  ];
  for (const c of cases) {
    const mainText = codeOnly(readFileSync(join(ROOT, c.product, c.entry), "utf8"));
    assert.match(mainText, new RegExp(`${c.bootFn}\\s*\\(`), `${c.product} 入口必须走 ${c.bootFn}`);
    assert.ok(
      !c.forbidden.test(mainText),
      `${c.product} 入口不该自己建窗口——装配只允许有一处，否则两份会不同步`,
    );
  }
});

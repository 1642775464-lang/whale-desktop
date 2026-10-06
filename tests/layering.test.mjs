/**
 * 分层铁律测试
 *
 * 职责：把架构铁律做成可机械化检查的断言，防止悄悄破例。
 * 所属层：测试（tests/）
 *
 * 被看住的铁律（见 Whale-ARCHITECTURE.md）：
 *   A-1 呈现层不得 require `@deepseek-ai/` —— 呈现层只走 HTTP，不直连宿主
 *   A-2 唯一通路：桥监听 127.0.0.1，不绑 0.0.0.0
 *   A-3 纯函数模块不引 IO 依赖（fs / net / http / child_process）
 *   A-4 渲染层零框架零构建（不出现 import 第三方包）
 *
 * 这些规则靠「读源码文本」实现，故意做得直白——被破坏时能一眼看懂是哪条。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// 必须用 fileURLToPath：项目路径含中文，url.pathname 会给出 %XX 编码串
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 递归收集某目录下的全部文件（跳过不存在的目录）。 */
function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      walk(full, out);
    } else {
      out.push(full);
    }
  }
  return out;
}

/** 读文件文本；读不到给空串（目录可能尚未建立）。 */
function read(file) {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** 呈现层的源码文件：两个 Electron 客户端 + 按钮插件的渲染侧。 */
function presentationFiles() {
  const dirs = [
    join(ROOT, "whale-hud"),
    join(ROOT, "whale-window"),
    join(ROOT, "whale-button"),
  ];
  const files = [];
  for (const dir of dirs) {
    for (const file of walk(dir)) {
      if (/\.(mjs|cjs|js|html)$/.test(file)) files.push(file);
    }
  }
  return files;
}

/** 桥的渲染侧文件（client.js 会被打进宿主页面，同属呈现层）。 */
function bridgeClientFiles() {
  const file = join(ROOT, "whale-bridge", "lib", "client.js");
  return existsSync(file) ? [file] : [];
}

/**
 * 呈现层里「跑在 Electron 主进程」的文件。
 *
 * 这些文件 `require("electron")` 是**正当的**：Electron 是运行时而非第三方库，
 * 《开发规范》§3.1 也明确写了「悬浮条 / 小窗：Node 内置 + Electron」。
 * 铁律 A-4 管的是**渲染层零框架零构建**，不该把主进程一起网进去。
 *
 * 判定方式：renderer/ 下的文件是渲染层；其余 .cjs 是主进程侧。
 */
function isMainProcessFile(file) {
  const norm = file.replace(/\\/g, "/");
  return !norm.includes("/renderer/");
}

/** Electron 自身：主进程与 preload 允许引用，渲染层不允许。 */
const ELECTRON_PACKAGE = "electron";

/**
 * 收集某个文件的裸包引用（既非相对路径、也非 node: 内置、也非绝对路径）。
 *
 * @param {string} file
 * @returns {string[]}
 */
function bareImports(file) {
  const text = read(file)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
    .join("\n");
  return [...text.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)]
    .map((m) => m[1])
    .filter((spec) => !spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("/"));
}

test("A-1 呈现层不得 require/import 宿主包 @deepseek-ai/", () => {
  const offenders = [];
  for (const file of [...presentationFiles(), ...bridgeClientFiles()]) {
    const text = read(file);
    // 匹配 require("@deepseek-ai/...") 或 from "@deepseek-ai/..."
    if (/require\(\s*["']@deepseek-ai\//.test(text) || /from\s+["']@deepseek-ai\//.test(text)) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(offenders, [], `这些文件引了宿主包，违反铁律 A-1：\n${offenders.join("\n")}`);
});

test("A-1 负向验证：违规样例确实会被规则抓到", () => {
  // 直接测判定逻辑本身，确保规则不是「永远通过」的空壳
  const badSamples = [
    'const x = require("@deepseek-ai/dsh-session");',
    'import { y } from "@deepseek-ai/dsh-agent";',
    "const z = require('@deepseek-ai/dsh-commands');",
  ];
  const goodSamples = [
    'const x = require("node:fs");',
    'import { y } from "./lib/fold.mjs";',
    "fetch('http://127.0.0.1:19387/whale');",
    "// 注释里提到 @deepseek-ai/dsh-session 不算违规",
  ];
  const violates = (text) =>
    /require\(\s*["']@deepseek-ai\//.test(text) || /from\s+["']@deepseek-ai\//.test(text);

  for (const s of badSamples) assert.equal(violates(s), true, `应判违规：${s}`);
  for (const s of goodSamples) assert.equal(violates(s), false, `不应判违规：${s}`);
});

test("A-2 桥只绑回环地址，不出现 0.0.0.0", () => {
  const files = walk(join(ROOT, "whale-bridge")).filter((f) => /\.(mjs|cjs|js)$/.test(f));
  assert.ok(files.length > 0, "应能扫到桥的源码文件");

  const offenders = [];
  for (const file of files) {
    const text = read(file);
    // 0.0.0.0 出现在字符串字面量里才算绑地址；注释里提到不算
    const stripped = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    if (/["']0\.0\.0\.0["']/.test(stripped)) offenders.push(relative(ROOT, file));
  }
  assert.deepEqual(offenders, [], `这些文件绑了 0.0.0.0，违反铁律 A-2：\n${offenders.join("\n")}`);
});

test("A-3 纯函数模块不引 IO 依赖", () => {
  // 架构草案 §3 标为「纯函数、可脱离宿主单测」的模块
  const pureModules = [
    join(ROOT, "whale-bridge", "lib", "fold.mjs"),
    join(ROOT, "whale-bridge", "lib", "usage-stats.mjs"),
    join(ROOT, "whale-bridge", "lib", "zstd-frame.mjs"),
  ];
  const ioPattern = /from\s+["']node:(fs|net|http|https|child_process|os|dns)["']/;
  const offenders = [];

  for (const file of pureModules) {
    assert.ok(existsSync(file), `纯函数模块应存在：${relative(ROOT, file)}`);
    const stripped = read(file)
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    if (ioPattern.test(stripped)) offenders.push(relative(ROOT, file));
  }

  assert.deepEqual(offenders, [], `纯函数模块引了 IO 依赖，违反铁律 A-3：\n${offenders.join("\n")}`);
});

test("A-4 渲染层不 import 第三方包（零框架零构建）", () => {
  const offenders = [];
  for (const file of presentationFiles()) {
    if (file.endsWith(".html")) continue;
    // 只查渲染层：主进程侧引 electron 是正当的，由下一条单独管
    if (isMainProcessFile(file)) continue;
    for (const spec of bareImports(file)) {
      offenders.push(`${relative(ROOT, file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `渲染层引了第三方包，违反铁律 A-4：\n${offenders.join("\n")}`);
});

test("A-4 主进程侧只允许引 electron 与 node: 内置", () => {
  const offenders = [];
  for (const file of presentationFiles()) {
    if (file.endsWith(".html") || !isMainProcessFile(file)) continue;
    for (const spec of bareImports(file)) {
      if (spec === ELECTRON_PACKAGE) continue;
      offenders.push(`${relative(ROOT, file)} → ${spec}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `主进程侧引了 electron 之外的第三方包，违反铁律 A-4：\n${offenders.join("\n")}`,
  );
});

test("A-4 负向验证：裸包引用确实会被规则抓到", () => {
  // 规则若写成空壳（永远通过），上面两条断言就毫无意义
  const bad = ['require("lodash")', 'import x from "axios";', 'require("electron")'];
  const good = ['require("./lib/geometry.cjs")', 'import fs from "node:fs";', "const x = 1;"];
  const isBare = (spec) => !spec.startsWith(".") && !spec.startsWith("node:") && !spec.startsWith("/");
  const specs = (s) => [...s.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);

  for (const s of bad) assert.equal(specs(s).some(isBare), true, `应判为裸包：${s}`);
  for (const s of good) assert.equal(specs(s).some(isBare), false, `不应判为裸包：${s}`);
});

test("A-4 负向验证：渲染层与主进程侧的判定确实不同", () => {
  // 若 isMainProcessFile 永远返回 true/false，主进程那条豁免就会失效或过度放宽
  assert.equal(isMainProcessFile(join(ROOT, "whale-hud", "main.cjs")), true);
  assert.equal(isMainProcessFile(join(ROOT, "whale-hud", "preload.cjs")), true);
  assert.equal(isMainProcessFile(join(ROOT, "whale-hud", "renderer", "hud.js")), false);
});

test("桥的运行时依赖数为 0（宿主侧只许 node: 内置；浏览器侧另算）", () => {
  // 口径与 tools/scan-deps.mjs 的闸门 5 保持一致：
  //   · 宿主/主进程侧 → 只允许 node: 内置与相对路径
  //   · 浏览器侧（package.json 的 exports["./client"]）→ 允许宿主模块表的基线模块，
  //     但**禁止** node: 内置模块（浏览器里根本不存在，引了必崩）
  //
  // 为什么浏览器侧要另算：客户端半侧跑在页面里，Node 从不加载它。
  // 它 require("react") 是从宿主模块表取的，不是 npm 依赖
  // （本机同槽位的 dsh-agnes-image 同样写法、同样不声明 react 依赖）。
  const pkgDir = join(ROOT, "whale-bridge");
  const manifest = JSON.parse(read(join(pkgDir, "package.json")));
  const clientEntry = manifest.exports?.["./client"];
  const browserFile = typeof clientEntry === "string"
    ? join(pkgDir, clientEntry.replace(/^\.\//, ""))
    : null;

  const BROWSER_OK = new Set(["react", "react-dom", "react/jsx-runtime"]);
  const EVERYWHERE_OK = new Set(["electron"]);

  const files = walk(pkgDir).filter((f) => /\.(mjs|cjs|js)$/.test(f));
  const offenders = [];
  for (const file of files) {
    const text = read(file);
    const imports = [...text.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    const isBrowser = browserFile !== null && file === browserFile;
    for (const spec of imports) {
      if (spec.startsWith(".") || spec.startsWith("/")) continue;
      if (EVERYWHERE_OK.has(spec)) continue;
      if (isBrowser) {
        if (BROWSER_OK.has(spec)) continue;
        offenders.push(`${relative(ROOT, file)} → ${spec}（浏览器侧只许宿主模块表提供的模块）`);
        continue;
      }
      if (spec.startsWith("node:")) continue;
      offenders.push(`${relative(ROOT, file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `桥引入了外部依赖：\n${offenders.join("\n")}`);
});

test("浏览器侧确实存在且被正确识别（防止上一条断言变成空壳）", () => {
  // 若 exports["./client"] 丢了，上面那条会把 client.js 当宿主侧文件扫，
  // 于是 react 又被判违规——这条用来区分「口径生效」与「豁免落空」
  const manifest = JSON.parse(read(join(ROOT, "whale-bridge", "package.json")));
  assert.equal(manifest.exports?.["./client"], "./lib/client.js", "必须声明客户端入口");
  assert.equal(manifest.dsh?.client?.platform, "web", "客户端必须标 web 平台");
  const clientPath = join(ROOT, "whale-bridge", "lib", "client.js");
  assert.equal(existsSync(clientPath), true, "客户端文件必须真的存在");
  // 而且它确实 require 了 react —— 否则这条测试与上一条都没有实际约束力
  assert.match(read(clientPath), /require\(["']react["']\)/, "客户端应使用宿主模块表的 react");
});

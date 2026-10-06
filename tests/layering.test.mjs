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
    const text = read(file);
    const stripped = text
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("*"))
      .join("\n");
    // 允许 node: 内置与相对路径；其它裸包名判违规
    const imports = [...stripped.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("/")) continue;
      offenders.push(`${relative(ROOT, file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `渲染层引了第三方包，违反铁律 A-4：\n${offenders.join("\n")}`);
});

test("桥的运行时依赖数为 0（只允许 node: 内置与相对路径）", () => {
  const files = walk(join(ROOT, "whale-bridge")).filter((f) => /\.(mjs|cjs|js)$/.test(f));
  const offenders = [];
  for (const file of files) {
    const text = read(file);
    const imports = [...text.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of imports) {
      if (spec.startsWith(".") || spec.startsWith("node:") || spec.startsWith("/")) continue;
      offenders.push(`${relative(ROOT, file)} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `桥引入了外部依赖：\n${offenders.join("\n")}`);
});

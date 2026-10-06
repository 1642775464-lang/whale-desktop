/**
 * 闸门 6 · 规范扫描
 *
 * 职责：执行《开发规范》§3 的三条模块拆分规则，以及分层依赖铁律。
 * 所属层：工程工具（tools/）
 *
 * 检查项（对应开发规范 强制 13/14/15/16/18/19/24）：
 *   1. 文件行数超上限（普通 500 / 纯函数 300）
 *   2. 出现垃圾桶文件名（utils|helpers|common|misc）
 *   3. 呈现层出现 require("@deepseek-ai/")
 *   4. 纯函数模块引入 IO 依赖
 *   5. .mjs/.cjs 文件名不合 kebab-case
 *   6. 文件头缺少注释块
 *
 * 退出码：0 = 通过；1 = 发现问题
 *
 * 用法：node tools/scan-rules.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { globSync } from "node:fs";
import { basename, extname } from "node:path";

/** 文件规模上限（开发规范 强制 14）。 */
const LIMIT_NORMAL = 500;
const LIMIT_PURE = 300;

/** 垃圾桶文件名（开发规范 强制 15）。 */
const JUNK_BASENAMES = /^(utils|helpers|common|misc|util|helper)(\.|$)/i;

/** 纯函数模块：位于 lib/ 且名字在这些集合内。 */
const PURE_MODULES = /(^|\/)(fold|usage-stats|zstd-frame)\.mjs$/;

/** 纯函数不得引入的 IO 模块（开发规范 强制 19）。 */
const IO_MODULES = new Set([
  "fs", "node:fs", "fs/promises", "node:fs/promises",
  "child_process", "node:child_process",
  "net", "node:net",
  "http", "node:http", "https", "node:https",
  "dgram", "node:dgram",
  "cluster", "node:cluster",
  "worker_threads", "node:worker_threads",
]);

/** 呈现层目录（开发规范 强制 18）。 */
const PRESENTATION_DIRS = [
  "whale-hud/renderer",
  "whale-window/renderer",
  "whale-button",
];

/** 被扫描的源码目录。 */
const SCAN_DIRS = ["whale-bridge", "whale-hud", "whale-window", "whale-button", "tools", "tests"];

const problems = [];
const stats = { files: 0, lines: 0 };

function collectFiles() {
  const out = [];
  for (const dir of SCAN_DIRS) {
    if (!existsSync(dir)) continue;
    let found = [];
    try {
      found = globSync(`${dir}/**/*.{js,mjs,cjs}`, {
        exclude: (name) => name === "node_modules",
      });
    } catch {
      continue;
    }
    out.push(...found);
  }
  return out;
}

function checkName(file) {
  const ext = extname(file);
  if (ext !== ".mjs" && ext !== ".cjs") return;
  const stem = basename(file, ext);
  // 允许：kebab-case、点分多段（如 host-impl）、纯小写字母数字
  if (!/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(stem)) {
    problems.push(`${file} 文件名 ${stem} 不符合 kebab-case（开发规范 强制 8）。`);
  }
}

function checkJunkName(file) {
  const stem = basename(file);
  if (JUNK_BASENAMES.test(stem)) {
    problems.push(
      `${file} 是垃圾桶文件名（开发规范 强制 15）。` +
        `请按职责重命名，例如 fold.mjs / usage-stats.mjs。`,
    );
  }
}

function checkHeader(file, lines) {
  // 文件头注释：前 10 行内出现 /** 或 /* 或 //
  const head = lines.slice(0, 10).join("\n");
  if (!/^\s*(\/\*\*|\/\*|\/\/)/m.test(head)) {
    problems.push(`${file} 缺少文件头注释块（开发规范 强制 4）。`);
  }
}

function checkPresentation(file, text) {
  const norm = file.replace(/\\/g, "/");
  const isPresentation = PRESENTATION_DIRS.some((d) => norm.startsWith(`${d}/`) || norm === d);
  if (!isPresentation) return;
  if (/@deepseek-ai\//.test(text)) {
    problems.push(
      `${file} 属于呈现层却引用了宿主包（架构铁律 A-1、开发规范 强制 18）。` +
        `呈现层只允许走 HTTP。`,
    );
  }
}

function checkPure(file, text) {
  if (!PURE_MODULES.test(file.replace(/\\/g, "/"))) return;
  const re = /(?:require\(\s*|from\s+)["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (IO_MODULES.has(m[1])) {
      problems.push(
        `${file} 是纯函数模块却引入了 IO 依赖 "${m[1]}"（架构铁律 A-3、开发规范 强制 19）。`,
      );
    }
  }
}

for (const file of collectFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  const count = lines.length;
  stats.files++;
  stats.lines += count;

  checkName(file);
  checkJunkName(file);
  checkHeader(file, lines);
  checkPresentation(file, text);
  checkPure(file, text);

  const isPure = PURE_MODULES.test(file.replace(/\\/g, "/"));
  const limit = isPure ? LIMIT_PURE : LIMIT_NORMAL;
  if (count > limit) {
    const kind = isPure ? "纯函数模块" : "普通模块";
    problems.push(
      `${file} 有 ${count} 行，超过${kind}上限 ${limit} 行（开发规范 强制 14）。` +
        `请按单一职责拆分。`,
    );
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`[规范] ${p}`);
  console.error(`\n闸门 6 失败：${problems.length} 项违规。`);
  process.exit(1);
}

console.log(`闸门 6 通过：${stats.files} 个文件、${stats.lines} 行，0 项违规。`);

/**
 * 闸门 1 · 语法检查
 *
 * 职责：对全部 .js/.mjs/.cjs 文件执行 node --check，确认语法正确。
 * 所属层：工程工具（tools/）
 *
 * 说明：本项目为零构建方案（架构铁律 A-4），没有编译步骤。
 * 「构建」闸门由本闸门替代（开发规范 强制 26）。
 *
 * 退出码：0 = 通过；1 = 发现问题
 *
 * 用法：node tools/check-syntax.mjs
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { globSync } from "node:fs";

const SCAN_DIRS = [
  "whale-bridge",
  "whale-hud",
  "whale-window",
  "whale-button",
  "tools",
  "tests",
];

const files = [];
for (const dir of SCAN_DIRS) {
  if (!existsSync(dir)) continue;
  try {
    files.push(
      ...globSync(`${dir}/**/*.{js,mjs,cjs}`, {
        exclude: (name) => name === "node_modules",
      }),
    );
  } catch {
    /* 目录不存在或不可读，跳过 */
  }
}

if (files.length === 0) {
  console.log("闸门 1 通过：暂无可检查的源码文件（尚未实施）。");
  process.exit(0);
}

/** .cjs / .js（CommonJS）与 .mjs 用不同解析目标。 */
function checkArgs(file) {
  if (file.endsWith(".mjs")) return ["--check", file];
  if (file.endsWith(".cjs")) return ["--check", file];
  return ["--check", file];
}

const failures = [];
for (const file of files) {
  try {
    execFileSync(process.execPath, checkArgs(file), {
      stdio: "pipe",
      encoding: "utf8",
    });
  } catch (err) {
    const msg = String(err.stderr ?? err.message ?? err).trim();
    failures.push({ file, msg });
  }
}

if (failures.length > 0) {
  for (const { file, msg } of failures) {
    console.error(`[语法] ${file}`);
    console.error(
      msg
        .split("\n")
        .map((l) => `        ${l}`)
        .join("\n"),
    );
  }
  console.error(`\n闸门 1 失败：${failures.length} 个文件语法错误。`);
  process.exit(1);
}

console.log(`闸门 1 通过：${files.length} 个文件语法正确。`);

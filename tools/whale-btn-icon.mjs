/**
 * 按钮鲸鱼图标机械注入工具
 *
 * 职责：把 `whale-hud/renderer/favicon-whale.svg` 的 path 数据**机械地**
 *       注入 `whale-bridge/lib/client.js` 的标记块之间。
 * 所属层：工程工具（tools/）
 *
 * 为什么需要它（与 tools/whale-icon.mjs 同一理由）：
 *   PRD 明确写了那条 path 有 4KB 单行数据、**人抄必错**。我在写按钮时
 *   凭印象编了一段鲸鱼 path，形状与真图标完全不同——正是这条警告说的坑。
 *   所以抄写一律交给程序；契约测试比对注入结果与源文件，漂移立刻红。
 *
 * 与 whale-icon.mjs 的关系：那个工具管悬浮条的 index.html，
 * 这个管按钮的 client.js。两者共用同一个源文件与同一套抽取逻辑，
 * 保证同一产品里只有一枚鲸鱼。
 *
 * 用法：
 *   node tools/whale-btn-icon.mjs            # 就地更新 client.js
 *   node tools/whale-btn-icon.mjs --check    # 只校验、不写（CI 用）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { SVG_FILE, extractWhalePath } from "./whale-icon.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 注入目标：按钮的客户端半侧。 */
export const CLIENT_FILE = path.join(ROOT, "whale-bridge", "lib", "client.js");

/** 标记块：工具只改这两个标记之间的内容。 */
export const MARKERS = Object.freeze({
  start: "/* WHALE_BTN_ICON_START */",
  end: "/* WHALE_BTN_ICON_END */",
});

/**
 * 把 path 数据渲染成一行 JS 声明。
 *
 * 用 `const` + 双引号：path 里只有数字、字母、空格与逗号，不含引号，
 * 所以不需要转义。万一将来含了引号，下面的断言会拦住而不是写出坏代码。
 *
 * @param {{d: string}} icon
 * @returns {string}
 */
export function renderPathDecl(icon) {
  if (icon.d.includes('"') || icon.d.includes("\\")) {
    throw new Error("path 含引号或反斜杠，需要转义处理（当前实现假定不含）");
  }
  return `const WHALE_PATH_D = "${icon.d}";`;
}

/**
 * 计算当前应当注入的内容。
 * @returns {string}
 */
export function expectedDecl() {
  return renderPathDecl(extractWhalePath(readFileSync(SVG_FILE, "utf8")));
}

/**
 * 取出 client.js 里当前注入的内容。
 *
 * @param {string} text
 * @returns {string | null}
 */
export function currentDecl(text) {
  const { start, end } = MARKERS;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return text.slice(from + start.length, to).trim();
}

/**
 * 把注入内容写进标记之间。
 *
 * @param {string} text
 * @param {string} decl
 * @returns {string}
 */
export function spliceDecl(text, decl) {
  const { start, end } = MARKERS;
  const from = text.indexOf(start);
  const to = text.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`client.js 缺少标记块 ${start} … ${end}`);
  }
  const head = text.slice(0, from + start.length);
  const tail = text.slice(to);
  return `${head}\n    ${decl}\n    ${tail}`;
}

/** CLI。 */
function main() {
  const checkOnly = process.argv.includes("--check");

  if (!existsSync(SVG_FILE)) {
    console.error(`[按钮图标] 找不到源文件：${SVG_FILE}`);
    process.exit(1);
  }
  if (!existsSync(CLIENT_FILE)) {
    console.error(`[按钮图标] 找不到目标：${CLIENT_FILE}`);
    process.exit(1);
  }

  const text = readFileSync(CLIENT_FILE, "utf8");
  const want = expectedDecl();
  const have = currentDecl(text);

  if (checkOnly) {
    if (have === want) {
      console.log("按钮鲸鱼图标：注入结果与源文件一致。");
      process.exit(0);
    }
    console.error("按钮鲸鱼图标：与 favicon-whale.svg 不一致，请运行 node tools/whale-btn-icon.mjs");
    process.exit(1);
  }

  if (have === want) {
    console.log("按钮鲸鱼图标：已是最新，无需改动。");
    process.exit(0);
  }

  writeFileSync(CLIENT_FILE, spliceDecl(text, want), "utf8");
  console.log("按钮鲸鱼图标：已按 favicon-whale.svg 注入。");
}

// 仅在被直接执行时跑 CLI（被 import 时不跑）
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

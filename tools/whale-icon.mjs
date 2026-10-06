/**
 * 鲸鱼图标内联工具
 *
 * 职责：把 `whale-hud/renderer/favicon-whale.svg` 的 path 数据**机械地**
 *       内联进 `renderer/index.html` 的标记块之间。
 * 所属层：工程工具（tools/）
 *
 * 为什么要有这个工具：PRD 明确写「不要试图手抄或用 edit 替换整串，会抄错」。
 * 那条 path 有 4KB 单行数据，人抄必错。所以抄写这件事交给程序，
 * 只在需要时重跑一次；`tests/contract/hud-renderer.test.mjs` 会比对
 * 内联结果与源文件是否一致，一旦漂移立刻红。
 *
 * 为什么不做成运行时加载：CSP 是 `default-src 'none'`，
 * 页面既不能 fetch 本地 svg，用 `<img>` 又没法用 CSS 改填充色
 * （图标底色是浅紫渐变，必须配深色鲸鱼，见《悬浮窗-PRD》F2 的配色硬约束）。
 * 内联是唯一能让 `fill` 走 CSS 变量的做法。
 *
 * 用法：
 *   node tools/whale-icon.mjs            # 就地更新 index.html
 *   node tools/whale-icon.mjs --check    # 只校验、不写（CI 用）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 图标源文件（官方 favicon，未经改动）。 */
export const SVG_FILE = path.join(ROOT, "whale-hud", "renderer", "favicon-whale.svg");

/** 内联目标。 */
export const HTML_FILE = path.join(ROOT, "whale-hud", "renderer", "index.html");

/** 标记块：工具只改这两个标记之间的内容，其余部分一个字都不动。 */
export const MARKERS = Object.freeze({
  start: "<!-- WHALE_ICON_START -->",
  end: "<!-- WHALE_ICON_END -->",
});

/**
 * 从 svg 文本里取出 path 的 `d` 与 viewBox。
 *
 * 取不到就抛错——宁可不生成，也不要生成一个空图标（空图标在界面上
 * 表现为「鲸鱼不见了」，很难联想到是工具没取到数据）。
 *
 * @param {string} svgText
 * @returns {{d: string, viewBox: string}}
 */
export function extractWhalePath(svgText) {
  const dMatch = /<path\b[^>]*\sd="([^"]+)"/.exec(svgText);
  if (dMatch === null) throw new Error("svg 里找不到 <path d=\"...\">");
  const vbMatch = /viewBox="([^"]+)"/.exec(svgText);
  return { d: dMatch[1], viewBox: vbMatch === null ? "0 0 50 50" : vbMatch[1] };
}

/**
 * 生成内联 SVG 块。
 *
 * `fill="none"` 写在 svg 上、真正的填充色交给 CSS（`.whale svg path{fill:var(--ink)}`），
 * 这样换配色时不用动图标数据。
 *
 * @param {{d: string, viewBox: string}} icon
 * @returns {string}
 */
export function renderInlineIcon(icon) {
  return [
    `<svg class="ico-whale" viewBox="${icon.viewBox}" fill="none" aria-hidden="true" focusable="false">`,
    `          <path d="${icon.d}" />`,
    "        </svg>",
  ].join("\n");
}

/**
 * 把内联块写进 html 的标记之间。
 *
 * @param {string} html
 * @param {string} block
 * @returns {string}
 */
export function spliceIcon(html, block) {
  const { start, end } = MARKERS;
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    throw new Error(`index.html 缺少标记块 ${start} … ${end}`);
  }
  const head = html.slice(0, from + start.length);
  const tail = html.slice(to);
  return `${head}\n        ${block}\n        ${tail}`;
}

/** 当前应当内联的块（读源文件算出来）。 */
export function expectedBlock() {
  return renderInlineIcon(extractWhalePath(readFileSync(SVG_FILE, "utf8")));
}

/**
 * 取出 html 里当前内联的块。
 *
 * @param {string} html
 * @returns {string | null}
 */
export function currentBlock(html) {
  const { start, end } = MARKERS;
  const from = html.indexOf(start);
  const to = html.indexOf(end);
  if (from === -1 || to === -1 || to < from) return null;
  return html.slice(from + start.length, to).trim();
}

/** CLI。 */
function main() {
  const checkOnly = process.argv.includes("--check");

  if (!existsSync(SVG_FILE)) {
    console.error(`[图标] 找不到源文件：${SVG_FILE}`);
    process.exit(1);
  }
  if (!existsSync(HTML_FILE)) {
    console.error(`[图标] 找不到目标：${HTML_FILE}`);
    process.exit(1);
  }

  const html = readFileSync(HTML_FILE, "utf8");
  const want = expectedBlock();
  const have = currentBlock(html);

  if (checkOnly) {
    if (have === want) {
      console.log("鲸鱼图标：内联结果与源文件一致。");
      process.exit(0);
    }
    console.error("鲸鱼图标：内联结果与 favicon-whale.svg 不一致，请运行 node tools/whale-icon.mjs");
    process.exit(1);
  }

  if (have === want) {
    console.log("鲸鱼图标：已是最新，无需改动。");
    process.exit(0);
  }

  writeFileSync(HTML_FILE, spliceIcon(html, want), "utf8");
  console.log("鲸鱼图标：已按 favicon-whale.svg 重新内联。");
}

// 仅在被直接执行时跑 CLI（被 import 时不跑）
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

/**
 * 菜单图标机械提取工具
 *
 * 职责：从 DSH 安装包里**解析**出主窗口＋号菜单那 7 行用的图标 path 数据，
 *       生成 `whale-window/renderer/menu-icons.js`（浏览器 script，内联 SVG）。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须机械提取（而不是照着截图手画）：
 *   用户裁定「照 DSH 主窗口那套图标像素级复刻」。而本项目的规矩是
 *   **禁止手抄源码 SVG**（`whale-icon.mjs` 的头注释原话：「不要试图手抄或用
 *   edit 替换整串，会抄错」）。目标的图标含 4 条 path、其中一条有 20 多个
 *   坐标点，手抄必错。所以抄写交给程序。
 *
 * 为什么数据源是 `dsh-client-ui-primitives`：
 *   主窗口的菜单行由 `@deepseek-ai/dsh-client-ui-commands` 组装，
 *   它的 `HOST_FACES` 把每个内置命令绑到 primitives 包里的一个图标组件
 *   （如 `goal → IconGoalOutlineRegular`）。图标 path 的本体（Artwork）
 *   就在 primitives 包内。契约测试会比对该包与 DSH 的 bundle 是否一致，
 *   所以这里读到的是**运行时真正渲染的那一套**，不是死代码。
 *
 * 为什么保留逐条属性差异：
 *   Artwork 里每条 path 的绘制方式并不统一——多数是 `stroke: currentColor`，
 *   但计划的清单框是 `fill`、权限盾牌带 `strokeLinejoin: round`、压缩的
 *   圆环带 `opacity: 0.35`。一律当 stroke 处理会让复刻走样。
 *
 * 用法：
 *   node tools/whale-menu-icons.mjs            # 就地更新 menu-icons.js
 *   node tools/whale-menu-icons.mjs --check    # 只校验、不写（CI 用）
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  COMMANDS_FILE,
  DSH_APP_DIR,
  LABEL_SOURCES,
  MENU_DESCRIPTIONS,
  MENU_LABELS,
  MENU_ROWS,
  MENU_SECTIONS,
  MODEL_FILE,
  OUT_FILE,
  PRIMITIVES_FILE,
  readZhEntry,
} from "./whale-menu-spec.mjs";

/**
 * 规格（菜单有哪些行、用哪个图标、文案是什么）在 whale-menu-spec.mjs；
 * 本文件只管**机制**：怎么从 DSH 包里把 path 数据抠出来、怎么生成模块。
 * 这里原样再导出一次，调用方（契约测试）只需认这一个入口。
 */
export {
  COMMANDS_FILE,
  DSH_APP_DIR,
  LABEL_SOURCES,
  MENU_DESCRIPTIONS,
  MENU_LABELS,
  MENU_ROWS,
  MENU_SECTIONS,
  MODEL_FILE,
  OUT_FILE,
  PRIMITIVES_FILE,
  readZhEntry,
};

/*
 * 规格（MENU_ROWS / MENU_SECTIONS / LABELS / DESCRIPTIONS / LABEL_SOURCES /
 * readZhEntry）在 whale-menu-spec.mjs；本文件只管**机制**：
 * 怎么从 DSH 包里抠出 path 数据、怎么生成 menu-icons.js。
 * 文件顶部已把它们原样再导出，调用方仍只需认这一个入口。
 */

/**
 * 从源码里抠出一个函数的函数体源码。
 *
 * ⚠️ 不能简单地「从声明处往后找第一个 `{` 再配对」。真实踩过：
 * Artwork 的写法是 `const X = ({ size = 16, ... }) => jsx("svg", {`，
 * **第一个 `{` 是参数解构**，配到参数结束就停了，于是抠出来的是
 * `{ size = 16, className, strokeWidth }` —— 后面报「找不到 viewBox」，
 * 看着像数据源不对，其实是定位错了位置。
 *
 * 所以分两步：先跨过参数列表，再看 `=>` 之后。
 * 另外 Artwork 是**表达式体**（`=> jsx(...)`，没有外层花括号），
 * 这种要一路配到 `jsx(...)` 的右括号为止。
 *
 * @param {string} src
 * @param {string} name
 * @returns {string}
 */
export function extractFunctionBody(src, name) {
  const decl = new RegExp(`(?:const|let|function)\\s+${name}\\b`).exec(src);
  if (decl === null) throw new Error(`源码里找不到 ${name}`);

  // 跨过参数列表：从声明处找到配对的那个右括号（`(props)` / `({ size = 16 })`）
  const parenAt = src.indexOf("(", decl.index);
  if (parenAt === -1) throw new Error(`${name} 没有参数列表`);
  let pdepth = 0;
  let parenEnd = -1;
  for (let i = parenAt; i < src.length; i += 1) {
    if (src[i] === "(") pdepth += 1;
    else if (src[i] === ")") {
      pdepth -= 1;
      if (pdepth === 0) { parenEnd = i; break; }
    }
  }
  if (parenEnd === -1) throw new Error(`${name} 的参数列表括号不配对`);

  const after = src.slice(parenEnd + 1);
  // ⚠️ 箭头**只能在参数列表后面紧挨着看**，不能在整个剩余源码里 indexOf("=>")。
  // 真实踩过：函数体里（或十万字符之后的别处）出现 `=>` 时，会把起点
  // 挪到那个位置去，抠出一段完全无关的代码。
  let k = 0;
  while (k < after.length && /\s/.test(after[k])) k += 1;
  const hasArrow = after.startsWith("=>", k);
  const startAt = parenEnd + 1 + (hasArrow ? k + 2 : 0);

  let i = startAt;
  while (i < src.length && /\s/.test(src[i])) i += 1;

  if (src[i] === "{") {
    // 花括号体：正常配对
    let depth = 0;
    for (let j = i; j < src.length; j += 1) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") {
        depth -= 1;
        if (depth === 0) return src.slice(i, j + 1);
      }
    }
    throw new Error(`${name} 的大括号没有配对`);
  }

  // 表达式体（`=> jsx("svg", {...})`）：配到 jsx(...) 的右括号
  const callParen = src.indexOf("(", i);
  if (callParen === -1) throw new Error(`${name} 的函数体既不是块也不是调用`);
  let cdepth = 0;
  for (let j = callParen; j < src.length; j += 1) {
    if (src[j] === "(") cdepth += 1;
    else if (src[j] === ")") {
      cdepth -= 1;
      if (cdepth === 0) return src.slice(i, j + 1);
    }
  }
  throw new Error(`${name} 的调用括号不配对`);
}

/**
 * @typedef {object} ArtworkPath
 * @property {string} d 路径数据
 * @property {"stroke"|"fill"} mode 绘制方式
 * @property {Array<[string, string]>} attrs 其它需要保留的绘制属性
 */

/**
 * path 上除 `d` 外、需要照搬的绘制属性：JSX 名 → SVG 名。
 *
 * 用**白名单 + 通用照搬**而不是逐条 if：Artwork 里的属性组合并不统一
 * （压缩的圆环带 opacity、权限的盾牌带 strokeLinejoin、模型的数据库图标
 * 带 strokeMiterlimit），漏掉一个不会报错，只是那一笔画得跟主窗口不一样，
 * 属于最难发现的复刻偏差。将来 DSH 换了写法，这里补一个名字即可。
 */
const ATTR_NAME_MAP = Object.freeze({
  opacity: "opacity",
  strokeLinejoin: "stroke-linejoin",
  strokeMiterlimit: "stroke-miterlimit",
  strokeLinecap: "stroke-linecap",
});

/**
 * @typedef {object} Artwork
 * @property {string} viewBox
 * @property {ArtworkPath[]} paths
 */

/**
 * 解析一个 Artwork 函数里的 viewBox 与全部 path。
 *
 * 每条 path 保留它的绘制属性差异（stroke / fill / opacity / strokeLinejoin /
 * strokeMiterlimit…）。一个都没有就抛错——宁可不生成，也不要生成一个空图标
 * （空图标在界面上表现为「图标不见了」，很难联想到是提取没取到数据）。
 *
 * @param {string} body
 * @param {string} name
 * @returns {Artwork}
 */
export function parseArtwork(body, name) {
  const vb = /viewBox:\s*"([^"]+)"/.exec(body);
  if (vb === null) throw new Error(`${name} 里找不到 viewBox`);

  const paths = [];
  // 每个 path 都是 jsx("path", { ... })，抠出后面的属性对象
  const re = /jsx\(\s*"path"\s*,\s*\{/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let end = start;
    for (; end < body.length; end += 1) {
      if (body[end] === "{") depth += 1;
      else if (body[end] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const obj = body.slice(start, end);
    const d = /(?:^|\s|,)d:\s*"([^"]+)"/.exec(obj);
    if (d === null) continue;

    // 判定绘制方式：出现 `fill: "currentColor"` 就是填充，否则描边。
    // 注意不能拿「有没有 stroke」来反推——第二条 path 往往**同时**带
    // stroke 与 strokeMiterlimit，那样会把它误判成填充。
    const isFill = /(?:^|\s|,)fill:\s*"currentColor"/.test(obj);

    const attrs = [];
    for (const jsxName of Object.keys(ATTR_NAME_MAP)) {
      const hit = new RegExp(`(?:^|\\s|,)${jsxName}:\\s*"([^"]+)"`).exec(obj);
      if (hit !== null) attrs.push([ATTR_NAME_MAP[jsxName], hit[1]]);
    }

    paths.push({ d: d[1], mode: isFill ? "fill" : "stroke", attrs });
  }
  if (paths.length === 0) throw new Error(`${name} 里一条 path 都没解析出来`);
  return { viewBox: vb[1], paths };
}

/**
 * 校验 commands 包的 HOST_FACES 与我们的绑定表没漂移。
 *
 * 这是「主窗口用的到底是哪个图标」的唯一凭据；DSH 换代把图标换掉时，
 * 这里会立刻红，而不是小窗悄悄画着上一版的图。
 *
 * @param {string} src commands 包的 client.js 源码
 * @returns {Map<string, string>} 命令名 → 图标组件名
 */
export function parseHostFaces(src) {
  const faces = new Map();
  const re = /hostFace\(\s*"([^"]+)"\s*,\s*[\w$.]*\.(\w+)\s*\)/g;
  let m;
  while ((m = re.exec(src)) !== null) faces.set(m[1], m[2]);
  if (faces.size === 0) throw new Error("commands 包里没解析到 HOST_FACES");
  return faces;
}

/** 按 MENU_ROWS 把全部图标数据取出来。 */
export function collectIcons() {
  if (!existsSync(PRIMITIVES_FILE)) {
    throw new Error(`找不到图标数据源：${PRIMITIVES_FILE}`);
  }
  const src = readFileSync(PRIMITIVES_FILE, "utf8");
  const faces = existsSync(COMMANDS_FILE)
    ? parseHostFaces(readFileSync(COMMANDS_FILE, "utf8"))
    : new Map();

  return MENU_ROWS.map((row) => {
    // 有宿主命令的行：核对主窗口绑的组件没变
    if (row.host !== null && faces.size > 0) {
      const want = faces.get(row.host);
      if (want !== undefined && want !== row.regular) {
        throw new Error(
          `图标绑定漂移：主窗口的 ${row.host} 现在用 ${want}，本工具记的是 ${row.regular}`,
        );
      }
    }
    const icon = parseArtwork(extractFunctionBody(src, row.artwork), row.artwork);
    return { ...row, ...icon };
  });
}

/** 把一条 path 渲染成 SVG 子元素。 */
function renderPath(p) {
  const parts = [`<path d="${p.d}"`];
  parts.push(p.mode === "fill" ? ' fill="currentColor"' : ' stroke="currentColor"');
  for (const [name, value] of p.attrs) parts.push(` ${name}="${value}"`);
  parts.push(" />");
  return parts.join("");
}

/**
 * 把一个普通对象渲染成带缩进的字面量块，并补上尾逗号。
 *
 * ⚠️ 必须补尾逗号：生成物会被 eslint 扫，`comma-dangle` 会因为最后一行
 * 缺逗号报错。改生成物没用（下次重跑覆盖），只能在生成器里修。
 *
 * @param {Record<string, string>} obj
 * @returns {string}
 */
function jsonBlock(obj) {
  const text = JSON.stringify(obj, null, 2);
  // 给最后一项补尾逗号（eslint comma-dangle），再整体缩进两格
  return text
    .replace(/\n(\s*)\}$/, ",\n$1}")
    .split("\n")
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join("\n");
}

/** 生成 menu-icons.js 的完整内容。 */
export function renderModule(icons) {
  const lines = [];
  lines.push("/**");
  lines.push(" * 菜单图标（内联 SVG path 数据）");
  lines.push(" *");
  lines.push(" * 职责：给 ＋ 菜单那 7 行提供图标 —— 与 DSH 主窗口用的**同一套 path 数据**。");
  lines.push(" * 所属层：小窗（whale-window/renderer）");
  lines.push(" *");
  lines.push(" * ⚠️ **本文件由 tools/whale-menu-icons.mjs 机械生成，不要手改。**");
  lines.push(" * 手改会在契约测试（tests/contract/menu-icons.test.mjs）里立刻红，");
  lines.push(" * 因为那份测试会把这里的内容与 DSH 安装包里解析出来的结果逐字比对。");
  lines.push(" *");
  lines.push(" * 为什么内联而不是加载文件：CSP 是 default-src 'none'，页面既不能");
  lines.push(" * fetch 本地 svg，用 <img> 又没法让图标继承 currentColor（换主题就废）。");
  lines.push(" *");
  lines.push(" * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleMenuIcons。");
  lines.push(" */");
  lines.push("");
  lines.push("(function attachMenuIcons(global) {");
  lines.push('  "use strict";');
  lines.push("");
  lines.push("  /** 图标 path 数据：键为菜单行标识，值为内联 svg 的字符串。 */");
  lines.push("  const ICONS = Object.freeze({");
  for (const icon of icons) {
    const body = icon.paths.map(renderPath).join("");
    const svg =
      `<svg class="ov-ico" viewBox="${icon.viewBox}" width="${icon.size}" height="${icon.size}" ` +
      `fill="none" aria-hidden="true" focusable="false">${body}</svg>`;
    lines.push(`    ${icon.key}:`);
    lines.push(`      '${svg}',`);
  }
  lines.push("  });");
  lines.push("");
  lines.push("  /** 分组顺序与标题（与主窗口菜单一致）。 */");
  lines.push("  const SECTIONS = Object.freeze([");
  lines.push(`    { name: "add", label: "添加", rows: Object.freeze(${JSON.stringify(MENU_SECTIONS.add)}) },`);
  lines.push(`    { name: "commands", label: "指令", rows: Object.freeze(${JSON.stringify(MENU_SECTIONS.commands)}) },`);
  lines.push("  ]);");
  lines.push("");
  lines.push("  /** 本地化标题：主窗口的菜单行显示中文，不是宿主返回的英文描述。 */");
  lines.push(`  const LABELS = Object.freeze(${jsonBlock(MENU_LABELS)});`);
  lines.push("");
  lines.push("  /** 本地化说明（同上）。 */");
  lines.push(`  const DESCRIPTIONS = Object.freeze(${jsonBlock(MENU_DESCRIPTIONS)});`);
  lines.push("");
  lines.push("  /**");
  lines.push("   * 取一个菜单行的图标 svg。");
  lines.push("   *");
  lines.push("   * 取不到返回空串（而不是抛错）：图标是装饰，缺了不该让菜单整片打不开。");
  lines.push("   * 契约测试会保证 7 个键都在。");
  lines.push("   *");
  lines.push("   * @param {string} key 菜单行标识");
  lines.push("   * @returns {string}");
  lines.push("   */");
  lines.push("  function iconOf(key) {");
  lines.push("    return ICONS[key] ?? \"\";");
  lines.push("  }");
  lines.push("");
  lines.push("  global.WhaleMenuIcons = { DESCRIPTIONS, ICONS, LABELS, SECTIONS, iconOf };");
  lines.push("})(typeof window !== \"undefined\" ? window : globalThis);");
  lines.push("");
  return lines.join("\n");
}

/** 当前应当生成的内容。 */
export function expectedSource() {
  return renderModule(collectIcons());
}

/** CLI。 */
function main() {
  const checkOnly = process.argv.includes("--check");

  let want;
  try {
    want = expectedSource();
  } catch (err) {
    console.error(`[菜单图标] 提取失败：${err.message}`);
    process.exit(1);
  }

  const have = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : null;

  if (checkOnly) {
    if (have === want) {
      console.log("菜单图标：与 DSH 主窗口的图标数据一致。");
      process.exit(0);
    }
    console.error("菜单图标：menu-icons.js 与 DSH 的图标数据不一致，请运行 node tools/whale-menu-icons.mjs");
    process.exit(1);
  }

  if (have === want) {
    console.log("菜单图标：已是最新，无需改动。");
    process.exit(0);
  }

  writeFileSync(OUT_FILE, want, "utf8");
  console.log(`菜单图标：已按 DSH 安装包重新提取（${MENU_ROWS.length} 个）。`);
}

// 仅在被直接执行时跑 CLI（被 import 时不跑）
if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

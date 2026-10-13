/**
 * 文件预览的类型判定
 *
 * 职责：按文件名/扩展名决定「这个文件该用哪种方式预览」——纯计算。
 * 所属层：小窗（whale-window/lib）
 *
 * ## 用户要求
 *
 * > 默认展示当前会话工作区的文件列表及文件内容，需要支持点击进行预览
 * > （md 文件、js 文件、图片、视频、音频、word、txt，html 则直接打开侧边栏的浏览器预览）
 *
 * 所以分类是明确的七类，映射到四种呈现方式：
 *
 * | 方式 | 用在哪 | 说明 |
 * |---|---|---|
 * | `text` | md / 代码 / txt | 取文本内容渲染（md 出排版） |
 * | `image` | png/jpg/gif/webp/svg | 直接给 `<img>` |
 * | `media` | mp4/webm、mp3/wav… | 直接给 `<video>` / `<audio>` |
 * | `browser` | html | 转给侧边栏浏览器（那里有平板 UA） |
 * | `system` | word / 其它二进制 | 用系统默认程序打开（浏览器渲染 word 要额外库） |
 *
 * ⚠️ 判定顺序有讲究：**html 先于 text** —— 它俩都是「文本」，但 html 要交给
 * 浏览器渲染，当成文本显示源码不是用户要的。
 *
 * 本模块不 require 任何东西，可脱离 Electron 单测。
 */

"use strict";

/** 代码/文本类扩展名（按文本渲染）。 */
const TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "log", "json", "jsonc", "yaml", "yml", "toml",
  "ini", "conf", "cfg", "env", "csv", "tsv",
  "js", "mjs", "cjs", "jsx", "ts", "tsx", "vue", "svelte",
  "css", "scss", "less", "html", "htm", "xhtml",
  "py", "rb", "go", "rs", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs",
  "sh", "bash", "zsh", "ps1", "bat", "cmd", "sql", "xml", "svg",
]);

/** 图片类扩展名。 */
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif"]);

/** 视频类扩展名。 */
const VIDEO_EXT = new Set(["mp4", "webm", "ogv", "mov", "m4v", "mkv"]);

/** 音频类扩展名。 */
const AUDIO_EXT = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus"]);

/** 富文本文档（需要额外渲染库，故交系统打开）。 */
const DOC_EXT = new Set(["doc", "docx", "rtf", "odt", "xls", "xlsx", "ppt", "pptx", "pdf"]);

/**
 * 取小写扩展名（无扩展名给空串）。
 *
 * @param {string} name 文件名或路径
 * @returns {string}
 */
function extOf(name) {
  const s = String(name ?? "");
  const base = s.split(/[/\\]/).pop() ?? "";
  const i = base.lastIndexOf(".");
  if (i <= 0 || i === base.length - 1) return "";
  return base.slice(i + 1).toLowerCase();
}

/**
 * 判定预览方式。
 *
 * @param {string} name 文件名（或路径）
 * @returns {{mode: "text"|"image"|"video"|"audio"|"browser"|"system", ext: string,
 *            markdown: boolean, language: string}}
 *   `language` 给代码高亮/文件名标注用（不做语法高亮，只用于展示标签）
 */
function previewModeOf(name) {
  const ext = extOf(name);

  // ⚠️ html 必须先判：它也在 TEXT_EXT 里，但要走浏览器而不是文本
  if (ext === "html" || ext === "htm" || ext === "xhtml") {
    return { mode: "browser", ext, markdown: false, language: "html" };
  }
  if (IMAGE_EXT.has(ext)) {
    return { mode: "image", ext, markdown: false, language: "" };
  }
  if (VIDEO_EXT.has(ext)) {
    return { mode: "video", ext, markdown: false, language: "" };
  }
  if (AUDIO_EXT.has(ext)) {
    return { mode: "audio", ext, markdown: false, language: "" };
  }
  if (DOC_EXT.has(ext)) {
    return { mode: "system", ext, markdown: false, language: "" };
  }
  if (TEXT_EXT.has(ext)) {
    return { mode: "text", ext, markdown: ext === "md" || ext === "markdown", language: ext };
  }
  /*
   * 不认识的扩展名：**按系统打开**而不是猜成文本。
   * 猜错会把二进制内容当文本渲染，界面出现一堆乱码方块。
   */
  return { mode: "system", ext, markdown: false, language: "" };
}

/**
 * 是否可在侧边栏内预览（不可预览的要给出「用系统打开」的出路）。
 *
 * @param {string} name
 * @returns {boolean}
 */
function isPreviewable(name) {
  return previewModeOf(name).mode !== "system";
}

/**
 * MIME 类型（给 `<img>`/`<video>`/`<audio>` 的 data URL 用）。
 *
 * @param {string} ext
 * @returns {string}
 */
function mimeOf(ext) {
  const e = String(ext ?? "").toLowerCase();
  const table = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    ico: "image/x-icon",
    avif: "image/avif",
    mp4: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    mov: "video/quicktime",
    m4v: "video/x-m4v",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    m4a: "audio/mp4",
    aac: "audio/aac",
    flac: "audio/flac",
    opus: "audio/opus",
  };
  return table[e] ?? "application/octet-stream";
}

/**
 * 把文本渲染成安全的 HTML（markdown 的**最小**处理）。
 *
 * ⚠️ 只做「够 md 看」的几件事：转义、标题、粗体、行内代码、代码块、列表、换行。
 * 不引入 markdown 库（那是新依赖），也不追求完整语法 —— 目的只是「能读」。
 *
 * ⚠️ **先转义再套标签**：顺序反了会把文件里的 `<script>` 当 HTML 执行。
 *
 * @param {string} text
 * @returns {string} 可安全 innerHTML 的字符串
 */
function renderMarkdown(text) {
  const esc = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = esc.split(/\r?\n/);
  const out = [];
  let inCode = false;

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      out.push(inCode ? "</code></pre>" : "<pre class=\"md-code\"><code>");
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out.push(`${line}\n`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h !== null) {
      const level = h[1].length;
      out.push(`<h${level} class="md-h">${h[2]}</h${level}>`);
      continue;
    }
    const li = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (li !== null) {
      out.push(`<div class="md-li">• ${li[1]}</div>`);
      continue;
    }
    if (/^\s*$/.test(line)) {
      out.push("<div class=\"md-gap\"></div>");
      continue;
    }
    out.push(`<div class="md-p">${line}</div>`);
  }
  if (inCode) out.push("</code></pre>");

  return out.join("\n")
    // 行内代码与粗体（在已转义的文本上做，安全）
    .replace(/`([^`]+)`/g, "<code class=\"md-inline\">$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

/*
 * 双端导出（UMD 的最小形态）。
 *
 * ⚠️ 这份逻辑**必须同时能被两侧用到**：
 *   · 主进程 / 单测 —— `require` 它（CommonJS）；
 *   · 侧窗页面（沙箱渲染进程）—— 用 `<script src="../lib/file-preview.cjs">` 引它。
 *
 * 为什么不做成两份：扩展名表与「哪种方式预览」是一套规则，抄两遍迟早
 * 不一致 —— 而那种不一致的表现是「同一个文件在两个入口里表现不同」，
 * 极难归因。所以宁可让这个文件兼容两种加载方式。
 */
const API = {
  extOf,
  isPreviewable,
  mimeOf,
  previewModeOf,
  renderMarkdown,
};

if (typeof module !== "undefined" && module.exports !== undefined) {
  module.exports = API;
}
if (typeof window !== "undefined") {
  /* eslint-disable-next-line no-undef -- 双端导出：浏览器侧才存在 window */
  window.WhaleFilePreview = API;
}

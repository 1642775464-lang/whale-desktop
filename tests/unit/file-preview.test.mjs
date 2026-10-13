/**
 * 文件预览的类型判定
 *
 * 职责：钉住「哪种文件用哪种方式预览」——用户逐项点名的七类。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：判错的两种表现都是**静默难查**的 ——
 *   · 二进制被当文本 → 界面出现一堆乱码方块；
 *   · html 被当文本 → 用户看到源码而不是页面（明确要求要「浏览器预览」）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

/*
 * ⚠️ 用**默认导入**：该模块是双端导出（UMD 的最小形态，末尾同时挂
 * `module.exports` 与 `window`），Node 的具名导入分析认不出这种写法。
 */
import preview from "../../whale-window/lib/file-preview.cjs";

const { extOf, isPreviewable, mimeOf, previewModeOf, renderMarkdown } = preview;

test("用户点名的七类各自落到正确的预览方式", () => {
  /*
   * 用户原话：「需要支持点击进行预览（md 文件、js 文件、图片、视频、音频、
   * word、txt，html 则直接打开侧边栏的浏览器预览）」
   */
  assert.equal(previewModeOf("a.md").mode, "text");
  assert.equal(previewModeOf("a.md").markdown, true, "md 要出排版");
  assert.equal(previewModeOf("a.js").mode, "text");
  assert.equal(previewModeOf("a.txt").mode, "text");
  assert.equal(previewModeOf("a.png").mode, "image");
  assert.equal(previewModeOf("a.mp4").mode, "video");
  assert.equal(previewModeOf("a.mp3").mode, "audio");
  assert.equal(previewModeOf("a.docx").mode, "system", "word 交系统打开");
  assert.equal(previewModeOf("a.html").mode, "browser", "html 交侧边栏浏览器");
});

test("**html 必须先于文本判定**（它俩都是文本，但要求不同）", () => {
  // 判成 text 会让用户看到源码；用户明确要的是「浏览器预览」
  for (const n of ["a.html", "a.htm", "a.xhtml", "A.HTML"]) {
    assert.equal(previewModeOf(n).mode, "browser", `${n} 应走浏览器`);
  }
});

test("大小写与带路径都认", () => {
  assert.equal(previewModeOf("docs/README.MD").mode, "text");
  assert.equal(previewModeOf("img\\photo.JPG").mode, "image");
  assert.equal(previewModeOf("C:/x/y/doc.DocX").mode, "system");
});

test("不认识的扩展名**按系统打开**，不猜成文本", () => {
  /*
   * 猜成文本会把二进制当字符串渲染 —— 界面出现一堆乱码方块。
   * 保守地交系统打开，用户至少能用对的程序看到内容。
   */
  assert.equal(previewModeOf("a.bin").mode, "system");
  assert.equal(previewModeOf("a.xyz").mode, "system");
  assert.equal(previewModeOf("noext").mode, "system");
});

test("extOf：取末段扩展名，无扩展名给空串", () => {
  assert.equal(extOf("a/b/c.md"), "md");
  assert.equal(extOf("a.MD"), "md");
  assert.equal(extOf("noext"), "");
  assert.equal(extOf(".hidden"), "", "以点开头没有主名，不算扩展名");
  assert.equal(extOf("a."), "");
});

test("mimeOf：图片/音视频给对 MIME（data URL 要用）", () => {
  assert.equal(mimeOf("png"), "image/png");
  assert.equal(mimeOf("jpg"), "image/jpeg");
  assert.equal(mimeOf("mp4"), "video/mp4");
  assert.equal(mimeOf("mp3"), "audio/mpeg");
  // 未知给通用兜底，不给空串（空串会让 data URL 变成 data:;base64 而解析失败）
  assert.equal(mimeOf("xyz"), "application/octet-stream");
});

test("isPreviewable：能内嵌的为真，交系统的为假", () => {
  assert.equal(isPreviewable("a.md"), true);
  assert.equal(isPreviewable("a.png"), true);
  assert.equal(isPreviewable("a.html"), true, "html 也算「窗内能看」（走浏览器）");
  assert.equal(isPreviewable("a.docx"), false);
});

test("renderMarkdown：**先转义再套标签**（顺序反了会执行文件里的脚本）", () => {
  const html = renderMarkdown("<script>alert(1)</script>");
  assert.ok(!html.includes("<script>"), `不该出现可执行标签：${html}`);
  assert.ok(html.includes("&lt;script&gt;"), "要转义成实体");
});

test("renderMarkdown：标题 / 列表 / 粗体 / 行内代码 / 代码块", () => {
  const html = renderMarkdown("# 标题\n\n- 项目\n\n**粗** 与 `code`");
  assert.ok(html.includes("<h1 class=\"md-h\">标题</h1>"));
  assert.ok(html.includes("md-li"));
  assert.ok(html.includes("<strong>粗</strong>"));
  assert.ok(html.includes("md-inline"));

  const code = renderMarkdown("```\nconst a = 1;\n```");
  assert.ok(code.includes("md-code"), "代码块要包起来");
  assert.ok(code.includes("const a = 1;"));
});

test("renderMarkdown：未闭合的代码块也要收尾（不能漏标签把后面全吞了）", () => {
  const html = renderMarkdown("```\n未闭合");
  assert.ok(html.includes("</code></pre>"), "必须补上结束标签");
});

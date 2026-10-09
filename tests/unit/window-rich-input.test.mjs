/**
 * 富文本输入框的行为测试
 *
 * 职责：钉住「纯文本读写正确 + 命令那段被染色 + 占位与引导」几件事。
 * 所属层：测试（tests/unit）
 *
 * 用户要求「小窗要和主窗口一样是富文本输入框」。
 * 主窗口点指令后会把命令那一段单独染成蓝色（DSH 的 TOKEN_STYLE），
 * 而 `<textarea>` 是纯文本控件、做不到局部着色 —— 所以要换成
 * contenteditable，并由 rich-input.js 承担 DOM 复杂度。
 *
 * 这一层的测试重点是**业务看得见的行为**（读到的文本、哪个片段有颜色、
 * 光标在哪），而不是节点树长什么样 —— 后者是 rich-input.js 的内部实现。
 *
 * 替身与加载装配共用 tests/helpers/rich-input-double.mjs
 * （命令认领与光标保持的测试在 window-rich-input-caret.test.mjs）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, tokenText, tokenClasses, RENDERER } from "../helpers/rich-input-double.mjs";

// 加载装配与断言工具见 tests/helpers/rich-input-double.mjs

// ─────────────────────────────────────────────────────────────
// 一、纯文本读写（业务只该看到这个层面）
// ─────────────────────────────────────────────────────────────

test("setText 之后能读回同样的纯文本", () => {
  const { editor } = load();
  editor.setText("你好世界");
  assert.equal(editor.getText(), "你好世界");
});

test("写入非字符串按空处理，不抛错", () => {
  const { editor } = load();
  editor.setText("abc");
  editor.setText(null);
  assert.equal(editor.getText(), "");
  editor.setText(undefined);
  assert.equal(editor.getText(), "");
});

test("清空后 isEmpty 为真，有内容为假", () => {
  const { editor } = load();
  editor.setText("  ");
  assert.equal(editor.isEmpty(), true, "只有空白也算空");
  editor.setText("x");
  assert.equal(editor.isEmpty(), false);
  editor.clear();
  assert.equal(editor.getText(), "");
  assert.equal(editor.isEmpty(), true);
});

test("插入会追加，且已有内容不以空白结尾时补空格", () => {
  const { editor } = load();
  editor.setText("你好");
  assert.equal(editor.insert("/压缩 "), "你好 /压缩 ");
  // 已以空白结尾则不再补
  editor.setText("你好 ");
  assert.equal(editor.insert("/压缩 "), "你好 /压缩 ");
});

test("插入空串不改内容", () => {
  const { editor } = load();
  editor.setText("abc");
  assert.equal(editor.insert(""), "abc");
});

test("内容变化会通知监听者（斜杠面板靠它同步）", () => {
  const { editor, changes } = load();
  editor.setText("/压缩 ");
  assert.ok(changes.length > 0, "程序化写入也要通知");
  assert.equal(changes.at(-1), "/压缩 ");
});

// ─────────────────────────────────────────────────────────────
// 二、命令着色（用户要的那个效果）
// ─────────────────────────────────────────────────────────────

test("开头的已知命令会被染色，且只染命令那一段", () => {
  const { editor, el } = load();
  editor.setText("/压缩 只压缩一半内容");
  assert.equal(tokenText(el), "/压缩", "只该染命令本身");
  assert.equal(editor.getText(), "/压缩 只压缩一半内容", "纯文本不受染色影响");
});

test("染色片段必须带上真正生效的样式类（否则界面上没有颜色）", () => {
  const { editor, el } = load();
  editor.setText("/压缩 x");
  assert.deepEqual(
    tokenClasses(el),
    ["ri-token"],
    "CSS 里 `.ri .ri-token { color: … }` 才是让字变蓝的那一环；" +
    "光有 data-token 标记，界面上一点颜色都没有",
  );

  // 类名必须与 CSS 里定义的选择器对得上（两端一起变，不能只改一处）
  const css = readFileSync(join(RENDERER, "skin.css"), "utf8");
  assert.match(css, /\.ri \.ri-token\s*\{/, "skin.css 必须定义 .ri-token 的颜色");
  const rich = readFileSync(join(RENDERER, "rich-input.js"), "utf8");
  assert.match(rich, /TOKEN_CLASS = "ri-token"/, "rich-input.js 的类名要与 CSS 一致");
  assert.match(css, /\.ri-token\s*\{[^}]*color:\s*var\(--brand\)/, "命令色要用品牌蓝");
});

test("命令后面没有参数时，整段都是命令色", () => {
  const { editor, el } = load();
  editor.setText("/btw ");
  assert.equal(tokenText(el), "/btw");
});

test("/压缩包 这种不该被误判成命令（命令后必须跟空白或结束）", () => {
  const { editor, el } = load();
  editor.setText("/压缩包内容");
  assert.equal(tokenText(el), "", "前缀相同但不是命令，不许染色");
});

test("普通文本不染色", () => {
  const { editor, el } = load();
  editor.setText("这是一句普通话");
  assert.equal(tokenText(el), "");
});

test("未知命令不染色（只有已知写法才认）", () => {
  const { editor, el } = load();
  editor.setText("/不存在的命令 参数");
  assert.equal(tokenText(el), "");
});

test("长命令优先：同时匹配多条时染最长的那条", () => {
  const { editor, el } = load({ commandTokens: () => ["压", "压缩"] });
  editor.setText("/压缩 x");
  assert.equal(tokenText(el), "/压缩", "应匹配更长的「压缩」而不是「压」");
});

test("用户改动内容后着色跟着更新（删除命令前缀就退色）", () => {
  const { editor, el } = load();
  editor.setText("/压缩 x");
  assert.equal(tokenText(el), "/压缩");
  el.type("普通文字");
  assert.equal(tokenText(el), "", "不再是命令了，颜色必须退掉");
});

test("commandMode 反映「是否已进入命令模式」", () => {
  const { editor } = load();
  editor.setText("/压缩 ");
  assert.equal(editor.commandMode(), true);
  editor.setText("普通输入");
  assert.equal(editor.commandMode(), false);
  editor.setText("/压缩包");  // 不是真命令
  assert.equal(editor.commandMode(), false);
});

test("写法表是活的：新增一条写法后原来的内容要重新着色", () => {
  // 真实缺陷：宿主命令名（btw/mnemon…）是**异步**才拿到的，
  // 而用户从＋菜单点「btw」时会立刻插入 `/btw ` ——
  // 若写法表是启动时拍下的快照，它就不在表里、于是永远不变蓝。
  // 修法是两件事：写法表可增长 + 增长后重绘。
  const tokens = ["压缩"];
  const { editor, el } = load({ commandTokens: () => tokens });

  editor.setText("/btw ");
  assert.equal(tokenText(el), "", "写法表里还没有它，不该染色");

  tokens.push("btw");
  editor.repaint();
  assert.equal(tokenText(el), "/btw", "写法补上之后重绘必须让它变蓝");
});

test("data-guide 始终记录当前引导（与是否显示无关）", () => {
  // 占位提示只在**无焦点**时显示，而点完菜单输入框是聚焦的 ——
  // 光看「有没有显示」分不清「没有引导」和「有引导但此刻不显示」。
  const { editor, el } = load();
  el.fire("focus");
  editor.setPlaceholder("接着写：旁问内容");
  assert.equal(el.getAttribute("data-placeholder"), "", "聚焦时不显示");
  assert.equal(
    el.getAttribute("data-guide"),
    "接着写：旁问内容",
    "但引导内容必须始终可查",
  );
});

// 命令认领与光标保持的测试在 window-rich-input-caret.test.mjs
// （本文件顶到 500 行上限后按职责拆出去，替身共用 tests/helpers/rich-input-double.mjs）

// ─────────────────────────────────────────────────────────────
// 三、占位提示（参数引导）
// ─────────────────────────────────────────────────────────────

test("空内容且无焦点时显示占位，有内容就不显示", () => {
  const { editor, el } = load();
  assert.equal(el.getAttribute("data-empty"), "1");
  assert.equal(el.getAttribute("data-placeholder"), "问点什么…");
  editor.setText("/压缩 ");
  assert.equal(el.getAttribute("data-empty"), "0");
  assert.equal(el.getAttribute("data-placeholder"), "");
});

test("有焦点时不显示占位（与原生控件一致）", () => {
  const { el } = load();
  el.fire("focus");
  assert.equal(el.getAttribute("data-placeholder"), "", "聚焦后不该还挂着占位提示");
  el.fire("blur");
  assert.equal(el.getAttribute("data-placeholder"), "问点什么…");
});

test("setPlaceholder 改的是引导文案（参数提示靠它）", () => {
  const { editor, el } = load();
  editor.setPlaceholder("接着写：旁问内容");
  assert.equal(editor.getPlaceholder(), "接着写：旁问内容");
  assert.equal(el.getAttribute("data-placeholder"), "接着写：旁问内容");
});

// ─────────────────────────────────────────────────────────────
// 四、接线：页面与业务代码都要走这个模块
// ─────────────────────────────────────────────────────────────

test("index.html 的输入框是 contenteditable（不再是 textarea）", () => {
  const html = readFileSync(join(RENDERER, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  assert.match(html, /id="input"[^>]*contenteditable/, "输入框必须能承载带样式的片段");
  assert.doesNotMatch(html, /<textarea\b/, "不该再有 textarea（它没法给一段文字单独上色）");
});

test("index.html 在 app.js 之前加载 rich-input.js", () => {
  const html = readFileSync(join(RENDERER, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const iRich = html.indexOf("rich-input.js");
  const iApp = html.indexOf("app.js");
  assert.ok(iRich !== -1, "index.html 没有加载 rich-input.js");
  assert.ok(iRich < iApp, "rich-input.js 必须在 app.js 之前加载");
});

test("业务代码不直接读输入框的 value（那是纯文本控件的用法）", () => {
  // 富文本没有 .value —— 谁残留谁就会读到 undefined，
  // 而这种错误在界面上表现为「发出空消息」「面板不弹」，很难定位。
  for (const file of ["app.js", "palette.js"]) {
    const src = readFileSync(join(RENDERER, file), "utf8");
    assert.doesNotMatch(
      src,
      /dom\.input\.value/,
      `${file} 仍在直接读 dom.input 的 value —— 富文本输入框没有这个属性`,
    );
  }
});

test("palette 从注入的 reader 取文本（不能再自己去猜 DOM 结构）", () => {
  const palette = readFileSync(join(RENDERER, "palette.js"), "utf8");
  assert.match(
    palette,
    /dom\.inputText/,
    "palette 必须用上层注入的取值函数，否则它得知道输入框是富文本还是纯文本",
  );
});

test("粘贴一律按纯文本（否则外来样式会盖掉命令色）", () => {
  // contenteditable 默认把外部 HTML 原样插进来：从网页粘一段带颜色的文字，
  // 样式会留在输入框里，命令着色被盖掉 —— 而且用户没法把它「洗」掉。
  const src = readFileSync(join(RENDERER, "input-area.js"), "utf8");
  assert.match(src, /addEventListener\("paste"/, "input-area.js 必须接管粘贴");
  /*
   * ⚠️ 断言必须钉在**纯文本分支**上，且要求「拦」与「取纯文本」紧邻。
   *
   * 真实踩过：写成 `preventDefault[\s\S]{0,200}getData` 这种模糊跨行匹配时，
   * 把纯文本分支的 `preventDefault` 删掉仍会被判为通过 ——
   * 因为前面**图片分支**里也有一个 `preventDefault`，正则从那里就匹配上了。
   * 结果是一条看起来有效、实际拦不住回归的断言。
   */
  assert.match(
    src,
    /ev\.preventDefault\(\);\s*\n\s*const text = ev\.clipboardData\?\.getData\?\.\("text\/plain"\)/,
    "纯文本粘贴必须先拦住浏览器默认的带样式插入，紧接着只取 text/plain",
  );

  // 图片粘贴要继续走附件（不能因为改纯文本就把图片功能弄丢）
  const appJs = readFileSync(join(RENDERER, "app.js"), "utf8");
  assert.match(appJs, /bindPaste\(/, "app.js 要接上粘贴处理并给它图片回调");
});

test("从菜单插入命令时要先登记写法（否则点 btw 不变蓝）", () => {
  const inputArea = readFileSync(join(RENDERER, "input-area.js"), "utf8");
  // 插入路径必须自己登记写法：宿主命令名要等一次网络往返才拿到，
  // 而用户点菜单时命令名是**已知的事实**，不该等网络。
  assert.match(
    inputArea,
    /rememberToken\(m\[1\]\)/,
    "insert 时要从文本里取出命令写法并登记，否则宿主命令名（btw/mnemon）不参与着色",
  );
  assert.match(inputArea, /new Set\(/, "写法表要用可变集合，不能是启动时的定值");
  assert.match(inputArea, /repaint\(\)/, "写法补上后必须重绘，否则已有的命令不会立刻变蓝");

  const appJs = readFileSync(join(RENDERER, "app.js"), "utf8");
  assert.match(
    appJs,
    /rememberHostCommands/,
    "app.js 要在会话就绪后补齐宿主命令写法（覆盖用户手打命令名的情形）",
  );
});

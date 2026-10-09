/**
 * 富文本输入框的行为测试
 *
 * 职责：钉住「纯文本读写正确 + 命令那段被染色」两件事。
 * 所属层：测试（tests/unit）
 *
 * 用户要求「小窗要和主窗口一样是富文本输入框」。
 * 主窗口点指令后会把命令那一段单独染成蓝色（DSH 的 TOKEN_STYLE），
 * 而 `<textarea>` 是纯文本控件、做不到局部着色 —— 所以要换成
 * contenteditable，并由 rich-input.js 承担 DOM 复杂度。
 *
 * 这一层的测试重点是**业务看得见的行为**（读到的文本、哪个片段有颜色），
 * 而不是节点树长什么样 —— 后者是 rich-input.js 的内部实现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RENDERER = join(ROOT, "whale-window", "renderer");

/** 一个够用的 contenteditable 元素替身（真的维护子节点）。 */
function makeEditable() {
  const handlers = new Map();
  const el = {
    tagName: "DIV",
    children: [],
    attrs: new Map(),
    focused: false,
    get firstChild() { return this.children[0] ?? null; },
    appendChild(c) { this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i !== -1) this.children.splice(i, 1);
      return c;
    },
    get textContent() { return this.children.map((c) => c.textContent ?? "").join(""); },
    get innerText() { return this.textContent; },
    setAttribute(n, v) {
      if (v === undefined || v === null) this.attrs.delete(n);
      else this.attrs.set(n, v);
    },
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    focus() { this.focused = true; },
    /** 测试用：模拟用户敲了字（改内容后派发 input）。 */
    type(text) {
      this.children = [{ textContent: text }];
      this.fire("input");
    },
    fire(type) {
      for (const fn of handlers.get(type) ?? []) fn({});
    },
  };
  return el;
}

/** 造文档替身。 */
function makeDocument() {
  return {
    createElement(tag) {
      const node = {
        tagName: String(tag).toUpperCase(),
        className: "",
        children: [],
        attrs: new Map(),
        textContent: "",
        appendChild(c) { this.children.push(c); return c; },
        removeChild(c) {
          const i = this.children.indexOf(c);
          if (i !== -1) this.children.splice(i, 1);
          return c;
        },
        setAttribute(n, v) { this.attrs.set(n, v); },
        getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; },
      };
      return node;
    },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
  };
}

/** 在沙箱里加载 rich-input.js 并建一个编辑器。 */
function load(opts = {}) {
  const el = makeEditable();
  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.document = makeDocument();
  w.console = sandbox.console;

  /*
   * 光标替身：**记录**「光标被放到了哪里」。
   *
   * ⚠️ 不能给个空函数。用户报的第二个问题就是「鼠标光标位置也不对」——
   * 若替身什么都不记，这条永远测不出来（只会得到「测试全绿、界面不对」）。
   * 这里记下 selectedNode 与 collapsed，足以断言「光标落在末尾」。
   */
  const caret = { node: null, collapsed: null, cleared: false };
  w.document.createRange = () => ({
    selectNodeContents(node) { caret.node = node; },
    collapse(toEnd) { caret.collapsed = toEnd; },
  });
  w.getSelection = () => ({
    removeAllRanges() { caret.cleared = true; },
    addRange() {},
    rangeCount: 0,
  });

  createContext(sandbox);
  runInContext(readFileSync(join(RENDERER, "rich-input.js"), "utf8"), sandbox, {
    filename: "rich-input.js",
  });

  const changes = [];
  const editor = sandbox.window.WhaleRichInput.createRichInput({
    el,
    commandTokens: opts.commandTokens ?? (() => ["压缩", "目标", "计划", "btw"]),
    placeholder: opts.placeholder ?? "问点什么…",
    onChange: () => changes.push(editor.getText()),
  });
  return { editor, el, changes, caret };
}

/** 取出被染色的片段文字。 */
function tokenText(el) {
  const spans = el.children.filter((c) => c.getAttribute && c.getAttribute("data-token") === "1");
  return spans.map((s) => s.textContent).join("");
}

/**
 * 取出被染色片段的**样式类名**。
 *
 * ⚠️ 必须单独断言 class，不能只断言 `data-token` 属性：
 * 真正让字变色的是 CSS 类（`.ri .ri-token { color: … }`），
 * 而 `data-token` 只是给测试与探针用的标记。
 * 真实踩过：把类名改成一个不存在的名字，光看属性的断言**全部照绿**，
 * 界面上却一点颜色都没有 —— 断言必须钉在「真正生效的那一环」。
 */
function tokenClasses(el) {
  const spans = el.children.filter((c) => c.getAttribute && c.getAttribute("data-token") === "1");
  return spans.map((s) => s.className);
}

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

// ─────────────────────────────────────────────────────────────
// 五、认领命令（把已敲的「/前缀」替换成完整命令）
//
// 用户报：「我输入 / 后，选择 btw 后，直接弹出了两个 /，而且鼠标光标位置也不对」
//
// 根因：选中面板条目时用的是**追加**，而草稿里那个 `/` 是用户敲的**命令引导符**。
// 追加的结果就是 `//btw`。主窗口的语义是**替换**草稿里那个 token
// （DSH 的 leadingClaim 注释：the composer keeps the claimed token in the draft）。
// ─────────────────────────────────────────────────────────────

test("认领命令：草稿是「/」时要替换成完整命令，不能追加", () => {
  const { editor } = load();
  editor.setText("/");
  const out = editor.claimCommand("/btw ");
  assert.equal(out, "/btw ", "必须替换掉用户敲的那个斜杠");
  assert.equal(editor.getText(), "/btw ", "界面上不能出现两个斜杠");
});

test("认领命令：草稿是已敲的过滤词时要整段替换", () => {
  const { editor } = load();
  editor.setText("/bt");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "/btw ", "用户敲的 /bt 应由完整命令取代");
});

test("认领命令：草稿为空时直接放进完整命令", () => {
  const { editor } = load();
  editor.setText("");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "/btw ");
});

test("认领命令：普通文字不被动（只认领以 / 开头的情况）", () => {
  const { editor } = load();
  editor.setText("你好");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "你好 /btw ", "不是命令引导符时按普通插入处理");
});

test("认领命令后光标必须落在末尾（用户接着打字，不该跳回开头）", () => {
  const { editor } = load();
  editor.setText("/");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "/btw ");
  assert.ok(editor.caretAtEnd(), "认领之后光标要落在末尾");
});

test("认领之后命令那段会被染色（它与插入是同一条视觉路径）", () => {
  const { editor, el } = load();
  editor.setText("/");
  editor.claimCommand("/btw ");
  assert.equal(tokenText(el), "/btw");
});

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

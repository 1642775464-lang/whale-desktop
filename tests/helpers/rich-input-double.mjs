/**
 * 富文本输入框的测试替身
 *
 * 职责：给「小窗输入框」相关的测试提供一份共用的 DOM / 选区替身，
 *       以及加载 rich-input.js 的沙箱装配。所属层：测试（tests/helpers）
 *
 * 为什么抽出来共用：跟着光标与重绘的测试增多，替身也在长（选区语义、
 * 节点复用规则都不简单）。每个测试文件各带一份必然漂移 ——
 * 表现是「一个文件里的替身修好了、另一个还在用旧的」，
 * 于是同一份产品代码在两处得到不同结论。
 *
 * ⚠️ 替身的**能力必须覆盖产品真实用到的那部分**。这条在本项目里已经
 * 踩过多次：事件监听器替成空函数 → 点击测不出来；`dispatchEvent` 不转发
 * → 「有没有通知监听者」测不出来；缺 `contains` → 一调用就抛、整套全红
 * 而报错指不出原因。所以这里刻意把内容、属性、选区、焦点都做成真的。
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RENDERER = join(ROOT, "whale-window", "renderer");

/**
 * 一个够用的 contenteditable 元素替身（真的维护子节点）。
 *
 * @returns {object}
 */
export function makeEditable() {
  const handlers = new Map();
  const el = {
    tagName: "DIV",
    children: [],
    attrs: new Map(),
    focused: false,
    /** 当前光标偏移量（字符数，从开头算）。 */
    caretOffset: 0,
    /** 编辑器最近一次把光标安置到的偏移量（-1 = 没安置过）。 */
    caretOffsetApplied: -1,
    /** 编辑器一共安置过几次光标（用来区分「没恢复」与「恢复了但值相同」）。 */
    editorSetCount: 0,
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
    /*
     * 编辑器会用 contains 判断「光标是不是落在这个输入框里」。
     * 替身必须提供它 —— 否则一调用就抛，整套测试全红，
     * 而报错指不出是替身缺能力还是产品有问题。
     */
    contains(node) { return node !== null && node !== undefined; },
    /** 测试侧设光标；load() 会把它覆盖成与编辑器共享同一份状态。 */
    setCaretOffset(n) { this.caretOffset = n; },
    /**
     * 测试用：模拟用户把输入框内容改成 fullText。
     *
     * ⚠️ 关键在于**尽可能复用现有节点** —— 这是浏览器的真实行为：
     * 用户打字只在现有文本节点上改字符，不会重建整个输入框。
     * 替身若每次把 children 全换掉，「有没有重建」就永远测不出来
     * （节点引用必然变），而那正是「光标被甩回开头」那条要守的东西。
     *
     * 规则（对齐浏览器）：
     *   · 现有命令段仍是新内容的前缀 → 保留它，只改后面的文本节点；
     *   · 否则 → 用单个文本节点承载全文（相当于浏览器重排了内容）。
     */
    type(fullText) {
      const first = this.children[0];
      const hasToken = first !== undefined && first.className === "ri-token";
      if (hasToken && fullText.startsWith(first.textContent)) {
        const tail = fullText.slice(first.textContent.length);
        const tailNode = this.children[1];
        if (tailNode !== undefined && tailNode.nodeType === 3) tailNode.textContent = tail;
        else this.children.push({ nodeType: 3, textContent: tail });
      } else if (!hasToken && this.children.length === 1 && this.children[0].nodeType === 3) {
        this.children[0].textContent = fullText;
      } else {
        this.children = [{ nodeType: 3, textContent: fullText }];
      }
      this.fire("input");
    },
    fire(type) {
      for (const fn of handlers.get(type) ?? []) fn({});
    },
  };
  return el;
}

/** 造文档替身。 */
export function makeDocument() {
  return {
    createElement(tag) {
      return {
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
    },
    createTextNode(text) { return { nodeType: 3, textContent: text }; },
  };
}

/**
 * 在沙箱里加载 rich-input.js 并建一个编辑器。
 *
 * @param {object} [opts]
 * @param {() => Array<string>} [opts.commandTokens] 已知命令写法
 * @param {string} [opts.placeholder]
 * @returns {{ editor: object, el: object, changes: Array<string> }}
 */
export function load(opts = {}) {
  const el = makeEditable();
  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.document = makeDocument();
  w.console = sandbox.console;

  /*
   * 光标替身：按**真实语义**工作 —— 用偏移量表示光标，能读能写。
   *
   * ⚠️ 不能给空函数。用户报的两个问题（「光标位置也不对」「接着光标就直接
   * 跳到最前面」）都出在光标上 —— 若替身什么都不记，这些永远测不出来，
   * 只会得到「测试全绿、界面不对」。
   *
   * 这里实现的是**偏移量**语义（从输入框开头算），与浏览器一致；
   * 差别只在真实实现要遍历节点，而这里直接切片。
   */
  const caret = { offset: 0 };
  /**
   * 编辑器把光标安置到某偏移量（真实现走 Range，这里直接记数）。
   *
   * ⚠️ 与「测试侧设光标」分开记录：
   * `caretOffsetApplied` 只由**编辑器**写。若两者共用一个字段，
   * 测试先设了 3、编辑器没恢复（也是 3），断言就看不出区别 ——
   * 于是「重建后恢复光标」这条根本测不出来（真实踩过）。
   */
  const editorSetCaret = (n) => {
    caret.offset = n;
    el.caretOffsetApplied = n;
    el.editorSetCount += 1;
  };
  /** 测试侧设光标：只改「当前光标在哪」，不冒充编辑器动作。 */
  el.setCaretOffset = (n) => { caret.offset = n; el.caretOffset = n; };
  w.document.createRange = () => ({
    setStart() {},
    setEnd() {},
    selectNodeContents() {},
    collapse() {},
    toString() { return el.innerText.slice(0, caret.offset); },
    cloneRange() { return { setEnd() {}, toString() { return ""; } }; },
  });
  w.getSelection = () => ({
    rangeCount: 1,
    removeAllRanges() {},
    addRange() {},
    getRangeAt() { return { startOffset: caret.offset, startContainer: { nodeType: 3 } }; },
    /** 编辑器安置光标时调它（真实现走 Range，这里直接记数）。 */
    _setOffset: editorSetCaret,
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
  return { editor, el, changes };
}

/**
 * 取出被染色片段的文字。
 * @param {object} el
 * @returns {string}
 */
export function tokenText(el) {
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
 *
 * @param {object} el
 * @returns {Array<string>}
 */
export function tokenClasses(el) {
  const spans = el.children.filter((c) => c.getAttribute && c.getAttribute("data-token") === "1");
  return spans.map((s) => s.className);
}

/** 渲染层目录（供各测试文件读源码做接线断言）。 */
export { RENDERER, ROOT };

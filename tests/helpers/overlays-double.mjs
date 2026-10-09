/**
 * 输入区浮层的测试替身
 *
 * 职责：给 `overlays.js`（权限 / 模型 / 用量 / 上传四个浮层）的行为测试
 *       提供共用的 DOM 替身与加载装配。所属层：测试（tests/helpers）
 *
 * ## 为什么这个文件值得存在
 *
 * `overlays.js` 是小窗里最大的文件（473 行），装着四个浮层。
 * 它原先**只被源码扫描型测试引用** —— 那种测试只能证明「文件里出现过
 * 某个字符串」。而用户报过的问题有一大半出在这里：权限标签不跟真值、
 * 点了没反应、＋菜单缺项。全是「源码测试全绿、界面不对」。
 *
 * 对比：`render.js` 与 `rich-input.js` 有真行为测试，它们同类的问题
 * 都是最早被发现的。**差距不在代码质量，在有没有真跑起来验。**
 *
 * ## 替身的能力必须覆盖产品真实用到的那部分
 *
 * 本项目已经踩过多次：事件监听器替成空函数 → 点击测不出来；
 * `dispatchEvent` 不转发 → 「有没有通知监听者」测不出来；
 * `textContent` 写成普通属性 → 父节点读不到子节点文字。
 * 所以这里刻意把内容、类名、属性、点击都做成真的。
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RENDERER = join(ROOT, "whale-window", "renderer");

/**
 * 造一个够用的元素替身。
 *
 * `innerHTML=""` 会真的清空 children —— 产品每次渲染浮层都靠它清场，
 * 替身不实现的话「渲染了几行」会累加，测试就全是错的。
 *
 * @returns {object}
 */
export function el() {
  const handlers = new Map();
  const own = { text: "" };
  const children = [];
  const classes = new Set();
  const attrs = new Map();

  const node = {
    className: "",
    hidden: false,
    value: "",
    style: {},
    children,
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) {
        if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    get textContent() {
      if (children.length === 0) return own.text;
      return children.map((c) => c.textContent).join("");
    },
    set textContent(v) { own.text = v === undefined || v === null ? "" : String(v); },
    get innerHTML() { return own.text; },
    set innerHTML(v) {
      // 产品用 `innerHTML = ""` 清场；清空子节点是本替身最关键的一处真实性
      if (v === "" || v === undefined || v === null) { children.length = 0; own.text = ""; }
      else { own.text = String(v); }
    },
    setAttribute(n, v) {
      if (v === undefined || v === null) attrs.delete(n);
      else attrs.set(n, v);
    },
    getAttribute(n) { return attrs.has(n) ? attrs.get(n) : null; },
    removeAttribute(n) { attrs.delete(n); },
    appendChild(c) { children.push(c); return c; },
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    removeEventListener() {},
    querySelector: () => null,
    querySelectorAll: () => [],
    focus() {},
    remove() {},
    /** 测试用：触发一次点击。 */
    click() {
      for (const fn of handlers.get("click") ?? []) fn({ preventDefault() {}, target: node });
    },
    /** 测试用：触发一次事件（拖拽等）。 */
    fire(type, payload = {}) {
      for (const fn of handlers.get(type) ?? []) fn({ preventDefault() {}, target: node, ...payload });
    },
  };
  return node;
}

/**
 * 在沙箱里加载 overlays.js 并建控制器。
 *
 * @param {object} [opts]
 * @param {object} [opts.client] 假客户端（不传就只给空方法，调用会抛）
 * @param {(msg: string) => void} [opts.onNotify]
 * @returns {{ dom: object, overlays: object, notifyCalls: Array<string> }}
 */
export function loadOverlays(opts = {}) {
  const dom = {
    overlay: el(),
    ovTitle: el(),
    ovBody: el(),
    ovClose: el(),
    uplList: el(),
  };
  const document = {
    createElement: () => el(),
    createTextNode: (t) => ({ nodeType: 3, textContent: t }),
  };

  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.Array = Array; w.Object = Object; w.String = String; w.Number = Number;
  w.JSON = JSON; w.Promise = Promise; w.Math = Math;
  w.console = sandbox.console;
  w.document = document;
  createContext(sandbox);
  runInContext(readFileSync(join(RENDERER, "overlays.js"), "utf8"), sandbox, {
    filename: "overlays.js",
  });

  const notifyCalls = [];
  /*
   * ⚠️ onNotify 必须真的把消息记下来。
   *
   * 不能写成 `opts.onNotify ?? ((m) => notifyCalls)` —— 那只是「返回了
   * 一个数组」，消息根本没进去，于是测试里「有没有如实提示用户」永远
   * 是空的（假防线）。
   */
  const onNotify = typeof opts.onNotify === "function"
    ? (m) => { notifyCalls.push(m); opts.onNotify(m); }
    : (m) => { notifyCalls.push(m); };

  const overlays = sandbox.window.WhaleOverlays.createOverlays({
    dom,
    getClient: () => opts.client ?? {},
    onNotify,
  });

  return { dom, overlays, notifyCalls };
}

/**
 * 浮层里渲染出来的行（按类名以 `ov-row` 开头的元素）。
 *
 * 只找**顶层**子节点：产品的行是直接 append 到 ovBody 的。
 *
 * @param {object} dom
 * @returns {Array<object>}
 */
export function rowsOf(dom) {
  return (dom.ovBody.children ?? []).filter((c) => String(c.className).startsWith("ov-row"));
}

/**
 * 浮层里的分组标题**文字**（模型浮层用它列 provider）。
 *
 * 返回文字而不是元素：调用方要断言的几乎总是「显示了哪些分组」，
 * 返回元素会逼着每个测试自己再取一次 textContent（而且容易写成
 * 「拿元素去和字符串比」）。
 *
 * @param {object} dom
 * @returns {Array<string>}
 */
export function groupsOf(dom) {
  return (dom.ovBody.children ?? [])
    .filter((c) => c.className === "ov-group")
    .map((c) => c.textContent);
}

/** 浮层里的空态/说明行。 */
export function notesOf(dom) {
  return (dom.ovBody.children ?? []).filter((c) => c.className === "ov-empty");
}

/** 一行的标签（第一栏文字，跳过图标容器）。 */
export function labelOf(row) {
  const spans = (row.children ?? []).filter((c) => c.className !== "ico" && c.className !== "v");
  return spans.length > 0 ? spans[0].textContent : "";
}

/** 一行的右侧说明。 */
export function descOf(row) {
  const v = (row.children ?? []).find((c) => c.className === "v");
  return v === undefined ? "" : v.textContent;
}

/** 按标签找一行。 */
export function findRow(dom, label) {
  return rowsOf(dom).find((r) => labelOf(r) === label);
}

export { RENDERER, ROOT };

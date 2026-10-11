/**
 * 小窗渲染层的测试替身
 *
 * 职责：给「小窗 render.js 显示什么」这类测试提供共用的 DOM 替身与加载装配。
 *       所属层：测试（tests/helpers）
 *
 * 为什么共用：跟着 render.js 的测试会越来越多（权限标签、消息流过滤、
 * 状态条文案……），每个文件各带一份替身必然漂移 —— 表现是
 * 「一个文件里的替身补齐了、另一个还在用旧的」，同一份产品代码在两处
 * 得出不同结论。这条教训在本项目里已经出现过。
 *
 * ⚠️ 替身能力必须覆盖产品真实用到的那部分：`appendChild` 要真的把节点收进
 * children（否则「消息流里有几行、分别是什么」根本读不出来），
 * `classList.toggle` 要真的记录状态（否则「运行中按钮变红」测不出来）。
 */

import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = join(ROOT, "whale-window", "renderer", "render.js");

/**
 * 造一个最小元素替身。
 *
 * @returns {object}
 */
export function el() {
  const classes = new Set();
  const own = { text: "" };
  const node = {
    className: "",
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    style: {},
    children: [],
    attrs: new Map(),
    /*
     * textContent 要**拼接子节点**，与真实 DOM 一致。
     *
     * 真实踩过：替身把它写成普通属性时，产品往子节点写的文字
     * （消息行是 wrap > role + body）在父节点上读不到 ——
     * 于是「消息流里显示了什么」的断言只能读到空串，
     * 一条永远为假的断言看起来却通过了（除了那条恰好断言「不含」的）。
     */
    get textContent() {
      if (this.children.length === 0) return own.text;
      return this.children.map((c) => c.textContent).join("");
    },
    set textContent(v) { own.text = v === undefined || v === null ? "" : String(v); },
    classList: {
      add(c) { classes.add(c); },
      remove(c) { classes.delete(c); },
      toggle(c, on) {
        // 真实 DOM 的 toggle 可以带第二参；产品用它表达「开/关」，
        // 替身不实现这一条的话「运行中」状态永远测不出来。
        if (on === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
        else if (on) classes.add(c); else classes.delete(c);
      },
      contains: (c) => classes.has(c),
    },
    setAttribute(n, v) { this.attrs.set(n, v); },
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; },
    removeAttribute(n) { this.attrs.delete(n); },
    appendChild(child) { this.children.push(child); return child; },
    querySelectorAll: () => [],
    remove() {},
    addEventListener() {},
  };
  return node;
}

/** 造一份够用的假 DOM（含 document.createElement）。 */
export function fakeDom() {
  const ids = [
    "tbTitle", "stream", "streamEmpty", "status", "statusText",
    "dock", "dockList", "dockCount", "dockProg", "dockCaret", "input", "btnSend",
    "btnPerm", "urFg", "usagePct", "infoSession", "infoBridge", "infoEvents",
  ];
  const dom = {};
  for (const id of ids) dom[id] = el();
  /** render.js 用到的最小的 document（它要 createElement 建消息行）。 */
  dom.__document = { createElement: () => el(), createTextNode: () => el() };
  return dom;
}

/** 在沙箱里加载 render.js 并建渲染器。 */
export function makeRenderer(fallbackPermission = "workspace-write") {
  const dom = fakeDom();
  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.Array = Array;
  w.Object = Object;
  w.String = String;
  w.Number = Number;
  w.JSON = JSON;
  w.console = sandbox.console;
  // render.js 通过 global.document 建元素（global 就是内层 window）
  w.document = dom.__document;
  createContext(sandbox);
  runInContext(readFileSync(FILE, "utf8"), sandbox, { filename: FILE });
  const renderer = sandbox.window.WhaleRender.createRenderer({
    dom,
    getPermission: () => fallbackPermission,
  });
  return { dom, renderer };
}

/** 喂给渲染器的一份最小 state。 */
export const baseState = {
  offline: false, title: "甲", workspace: null, running: false,
  messages: [], todos: [], permission: null,
};

/** 消息流里各行的类名与文字（用来断言「显示了什么」）。 */
export function streamLines(dom) {
  return dom.stream.children.map((c) => ({ cls: c.className, text: c.textContent }));
}

export { FILE, ROOT };

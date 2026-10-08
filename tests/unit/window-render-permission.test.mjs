/**
 * 小窗渲染层：权限标签必须显示宿主实际档位（行为级）
 *
 * 职责：真的把渲染器跑起来、喂 state，断言按钮上的文案。
 * 所属层：测试（tests/unit）
 *
 * 为什么必须是行为级：这个标签原先只有**正则扫源码**的契约断言
 * （「文件里出现 PERMISSION_TEXT 这几个字」），把实现改回写死的常量照样全绿。
 *
 * 真实事故（用户报）：
 *   「权限切换，切换为完全权限，但是输入框还是显示工作区内修改」
 *   ——切换真的生效了，只是标签读的是一个写死的常量。
 *
 * render.js 是浏览器 script，用 node:vm 造沙箱加载；DOM 用最小替身
 * （只实现测试用到的那几个属性），不引入 jsdom。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FILE = join(ROOT, "whale-window", "renderer", "render.js");

/** 造一个最小元素替身。 */
function el() {
  const node = {
    textContent: "", className: "", hidden: false, scrollTop: 0, scrollHeight: 0,
    style: {}, children: [],
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, appendChild(child) { this.children.push(child); },
    querySelectorAll: () => [], remove() {}, addEventListener() {},
  };
  return node;
}

/** 造一份够用的假 DOM（含 document.createElement）。 */
function fakeDom() {
  const ids = [
    "tbTitle", "shTitle", "shSub", "stream", "streamEmpty", "status", "statusText",
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
function makeRenderer(fallbackPermission = "workspace-write") {
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

const baseState = {
  offline: false, title: "甲", workspace: null, running: false,
  messages: [], todos: [], permission: null,
};

test("state.permission 是完整权限时，标签显示「完全权限」", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, permission: "danger-full-access" });
  assert.equal(
    dom.btnPerm.textContent,
    "完全权限",
    "标签必须跟着 state.permission 走——这就是用户报的那个现象",
  );
});

test("三个档位文案都跟 state 走（不是写死的）", () => {
  const { dom, renderer } = makeRenderer();
  const cases = [
    ["read-only", "仅可查看"],
    ["workspace-write", "工作区内修改"],
    ["danger-full-access", "完全权限"],
  ];
  for (const [value, text] of cases) {
    renderer.all({ ...baseState, permission: value });
    assert.equal(dom.btnPerm.textContent, text, `${value} 应显示「${text}」`);
  }
});

test("档位从工作区改成完全权限时，标签要跟着变（切完必须更新）", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, permission: "workspace-write" });
  assert.equal(dom.btnPerm.textContent, "工作区内修改");

  renderer.all({ ...baseState, permission: "danger-full-access" });
  assert.equal(
    dom.btnPerm.textContent,
    "完全权限",
    "切完之后标签没变 —— 用户报的就是这个（切了但输入框还显示旧的）",
  );
});

test("真值还没有时（首帧）退回启动占位值，不显示空白", () => {
  const { dom, renderer } = makeRenderer("read-only");
  renderer.all({ ...baseState, permission: null });
  assert.equal(dom.btnPerm.textContent, "仅可查看", "首帧用注入的占位值，不是编一个");
});

test("宿主给了没见过的档位值时，退回占位值而不是显示空白", () => {
  // 宿主将来加档位时，小窗不认识就显示占位值——总比空白好，
  // 且不会把未知值当已知文案渲染出去。
  const { dom, renderer } = makeRenderer("workspace-write");
  renderer.all({ ...baseState, permission: "some-new-preset" });
  assert.equal(dom.btnPerm.textContent, "工作区内修改");
});

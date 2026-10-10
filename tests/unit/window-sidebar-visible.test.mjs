/**
 * 侧边栏的会话可见性判据
 *
 * 职责：钉住「哪些会话该出现在侧边栏里」——判据照主窗口的同名规则。
 * 所属层：测试（tests/unit）
 *
 * ## 用户报的那次问题
 *
 * > 数目根本不对，宿主侧数量没有那么多，你自己看你多出来的都是一堆空壳
 *
 * 原因是**漏了一条判据**：主窗口（`dsh-client-ui-workspace` 的
 * `sessionVisible`）会隐藏空会话，而我只做了归档过滤：
 *
 *     if (session.blank && session.id !== current) return false;
 *     default: return !archived.has(session.id);
 *
 * 这条判据原来埋在渲染循环里，测不到；现在抽成纯函数 `sessionVisible`
 * 单独测 —— 「哪些该显示」是一条规则，不该只活在 DOM 操作中间。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 在沙箱里加载 sidebar.js 并取那个纯函数。 */
function load() {
  const sandbox = { window: {}, console: { warn: () => {} }, Object, Array, String };
  sandbox.window.document = { createElement: () => ({}) };
  sandbox.window.console = sandbox.console;
  createContext(sandbox);
  runInContext(readFileSync(join(ROOT, "whale-window", "renderer", "sidebar.js"), "utf8"), sandbox, {
    filename: "sidebar.js",
  });
  return sandbox.window.WhaleSidebar;
}

test("普通会话显示", () => {
  const { sessionVisible } = load();
  const s = { sessionId: "a", blank: false, archived: false };
  assert.equal(sessionVisible(s, "other", true), true);
});

test("空会话不显示 —— 这条正是用户报的「多出来一堆空壳」", () => {
  const { sessionVisible } = load();
  const s = { sessionId: "a", blank: true, archived: false };
  assert.equal(sessionVisible(s, "other", true), false, "主窗口也不显示空会话");
});

test("空会话若是**当前**那个，要显示", () => {
  /*
   * 用户可能正停在刚建的空会话上 —— 把它藏掉，界面上就没有「当前」那一条了，
   * 看起来像小窗丢了会话。主窗口的判据也是这么写的（`id !== current`）。
   */
  const { sessionVisible } = load();
  const s = { sessionId: "a", blank: true, archived: false };
  assert.equal(sessionVisible(s, "a", true), true);
});

test("归档会话不显示", () => {
  const { sessionVisible } = load();
  const s = { sessionId: "a", blank: false, archived: true };
  assert.equal(sessionVisible(s, "other", true), false);
});

test("归档判据**没拿到**时不按归档隐藏（宁可多列不可误藏）", () => {
  /*
   * 两种失败不对等：多列只是噪音；误隐藏会让用户的会话凭空少一截。
   * 所以 `archivedKnown=false` 时一律不因 archive 字段隐藏。
   */
  const { sessionVisible } = load();
  const s = { sessionId: "a", blank: false, archived: true };
  assert.equal(sessionVisible(s, "other", false), true, "判据未知时保守显示");
});

test("归档且空壳：判据未知时仍按 blank 隐藏（blank 是数据自带的）", () => {
  const { sessionVisible } = load();
  const s = { sessionId: "a", blank: true, archived: true };
  assert.equal(sessionVisible(s, "other", false), false, "blank 不依赖外部判据");
});

test("畸形输入一律不显示，不崩", () => {
  const { sessionVisible } = load();
  assert.equal(sessionVisible(null, "a", true), false);
  assert.equal(sessionVisible(undefined, "a", true), false);
  assert.equal(sessionVisible("坏了", "a", true), false);
});

test("没有 currentId 时空会话照样隐藏（只有当前那个例外）", () => {
  const { sessionVisible } = load();
  const s = { sessionId: "a", blank: true, archived: false };
  assert.equal(sessionVisible(s, null, true), false, "不知道当前是谁 → 一律隐藏空会话");
});

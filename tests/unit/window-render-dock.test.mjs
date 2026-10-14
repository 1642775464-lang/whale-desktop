/**
 * 任务坞的显隐
 *
 * 职责：钉住「任务都完成了就别再展示任务条」这条要求。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：这是**信息密度**问题 —— 全部完成的任务条没有任何信息量，
 * 却一直占着消息区的高度。旧实现只看「清单是否为空」，于是 7/7 全做完
 * 仍然挂着（用户截图里那条就是）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRenderer, baseState } from "../helpers/window-render-double.mjs";

test("清单为空 → 不显示任务坞", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, todos: [] });
  assert.equal(dom.dock.hidden, true);
});

test("**全部完成 → 不显示任务坞**（用户要求：任务都完成了就别展示）", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    todos: [
      { status: "completed", content: "甲" },
      { status: "completed", content: "乙" },
      { status: "completed", content: "丙" },
    ],
  });
  assert.equal(dom.dock.hidden, true, "3/3 全做完就不该再占位置");
});

test("还有未完成 → 显示任务坞，且计数正确", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    todos: [
      { status: "completed", content: "甲" },
      { status: "pending", content: "乙" },
      { status: "in_progress", content: "丙" },
    ],
  });
  assert.equal(dom.dock.hidden, false);
  assert.equal(dom.dockProg.textContent, "1 / 3", "计数是「已完成 / 总数」");
});

test("停在 in_progress 的清单**仍要显示**（不是「都完成了」）", () => {
  /*
   * 边界：清单被中断时可能停在 in_progress 而没有 pending ——
   * 那不是「都完成了」，用户需要看到它，所以判据必须是
   * 「已完成数 == 总数」而不是「没有未完成项」。
   */
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    todos: [
      { status: "completed", content: "甲" },
      { status: "in_progress", content: "乙" },
    ],
  });
  assert.equal(dom.dock.hidden, false, "停在 in_progress 不能当成已完成");
});

test("从「有未完成」变成「全完成」时，任务坞要收起来（不是只在首帧判一次）", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, todos: [{ status: "pending", content: "甲" }] });
  assert.equal(dom.dock.hidden, false);

  renderer.all({ ...baseState, todos: [{ status: "completed", content: "甲" }] });
  assert.equal(dom.dock.hidden, true, "状态变化后必须重新判显隐");
});

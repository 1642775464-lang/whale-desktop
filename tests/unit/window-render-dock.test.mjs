/**
 * 任务坞的显隐
 *
 * 职责：钉住「**只在任务正在运行时**显示任务条」这条要求。
 * 所属层：测试（tests/unit）
 *
 * ## 判据演进过两次，都来自用户反馈
 *
 * 1. 最初只看「清单是否为空」→ 全做完仍占一条（用户：「任务都完成了，
 *    进会话就不要展示任务条了」）；
 * 2. 改成「已完成数 == 总数 就收」→ 用户看到的仍是 0/5 的一条
 *    （我干完活忘了标完成），且他质疑「宿主都没有，为什么小窗还要显示」；
 * 3. 现在按**运行状态**：任务条的意义是「这轮正在做什么」，
 *    运行一结束就收起 —— 不管清单里留着什么状态。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRenderer, baseState } from "../helpers/window-render-double.mjs";

const TODOS = [
  { status: "pending", content: "甲" },
  { status: "in_progress", content: "乙" },
];

test("清单为空 → 不显示（即使正在运行）", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, running: true, todos: [] });
  assert.equal(dom.dock.hidden, true);
});

test("**不在运行 → 不显示**（哪怕清单里还留着未完成项）", () => {
  /*
   * 这条是关键：用户看到的就是这种情况 —— 活干完了，但清单因为
   * 中断/忘了更新而停在未完成，界面却一直挂着一条。
   * 运行状态才是「现在是否值得显示」的可靠信号。
   */
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, running: false, todos: TODOS });
  assert.equal(dom.dock.hidden, true, "不在运行就不该占位置");
});

test("清单全完成且不在运行 → 不显示", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    running: false,
    todos: [{ status: "completed", content: "甲" }],
  });
  assert.equal(dom.dock.hidden, true);
});

test("正在运行且有清单 → 显示，计数正确", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, running: true, todos: TODOS });
  assert.equal(dom.dock.hidden, false);
  assert.equal(dom.dockProg.textContent, "0 / 2", "计数是「已完成 / 总数」");
});

test("运行中全完成也显示（那一轮还在跑，用户要能看到收尾）", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    running: true,
    todos: [{ status: "completed", content: "甲" }],
  });
  assert.equal(dom.dock.hidden, false, "还在跑就显示，跑完才收");
});

test("从「运行中」变成「已结束」时，任务条要收起来", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, running: true, todos: TODOS });
  assert.equal(dom.dock.hidden, false);

  renderer.all({ ...baseState, running: false, todos: TODOS });
  assert.equal(dom.dock.hidden, true, "回合结束后必须重新判显隐");
});

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
import { makeRenderer, baseState } from "../helpers/window-render-double.mjs";

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

test("真值还没有时（首帧）显示占位「—」，**不编一个档位**", () => {
  /*
   * ⚠️ 这条改过，原因是用户反馈：
   * 「小窗打开后的初始权限和宿主的没匹配上，要完全一致」。
   *
   * 旧行为是「退回注入的启动占位值」—— 而那个占位值是写死的
   * `workspace-write`，于是首帧永远显示「工作区内修改」，
   * 宿主实际可能是「完全权限」。
   *
   * 新行为：拿不到真值就显示占位「—」，让「还没拿到」与
   * 「就是这个档位」在视觉上分得开。真值仍只认 `/whale/presets` 的 current。
   */
  const { dom, renderer } = makeRenderer(null);
  renderer.all({ ...baseState, permission: null });
  assert.equal(dom.btnPerm.textContent, "—", "没有真值时显示占位，不编档位");
});

test("宿主给了没见过的档位值时，**照实显示**而不是硬套成某一档", () => {
  /*
   * ⚠️ 这条也改过。旧行为是「退回占位值」→ 未知档位被硬套成
   * 「工作区内修改」，用户看到的就是一个**假的**档位。
   *
   * 新行为：照实显示宿主给的值。宁可显示一个内部名（可查），
   * 也不能显示一个看起来像答案、其实是编的档位。
   */
  const { dom, renderer } = makeRenderer("workspace-write");
  renderer.all({ ...baseState, permission: "some-new-preset" });
  assert.equal(dom.btnPerm.textContent, "some-new-preset", "未知档位照实显示，不硬套");
});

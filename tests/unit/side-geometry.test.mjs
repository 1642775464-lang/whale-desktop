/**
 * 右侧附带窗的几何
 *
 * 职责：钉住「贴合点」「收起位」「匀速插值」「屏外回退」四条计算。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：贴靠算错的三种表现都**看不出根因**——
 *   · 差一个 SHADOW_PAD → 看着「没贴上」但说不出差多少；
 *   · 收起位算错 → 窗口停在屏幕上，用户以为没关掉；
 *   · 屏外没回退 → 面板整块跑到屏幕外，表现是「点了没反应」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DRAWER_MS,
  SHADOW_PAD,
  dockedPosition,
  drawerFrame,
  expandFrame,
  hiddenPosition,
  isJoined,
  needsRedock,
} from "../../whale-window/lib/side-geometry.cjs";

/** 一块典型的小窗窗口矩形（492 = 460 内容 + 16×2 投影）。 */
const WIN = { x: 100, y: 200, width: 492, height: 710 };

test("贴靠位：两窗**可见区**边缘相接（不是窗口矩形相接）", () => {
  /*
   * ⚠️ 窗口矩形四周有 SHADOW_PAD 的透明投影边距。
   * 按矩形相接会留出 32px 空隙（观感就是「没贴上」）。
   */
  const pos = dockedPosition(WIN, 492);
  assert.equal(pos.x, 100 + 460, "x = 小窗.x + 内容宽");
  assert.equal(pos.y, 200, "纵向对齐");
});

test("贴靠位：屏幕右边放不下时回退，不跑到屏幕外", () => {
  const work = { x: 0, y: 0, width: 1200, height: 900 };
  const far = { x: 900, y: 100, width: 492, height: 710 };
  const pos = dockedPosition(far, 492, work);
  assert.ok(pos.x + 492 <= work.x + work.width, `要落在工作区内，实际 ${JSON.stringify(pos)}`);
  assert.ok(pos.x >= work.x);
});

test("收起位：完全推到贴靠位右侧（一个窗口宽）", () => {
  const docked = dockedPosition(WIN, 492);
  const hidden = hiddenPosition(WIN, 492);
  assert.equal(hidden.x, docked.x + 492);
  assert.equal(hidden.y, docked.y);
});

test("抽屉插值：**匀速** —— 进度与位置成正比", () => {
  const half = drawerFrame(WIN, 492, 0.5);
  const from = hiddenPosition(WIN, 492);
  const to = dockedPosition(WIN, 492);
  assert.equal(half.x, Math.round(from.x + (to.x - from.x) * 0.5));
  // 0.25 与 0.75 也落在同一直线上（线性）
  const q1 = drawerFrame(WIN, 492, 0.25);
  const q3 = drawerFrame(WIN, 492, 0.75);
  assert.equal(q1.x, Math.round(from.x + (to.x - from.x) * 0.25));
  assert.equal(q3.x, Math.round(from.x + (to.x - from.x) * 0.75));
});

test("抽屉插值：t 越界与非法值被夹到 [0,1]", () => {
  assert.deepEqual(drawerFrame(WIN, 492, -1), hiddenPosition(WIN, 492));
  assert.deepEqual(drawerFrame(WIN, 492, 2), dockedPosition(WIN, 492));
  assert.deepEqual(drawerFrame(WIN, 492, NaN), hiddenPosition(WIN, 492));
});

test("展开帧：**左边缘固定**在小窗右边框，只有宽度在长", () => {
  /*
   * 用户要求「从小窗的右边框往右拉出」——
   * 若 x 也跟着变，观感就退回「旁边滑来一个窗口」。
   */
  const docked = dockedPosition(WIN, 492);
  for (const t of [0, 0.2, 0.5, 0.9, 1]) {
    const f = expandFrame(WIN, 492, t);
    assert.equal(f.x, docked.x, `t=${t} 时左边缘必须钉住`);
    assert.equal(f.y, docked.y);
  }
});

test("展开帧：宽度**匀速**从 0 长到全宽", () => {
  assert.equal(expandFrame(WIN, 492, 0).width, 1, "0 宽会被 Electron 忽略，从 1px 起步");
  assert.equal(expandFrame(WIN, 492, 1).width, 492);
  assert.equal(expandFrame(WIN, 492, 0.5).width, 246);
  // 线性：25% 与 75% 落在同一直线上
  assert.equal(expandFrame(WIN, 492, 0.25).width, 123);
  assert.equal(expandFrame(WIN, 492, 0.75).width, 369);
});

test("展开帧：宽度**永远不会是 0**（否则 Electron 忽略这次 setBounds）", () => {
  /*
   * 实测坑：0 宽被当作非法尺寸 → setBounds 整条被忽略 → 窗口保持旧宽度，
   * 表现是「动画不播、面板直接出现」，且没有任何报错。
   */
  for (const t of [0, -1, NaN, 0.0001]) {
    assert.ok(expandFrame(WIN, 492, t).width >= 1, `t=${t} 时宽度必须 >= 1`);
  }
});

test("isJoined：只有落在贴靠位才算连住", () => {
  /*
   * 这条判据决定「两块要不要连成一体」（去掉中间的圆角/边框/阴影）。
   * 判太松 → 没贴上就切了圆角（看着残缺）；判太严 → 贴上了中间还留着缝。
   */
  const pos = dockedPosition(WIN, 492);
  assert.equal(isJoined(pos, WIN, 492), true, "贴靠位就是连住");
  assert.equal(isJoined({ x: pos.x + 1, y: pos.y }, WIN, 492), true, "1px 内算贴住");
  assert.equal(isJoined({ x: pos.x + 20, y: pos.y }, WIN, 492), false, "差 20px 不算");
  assert.equal(isJoined({ x: pos.x, y: pos.y + 20 }, WIN, 492), false, "纵向偏了也不算");
});

test("needsRedock：小窗被移动后判定为需要重新贴合", () => {
  const sidePos = dockedPosition(WIN, 492);
  assert.equal(needsRedock(sidePos, WIN), false, "原位不需要动");
  const moved = { ...WIN, x: WIN.x + 40 };
  assert.equal(needsRedock(sidePos, moved), true, "小窗移了就要跟");
});

test("动画时长要「快」但仍是滑动（用户要求加快过）", () => {
  /*
   * 两轮调整：220ms → 用户说「滑动打开和关闭的速度加快」→ 140ms。
   * 下限 100ms：再快就是「闪一下」，不是滑动，与「类似抽屉拉开」的要求相反。
   * 上限 200ms：不能回到用户说「太慢」的那一档。
   */
  assert.ok(DRAWER_MS <= 200, `不能比 220ms 那档还慢，实际 ${DRAWER_MS}`);
  assert.ok(DRAWER_MS >= 100, `再快就不是滑动了，实际 ${DRAWER_MS}`);
});

test("SHADOW_PAD 与主窗几何同源", async () => {
  // 两处常量必须一致，否则贴合点会差 16 的整数倍（看着「没贴上」）
  const geometry = await import("../../whale-window/lib/geometry.cjs");
  assert.equal(SHADOW_PAD, geometry.default.SHADOW_PAD ?? geometry.SHADOW_PAD);
});

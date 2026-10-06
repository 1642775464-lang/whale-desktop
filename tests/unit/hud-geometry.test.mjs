/**
 * 悬浮条几何单测
 *
 * 职责：钉死 A1（顶边居中）与 A9（两态图标屏幕坐标一致）的数学，
 *       以及「拿不到工作区时不猜默认值」的失败语义。
 * 所属层：测试（tests/unit）
 *
 * 几何测试的价值在于**它能在没有窗口的情况下证明布局是对的**。
 * 真起 Electron 只能验「这一次摆对了」，这里的断言验的是「任何 workArea 都对」。
 *
 * geometry.cjs 是 CommonJS（Electron 主进程口径），故用 createRequire 加载。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  FORMS,
  GEOMETRY,
  ballBounds,
  barBounds,
  boundsFor,
  detailBounds,
  iconScreenPoint,
  normalizeWorkArea,
} = require("../../whale-hud/lib/geometry.cjs");

/** 本机实测工作区：2560×1440 单屏，任务栏在下。 */
const WORK_AREA = { x: 0, y: 0, width: 2560, height: 1392 };

/** 一个偏移过的副屏工作区，用来证明公式不是「恰好对上主屏」。 */
const OFFSET_AREA = { x: -1920, y: 40, width: 1920, height: 1040 };

test("常量与 PRD / 前端设计规范一致", () => {
  assert.equal(GEOMETRY.BAR_WIDTH, 560);
  assert.equal(GEOMETRY.BAR_HEIGHT, 52);
  assert.equal(GEOMETRY.TOP_GAP, 6);
  assert.equal(GEOMETRY.SHADOW_PAD, 14);
  assert.equal(GEOMETRY.MENU_EXTRA_HEIGHT, 268);
  assert.equal(GEOMETRY.WINDOW_WIDTH, 588);
  assert.equal(GEOMETRY.WINDOW_HEIGHT, 72);
  assert.equal(GEOMETRY.BALL_WINDOW_SIZE, 88);
  assert.equal(GEOMETRY.BALL_INSET_X, 24);
  assert.equal(GEOMETRY.BALL_INSET_Y, 12);
});

test("展开态：588×72，顶边居中，y 等于工作区顶边", () => {
  const b = barBounds(WORK_AREA);
  assert.equal(b.width, 588);
  assert.equal(b.height, 72);
  assert.equal(b.y, 0, "窗口 y 必须等于工作区顶边——负 y 会被 Windows 夹回 0");
  // A1 判据：窗口中心 == 工作区中心（±1）
  assert.ok(Math.abs(b.x + 588 / 2 - (WORK_AREA.x + WORK_AREA.width / 2)) <= 1);
});

test("展开态：偏移工作区同样居中", () => {
  const b = barBounds(OFFSET_AREA);
  assert.equal(b.y, 40, "y 跟着工作区走，不是写死 0");
  assert.ok(Math.abs(b.x + 588 / 2 - (OFFSET_AREA.x + OFFSET_AREA.width / 2)) <= 1);
});

test("详情态：只加高 268，x/y 不动", () => {
  const bar = barBounds(WORK_AREA);
  const detail = detailBounds(WORK_AREA);
  assert.equal(detail.height, 72 + 268);
  assert.equal(detail.x, bar.x, "条必须原地不动，否则鼠标还没到浮层条就跳走了");
  assert.equal(detail.y, bar.y);
  assert.equal(detail.width, bar.width);
});

test("详情态高度等于 PRD 的 340", () => {
  assert.equal(detailBounds(WORK_AREA).height, 340);
});

test("球形态：88×88", () => {
  const b = ballBounds(WORK_AREA);
  assert.equal(b.width, 88);
  assert.equal(b.height, 88);
});

test("A9：展开态与球形态的图标屏幕坐标一致", () => {
  for (const area of [WORK_AREA, OFFSET_AREA]) {
    const expanded = iconScreenPoint("bar", area);
    const ball = iconScreenPoint("ball", area);
    assert.deepEqual(ball, expanded, "球就是条左端那个图标，全程不动");
  }
});

test("A9：详情态图标也在同一处（加高不该让图标跳）", () => {
  assert.deepEqual(iconScreenPoint("detail", WORK_AREA), iconScreenPoint("bar", WORK_AREA));
});

test("A9：图标相对窗口左缘恒为 36 —— 规范记的「实测都是 36」是这个量", () => {
  // 规范 3.1 的「两态实测都是 36」是图标相对**窗口左缘**的偏移，
  // 不是屏幕绝对坐标（绝对坐标随工作区宽度变，不可能恒为 36）。
  for (const area of [WORK_AREA, OFFSET_AREA]) {
    const bar = barBounds(area);
    const ball = ballBounds(area);
    assert.equal(iconScreenPoint("bar", area).x - bar.x, 36);
    assert.equal(iconScreenPoint("ball", area).x - ball.x, 24, "球形态下图标相对窗口左缘是球的边距");
    // 但屏幕绝对坐标两态必须一致——这才是 A9 的判据
    assert.equal(iconScreenPoint("ball", area).x, iconScreenPoint("bar", area).x);
  }
});

test("球形态窗口相对条窗口的位置是反解出来的，不是硬编码", () => {
  const bar = barBounds(WORK_AREA);
  const ball = ballBounds(WORK_AREA);
  // 球窗口 x 偏移 = 图标在窗口内的 x - 球在窗口内的左边距
  assert.equal(ball.x - bar.x, GEOMETRY.ICON_IN_WINDOW_X - GEOMETRY.BALL_INSET_X);
  assert.equal(ball.y - bar.y, GEOMETRY.ICON_IN_WINDOW_Y - GEOMETRY.BALL_INSET_Y);
});

test("boundsFor 覆盖三种形态，未知形态明确抛错", () => {
  for (const form of FORMS) {
    const b = boundsFor(form, WORK_AREA);
    assert.ok(b.width > 0 && b.height > 0, `${form} 的尺寸必须为正`);
    assert.ok(Number.isInteger(b.x) && Number.isInteger(b.y), `${form} 的坐标必须是整数`);
  }
  assert.throws(() => boundsFor("飞起来", WORK_AREA), /未知形态/);
});

test("全部形态都取整：setBounds 只接受整数", () => {
  // 宽度为奇数的工作区才能逼出 .5 的居中偏移
  const odd = { x: 0, y: 0, width: 1921, height: 1080 };
  for (const form of FORMS) {
    const b = boundsFor(form, odd);
    for (const [k, v] of Object.entries(b)) {
      assert.ok(Number.isInteger(v), `${form}.${k} = ${v} 不是整数`);
    }
  }
});

test("工作区非法时明确抛错，不猜默认值", () => {
  for (const bad of [null, undefined, 42, {}, { x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 10 }]) {
    assert.equal(normalizeWorkArea(bad), null, `${JSON.stringify(bad)} 应判为非法`);
  }
  assert.throws(() => barBounds(null), /workArea 不合法/);
});

test("normalizeWorkArea 放行合法值并保持原样", () => {
  assert.deepEqual(normalizeWorkArea(WORK_AREA), WORK_AREA);
});

test("窗口比条大一圈 —— 阴影是画在窗口内部的", () => {
  const b = barBounds(WORK_AREA);
  // 左右各 14px、下方 14px、上方 6px
  assert.equal(b.width - GEOMETRY.BAR_WIDTH, GEOMETRY.SHADOW_PAD * 2);
  assert.equal(b.height - GEOMETRY.BAR_HEIGHT, GEOMETRY.TOP_GAP + GEOMETRY.SHADOW_PAD);
});

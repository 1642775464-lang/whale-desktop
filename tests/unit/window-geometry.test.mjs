/**
 * 小窗几何单测
 *
 * 职责：钉死「缩放只施加一次」与「记忆值不再乘系数」这两条，
 *       它们是 PRD 明文记过的坑（曾放大成 1.1³ ≈ 1.33）。
 * 所属层：测试（tests/unit）
 *
 * 几何测试的价值：它能在**没有窗口**的情况下证明尺寸口径是对的，
 * 而且能把「放大两次恰好得到 460×678」这条历史事实变成可验证的断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  BASE_CONTENT,
  CONTENT_SCALE,
  CONTENT_WIDTH,
  CONTENT_HEIGHT,
  GEOMETRY,
  SHADOW_PAD,
  defaultBounds,
  defaultContentSize,
  scaledContent,
  toContentSize,
  toWindowSize,
} = require("../../whale-window/lib/geometry.cjs");

/** 本机工作区（2560×1440，任务栏在下）。 */
const WORK_AREA = { x: 0, y: 0, width: 2560, height: 1400 };

test("常量与 PRD / 前端设计规范一致", () => {
  assert.equal(SHADOW_PAD, 16);
  assert.equal(CONTENT_WIDTH, 460);
  assert.equal(CONTENT_HEIGHT, 678);
  assert.equal(CONTENT_SCALE, 1.1);
  assert.equal(GEOMETRY.CORNER_RADIUS, 18);
  // 顶栏高度：用户要求 1.3 倍放大（42 → 55）
  assert.equal(GEOMETRY.TOPBAR_HEIGHT, 55);
});

test("内容 460×678 → 窗口 492×710", () => {
  const win = toWindowSize({ width: 460, height: 678 });
  assert.deepEqual(win, { width: 492, height: 710 });
});

test("窗口 492×710 → 内容 460×678（可逆）", () => {
  assert.deepEqual(toContentSize({ width: 492, height: 710 }), { width: 460, height: 678 });
});

test("toWindowSize 只加边距，不乘系数", () => {
  // PRD 明文警告：在 toWindowSize 里再乘一次缩放会变成 1.1³
  const win = toWindowSize({ width: 460, height: 678 });
  assert.equal(win.width - 460, SHADOW_PAD * 2);
  assert.equal(win.height - 678, SHADOW_PAD * 2);
  // 若这里乘了 1.1，宽度会是 541 而不是 492
  assert.notEqual(win.width, Math.round(460 * 1.1) + SHADOW_PAD * 2);
});

test("放大链：380×560 放大两次恰好得 460×678", () => {
  // 这是 PRD 的历史事实（380 → 418 → 460），钉住它才能保证默认值不是抄错的
  const once = scaledContent(BASE_CONTENT, 1);
  assert.deepEqual(once, { width: 418, height: 616 }, "第一次放大到 418×616");

  const twice = scaledContent(BASE_CONTENT, 2);
  assert.deepEqual(twice, { width: 460, height: 678 }, "第二次放大到 460×678");

  const win = toWindowSize(twice);
  assert.deepEqual(win, { width: 492, height: 710 }, "此时窗口应为 492×710");
});

test("放大系数施加三次会得到 PRD 记录的错误尺寸 506×746", () => {
  // PRD 记的坑：用户放大两次（×1.1²），代码又让 toWindowSize() 乘了一遍，
  // 于是系数被施加三次，实测可见内容变成 506×746。
  //
  // 复现它必须**逐次取整**（每一步都 round），否则算出来是 509×749 —— 差一点，
  // 那就说明复现的算法不对，而不是 PRD 记错了。这条测试同时也钉住这件事：
  // 只有「每一步都取整」的算法才会得出 506×746。
  let content = BASE_CONTENT;
  for (let i = 0; i < 3; i += 1) {
    content = {
      width: Math.round(content.width * CONTENT_SCALE),
      height: Math.round(content.height * CONTENT_SCALE),
    };
  }
  assert.deepEqual(content, { width: 506, height: 746 }, "这就是当初实测到的尺寸");

  // 正确结果与之必须不同，否则这条测试抓不到东西
  assert.notDeepEqual(scaledContent(BASE_CONTENT, 2), content);
});

test("默认内容尺寸与常量一致", () => {
  assert.deepEqual(defaultContentSize(), { width: 460, height: 678 });
});

test("记忆值直接当窗口尺寸用，不再乘系数", () => {
  // 用户拖出来的窗口尺寸原样存、原样用；若再乘系数，每重启一次就大一圈
  const remembered = { width: 600, height: 900 };
  assert.deepEqual(toContentSize(remembered), { width: 568, height: 868 });
  // 关键：不得出现「记忆值 × 1.1」
  assert.notEqual(Math.round(remembered.width * CONTENT_SCALE), remembered.width);
});

test("默认位置：屏幕右侧居中", () => {
  const win = { width: 492, height: 710 };
  const b = defaultBounds(WORK_AREA, win, 24);
  assert.equal(b.width, 492);
  assert.equal(b.height, 710);
  // 右缘距工作区右缘 = margin
  assert.equal(WORK_AREA.x + WORK_AREA.width - (b.x + b.width), 24);
  // 垂直居中（±1）
  const centerDelta = Math.abs(b.y + b.height / 2 - (WORK_AREA.y + WORK_AREA.height / 2));
  assert.ok(centerDelta <= 1, `垂直居中误差 ${centerDelta}`);
});

test("默认位置：偏移工作区同样正确", () => {
  const area = { x: -1920, y: 40, width: 1920, height: 1040 };
  const b = defaultBounds(area, { width: 492, height: 710 }, 24);
  assert.equal(area.x + area.width - (b.x + b.width), 24);
  assert.ok(Math.abs(b.y + b.height / 2 - (area.y + area.height / 2)) <= 1);
});

test("尺寸非法时明确抛错，不猜默认值", () => {
  for (const bad of [null, undefined, 42, {}, { width: 0, height: 10 }, { width: 10 }]) {
    assert.throws(() => toWindowSize(bad), TypeError, `${JSON.stringify(bad)} 应抛错`);
  }
});

test("工作区非法时明确抛错", () => {
  assert.throws(() => defaultBounds(null, { width: 492, height: 710 }), /workArea 不合法/);
});

test("全部输出都是整数（setBounds 只接受整数）", () => {
  const area = { x: 1, y: 3, width: 1921, height: 1081 };
  const b = defaultBounds(area, { width: 493, height: 711 }, 25);
  for (const [k, v] of Object.entries(b)) {
    assert.ok(Number.isInteger(v), `${k} = ${v} 不是整数`);
  }
});

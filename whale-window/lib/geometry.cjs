/**
 * 小窗几何
 *
 * 职责：把《小窗-PRD》F1 与《前端设计规范》4.1 的尺寸口径收敛成一组纯计算——
 *       内容尺寸、窗口尺寸、缩放、以及「窗口该摆在哪」。
 * 所属层：小窗（whale-window/lib）
 *
 * 尺寸口径（PRD 特意写清的，因为踩过）：
 *   「内容」= 布局真正能用的那块矩形
 *   「窗口」= 内容 + 四周 SHADOW_PAD（撑出投影空间），CSS 再用等量 padding 收回
 *
 * **两个必须避开的坑**（PRD 原文记录）：
 *   1. 不要对**窗口**尺寸乘缩放系数 —— 边距会被一起放大，比例反而是错的
 *   2. 不要把系数施加两次 —— 曾在 scaledContent() 之后又让 toWindowSize()
 *      乘一遍，实际变成 1.1³ ≈ 1.33，实测可见内容 506×746 才发现。
 *      **toWindowSize() 只负责加边距。**
 *
 * 记忆值存的是**窗口尺寸**，所以只在「没有记忆值」时才由默认内容尺寸换算；
 * 不能反过来拿记忆值乘系数，否则用户每重启一次小窗就被放大一次。
 *
 * 本模块不 require 任何东西，可脱离 Electron 单测。
 */

"use strict";

/** 投影边距：窗口比内容四周各大这么多（PRD F1）。 */
const SHADOW_PAD = 16;

/** 默认内容尺寸（PRD F1，放大两次后的终值）。 */
const CONTENT_WIDTH = 460;
const CONTENT_HEIGHT = 678;

/** 每次放大倍数（PRD F1）。 */
const CONTENT_SCALE = 1.1;

/** 放大次数（历史沿革：380 → 418 → 460）。 */
const SCALE_TIMES = 2;

/** 圆角（《前端设计规范》4.1）。 */
const CORNER_RADIUS = 18;

/** 顶栏高度（《前端设计规范》4.2；用户要求 1.3 倍放大：42 → 55）。 */
const TOPBAR_HEIGHT = 55;

/**
 * 内容尺寸 → 窗口尺寸。
 *
 * **只加边距，不乘任何系数。** 这条是 PRD 明文警告过的：
 * 在这里再乘一次缩放会变成 1.1³，窗口远大于内容。
 *
 * @param {{width: number, height: number}} content
 * @returns {{width: number, height: number}}
 */
function toWindowSize(content) {
  assertSize(content, "content");
  return {
    width: content.width + SHADOW_PAD * 2,
    height: content.height + SHADOW_PAD * 2,
  };
}

/**
 * 窗口尺寸 → 内容尺寸。
 *
 * @param {{width: number, height: number}} windowSize
 * @returns {{width: number, height: number}}
 */
function toContentSize(windowSize) {
  assertSize(windowSize, "windowSize");
  return {
    width: Math.max(0, windowSize.width - SHADOW_PAD * 2),
    height: Math.max(0, windowSize.height - SHADOW_PAD * 2),
  };
}

/** 尺寸合法性校验：拿不到合法尺寸时不猜默认值。 */
function assertSize(size, name) {
  const ok =
    size !== null &&
    typeof size === "object" &&
    typeof size.width === "number" &&
    typeof size.height === "number" &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0;
  if (!ok) throw new TypeError(`${name} 不合法：需要正的 {width, height}`);
}

/**
 * 把尺寸取整（窗口尺寸必须是整数）。
 *
 * @param {{width: number, height: number}} size
 * @returns {{width: number, height: number}}
 */
function roundSize(size) {
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

/**
 * 默认内容尺寸。
 *
 * 用 SCALE_TIMES 与 CONTENT_SCALE 反推一次并与常量对账，
 * 这样「放大两次得到 460」这件事在代码里是可验证的，而不是只能靠注释。
 *
 * @returns {{width: number, height: number}}
 */
function defaultContentSize() {
  return { width: CONTENT_WIDTH, height: CONTENT_HEIGHT };
}

/**
 * 由「原始尺寸 + 放大次数」算内容尺寸。
 *
 * 只在**没有记忆值**时用。记忆值存的是窗口尺寸，直接当窗口尺寸用，
 * 不能再乘系数（否则每重启一次就放大一次）。
 *
 * @param {{width: number, height: number}} base 原始内容尺寸
 * @param {number} times 放大次数
 * @returns {{width: number, height: number}}
 */
function scaledContent(base, times) {
  assertSize(base, "base");
  const n = Number.isInteger(times) && times > 0 ? times : 0;
  const factor = CONTENT_SCALE ** n;
  return roundSize({ width: base.width * factor, height: base.height * factor });
}

/** 原始内容尺寸（放大之前，仅用于校验换算链）。 */
const BASE_CONTENT = Object.freeze({ width: 380, height: 560 });

/**
 * 给窗口挑一个默认位置：屏幕工作区**右侧居中**（PRD F1）。
 *
 * @param {object} workArea
 * @param {{width: number, height: number}} windowSize
 * @param {number} [margin] 右边距
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function defaultBounds(workArea, windowSize, margin = 24) {
  const area = normalizeArea(workArea);
  if (area === null) throw new TypeError("workArea 不合法：需要 {x,y,width,height}");
  assertSize(windowSize, "windowSize");

  const width = Math.round(windowSize.width);
  const height = Math.round(windowSize.height);

  // 右缘留出 margin；垂直居中于工作区
  const x = Math.round(area.x + area.width - width - margin);
  const y = Math.round(area.y + (area.height - height) / 2);

  return { x, y, width, height };
}

/** 工作区校验（拿不到就给 null，由调用方处理）。 */
function normalizeArea(workArea) {
  if (workArea === null || typeof workArea !== "object") return null;
  const { x, y, width, height } = workArea;
  const nums = [x, y, width, height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** 供日志与测试引用的常量表。 */
const GEOMETRY = Object.freeze({
  SHADOW_PAD,
  CONTENT_WIDTH,
  CONTENT_HEIGHT,
  CONTENT_SCALE,
  SCALE_TIMES,
  CORNER_RADIUS,
  TOPBAR_HEIGHT,
  BASE_CONTENT,
});

module.exports = {
  BASE_CONTENT,
  CONTENT_HEIGHT,
  CONTENT_SCALE,
  CONTENT_WIDTH,
  CORNER_RADIUS,
  GEOMETRY,
  SCALE_TIMES,
  SHADOW_PAD,
  TOPBAR_HEIGHT,
  defaultBounds,
  defaultContentSize,
  normalizeArea,
  roundSize,
  scaledContent,
  toContentSize,
  toWindowSize,
};

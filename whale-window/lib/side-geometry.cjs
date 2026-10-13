/**
 * 右侧附带窗的几何
 *
 * 职责：算「右侧窗该贴在哪」与「抽屉拉开动画的每一帧位置」——
 *       纯计算，不碰 Electron。
 * 所属层：小窗（whale-window/lib）
 *
 * ## 尺寸口径（沿用 geometry.cjs 的约定）
 *
 *   「内容」= 布局真正能用的矩形
 *   「窗口」= 内容 + 四周 SHADOW_PAD（撑投影空间）
 *
 * 侧窗与小窗**等宽等高**（用户要求「大小和现有小窗窗口一致」），
 * 因此窗口尺寸由 `geometry.toWindowSize` 直接算，本模块只管**位置**。
 *
 * ## 贴合点怎么定
 *
 * 「贴在小窗右侧」= 两个窗口的**可见区**边缘相接，而不是窗口矩形相接 ——
 * 窗口矩形四周有 SHADOW_PAD 的透明投影边距，按矩形相接会留出
 * 32px 的空隙（实测观感就是「没贴上」）。
 *
 *   小窗可见右边缘 = win.x + SHADOW_PAD + contentW
 *   侧窗可见左边缘 = side.x + SHADOW_PAD
 *   两者相等 → side.x = win.x + contentW
 *
 * 本模块不 require 任何东西，可脱离 Electron 单测。
 */

"use strict";

/** 投影边距（与 geometry.cjs 同一口径，单列常量避免循环依赖）。 */
const SHADOW_PAD = 16;

/**
 * 展开/收起动画时长（毫秒）。用户要求「匀速拉开」，所以不做缓动。
 *
 * 两轮调整：220ms（有抽屉感）→ 用户说「滑动打开和关闭的速度加快」→ 140ms。
 * 再快就会显得是「闪一下」而不是滑动，所以不再往下调。
 */
const DRAWER_MS = 140;

/**
 * 把值夹到区间内。
 *
 * @param {number} v
 * @param {number} lo
 * @param {number} hi
 * @returns {number}
 */
function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * 算侧窗在「完全拉开」时的位置。
 *
 * @param {{x:number,y:number,width:number,height:number}} winBounds 小窗窗口矩形
 * @param {number} sideWindowWidth 侧窗窗口宽度
 * @param {{x:number,y:number,width:number,height:number}} [workArea] 屏幕工作区（可选）
 * @returns {{x:number,y:number}} 侧窗左上角
 */
function dockedPosition(winBounds, sideWindowWidth, workArea) {
  const contentW = winBounds.width - SHADOW_PAD * 2;
  let x = winBounds.x + contentW;
  const y = winBounds.y;

  /*
   * 屏幕右边放不下时**回退到左移**：硬贴着会跑到屏幕外，
   * 用户看到的是「面板没出现」（比叠在一起更难查）。
   * 这里只保证它落在工作区内，不改变贴合语义（仍是紧挨着）。
   */
  if (workArea !== undefined && workArea !== null) {
    const rightEdge = x + sideWindowWidth;
    if (rightEdge > workArea.x + workArea.width) {
      x = clamp(workArea.x + workArea.width - sideWindowWidth, workArea.x, x);
    }
  }
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * 算「收起」时的位置（抽屉推进屏幕右侧外）。
 *
 * 收起态放在屏幕外，而不是把窗口隐藏 —— 隐藏窗口无法播放动画。
 *
 * @param {{x:number,y:number,width:number,height:number}} winBounds
 * @param {number} sideWindowWidth
 * @param {{x:number,y:number,width:number,height:number}} [workArea]
 * @returns {{x:number,y:number}}
 */
function hiddenPosition(winBounds, sideWindowWidth, workArea) {
  const docked = dockedPosition(winBounds, sideWindowWidth, workArea);
  return { x: Math.round(docked.x + sideWindowWidth), y: docked.y };
}

/**
 * 算抽屉动画在某个时刻的位置（**匀速** —— 用户明确要求）。
 *
 * @param {{x:number,y:number,width:number,height:number}} winBounds
 * @param {number} sideWindowWidth
 * @param {number} t 进度：0 = 完全收起，1 = 完全拉开
 * @param {{x:number,y:number,width:number,height:number}} [workArea]
 * @returns {{x:number,y:number}}
 */
function drawerFrame(winBounds, sideWindowWidth, t, workArea) {
  const p = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  const from = hiddenPosition(winBounds, sideWindowWidth, workArea);
  const to = dockedPosition(winBounds, sideWindowWidth, workArea);
  // 匀速：位置与进度成正比
  return {
    x: Math.round(from.x + (to.x - from.x) * p),
    y: Math.round(from.y + (to.y - from.y) * p),
  };
}

/**
 * 判断侧窗是否还贴着（小窗被移动/缩放后要跟随）。
 *
 * @param {{x:number,y:number}} sidePos 侧窗当前位置
 * @param {{x:number,y:number,width:number,height:number}} winBounds 小窗当前矩形
 * @param {{x:number,y:number,width:number,height:number}} [workArea]
 * @returns {boolean}
 */
function needsRedock(sidePos, winBounds, workArea) {
  const want = dockedPosition(winBounds, winBounds.width, workArea);
  return Math.abs(sidePos.x - want.x) > 1 || Math.abs(sidePos.y - want.y) > 1;
}

/**
 * 算「往右展开」动画的某一帧（**宽度插值**）。
 *
 * ⚠️ 与 `drawerFrame` 的区别（用户要求改了做法，两套都保留但各司其职）：
 *   · `drawerFrame` 是**整体平移**（窗口从屏幕右侧滑到贴靠位）；
 *   · 这里是**从左边框往外长** —— 左边缘固定在小窗的右边框上，
 *     只有宽度从 0 长到全宽。
 *
 * 用户原话是「从小窗的右边框往右拉出」，所以用这一种。
 *
 * @param {{x:number,y:number,width:number,height:number}} winBounds 小窗窗口矩形
 * @param {number} sideWindowWidth 完全展开时的窗口宽度
 * @param {number} t 进度：0 = 宽 0，1 = 全宽
 * @param {{x:number,y:number,width:number,height:number}} [workArea]
 * @returns {{x:number,y:number,width:number}} 该帧的窗口矩形（高度由调用方保持）
 */
function expandFrame(winBounds, sideWindowWidth, t, workArea) {
  const p = clamp(Number.isFinite(t) ? t : 0, 0, 1);
  /*
   * 左边缘固定在**小窗可见区右缘**：整段动画里窗口左边不动、右边往右长 ——
   * 这正是「从边框拉出」的观感。用 dockedPosition 算是为了让
   * 「贴到屏外时回退」这条规则在展开动画里也一致生效。
   */
  const target = dockedPosition(winBounds, sideWindowWidth, workArea);
  /*
   * ⚠️ 宽度不能给 0：Electron 会把 0 宽当非法尺寸并**忽略这次 setBounds**
   * （窗口保持旧宽度），表现是「动画不播、面板直接出现」。
   * 从 1px 起步在视觉上等同于「从零长出」。
   */
  const width = Math.max(1, Math.round(sideWindowWidth * p));
  return { x: target.x, y: target.y, width };
}

/**
 * 贴住时两侧是否该「连成一体」（去掉相邻的圆角/边框/阴影）。
 *
 * 抽成函数是为了让呈现层与测试**共用同一条判据**，
 * 而不是主进程、两侧 CSS、探针各写一遍「差几像素算贴住」。
 *
 * @param {{x:number,y:number}} sidePos 侧窗当前位置
 * @param {{x:number,y:number,width:number,height:number}} winBounds 小窗矩形
 * @param {number} sideWindowWidth
 * @param {{x:number,y:number,width:number,height:number}} [workArea]
 * @returns {boolean}
 */
function isJoined(sidePos, winBounds, sideWindowWidth, workArea) {
  const want = dockedPosition(winBounds, sideWindowWidth, workArea);
  return Math.abs(sidePos.x - want.x) <= 1 && Math.abs(sidePos.y - want.y) <= 1;
}

module.exports = {
  DRAWER_MS,
  SHADOW_PAD,
  dockedPosition,
  drawerFrame,
  expandFrame,
  hiddenPosition,
  isJoined,
  needsRedock,
};

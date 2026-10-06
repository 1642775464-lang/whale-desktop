/**
 * 悬浮条几何
 *
 * 职责：把《悬浮窗-PRD》F1/F5 与《前端设计规范》3.1 的几何常量收敛成
 *       一组纯计算——窗口该摆在哪、三形态各多大、图标屏幕坐标是多少。
 * 所属层：悬浮条（whale-hud/lib）
 *
 * 为什么单独成文件：几何是「算数」，状态机是「记状态」。改缩放适配只动这里，
 * 改交互只动状态机——两者改动原因不同，挤在一起会让「加一种形态」变成
 * 在两个关注点之间来回跳。
 *
 * 为什么全程用 DIP（设备无关像素）而不调 Win32：
 * A1 判据里的 `workArea` 与 `setBounds` 收的都是 DIP，两侧同量纲，居中自洽。
 * 读物理矩形需要 FFI（node-ffi / koffi），与「运行时依赖为 0」冲突。
 * 这是一处**对架构草案的偏离**，已在《切片 4 范围声明》S4-D1 记录。
 *
 * 关于锚点：球可以拖动。拖动之后图标不再位于居中位置，若展开时又按居中算，
 * 图标就会「跳回去」。所以所有定位函数都接受一个可选的**图标屏幕 x 锚点**：
 * 给了就按它定位，没给才走居中。这样「球全程不动」这条模型在拖动后依然成立。
 *
 * 本模块不 require 任何东西，可脱离 Electron 单测。
 */

"use strict";

/** 条本体宽（PRD F1）。 */
const BAR_WIDTH = 560;

/** 条本体高（PRD F1）。 */
const BAR_HEIGHT = 52;

/**
 * 条上方留白。
 *
 * 为什么不是 0：想把条贴死在屏幕上缘就得给负的窗口 y，
 * 而 Windows 会把负 y 夹回 0，结果条被往下推、上圆角被吃掉。
 * 所以窗口 y 就等于工作区顶边，条在里面再下移 6px。
 */
const TOP_GAP = 6;

/** 左右与下方留白，用来画 CSS 阴影（Windows 对无边框透明窗不画原生阴影）。 */
const SHADOW_PAD = 14;

/** 悬停详情时窗口额外加高。 */
const MENU_EXTRA_HEIGHT = 268;

/** 展开态窗口宽 = 条宽 + 左右阴影边距。 */
const WINDOW_WIDTH = BAR_WIDTH + SHADOW_PAD * 2;

/** 展开态窗口高 = 条高 + 上方留白 + 下方阴影边距。 */
const WINDOW_HEIGHT = BAR_HEIGHT + TOP_GAP + SHADOW_PAD;

/** 球形态窗口边长（PRD F5）。 */
const BALL_WINDOW_SIZE = 88;

/** 球在窗口内的左边距（PRD F5）。 */
const BALL_INSET_X = 24;

/** 球在窗口内的上边距（PRD F5）。 */
const BALL_INSET_Y = 12;

/** 球直径。 */
const BALL_DIAMETER = 40;

/** 图标在条内的左边距（《前端设计规范》3.1）。 */
const BAR_ICON_INSET_X = 22;

/** 图标在条内的上边距（《前端设计规范》3.1）。 */
const BAR_ICON_INSET_Y = 12;

/** 图标边长。 */
const BAR_ICON_SIZE = 40;

/**
 * 图标在窗口坐标系里的左上角。
 *
 * 这就是 A9 判据要钉的那个数：**两态必须一致**。
 * 展开态 = 阴影边距 + 条内偏移；球形态的位置由 ballBounds 反解保证相等，
 * 而不是两处各写各的。
 */
const ICON_IN_WINDOW_X = SHADOW_PAD + BAR_ICON_INSET_X;
const ICON_IN_WINDOW_Y = TOP_GAP + BAR_ICON_INSET_Y;

/** 三种形态名。 */
const FORMS = ["bar", "ball", "detail"];

/**
 * 把矩形取整。
 *
 * Electron 的 setBounds 只接受整数；小数会被各自取整，
 * 于是「窗口中心」与「工作区中心」可能差 1px。统一在本层取整，
 * 让 A1 的 ±1 容差有确定来源。
 *
 * @param {{x: number, y: number, width: number, height: number}} rect
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function roundRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

/**
 * 工作区校验。
 *
 * 拿不到工作区时不猜一个默认值——猜出来的坐标会把窗口丢到看不见的地方，
 * 比明确失败更难查。调用方必须处理 null。
 *
 * @param {unknown} workArea
 * @returns {{x: number, y: number, width: number, height: number} | null}
 */
function normalizeWorkArea(workArea) {
  if (workArea === null || typeof workArea !== "object") return null;
  const { x, y, width, height } = workArea;
  const nums = [x, y, width, height];
  if (!nums.every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/** 锚点是否为可用数字。 */
function hasAnchor(anchorIconX) {
  return typeof anchorIconX === "number" && Number.isFinite(anchorIconX);
}

/** 要求一个合法工作区，否则抛错。 */
function requireWorkArea(workArea) {
  const area = normalizeWorkArea(workArea);
  if (area === null) throw new TypeError("workArea 不合法：需要 {x,y,width,height}");
  return area;
}

/**
 * 展开态（P1）窗口矩形：顶边居中；给了锚点就按锚点对齐。
 *
 * @param {object} workArea
 * @param {number} [anchorIconX] 图标左边缘的屏幕 x
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function barBounds(workArea, anchorIconX) {
  const area = requireWorkArea(workArea);
  const x = hasAnchor(anchorIconX)
    ? anchorIconX - ICON_IN_WINDOW_X
    : area.x + (area.width - WINDOW_WIDTH) / 2;
  return roundRect({ x, y: area.y, width: WINDOW_WIDTH, height: WINDOW_HEIGHT });
}

/**
 * 悬停详情（P3）窗口矩形。
 *
 * 只加高，不动 x/y：条必须**原地不动**，否则鼠标还没移到浮层上，
 * 条已经跳走了。
 *
 * @param {object} workArea
 * @param {number} [anchorIconX]
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function detailBounds(workArea, anchorIconX) {
  const base = barBounds(workArea, anchorIconX);
  return { ...base, height: base.height + MENU_EXTRA_HEIGHT };
}

/**
 * 球形态（P2）窗口矩形。
 *
 * 核心模型（用户裁定）：球就是条左端那个图标，**全程不动**。
 * 所以球窗口的位置不是随便定的，而是**从「图标屏幕坐标不变」反解出来的**：
 *   图标屏幕 x = 条窗口 x + ICON_IN_WINDOW_X = 球窗口 x + BALL_INSET_X
 * 两个表达式一联立就得到下面的偏移量。若哪天改了 ICON_IN_WINDOW_X，
 * 球窗口会跟着走，图标仍然不动——这正是要的效果。
 *
 * @param {object} workArea
 * @param {number} [anchorIconX]
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function ballBounds(workArea, anchorIconX) {
  const base = barBounds(workArea, anchorIconX);
  const x = hasAnchor(anchorIconX)
    ? anchorIconX - BALL_INSET_X
    : base.x + (ICON_IN_WINDOW_X - BALL_INSET_X);
  return roundRect({
    x,
    y: base.y + (ICON_IN_WINDOW_Y - BALL_INSET_Y),
    width: BALL_WINDOW_SIZE,
    height: BALL_WINDOW_SIZE,
  });
}

/**
 * 取某形态的窗口矩形。
 *
 * @param {string} form
 * @param {object} workArea
 * @param {number} [anchorIconX]
 * @returns {{x: number, y: number, width: number, height: number}}
 */
function boundsFor(form, workArea, anchorIconX) {
  if (form === "bar") return barBounds(workArea, anchorIconX);
  if (form === "ball") return ballBounds(workArea, anchorIconX);
  if (form === "detail") return detailBounds(workArea, anchorIconX);
  throw new TypeError(`未知形态：${form}`);
}

/**
 * 图标在屏幕上的左上角坐标。
 *
 * 这是 A9 的机器判据本体：给同一次测量到的 workArea，
 * 两态求出来的值必须相等。
 *
 * @param {string} form
 * @param {object} workArea
 * @param {number} [anchorIconX]
 * @returns {{x: number, y: number}}
 */
function iconScreenPoint(form, workArea, anchorIconX) {
  const win = boundsFor(form, workArea, anchorIconX);
  if (form === "ball") {
    return { x: win.x + BALL_INSET_X, y: win.y + BALL_INSET_Y };
  }
  // 详情态的条位置与展开态一致，图标自然也在同一处
  return { x: win.x + ICON_IN_WINDOW_X, y: win.y + ICON_IN_WINDOW_Y };
}

/** 供主进程日志与测试引用的常量表（只读）。 */
const GEOMETRY = Object.freeze({
  BAR_WIDTH,
  BAR_HEIGHT,
  TOP_GAP,
  SHADOW_PAD,
  MENU_EXTRA_HEIGHT,
  WINDOW_WIDTH,
  WINDOW_HEIGHT,
  BALL_WINDOW_SIZE,
  BALL_INSET_X,
  BALL_INSET_Y,
  BALL_DIAMETER,
  BAR_ICON_INSET_X,
  BAR_ICON_INSET_Y,
  BAR_ICON_SIZE,
  ICON_IN_WINDOW_X,
  ICON_IN_WINDOW_Y,
});

module.exports = {
  FORMS,
  GEOMETRY,
  ballBounds,
  barBounds,
  boundsFor,
  detailBounds,
  iconScreenPoint,
  normalizeWorkArea,
};

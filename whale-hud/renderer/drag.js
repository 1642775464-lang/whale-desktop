/*
 * 球的拖动与单击/双击判定
 *
 * 职责：处理完整的鼠标序列——mousedown / mousemove / mouseup，
 *       并从中判定「拖动」「单击」「双击」三种意图。
 * 所属层：悬浮条（whale-hud/renderer）
 *
 * 为什么单独成文件：它是**唯一处理鼠标序列**的地方，而这三件事互相牵制——
 *   拖动超过 3px 就不算点击（A10）；
 *   单击唤起/收起小窗（F2①）；
 *   双击展开成条（球形态下的展开手势）。
 * 混在 hud.js 里时，改一个手势很容易碰到另一个，而且 hud.js 会越过模块行数上限。
 *
 * **单击/双击必须在这里一起判**，不能再挂一个 `click` 监听：
 * 拖动逻辑本来就掌握完整的鼠标序列，另挂监听会让一次点击被处理两遍。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleDrag。
 */

(function attachDrag(global) {
  "use strict";

  /** 拖动阈值：位移**超过**它才算拖动，否则算点击（A10）。 */
  const THRESHOLD_PX = 3;

  /** 双击判定窗口：两次点击间隔小于它当双击。 */
  const DOUBLE_CLICK_MS = 300;

  /**
   * 绑定拖动与手势。
   *
   * @param {object} deps
   * @param {HTMLElement} deps.handle 拖动把手（球）
   * @param {() => boolean} deps.canDrag 现在允许拖动吗（只有球形态允许）
   * @param {(dx: number, dy: number) => void} deps.onDragStart
   * @param {(dx: number, dy: number) => void} deps.onDragMove
   * @param {() => void} deps.onDragEnd
   * @param {() => void} deps.onClick 单击：唤起或收起小窗
   * @param {() => void} deps.onDoubleClick 双击：展开成条
   * @returns {{ thresholdPx: number, doubleClickMs: number }}
   */
  function bindDrag(deps) {
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let lastClickAt = 0;

    deps.handle.addEventListener("mousedown", function (ev) {
      if (!deps.canDrag() || ev.button !== 0) return;
      ev.preventDefault();
      dragging = true;
      startX = ev.screenX;
      startY = ev.screenY;
      deps.onDragStart();
    });

    global.document.addEventListener("mousemove", function (ev) {
      if (!dragging) return;
      deps.onDragMove(ev.screenX - startX, ev.screenY - startY);
    });

    global.document.addEventListener("mouseup", function (ev) {
      if (!dragging) return;
      dragging = false;

      const moved = Math.abs(ev.screenX - startX) > THRESHOLD_PX
        || Math.abs(ev.screenY - startY) > THRESHOLD_PX;
      deps.onDragEnd();

      // 位移超过阈值 = 拖动，不算点击
      if (moved) return;

      const now = Date.now();
      if (now - lastClickAt < DOUBLE_CLICK_MS) {
        lastClickAt = 0;
        deps.onDoubleClick();
        return;
      }
      lastClickAt = now;
      deps.onClick();
    });

    return { thresholdPx: THRESHOLD_PX, doubleClickMs: DOUBLE_CLICK_MS };
  }

  global.WhaleDrag = {
    DOUBLE_CLICK_MS,
    THRESHOLD_PX,
    bindDrag,
  };
})(typeof window !== "undefined" ? window : globalThis);

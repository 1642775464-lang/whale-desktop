/*
 * 左侧边栏
 *
 * 职责：顶栏「打开左侧边栏」按钮点开的那块面板 ——
 *       新会话、技能中心两个入口，加上工作区下的会话清单与切换。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么与 panels.js 分开：
 *   panels.js 是 ☰ 菜单里的会話列表（F9），它是**菜单的子层**；
 *   本文件是常驻的侧边栏，有自己的开关状态与两个功能入口。
 *   两者的容器、打开方式、生命周期都不同，混在一起会互相牵制。
 *
 * 会话切换的**副作用**必须说清（与 panels 同一条纪律）：
 *   点「可切换」= 把小窗绑到那个会话（activate）；
 *   点「历史」= 先在宿主里唤醒它（resume），成功才切。
 *   所以这两个分支不能接成纯展示的分支。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSidebar。
 */

(function attachSidebar(global) {
  "use strict";

  /**
   * 建侧边栏控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {sidebar, sbClose, sbNew, sbSkills, sbSessions}
   * @param {() => Array<object>} deps.getSessions 会话清单
   * @param {() => string|null} deps.getCurrentId 当前会话
   * @param {(sessionId: string) => void} deps.onSwitch 切到可切换的会话
   * @param {(sessionId: string) => void} deps.onResume 唤醒历史会话
   * @param {() => Promise<object>} deps.onNewSession 新建会话（宿主建完给 id）
   * @param {() => void} deps.onOpenSkills 打开技能中心
   * @param {(msg: string) => void} [deps.onNotify] 如实提示
   * @returns {object} 控制器
   */
  function createSidebar(deps) {
    const dom = deps.dom;
    const onNotify = typeof deps.onNotify === "function" ? deps.onNotify : function () {};
    let open = false;
    /** 唤醒中的会话 id → 已等待秒数（与 panels 同口径）。 */
    const waking = Object.create(null);
    /** 新建中的标记：连点两下不能建两个会话。 */
    let creating = false;

    /** 会话行的三档标签（复用 panels 的纯函数，规则只有一处实现）。 */
    function labelFor(session) {
      return global.WhalePanels.labelFor(session, deps.getCurrentId());
    }

    /** 渲染会话清单。 */
    function renderSessions() {
      const sessions = deps.getSessions();
      dom.sbSessions.innerHTML = "";

      if (!Array.isArray(sessions) || sessions.length === 0) {
        const none = global.document.createElement("div");
        none.className = "sb-empty";
        none.textContent = "没有可见的会话";
        dom.sbSessions.appendChild(none);
        return;
      }

      sessions.forEach(function (s) {
        const row = global.document.createElement("div");
        row.className = "sb-row";

        const name = global.document.createElement("span");
        name.textContent = s.title ?? s.sessionId;
        row.appendChild(name);

        const label = labelFor(s);
        const tag = global.document.createElement("span");
        if (waking[s.sessionId] !== undefined) {
          tag.className = "st sw";
          tag.textContent = `唤醒中 ${waking[s.sessionId]}s`;
        } else {
          tag.className = `st ${label.cls}`;
          tag.textContent = label.text;
        }
        row.appendChild(tag);

        row.addEventListener("click", function () {
          if (label.cls === "cur") {
            // 当前会话：不切，但收起侧边栏（点了要有个反馈）
            close();
            return;
          }
          if (label.cls === "sw") {
            deps.onSwitch(s.sessionId);
            close();
            return;
          }
          waking[s.sessionId] = 0;
          renderSessions();
          deps.onResume(s.sessionId);
        });

        dom.sbSessions.appendChild(row);
      });
    }

    /** 唤醒失败（由调用方在 resume 失败时调）。 */
    function markWakeFailed(sessionId) {
      delete waking[sessionId];
      renderSessions();
    }

    /** 唤醒成功。 */
    function markWoke(sessionId) {
      delete waking[sessionId];
      renderSessions();
    }

    /** 每秒推进唤醒倒计时。 */
    function tickWaking() {
      let changed = false;
      Object.keys(waking).forEach(function (id) {
        waking[id] += 1;
        changed = true;
      });
      if (changed && open) renderSessions();
    }

    /** 打开。 */
    function openSidebar() {
      open = true;
      dom.sidebar.hidden = false;
      renderSessions();
    }

    /** 关闭。 */
    function close() {
      open = false;
      dom.sidebar.hidden = true;
    }

    /** 切换。 */
    function toggle() {
      if (open) close();
      else openSidebar();
    }

    function isOpen() {
      return open;
    }

    // ── 两个入口 ──────────────────────────────────────

    dom.sbClose.addEventListener("click", close);

    dom.sbNew.addEventListener("click", function () {
      /*
       * ⚠️ 建会话是**写操作**（会在宿主里真的建一个）。
       * 连点两下会建两个空会话，所以这里挡住重入。
       */
      if (creating) return;
      creating = true;
      dom.sbNew.classList.add("busy");

      deps.onNewSession().then(function (out) {
        creating = false;
        dom.sbNew.classList.remove("busy");
        if (!out || out.ok !== true) {
          onNotify(`新建会话失败：${out?.code ?? "unknown"}`);
          return;
        }
        // 建完直接切过去 —— 用户点「新会话」就是要进新会话
        deps.onSwitch(out.sessionId);
        close();
      });
    });

    dom.sbSkills.addEventListener("click", function () {
      deps.onOpenSkills();
      close();
    });

    return {
      close,
      isOpen,
      markWakeFailed,
      markWoke,
      open: openSidebar,
      renderSessions,
      tickWaking,
      toggle,
    };
  }

  global.WhaleSidebar = { createSidebar };
})(typeof window !== "undefined" ? window : globalThis);

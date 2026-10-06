/*
 * 菜单与会话切换
 *
 * 职责：顶栏 `☰` 菜单、项目 → 会话列表的三档标签（当前 / 可切换 / 历史）、
 *       以及「更多」里的窗口动作。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：会话切换是**唯一有副作用的列表**——点「历史」会话会真的
 * 在宿主里唤醒它。它与「只是显示」的菜单项混在一起时，很容易顺手把一个
 * 有副作用的动作接成一个纯展示的分支。
 *
 * 三档标签的判据（《小窗-PRD》F9）：列的是「这个会话现在能不能直接切过去」。
 * 唤醒中显示倒计时，失败要还原标签并给出真实原因 —— 不使用模糊措辞。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhalePanels。
 */

(function attachPanels(global) {
  "use strict";

  /** 菜单项（顺序固定，见《页面框架》4.2）。 */
  const MENU_ITEMS = [
    { id: "projects", icon: "📁", label: "项目" },
    { id: "approval", icon: "🛡", label: "按需确认", badge: "灰" },
    { id: "skills", icon: "⚡", label: "技能" },
    { id: "plugins", icon: "🧩", label: "插件" },
    { divider: true },
    { id: "more", icon: "⋯", label: "更多", suffix: "窗口与设置" },
  ];

  /** 「更多」展开后的动作（F10）。 */
  const MORE_ITEMS = [
    { id: "minimize", label: "最小化" },
    { id: "reload", label: "重新加载界面" },
    { id: "quit", label: "退出小窗" },
  ];

  /**
   * 判一个会话该显示哪档标签。
   *
   * @param {object} session 会话条目 {sessionId, running, agentAvailable, ...}
   * @param {string|null} currentId 当前小窗打开的会话
   * @returns {{cls: string, text: string}} 标签的类与文案
   */
  function labelFor(session, currentId) {
    if (session.sessionId === currentId) return { cls: "cur", text: "当前" };
    // 宿主内存里有 agent → 能立刻切过去
    if (session.agentAvailable === true) return { cls: "sw", text: "可切换" };
    // 只在磁盘上 → 需要先唤醒
    return { cls: "hist", text: "历史" };
  }

  /**
   * 建一个菜单控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {menuBtn, menuBox, menuList, sessList}
   * @param {() => Array<object>} deps.getSessions
   * @param {() => string|null} deps.getCurrentId
   * @param {(sessionId: string) => void} deps.onSwitch 切到可切换的会话
   * @param {(sessionId: string) => void} deps.onResume 唤醒历史会话
   * @param {(action: string) => void} deps.onAction 窗口动作（最小化/重载/退出）
   * @param {(msg: string) => void} [deps.onUnavailable] 灰色项被点时的如实提示
   * @returns {object} 控制器
   */
  function createPanels(deps) {
    const dom = deps.dom;
    const onUnavailable = typeof deps.onUnavailable === "function" ? deps.onUnavailable : function () {};
    let open = false;
    /** 唤醒中的会话 id → 已等待秒数。 */
    const waking = Object.create(null);

    /** 渲染菜单主项。 */
    function renderMenu() {
      dom.menuList.innerHTML = "";
      MENU_ITEMS.forEach(function (item) {
        if (item.divider === true) {
          const dl = global.document.createElement("div");
          dl.className = "mdl";
          dom.menuList.appendChild(dl);
          return;
        }
        const row = global.document.createElement("div");
        // 「按需确认」能力未接通 → 灰色，且点击无静默效果
        row.className = item.badge === "灰" ? "mi grey" : "mi";
        row.textContent = `${item.icon} ${item.label}${item.suffix !== undefined ? `　${item.suffix}` : ""}`;
        row.addEventListener("click", function () {
          if (item.badge === "灰") {
            onUnavailable(`${item.label}（能力未接通）`);
            return;
          }
          if (item.id === "projects") {
            toggleSessions();
            return;
          }
          if (item.id === "more") {
            renderMore();
            return;
          }
          onUnavailable(`${item.label}（本片未接通）`);
        });
        dom.menuList.appendChild(row);
      });
    }

    /** 渲染「更多」的动作列表。 */
    function renderMore() {
      dom.menuList.innerHTML = "";
      MORE_ITEMS.forEach(function (item) {
        const row = global.document.createElement("div");
        row.className = "mi";
        row.textContent = item.label;
        row.addEventListener("click", function () {
          closeMenu();
          deps.onAction(item.id);
        });
        dom.menuList.appendChild(row);
      });
    }

    /** 展开/收起会话列表。 */
    function toggleSessions() {
      if (!dom.sessList.hidden) {
        dom.sessList.hidden = true;
        return;
      }
      renderSessions();
      dom.sessList.hidden = false;
    }

    /** 渲染会话列表（含三档标签与唤醒倒计时）。 */
    function renderSessions() {
      const currentId = deps.getCurrentId();
      const sessions = deps.getSessions();
      dom.sessList.innerHTML = "";

      if (sessions.length === 0) {
        const none = global.document.createElement("div");
        none.className = "sess-row";
        none.textContent = "没有可见的会话";
        dom.sessList.appendChild(none);
        return;
      }

      sessions.forEach(function (s) {
        const row = global.document.createElement("div");
        row.className = "sess-row";

        const name = global.document.createElement("span");
        name.textContent = s.title ?? s.sessionId;
        row.appendChild(name);

        const tag = global.document.createElement("span");
        const label = labelFor(s, currentId);
        // 唤醒中：标签变成「唤醒中 Ns」（F9）
        if (waking[s.sessionId] !== undefined) {
          tag.className = "st sw";
          tag.textContent = `唤醒中 ${waking[s.sessionId]}s`;
        } else {
          tag.className = `st ${label.cls}`;
          tag.textContent = label.text;
        }
        row.appendChild(tag);

        row.addEventListener("click", function () {
          if (label.cls === "cur") return; // 当前会话无操作
          if (label.cls === "sw") {
            closeMenu();
            deps.onSwitch(s.sessionId);
            return;
          }
          // 历史：先标记唤醒中，再真的去唤醒
          waking[s.sessionId] = 0;
          renderSessions();
          deps.onResume(s.sessionId);
        });

        dom.sessList.appendChild(row);
      });
    }

    /** 唤醒失败：还原标签（由调用方在 resume 失败时调）。 */
    function markWakeFailed(sessionId) {
      delete waking[sessionId];
      renderSessions();
    }

    /** 唤醒成功：清掉标记。 */
    function markWoke(sessionId) {
      delete waking[sessionId];
      renderSessions();
    }

    /** 每秒推进唤醒倒计时（F9 的「唤醒中 3s」）。 */
    function tickWaking() {
      let changed = false;
      Object.keys(waking).forEach(function (id) {
        waking[id] += 1;
        changed = true;
      });
      if (changed && !dom.sessList.hidden) renderSessions();
    }

    /** 打开菜单。 */
    function openMenu() {
      open = true;
      dom.menuBox.hidden = false;
      dom.sessList.hidden = true;
      renderMenu();
    }

    /** 关闭菜单。 */
    function closeMenu() {
      open = false;
      dom.menuBox.hidden = true;
      dom.sessList.hidden = true;
    }

    /** 切换菜单开关。 */
    function toggleMenu() {
      if (open) closeMenu();
      else openMenu();
    }

    /** 是否打开。 */
    function isOpen() {
      return open;
    }

    return {
      closeMenu,
      isOpen,
      markWakeFailed,
      markWoke,
      renderSessions,
      tickWaking,
      toggleMenu,
    };
  }

  global.WhalePanels = {
    MENU_ITEMS,
    MORE_ITEMS,
    createPanels,
    labelFor,
  };
})(typeof window !== "undefined" ? window : globalThis);

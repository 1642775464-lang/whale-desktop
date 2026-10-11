/*
 * 左侧边栏
 *
 * 职责：顶栏「打开左侧边栏」按钮点开的那块面板 ——
 *       新会话、技能中心两个入口，下面按**工作区分组**列会话标题。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么与 panels.js 分开：
 *   panels.js 是 ☰ 菜单里的会话列表（F9），它是**菜单的子层**；
 *   本文件是常驻的侧边栏，有自己的开关状态、两个入口与工作区分组。
 *   两者的容器、打开方式、生命周期都不同，混在一起会互相牵制。
 *
 * 会话清单**自己拉**（`/whale/session/list`），不读 `state.sessions`：
 *   后者来自 `/whale/hud`，只有折叠器里那几条、且**没有工作区字段**；
 *   而主窗口侧边栏的分组依据是每个会话的 `cwd`。用户报的
 *   「工作区与会话列表没加载」就是数据源选错了。
 *
 * 会话切换的**副作用**必须说清（与 panels 同一条纪律）：
 *   点「可切换」= 把小窗绑到那个会话（activate）；
 *   点「历史」= 先在宿主里唤醒它（resume），成功才切。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSidebar。
 */

(function attachSidebar(global) {
  "use strict";

  /**
   * 取工作区的显示名：取路径最后一段；取不到就用整条路径。
   *
   * `D:\DEEPSEEK\悬浮窗` → `悬浮窗`；`/home/me/proj` → `proj`。
   *
   * @param {string|null} cwd
   * @returns {string}
   */
  function workspaceNameOf(cwd) {
    if (typeof cwd !== "string" || cwd === "") return "其他";
    const parts = cwd.split(/[\\/]/).filter(function (p) { return p !== ""; });
    return parts.length > 0 ? parts[parts.length - 1] : cwd;
  }

  /**
   * 把会话按工作区归组，保持「组内按最近活动倒序」。
   *
   * ⚠️ 分组用桥给的 **`workspaceTitle`**（来自 Workspace registry 的登记标题），
   * 而不是从 `workspace` 路径里猜最后一段 —— 登记标题才是主窗口显示的那个，
   * 两者不一定相同（注册表里可以起任意标题）。
   * 拿不到登记标题时才退回路径猜测。
   *
   * @param {Array<object>} sessions
   * @returns {Array<{workspace: string, cwd: string|null, sessions: Array<object>}>}
   */
  function groupByWorkspace(sessions) {
    const groups = [];
    const index = Object.create(null);
    sessions.forEach(function (s) {
      const cwd = typeof s.workspace === "string" && s.workspace !== "" ? s.workspace : null;
      const title = typeof s.workspaceTitle === "string" && s.workspaceTitle !== ""
        ? s.workspaceTitle
        : workspaceNameOf(cwd);
      // 用工作区 id 分组（同名工作区不该被合并）；没有 id 时退回标题
      const key = typeof s.workspaceId === "string" && s.workspaceId !== "" ? s.workspaceId : title;
      if (index[key] === undefined) {
        index[key] = { workspace: title, cwd, sessions: [] };
        groups.push(index[key]);
      }
      index[key].sessions.push(s);
    });
    return groups;
  }

  /**
   * 一条会话该不该出现在侧边栏里。
   *
   * 判据照**主窗口**（`dsh-client-ui-workspace` 的 `sessionVisible`）：
   *
   *     if (session.blank && session.id !== current) return false;
   *     default: return !archived.has(session.id);
   *
   * 抽成纯函数是为了能直接单测 —— 用户报的「数目根本不对、多出来一堆
   * 空壳」就是因为这条判据漏了 blank，而它埋在渲染循环里时测不到。
   *
   * @param {object} session 会话行（含 `blank` / `archived`）
   * @param {string|null} currentId 当前会话 id
   * @param {boolean} archivedKnown 归档判据是否拿到（拿不到就不按归档过滤）
   * @returns {boolean} 是否显示
   */
  function sessionVisible(session, currentId, archivedKnown) {
    if (session === null || typeof session !== "object") return false;
    // 归档：只在我们**确实知道**归档状态时才隐藏（宁可多列不可误藏）
    if (archivedKnown === true && session.archived === true) return false;
    // 空会话：当前那个例外（用户可能正停在刚建的空会话上）
    if (session.blank === true && session.sessionId !== currentId) return false;
    return true;
  }

  /**
   * 建侧边栏控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {sidebar, sbClose, sbNew, sbSkills, sbSessions}
   * @param {() => Promise<{ok: boolean, sessions?: Array<object>, code?: string}>} deps.fetchSessions
   *        拉会话清单（含工作区）。**不走 state** —— 见文件头注释。
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
    /** 当前清单（拉回来之后存这里，供重绘与筛选用）。 */
    let sessions = [];
    /** 上一次拉取失败的原因；有值时界面显示它而不是「没有会话」。 */
    let loadError = null;
    /** 降级标记：清单是**回退数据**（不完整），要如实告知用户。 */
    let degraded = null;
    /**
     * 归档判据是否**拿到了**。
     *
     * `true` 时才按 `archived` 字段隐藏会话；`false` 时一律不隐藏 ——
     * 判据拿不到就按「都没归档」处理的话，会把用户的会话凭空藏掉。
     */
    let archivedKnown = false;
    /** 唤醒中的会话 id → 已等待秒数（与 panels 同口径）。 */
    const waking = Object.create(null);
    /** 新建中的标记：连点两下不能建两个会话。 */
    let creating = false;

    /** 会话行的三档标签（复用 panels 的纯函数，规则只有一处实现）。 */
    function labelFor(session) {
      return global.WhalePanels.labelFor(session, deps.getCurrentId());
    }

    /** 造一行会话。 */
    function sessionRow(s) {
      const row = global.document.createElement("div");
      row.className = "sb-row";

      const name = global.document.createElement("span");
      // 没有标题时显示短 id（`session-` 前缀去掉），比一整串可读
      const shortId = String(s.sessionId).replace(/^session-/, "").slice(0, 8);
      name.textContent = s.title ?? shortId;
      name.title = s.title ?? s.sessionId;
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
          close();   // 当前会话：不切，但收起侧边栏（点了要有反馈）
          return;
        }
        if (label.cls === "sw") {
          deps.onSwitch(s.sessionId);
          close();
          return;
        }
        // 历史：先标记唤醒中，再真的去唤醒
        waking[s.sessionId] = 0;
        renderSessions();
        deps.onResume(s.sessionId);
      });

      return row;
    }

    /** 造一个分组标题。 */
    function groupHead(group) {
      const head = global.document.createElement("div");
      head.className = "sb-group";
      const name = global.document.createElement("span");
      name.textContent = group.workspace;
      head.appendChild(name);
      const count = global.document.createElement("span");
      count.className = "sb-group-n";
      count.textContent = String(group.sessions.length);
      head.appendChild(count);
      if (group.cwd !== null) head.title = group.cwd;
      return head;
    }

    /** 渲染会话清单（按工作区分组）。 */
    function renderSessions() {
      dom.sbSessions.innerHTML = "";

      /*
       * 读失败时显示**原因**，不显示「没有可见的会话」——
       * 两者含义完全不同：一个是读不到，一个是真没有。
       * 混成一个会让用户以为会话没了。
       */
      if (loadError !== null) {
        const err = global.document.createElement("div");
        err.className = "sb-empty";
        err.textContent = `读不到会话清单：${loadError}`;
        dom.sbSessions.appendChild(err);
        return;
      }

      if (sessions.length === 0) {
        const none = global.document.createElement("div");
        none.className = "sb-empty";
        none.textContent = "没有可见的会话";
        dom.sbSessions.appendChild(none);
        return;
      }

      /*
       * 可见性判据在纯函数 `sessionVisible` 里（照主窗口的同名规则）。
       *
       * ⚠️ **不显示「略过 N 个空会话 / 隐藏 N 个归档会话」这类说明**。
       *
       * 用户明确要求去掉它们：「这个不需要显示出来」。理由也成立 ——
       * 过滤是我们的**正常行为**（主窗口同样这么做），不是异常。
       * 把它报成一行提示，等于每次开侧边栏都在提醒用户「有些东西你没看到」，
       * 那是噪音，而且会让人以为列表不完整。
       *
       * 仍然会出声的只剩**真正的异常**：
       *   · 读不到清单（loadError）→ 显示原因，因为那是故障；
       *   · 降级到回退数据（degraded）→ 说明数据可能不全。
       */
      const currentId = deps.getCurrentId();
      const visible = sessions.filter(function (s) {
        return sessionVisible(s, currentId, archivedKnown);
      });

      groupByWorkspace(visible).forEach(function (group) {
        dom.sbSessions.appendChild(groupHead(group));
        group.sessions.forEach(function (s) {
          dom.sbSessions.appendChild(sessionRow(s));
        });
      });

      /*
       * 降级说明放**最后**（列表下方）：会话仍能看能切，
       * 但不能假装数据完整 —— 标题/工作区可能缺，数量可能不全。
       */
      if (degraded !== null) {
        const note = global.document.createElement("div");
        note.className = "sb-note";
        note.textContent = `清单不完整（${degraded}）：仅显示已加载的会话`;
        dom.sbSessions.appendChild(note);
      }
    }

    /** 拉清单并重绘。 */
    function refresh() {
      return Promise.resolve(deps.fetchSessions()).then(function (out) {
        if (out !== null && out !== undefined && out.ok === true) {
          sessions = Array.isArray(out.sessions) ? out.sessions : [];
          loadError = null;
          degraded = typeof out.degraded === "string" && out.degraded !== "" ? out.degraded : null;
          archivedKnown = out.archivedKnown === true;
        } else {
          // 失败保留旧清单，但把原因显示出来（不静默变空）
          loadError = (out && out.code) ? String(out.code) : "unknown";
          degraded = null;
        }
        renderSessions();
        return out;
      }).catch(function (err) {
        loadError = err && err.message ? err.message : "network";
        degraded = null;
        renderSessions();
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

    /**
     * 点击侧边栏**外**的任意区域 → 关闭（用户要求的交互）。
     *
     * 挂在 document 的 click 上，只在该关的时候关：
     *   · 点在侧边栏**内** → 不关（会话行 / 新会话 / 技能中心自己处理）；
     *   · 点在顶栏「打开左侧边栏」按钮上 → 不关（按钮自己 toggle，
     *     这里再关会把刚打开的又合上）；
     *   · 其余（消息流 / 输入区 / 顶栏其它按钮）→ 关。
     *
     * 用 closest 判断而不是 contains：target 可能是文本节点，
     * closest 对文本节点返回 null，先归到父元素再查。
     *
     * @param {object} ev 点击事件
     */
    function onDocClick(ev) {
      if (!open) return;
      const raw = ev && ev.target;
      const el = raw && raw.nodeType === 1 ? raw : (raw && raw.parentElement);
      if (el === null || el === undefined) return;
      if (el.closest("#sidebar") !== null) return;
      if (el.closest("#btnSideLeft") !== null) return;
      close();
    }

    /** 打开（顺带拉一次清单：每次打开都要看到最新会话）。 */
    function openSidebar() {
      open = true;
      dom.sidebar.hidden = false;
      // 点外部关闭：只在打开期间监听，关闭即卸 —— 避免常驻判断
      global.document.addEventListener("click", onDocClick);
      renderSessions();          // 先用旧数据画一帧，避免空白
      void refresh();
    }

    /** 关闭。 */
    function close() {
      open = false;
      dom.sidebar.hidden = true;
      global.document.removeEventListener("click", onDocClick);
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
      refresh,
      renderSessions,
      tickWaking,
      toggle,
    };
  }

  global.WhaleSidebar = { createSidebar, groupByWorkspace, workspaceNameOf, sessionVisible };
})(typeof window !== "undefined" ? window : globalThis);

/*
 * 小窗渲染
 *
 * 职责：把桥给的快照画成界面——顶栏标题、会话标题行、消息流、状态条、
 *       任务坞、用量圆环、发送键、权限文案。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么与 app.js 分开：这两件事的**改动原因完全不同**。
 * 「界面该长什么样」只动这里；「事件怎么接、动作往哪发」只动 app.js。
 * 挤在一个文件里，改一个显示细节要在上千行里找，还容易顺手碰错另一边。
 *
 * 两条纪律：
 *   1. 消息按桥给的 `kind` 分流（user / assistant / tool），**不按 role**——
 *      读错字段的表现是每条都渲染成助手、用户发言看不见，而且不报错。
 *   2. 取不到值就显示 `–`，不编造（规范：不使用模糊措辞，也不假装知道）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleRender。
 */

(function attachRender(global) {
  "use strict";

  /** 权限三档文案（必须与主窗口逐字一致）。 */
  const PERMISSION_TEXT = {
    "read-only": "仅可查看",
    "workspace-write": "工作区内修改",
    "danger-full-access": "完全权限",
  };

  /**
   * 建渲染器。
   *
   * @param {object} deps
   * @param {object} deps.dom 元素引用集合
   * @param {() => string} deps.getPermission 当前权限档位
   * @returns {object} 渲染器
   */
  function createRenderer(deps) {
    const dom = deps.dom;
    const getPermission = deps.getPermission;

    /** 消息流上一次渲染的签名（只在变化时重建，保住滚动位置）。 */
    let lastStreamSig = null;
    /** 任务清单上一次渲染的签名（保住用户展开状态）。 */
    let lastDockSig = null;

    /** 顶栏标题（内容区顶部的会话标题行已按用户要求移除）。 */
    function header(state) {
      if (state.offline) {
        // 文案取自《前端设计规范》6.3 空态文案表，不自创措辞
        dom.tbTitle.textContent = "未连接";
        return;
      }
      const title = state.title ?? "（无标题会话）";
      dom.tbTitle.textContent = title;
    }

    /**
     * 消息流。
     *
     * 只在「条数或最后一条变了」时重建：每 5 秒轮询都重建会把用户
     * 正在滚动的位置顶回底部。
     */
    function stream(state) {
      const messages = Array.isArray(state.messages) ? state.messages : [];
      const last = messages[messages.length - 1];
      const sig = `${messages.length}|${last?.text ?? ""}|${last?.name ?? ""}`;
      if (sig === lastStreamSig) return;
      lastStreamSig = sig;

      dom.stream.innerHTML = "";
      if (messages.length === 0) {
        const empty = global.document.createElement("div");
        empty.className = "empty";
        empty.id = "streamEmpty";
        empty.textContent = state.offline ? "桥未连接 · 重试中" : "还没有消息";
        dom.stream.appendChild(empty);
        return;
      }

      messages.forEach(function (m) {
        const kind = m.kind ?? "assistant";

        /*
         * 工具调用**不显示**。
         *
         * 用户要求：「小窗里不需要展示你的工具调用过程，不需要展示你的思考过程」。
         * 小窗是盯进度的小窗口，不是调试面板 —— 用户要看到的是
         * 「我问了什么 / 助手答了什么」。工具调用属于过程，
         * 放在这里只会把真正的对话挤出视野（小窗本来就矮）。
         *
         * 桥仍然会把工具事件折进消息尾巴（`kind: "tool"`），
         * 那是它的职责；**过滤是呈现层的决定** —— 想看过程的将来可以考虑
         * 放在资料抽屉里，而不是流里。
         */
        if (kind === "tool") return;

        const wrap = global.document.createElement("div");
        wrap.className = `msg ${kind === "user" ? "me" : "ai"}`;
        const role = global.document.createElement("div");
        role.className = "role";
        // 角色文案：用户「你」，助手「DSH」
        role.textContent = kind === "user" ? "你" : "DSH";
        const body = global.document.createElement("div");
        body.textContent = m.text ?? "";
        wrap.appendChild(role);
        wrap.appendChild(body);
        dom.stream.appendChild(wrap);
      });
      dom.stream.scrollTop = dom.stream.scrollHeight;
    }

    /** 发送键：回合运行中是红方块（B7 判据按 aria-label 读 DOM）。 */
    function sendButton(state) {
      const running = state.running === true;
      dom.btnSend.classList.toggle("stop", running);
      dom.btnSend.setAttribute("aria-label", running ? "中断" : "发送");
    }

    /**
     * 状态条：回合运行中出现，只说「正在运行」。
     *
     * ⚠️ **不报具体工具名**。原先会显示「正在运行 read_file」之类 ——
     * 那等于把过程暴露在界面上，与「小窗不展示工具调用」是同一条要求。
     * 用户只需要知道「它还在忙」，不需要知道它在用哪个工具。
     */
    function status(state) {
      if (state.running !== true) {
        dom.status.hidden = true;
        return;
      }
      dom.status.hidden = false;
      dom.statusText.textContent = "正在运行";
    }

    /** 任务坞：有清单才出现，默认收起，计数「已完成 / 总数」。 */
    function dock(state) {
      const todos = Array.isArray(state.todos) ? state.todos : [];
      if (todos.length === 0) {
        dom.dock.hidden = true;
        return;
      }
      dom.dock.hidden = false;

      const done = todos.filter(function (t) { return t.status === "completed"; }).length;
      dom.dockProg.textContent = `${done} / ${todos.length}`;

      const sig = todos.map(function (t) { return `${t.status}:${t.content}`; }).join("|");
      if (sig === lastDockSig) return;
      lastDockSig = sig;

      dom.dockList.innerHTML = "";
      todos.forEach(function (t) {
        const row = global.document.createElement("div");
        row.className = "task";
        const dot = global.document.createElement("span");
        // 绿 = 已完成、橙 = 进行中、灰空心 = 待办
        const s = t.status === "completed" ? "done" : t.status === "in_progress" ? "doing" : "todo";
        dot.className = `pd ${s}`;
        const text = global.document.createElement("span");
        text.textContent = t.content ?? "";
        row.appendChild(dot);
        row.appendChild(text);
        dom.dockList.appendChild(row);
      });
    }

    /** 用量圆环：周长 2πr = 2π×8 ≈ 50.27。 */
    function usage(state) {
      const used = state.contextUsed;
      const total = state.contextWindow;
      if (typeof used !== "number" || typeof total !== "number" || total <= 0) {
        dom.usagePct.textContent = "–";
        dom.urFg.setAttribute("stroke-dashoffset", "50.3");
        return;
      }
      const pct = Math.max(0, Math.min(100, Math.round((used / total) * 100)));
      dom.usagePct.textContent = String(pct);
      // offset = 周长 × (1 − 百分比/100)
      dom.urFg.setAttribute("stroke-dashoffset", String(50.3 * (1 - pct / 100)));
    }

    /** 权限按钮文案（三档，与主窗逐字一致）。 */
    /**
     * 输入框上那个权限标签。
     *
     * **真值来自 state.permission**（由 `/whale/presets` 的 `current` 填进来，
     * 那是宿主 `permissionPresets.current(session)` 算出的唯一真相源）。
     *
     * 真实事故（用户报「切为完全权限了，输入框还是显示工作区内修改」）：
     * 这个标签原先读的是一个**写死的常量**，与宿主实际档位毫无关系；
     * 而桥的面板 permission 字段又恒为 null（处理器从没传过 gates），
     * 于是真值从来没有来源，文案永远停在「工作区内修改」。
     *
     * 真值还没拿到时（首帧、或宿主读不到）退回注入的 getPermission()
     * ——它是启动时的已知值，不是「编一个」。
     *
     * @param {object} [state]
     */
    function permissionText(state) {
      const fromState = state !== undefined && state !== null ? state.permission : undefined;
      const p = typeof fromState === "string" && fromState !== "" ? fromState : getPermission();
      dom.btnPerm.textContent = PERMISSION_TEXT[p] ?? PERMISSION_TEXT["workspace-write"];
    }

    /** 资料抽屉三行。 */
    function infoDrawer(state, bridgeBase) {
      dom.infoSession.textContent = state.sessionId ?? "–";
      dom.infoBridge.textContent = bridgeBase;
      dom.infoEvents.textContent =
        typeof state.eventsSeen === "number" ? String(state.eventsSeen) : "–";
    }

    /** 整屏渲染。 */
    function all(state) {
      header(state);
      stream(state);
      status(state);
      dock(state);
      sendButton(state);
      usage(state);
      permissionText(state);
    }

    return {
      all,
      dock,
      header,
      infoDrawer,
      permission: permissionText,
      sendButton,
      status,
      stream,
      usage,
    };
  }

  global.WhaleRender = {
    PERMISSION_TEXT,
    createRenderer,
  };
})(typeof window !== "undefined" ? window : globalThis);

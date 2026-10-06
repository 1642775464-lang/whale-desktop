/*
 * 桥的数据接入（小窗）
 *
 * 职责：从桥拿数并维护一份本地快照——`/whale/panel` 全量 + `/whale/events` 增量 +
 *       降级标记；以及三个写操作（发消息 / 中断 / 切会话 / 唤醒）。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么与渲染分开：这两件事的**改动原因完全不同**。
 * 「桥的接口变了」只动这里；「界面长什么样」只动 app.js。
 *
 * 与悬浮条那份的关系：职责同源、实现独立。刻意**不共享文件**——
 * 两者进程独立、userData 独立，将来任一方要单独演进时不该被另一方拖住；
 * 共享一份反而会制造「改小窗会不会弄坏悬浮条」的假顾虑。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleBridge。
 */

(function attachBridgeClient(global) {
  "use strict";

  /** 默认端口，与桥的 PORT 一致；主进程可用 ?port= 覆盖。 */
  const DEFAULT_PORT = 19387;

  /** 重连退避上限（F4：1s → 15s 退避）。 */
  const RECONNECT_MAX_MS = 15000;

  /** 从 URL 查询串取桥端口。 */
  function portFromLocation() {
    try {
      const params = new global.URLSearchParams(global.location.search);
      const raw = params.get("port");
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
    } catch {
      return DEFAULT_PORT;
    }
  }

  /**
   * 建一个桥客户端。
   *
   * @param {object} deps
   * @param {(state: object) => void} deps.onChange 数据变化回调
   * @param {number} [deps.port]
   * @returns {object}
   */
  function createClient(deps) {
    const onChange = typeof deps.onChange === "function" ? deps.onChange : function () {};
    const port = Number.isInteger(deps.port) ? deps.port : portFromLocation();
    const base = `http://127.0.0.1:${  port}`;

    const state = {
      offline: true,
      /** 降级态是否已经通知过界面（避免重复通知同一状态）。 */
      renderedOffline: false,
      /** 当前会话 id。 */
      sessionId: null,
      /** 会话标题。 */
      title: null,
      /** 工作区路径。 */
      workspace: null,
      /** 消息列表（最近 40 条渲染事件折出来的）。 */
      messages: [],
      /** 任务清单。 */
      todos: [],
      /** 当前回合状态。 */
      running: false,
      /** 正在跑的工具名（状态条用）。 */
      toolName: null,
      /** 步/回合计数。 */
      steps: 0,
      turns: 0,
      /** 上下文占用与窗口（用量圆环用）。 */
      contextUsed: null,
      contextWindow: null,
      /** 权限档位（三档文案之一）。 */
      permission: null,
      /** 已收到的事件数（资料抽屉要显示）。 */
      eventsSeen: 0,
      port,
    };

    let pollHandle = null;
    let stream = null;
    let reconnectDelay = 1000;

    /** 进降级态。注意不能写成「已经 offline 就 return」——初值就是 true。 */
    function markOffline() {
      if (state.offline && state.renderedOffline) return;
      state.offline = true;
      state.renderedOffline = true;
      onChange(state);
    }

    /**
     * 拉一次面板全量。
     *
     * **先确保有 sessionId**：`/whale/panel` 必须带 `sessionId`，
     * 缺了会 400。而小窗启动时并不知道自己是哪个会话——这个鸡生蛋问题
     * 靠先问 `/whale/hud`（它不需要参数，且带 `activeSessionId`）解决。
     * 没有这一步，小窗会永远停在「未连接」，而桥其实是通的。
     */
    function refresh() {
      if (typeof state.sessionId !== "string" || state.sessionId === "") {
        return fetchActiveSessionId().then(function (ok) {
          if (!ok) return false;
          return refreshPanel();
        });
      }
      return refreshPanel();
    }

    /** 问桥「当前活跃会话是哪个」。 */
    function fetchActiveSessionId() {
      return global
        .fetch(`${base  }/whale/hud`)
        .then(function (res) {
          if (!res.ok) throw new Error(`HTTP ${  res.status}`);
          return res.json();
        })
        .then(function (json) {
          const list = Array.isArray(json.sessions) ? json.sessions : [];
          const active = typeof json.activeSessionId === "string" && json.activeSessionId !== ""
            ? json.activeSessionId
            : (list.length > 0 ? list[0].sessionId : null);
          if (active === null) {
            // 桥通了但一个会话都没有：这是「待机」，不是「断连」
            state.offline = false;
            state.renderedOffline = false;
            state.title = null;
            onChange(state);
            return false;
          }
          state.sessionId = active;
          if (list.length > 0) {
            const found = list.filter(function (s) { return s.sessionId === active; })[0];
            if (found !== undefined) {
              state.title = found.title ?? null;
              state.workspace = found.workspace ?? null;
              state.contextUsed = found.contextUsed ?? null;
              state.contextWindow = found.contextWindow ?? null;
            }
          }
          return true;
        })
        .catch(function () {
          markOffline();
          return false;
        });
    }

    /** 拉面板本体（此时 sessionId 一定有）。 */
    function refreshPanel() {
      const path = `/whale/panel?sessionId=${  encodeURIComponent(state.sessionId)}`;
      return global
        .fetch(base + path)
        .then(function (res) {
          if (!res.ok) throw new Error(`HTTP ${  res.status}`);
          return res.json();
        })
        .then(function (json) {
          // 面板给的是 {kind, text, seq}（桥投影过）；原样收下，不改名——
          // 改名会造成「内部形状」与「桥形状」两套，多一处会不同步的地方
          state.messages = Array.isArray(json.messages) ? json.messages : [];
          state.todos = Array.isArray(json.todos) ? json.todos : [];
          // 回合运行态：**两个来源取或**。
          //   running      —— 折叠器从 turn/start、turn/end 推出的，总是有值
          //   agentRunning —— 活 agent 的状态，桥拿不到 agent 时恒为 false
          // 只看 agentRunning 的话，状态条与中断键在「桥能看到事件但看不到 agent」
          // 时永远不亮（真实踩过：桥的面板报 agentRunning=false 而 phase=running）。
          state.running = json.running === true || json.agentRunning === true;
          state.toolName = typeof json.toolName === "string" ? json.toolName : null;
          state.steps = json.steps ?? 0;
          state.turns = json.turns ?? 0;
          if (json.contextUsed !== undefined) state.contextUsed = json.contextUsed;
          if (json.contextWindow !== undefined) state.contextWindow = json.contextWindow;
          if (typeof json.permission === "string") state.permission = json.permission;
          if (typeof json.title === "string") state.title = json.title;
          if (typeof json.workspace === "string") state.workspace = json.workspace;
          state.offline = false;
          state.renderedOffline = false;
          onChange(state);
          return true;
        })
        .catch(function () {
          markOffline();
          return false;
        });
    }

    /** 接上增量流（断线按 1s→15s 退避重连）。 */
    function connect() {
      if (typeof global.EventSource !== "function") {
        global.console.warn("环境没有 EventSource，退化为轮询");
        return;
      }
      stream = new global.EventSource(`${base  }/whale/events`);

      stream.onopen = function () {
        reconnectDelay = 1000;
        // 重连成功后必须补拉全量：断线期间的口径可能已经变了
        refresh();
      };

      stream.onmessage = function (event) {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return;
        }
        if (payload === null || typeof payload !== "object") return;
        state.eventsSeen += 1;
        applyEvent(payload);
        state.offline = false;
        state.renderedOffline = false;
        onChange(state);
      };

      stream.onerror = function () {
        markOffline();
        // EventSource 自己会重连，这里只把退避间隔记下来供界面显示
        if (reconnectDelay < RECONNECT_MAX_MS) reconnectDelay *= 2;
      };
    }

    /**
     * 把一条宿主事件并进快照。
     *
     * **事件字段与面板字段不同**，必须归一到同一个内部形状：
     *   - 增量流给的是宿主原样事件：`{type, data:{message:{content:[...]}}}`
     *   - 面板给的是桥投影过的：`{kind:"user"|"assistant"|"tool", text, seq}`
     * 统一成 `{kind, text}` 之后，渲染层只认一种形状。
     * 曾经渲染层按 `role` 读，而桥给的是 `kind` —— 结果每条消息都渲染成「DSH」，
     * 用户的发言完全看不出来。
     */
    function applyEvent(event) {
      const type = event.type;
      if (type === "user/message") {
        pushMessage({ kind: "user", text: textOf(event), seq: event.seq ?? null });
      } else if (type === "assistant/message") {
        pushMessage({ kind: "assistant", text: textOf(event), seq: event.seq ?? null });
      } else if (type === "turn/start") {
        state.running = true;
        state.turns += 1;
      } else if (type === "turn/end") {
        state.running = false;
        state.toolName = null;
      } else if (type === "step/start") {
        state.steps += 1;
      } else if (type === "tool/call") {
        const name = event.data && event.data.name ? event.data.name : null;
        state.toolName = name;
        pushMessage({ kind: "tool", name, text: "", seq: event.seq ?? null });
      } else if (type === "request/context") {
        if (event.data && typeof event.data.contextWindow === "number") {
          state.contextWindow = event.data.contextWindow;
        }
      }
    }

    /**
     * 取事件里的文本。
     *
     * **两种封套都要兜住**（references/session-events.md 实测）：
     *   - `assistant/message` / `tool/result`：内容在 `data.message.content`
     *   - `user/message`：内容直接在 `data.content`，**没有 message 包裹**
     * 只认一种的话，另一种类型的消息会静默变成空文本被丢掉——
     * 表现是「用户发的消息在小窗里根本不出现」。
     */
    function textOf(event) {
      const data = event.data;
      if (data === null || typeof data === "undefined") return "";
      const container = data.message ?? data;
      const content = container.content;
      if (Array.isArray(content)) {
        return content
          .filter(function (c) { return c && c.type === "text"; })
          .map(function (c) { return c.text; })
          .join("");
      }
      return "";
    }

    /** 推一条消息，超出 40 条丢最旧。 */
    function pushMessage(msg) {
      state.messages.push(msg);
      while (state.messages.length > 40) state.messages.shift();
    }

    /** 起轮询兜底。 */
    function startPolling(ms) {
      const every = Number.isInteger(ms) ? ms : 5000;
      if (pollHandle !== null) return;
      pollHandle = global.setInterval(refresh, every);
    }

    /** 发一个 POST，结果规整成 {ok, code}。 */
    function post(path, body) {
      return global
        .fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
        .then(function (res) {
          return res.json().catch(function () { return {}; });
        })
        .then(function (json) {
          if (json && json.ok === true) return { ok: true, raw: json };
          const code = json && json.error && json.error.code ? json.error.code : "request-failed";
          return { ok: false, code };
        })
        .catch(function (err) {
          return { ok: false, code: "network", message: err.message };
        });
    }

    /**
     * 发消息进真会话（F4）。
     *
     * 回合运行中桥会自动走排队语义，并回 `queued: true`（不打断当前回合）。
     */
    function send(text) {
      return post("/whale/send", { sessionId: state.sessionId, text });
    }

    /** 中断当前回合（F4，桥侧有护栏）。 */
    function abort() {
      return post("/whale/abort", { sessionId: state.sessionId });
    }

    /** 发斜杠命令（F6：权限三档就是发 /permission）。 */
    function command(line) {
      return post("/whale/command", { sessionId: state.sessionId, line });
    }

    /** 切到某会话（F9）。 */
    function activate(sessionId) {
      return post("/whale/activate", { sessionId });
    }

    /** 唤醒历史会话（F9）。 */
    function resume(sessionId) {
      return post("/whale/resume", { sessionId });
    }

    /** 断开增量流。 */
    function close() {
      if (pollHandle !== null) {
        global.clearInterval(pollHandle);
        pollHandle = null;
      }
      if (stream !== null) {
        stream.close();
        stream = null;
      }
    }

    return {
      abort,
      activate,
      close,
      command,
      connect,
      getState () { return state; },
      refresh,
      resume,
      send,
      startPolling,
    };
  }

  global.WhaleBridge = {
    DEFAULT_PORT,
    RECONNECT_MAX_MS,
    createClient,
    portFromLocation,
  };
})(typeof window !== "undefined" ? window : globalThis);

/*
 * 桥的数据接入（小窗）
 *
 * 职责：从桥拿数并维护本地快照（面板全量 + SSE 增量 + 降级标记）；
 *       以及写操作（发消息 / 中断 / 切会话 / 唤醒 / 切模型 / 上传附件）。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么与渲染分开：这两件事的**改动原因完全不同**。
 * 「桥的接口变了」只动这里；「界面长什么样」只动 app.js。
 *
 * 与悬浮条那份的关系：职责同源、实现独立。刻意**不共享文件**——
 * 两者进程独立、userData 独立，单独演进时不该被另一方拖住。
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
      /*
       * 可见会话清单（侧边栏与 ☰ 菜单的会话列表都读它）。
       * 每次 `/whale/hud` 刷新时更新（见 fetchActiveSessionId）。
       */
      sessions: [],
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
      /** 累计用量四桶（用量浮层用；D1 决策 C 的口径）。 */
      usageTotals: { input: null, output: null, cacheRead: null, cacheWrite: null },
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
     * 拉一次面板全量，并**跟随桥的活跃会话**。
     *
     * 每一步都要问桥「现在活跃的是哪个」——不能只在 sessionId 为空时问一次。
     *
     * 为什么（用户裁定的行为）：小窗启动时默认绑上「最近一次会话」，
     * 之后用户在宿主里开新会话时**小窗要跟着过去**。
     * 原先只在 sessionId 为空时才问桥，拿到 id 就绑死，
     * 结果是桥那边的指针换了、小窗纹丝不动 —— 表现是「窗口一直停在旧会话」，
     * 而所有代码看起来都在。真实踩过。
     *
     * 三步固定顺序：问活跃 → 按需切换 → 拉面板。
     */
    function refresh() {
      return fetchActiveSessionId().then(function (ok) {
        if (!ok) return false;
        return refreshPanel();
      });
    }

    /**
     * 问桥「当前活跃会话是哪个」，并按需把本地会话切过去。
     *
     * 三种要区分的情况（各有测试）：
     *   1. 活跃指针变了、且新会话在清单里 → **跟过去**（用户要的行为）
     *   2. 活跃指针为空（待机）→ **保持当前会话**，不清空。
     *      待机是**会过去**的状态（用户随后就开了会话），清空会让消息流闪白、
     *      用户以为自己点坏了。
     *   3. 活跃指针指向清单里没有的会话 → **不盲从**。
     *      盲从会切到一个拉不到面板的会话上，表现是「窗口突然空了」。
     *
     * @returns {Promise<boolean>} 是否拿到了可用会话
     */
    function fetchActiveSessionId() {
      return global
        .fetch(`${base  }/whale/hud`)
        .then(function (res) {
          if (!res.ok) throw new Error(`HTTP ${  res.status}`);
          return res.json();
        })
        .then(function (json) {
          /*
           * ⚠️ 会话清单必须**每次刷新都存进 state**。
           *
           * 原先这里只设 `state.sessionId`，从不设 `state.sessions` ——
           * 于是 `getState().sessions` 恒为 undefined，侧边栏与 ☰ 菜单里的
           * 会话列表**永远是空的**（真窗口实测：只显示「没有可见的会话」）。
           * 那是既有缺陷，加侧边栏时才暴露出来。
           */
          state.sessions = Array.isArray(json.sessions) ? json.sessions : [];

          // 判定「该用哪个会话」交给纯函数（见 follow.js）：
          // 三种情况（跟过去 / 待机保持 / 清单里没有就不盲从）各有单测，
          // 规则只有一处实现，不必在网络流程里重复那套 if。
          const decision = global.WhaleFollow.decideFollow({
            sessions: json.sessions,
            activeSessionId: json.activeSessionId,
            currentSessionId: state.sessionId,
          });

          if (decision.idle === true) {
            // 待机：桥通了但暂时没有会话——不是断连，也不清空本地绑定
            state.offline = false;
            state.renderedOffline = false;
            onChange(state);
            return decision.sessionId !== null && decision.sessionId !== "";
          }
          if (decision.sessionId === null) return false;

          // 切过去（id 没变时这里是空操作，不会引起无谓重建）
          state.sessionId = decision.sessionId;
          const list = Array.isArray(json.sessions) ? json.sessions : [];
          const found = list.filter(function (s) {
            return s.sessionId === decision.sessionId;
          })[0];
          if (found !== undefined) {
            state.title = found.title ?? null;
            state.workspace = found.workspace ?? null;
            state.contextUsed = found.contextUsed ?? null;
            state.contextWindow = found.contextWindow ?? null;
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
          // 累计四桶（D1 决策 C）：面板有就刷新，取不到保留旧值
          if (json.totalInput !== undefined) state.usageTotals.input = json.totalInput;
          if (json.totalOutput !== undefined) state.usageTotals.output = json.totalOutput;
          if (json.totalCacheRead !== undefined) state.usageTotals.cacheRead = json.totalCacheRead;
          if (json.totalCacheWrite !== undefined) state.usageTotals.cacheWrite = json.totalCacheWrite;
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
        // 折事件是纯规则，放在 stream.js（可单测，不必搭假 EventSource）
        global.WhaleStream.applyEventTo(state, payload);
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

    /**
     * 拉宿主的斜杠命令目录（切片 7）。
     *
     * 为什么要问桥而不是本地写死：宿主有二十多条命令（文件/目标/计划/压缩/
     * 权限/模型…），硬编码永远追不上，而且不同会话可见集合可能不同。
     *
     * 失败返回空数组（面板显示「没有可用命令」），**不退回硬编码列表** ——
     * 显示一份假的命令表比不显示更糟：用户会照着它去执行不存在的命令。
     *
     * @returns {Promise<Array<object>>}
     */
    function listCommands() {
      if (typeof state.sessionId !== "string" || state.sessionId === "") return Promise.resolve([]);
      return global
        .fetch(`${base}/whale/commands?sessionId=${encodeURIComponent(state.sessionId)}`)
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (json) {
          return Array.isArray(json?.commands) ? json.commands : [];
        })
        .catch(function () { return []; });
    }

    /** 切到某会话（F9）。 */
    function activate(sessionId) {
      return post("/whale/activate", { sessionId });
    }

    /** 唤醒历史会话（F9）。 */
    function resume(sessionId) {
      return post("/whale/resume", { sessionId });
    }

    /** 发一个 GET，结果规整成 {ok, code, data}（与 post 对称）。 */
    function get(path) {
      return global
        .fetch(base + path)
        .then(function (res) {
          return res.json().catch(function () { return {}; });
        })
        .then(function (json) {
          if (json && json.ok === true) return { ok: true, data: json };
          const code = json && json.error && json.error.code ? json.error.code : "request-failed";
          const message = json && json.error && json.error.message ? json.error.message : undefined;
          return { ok: false, code, message };
        })
        .catch(function (err) {
          return { ok: false, code: "network", message: err.message };
        });
    }

    /**
     * 新建一个会话（侧边栏「新会话」）。
     *
     * ⚠️ 这是**写操作**：会在宿主里真的建一个会话，然后宿主返回它的 id。
     * 所以调用方要防重入（连点会建出两个空会话）—— 侧边栏那边已挡住。
     */
    function createSession(body) {
      return post("/whale/session/create", body ?? {});
    }

    /** 读技能目录（侧边栏「技能中心」）。需按会话寻址。 */
    function skills(sessionId) {
      return get(`/whale/skills?sessionId=${encodeURIComponent(sessionId)}`);
    }

    /**
     * 会话的可见性清单（不唤醒冷会话）。
     *
     * ⚠️ 返回值**规整成 `{ok, sessions}`**（与 `skills()` 的 `{ok, data}` 不同）。
     * 调用方（侧边栏）直接消费 sessions；让它自己剥一层 `data` 的话，
     * 谁忘了剥就静默拿到 undefined —— 表现为「会话列表是空的」。
     * 真窗口实测踩过：侧边栏显示「没有可见的会话」，而桥其实返回了 55 条。
     */
    function sessionList() {
      return get("/whale/session/list").then(function (out) {
        if (!out.ok) return { ok: false, code: out.code, message: out.message };
        return { ok: true, sessions: Array.isArray(out.data?.sessions) ? out.data.sessions : [] };
      });
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

    /**
     * 宿主能力请求（唤起/权限/模型/文件引用/上传）走 bridge-capabilities.js。
     *
     * 这里是薄转交：调用方（overlays / add-menu / app）拿到的方法名不变，
     * 但那一组请求的失败降级、形状纪律都收在一个地方。
     */
    const capabilities = global.WhaleCapabilities.createCapabilities({
      base,
      state,
      onChange: (s) => onChange(s),
      post: (path, body) => post(path, body),
    });

    return {
      abort,
      activate,
      close,
      command,
      connect,
      createSession,
      sessionList,
      skills,
      fileReferences: capabilities.fileReferences,
      getState () { return state; },
      listCommands,
      modelCatalog: capabilities.modelCatalog,
      permissionPresets: capabilities.permissionPresets,
      refresh,
      resume,
      send,
      setModel: capabilities.setModel,
      startPolling,
      takeSummon: capabilities.takeSummon,
      uploadFiles: capabilities.uploadFiles,
      uploadImages: capabilities.uploadImages,
    };
  }

  global.WhaleBridge = {
    DEFAULT_PORT,
    RECONNECT_MAX_MS,
    createClient,
    portFromLocation,
  };
})(typeof window !== "undefined" ? window : globalThis);

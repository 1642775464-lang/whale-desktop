/*
 * 桥的数据接入
 *
 * 职责：从桥拿数并维护一份本地快照——全量拉取、SSE 增量、心跳 tick 合并、降级标记；
 *       以及三个写操作（唤起小窗 / 切会话）。
 * 所属层：悬浮条（whale-hud/renderer）
 *
 * 为什么与渲染分开：这两件事的**改动原因完全不同**。
 * 「桥的接口变了」只动这里；「界面长什么样」只动 hud.js。
 * 挤在一个文件里，改一个形状要在一千行里找，而且很容易顺手改错另一边。
 *
 * 纪律：**不自己算 token**。这里只做搬运与合并，一个 token 都不推导——
 * 桥不给数就保持 null，由渲染层显示 `–`（宁可显示 – 不显示错的数）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleBridge。
 */

(function attachBridgeClient(global) {
  "use strict";

  /** 默认端口，与桥的 PORT 一致；主进程可用 ?port= 覆盖（联调用）。 */
  const DEFAULT_PORT = 19387;

  /** 兜底轮询间隔：SSE 静默失效时靠它把数字拉回真实值。 */
  const POLL_MS = 5000;

  /**
 * 「唤起请求」的轮询间隔（切片 7 第三批）。
 *
 * 比 POLL_MS 密：用户点了鲸鱼就站在那儿等反馈，
 * 5 秒才响应一次会让他以为「又没反应」。
 */
  const SUMMON_WATCH_MS = 1500;

  /**
   * 从 URL 查询串取桥端口。
   *
   * @returns {number}
   */
  function portFromLocation() {
    try {
      const params = new global.URLSearchParams(global.location.search);
      const raw = params.get("port");
      const n = Number(raw);
      return Number.isInteger(n) && n > 0 && n < 65536 ? n : DEFAULT_PORT;
    } catch {
      // 拿不到 location 或参数解析失败都退回默认端口，不抛
      return DEFAULT_PORT;
    }
  }

  /**
   * 建一个桥客户端。
   *
   * @param {object} deps
   * @param {(state: object) => void} deps.onChange 每次数据变化后回调（节流由调用方负责）
   * @param {number} [deps.port]
   * @returns {object}
   */
  function createClient(deps) {
    const onChange = typeof deps.onChange === "function" ? deps.onChange : function () {};
    const port = Number.isInteger(deps.port) ? deps.port : portFromLocation();
    const base = `http://127.0.0.1:${  port}`;

    /** 本地快照。sessions 直接存桥给的形状，不做任何字段改名。 */
    const state = {
      sessions: [],
      activeSessionId: null,
      bridge: null,
      offline: true,
      /** 降级态是否已经通知过界面（避免每 5 秒轮询都重复通知一次同样的状态）。 */
      renderedOffline: false,
      port,
    };

    let pollHandle = null;
    let stream = null;
    /** 唤起轮询的句柄（与 pollHandle 分开：两者节奏不同）。 */
    let summonHandle = null;

    /** 合并一批心跳 tick 进快照。 */
    function applyTicks(ticks) {
      const byId = Object.create(null);
      state.sessions.forEach(function (s) { byId[s.sessionId] = s; });

      ticks.forEach(function (t) {
        const s = byId[t.sessionId];
        if (s === undefined) return;
        // tick 只带随时间变化的三个数，其余字段保留快照里的旧值（S3-D4）
        s.speed = { tokPerSec: t.tokPerSec, phase: t.phase, frozen: false };
        s.contextUsed = t.contextUsed;
        s.contextWindow = t.contextWindow;
      });
    }

    /** 进降级态：红点 + 全部 `–`，不崩不弹窗（R-1）。 */
    function markOffline() {
      // 注意不能写成「已经是 offline 就 return」：state.offline 初值就是 true，
      // 那样**第一次连不上时永远不会通知界面**，红点与空态文案都出不来
      // （实测：点显示灰、标题停在占位符）。所以只要还没渲染过降级态就通知一次。
      if (state.offline && state.renderedOffline) return;
      state.offline = true;
      state.renderedOffline = true;
      onChange(state);
    }

    /**
     * 拉一次全量快照。
     *
     * @returns {Promise<boolean>}
     */
    function refresh() {
      return global
        .fetch(`${base  }/whale/hud`)
        .then(function (res) {
          if (!res.ok) throw new Error(`HTTP ${  res.status}`);
          return res.json();
        })
        .then(function (json) {
          state.sessions = Array.isArray(json.sessions) ? json.sessions : [];
          state.activeSessionId = typeof json.activeSessionId === "string" ? json.activeSessionId : null;
          state.bridge = json.bridge || null;
          state.offline = false;
          state.renderedOffline = false; // 恢复在线：下次再断要能重新通知
          onChange(state);
          return true;
        })
        .catch(function () {
          markOffline();
          return false;
        });
    }

    /**
     * 接上增量流。
     *
     * 断线由 EventSource 自己重连（浏览器行为）。**重连成功后必须重新拉一次全量**：
     * 断线期间的速度采样与上下文口径都可能已经变了，只等 tick 会把旧值一直挂着（R-2）。
     */
    function connect() {
      if (typeof global.EventSource !== "function") {
        global.console.warn("环境没有 EventSource，退化为轮询");
        return;
      }

      stream = new global.EventSource(`${base  }/whale/hud/events`);

      stream.onopen = function () {
        refresh();
      };

      stream.onmessage = function (event) {
        let payload;
        try {
          payload = JSON.parse(event.data);
        } catch {
          return; // 坏帧跳过，不影响后续
        }
        if (payload === null || typeof payload !== "object") return;
        if (payload.kind === "tick" && Array.isArray(payload.sessions)) {
          applyTicks(payload.sessions);
          state.offline = false;
          state.renderedOffline = false;
          onChange(state);
        }
      };

      stream.onerror = function () {
        markOffline();
      };
    }

    /** 起轮询兜底。 */
    function startPolling(ms) {
      const every = Number.isInteger(ms) ? ms : POLL_MS;
      if (pollHandle !== null) return;
      pollHandle = global.setInterval(refresh, every);
    }

    /**
     * 唤起小窗（F2①）。
     *
     * 返回结构化结果而不是抛错：调用方要据此决定「红闪」还是「点亮绿环」。
     * 切片 5 之前 `whale-window/` 不存在，桥会回 `entry-missing`——
     * 这种情况必须让用户看见，不能静默。
     *
     * @returns {Promise<{ok: boolean, code?: string, reused?: boolean}>}
     */
    function openSmallWindow() {
      return post("/whale/open", { reason: "hud", target: "window" });
    }

    /**
     * 收起（关闭）小窗进程。
     *
     * PRD F2①：小窗已在跑时再点鲸鱼要**收起**，不是重复唤起。
     * 关的是进程而不是隐藏窗口——小窗 PRD 的「临时收起」另有 `−` 最小化那条路，
     * 鲸鱼这一下对应的是「关掉」。
     *
     * @returns {Promise<{ok: boolean, code?: string, closed?: number}>}
     */
    function closeSmallWindow() {
      return post("/whale/close", { target: "window" });
    }

    /**
     * 问桥：小窗现在在跑吗。
     *
     * 鲸鱼的绿环与「点一下是唤起还是收起」都取决于它。
     * 取不到就当作「没在跑」——宁可多点一次唤起，也不要让用户点了个关不掉的键。
     *
     * @returns {Promise<boolean>}
     */
    function isSmallWindowRunning() {
      return global
        .fetch(`${base}/whale/windows`)
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
          const list = Array.isArray(json?.windows) ? json.windows : [];
          return list.some((w) => w.target === "window");
        })
        .catch(() => false);
    }

    /**
     * 起「唤起请求」轮询：桥留标记，窗口来取。
     *
     * 为什么不用推送：桥**没法主动推**给窗口——窗口是独立进程，
     * 只靠环境变量拿到桥端口后自己来连，桥到窗口没有反向通道。
     * 所以复用窗口**已有的轮询**：定期问一次，拿到就唤起。
     *
     * 用户裁定：收成球时点鲸鱼要**展开成条**（「我看不出反应的窗口等于没响应」）。
     *
     * @param {number} [ms]
     */
    function watchSummon(ms) {
      const every = Number.isInteger(ms) ? ms : SUMMON_WATCH_MS;
      if (summonHandle !== null) return;
      const check = function () {
        takeSummon().then(function (summon) {
          if (!summon) return;
          global.whale.summon().then(function (out) {
            if (out && out.ok !== true) global.console.warn(`唤起失败：${out.code}`);
          });
        });
      };
      check();
      summonHandle = global.setInterval(check, every);
    }

    /**
     * 取走「唤起请求」（切片 7 第三批）。
     *
     * 用户报「已重启，但是点击无法唤起」。真因是**复用 ≠ 唤起**：
     * 桥的复用分支只回 `{reused:true}`，从不把已存在的窗口显示出来。
     * **取走即消费**（桥侧实现），所以只有拿到 true 才唤起，
     * 不会每轮都把自己弹出来。
     *
     * @returns {Promise<boolean>}
     */
    function takeSummon() {
      return global
        .fetch(`${base}/whale/summon?target=hud`)
        .then(function (res) { return res.ok ? res.json() : {}; })
        .then(function (json) { return json?.summon === true; })
        .catch(function () { return false; });
    }

    /**
     * 切到某个会话。
     *
     * @param {string} sessionId
     */
    function activate(sessionId) {
      return post("/whale/activate", { sessionId });
    }

    /**
     * 发一个 POST，并把结果规整成 `{ok, code}`。
     *
     * @param {string} path
     * @param {object} body
     * @returns {Promise<{ok: boolean, code?: string, reused?: boolean}>}
     */
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
          if (json && json.ok === true) {
            return { ok: true, reused: json.reused === true, pid: json.pid };
          }
          const code = json && json.error && json.error.code ? json.error.code : "request-failed";
          return { ok: false, code };
        })
        .catch(function (err) {
          return { ok: false, code: "network", message: err.message };
        });
    }

    /** 断开增量流（退出前调用，避免连接悬挂）。 */
    function close() {
      if (pollHandle !== null) {
        global.clearInterval(pollHandle);
        pollHandle = null;
      }
      // 唤起轮询也要停：它同样是定时器，漏了会在退出后继续敲桥
      if (summonHandle !== null) {
        global.clearInterval(summonHandle);
        summonHandle = null;
      }
      if (stream !== null) {
        stream.close();
        stream = null;
      }
    }

    return {
      activate,
      close,
      closeSmallWindow,
      connect,
      getState () { return state; },
      isSmallWindowRunning,
      openSmallWindow,
      refresh,
      startPolling,
      takeSummon,
      watchSummon,
    };
  }

  global.WhaleBridge = {
    DEFAULT_PORT,
    POLL_MS,
    createClient,
    portFromLocation,
  };
})(typeof window !== "undefined" ? window : globalThis);

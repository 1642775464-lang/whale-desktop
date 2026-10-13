/*
 * 侧窗的桥客户端
 *
 * 职责：侧窗自己连桥读数据 —— 新建会话、拉会话面板、发消息、列工作区文件。
 * 所属层：小窗（whale-window/renderer）
 *
 * ## 为什么侧窗要有自己的客户端，不共用主窗的
 *
 * 主窗的 `bridge-client.js` 是**一对一的会话绑定**：它持有
 * `state.sessionId`、轮询 hud 跟随活跃会话、维护增量流。
 * 侧窗要的是「另一个会话 + 另一个上下文」，共用一份状态会互相踩
 * （主窗切会话，侧窗跟着跳）。
 *
 * 所以侧窗这份只保留**自己需要的那几个调用**，状态只装自己的会话：
 *
 *   · 建会话：POST /whale/session/create
 *   · 读面板：GET  /whale/panel?sessionId=
 *   · 发消息：POST /whale/send
 *   · 列文件：GET  /whale/workspace/files?sessionId=&dir=
 *   · 开文件：POST /whale/workspace/open
 *
 * 桥端口从 URL 查询串拿（主进程 loadFile 时传的 `?port=`）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleSideBridge。
 */

(function attachSideBridge(global) {
  "use strict";

  /** 从 URL 查询串取桥端口（主进程 loadFile 时传的）。 */
  function portFromLocation() {
    try {
      const p = new URLSearchParams(global.location.search).get("port");
      const n = Number(p);
      return Number.isInteger(n) && n > 0 ? n : 19387;
    } catch {
      return 19387;
    }
  }

  /**
   * 建侧窗客户端。
   *
   * @param {object} [deps]
   * @param {number} [deps.port]
   * @returns {object} 客户端
   */
  function createSideClient(deps = {}) {
    const base = `http://127.0.0.1:${deps.port ?? portFromLocation()}`;
    /** 本侧窗绑定的会话（与主窗无关）。 */
    let sessionId = null;

    /** 发 GET，规整成 `{ok, data, code, message}`。 */
    function get(path) {
      return global.fetch(base + path)
        .then((res) => res.json().catch(() => ({})))
        .then((json) => {
          if (json && json.ok === true) return { ok: true, data: json };
          const code = json?.error?.code ?? "request-failed";
          const message = json?.error?.message;
          return { ok: false, code, message };
        })
        .catch((err) => ({ ok: false, code: "network", message: err?.message }));
    }

    /** 发 POST，规整成 `{ok, raw, code, message}`。 */
    function post(path, body) {
      return global.fetch(base + path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body ?? {}),
      })
        .then((res) => res.json().catch(() => ({})))
        .then((json) => {
          if (json && json.ok === true) return { ok: true, raw: json };
          const code = json?.error?.code ?? "request-failed";
          const message = json?.error?.message;
          return { ok: false, code, message };
        })
        .catch((err) => ({ ok: false, code: "network", message: err?.message }));
    }

    /** 新建一个真会话（宿主体内真的建一个）。 */
    function createSession() {
      return post("/whale/session/create", {}).then((out) => {
        if (!out.ok) return out;
        const id = out.raw?.sessionId;
        if (typeof id !== "string" || id === "") {
          return { ok: false, code: "session-create-no-id" };
        }
        sessionId = id;
        return { ok: true, sessionId: id };
      });
    }

    /** 读某个会话的面板（消息流）。 */
    function panel(id) {
      const sid = id ?? sessionId;
      if (typeof sid !== "string" || sid === "") {
        return Promise.resolve({ ok: false, code: "no-session" });
      }
      return get(`/whale/panel?sessionId=${encodeURIComponent(sid)}`).then((out) => {
        if (!out.ok) return out;
        return {
          ok: true,
          messages: Array.isArray(out.data?.messages) ? out.data.messages : [],
          running: out.data?.running === true,
          title: typeof out.data?.title === "string" ? out.data.title : null,
        };
      });
    }

    /** 给本侧窗的会话发一条消息。 */
    function send(text) {
      if (typeof sessionId !== "string" || sessionId === "") {
        return Promise.resolve({ ok: false, code: "no-session" });
      }
      return post("/whale/send", { sessionId, text });
    }

    /** 列工作区某目录。 */
    function workspaceFiles(dir) {
      const d = typeof dir === "string" ? dir : "";
      const sid = encodeURIComponent(sessionId ?? "");
      return get(`/whale/workspace/files?sessionId=${sid}&dir=${encodeURIComponent(d)}`)
        .then((out) => {
          if (!out.ok) return { ok: false, code: out.code, message: out.message };
          return {
            ok: true,
            dir: typeof out.data?.dir === "string" ? out.data.dir : d,
            entries: Array.isArray(out.data?.entries) ? out.data.entries : [],
            reason: typeof out.data?.reason === "string" ? out.data.reason : null,
          };
        });
    }

    /** 用系统默认程序打开工作区文件。 */
    function openWorkspacePath(path) {
      return post("/whale/workspace/open", { sessionId: sessionId ?? "", path });
    }

    return {
      base,
      createSession,
      getSessionId: () => sessionId,
      openWorkspacePath,
      panel,
      send,
      setSessionId: (id) => { sessionId = id; },
      workspaceFiles,
    };
  }

  global.WhaleSideBridge = { createSideClient, portFromLocation };
})(typeof window !== "undefined" ? window : globalThis);

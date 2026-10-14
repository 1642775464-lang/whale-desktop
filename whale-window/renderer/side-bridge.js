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

    /**
     * 读工作区文件内容（预览用）。
     *
     * @param {string} path 工作区相对路径
     * @param {boolean} binary 是否要 base64（图片/音视频要，文本类不要）
     * @returns {Promise<{ok: boolean, text?: string, base64?: string, size?: number, code?: string}>}
     */
    function readWorkspaceFile(path, binary) {
      const sid = encodeURIComponent(sessionId ?? "");
      const b = binary === true ? "1" : "0";
      return get(`/whale/workspace/read?sessionId=${sid}&path=${encodeURIComponent(path)}&binary=${b}`)
        .then((out) => {
          if (!out.ok) return out;
          return {
            ok: true,
            path: out.data?.path ?? path,
            size: typeof out.data?.size === "number" ? out.data.size : null,
            text: typeof out.data?.text === "string" ? out.data.text : null,
            base64: typeof out.data?.base64 === "string" ? out.data.base64 : null,
          };
        });
    }

    /**
     * 取会话清单（选「继承哪条会话的上下文」用）。
     *
     * 用桥的 `/whale/session/list`（与主窗同一来源），规整成扁平数组 ——
     * 界面只关心「标题 + id + 工作区名」，不必自己剥一层 data。
     *
     * @returns {Promise<{ok: boolean, sessions: Array<object>, code?: string}>}
     */
    function sessionList() {
      return get("/whale/session/list").then((out) => {
        if (!out.ok) return { ok: false, code: out.code };
        const raw = Array.isArray(out.data?.sessions) ? out.data.sessions : [];
        return {
          ok: true,
          sessions: raw.map((s) => ({
            sessionId: s.sessionId,
            title: typeof s.title === "string" && s.title !== "" ? s.title : "(未命名会话)",
            workspaceTitle: typeof s.workspaceTitle === "string" ? s.workspaceTitle : "",
            workspacePath: typeof s.workspacePath === "string" ? s.workspacePath : "",
            updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
            /*
             * ⚠️ 必须把 `archived` 带出来：调用方要靠它滤掉归档会话
             * （用户报「继承下拉里出现很多已归档的不存在的会话」）。
             * 早先这里没这个字段，过滤条件就永远拿不到 true、形同虚设。
             */
            archived: s.archived === true,
          })),
        };
      });
    }

    /**
     * 从桥取**当前活跃会话**及其工作区。
     *
     * ## 为什么侧窗必须自己问，而不是只用建窗时的查询串
     *
     * 用户报「文件区域读不到当前工作区」——实测根因：侧窗的查询串只有
     * `?port=19387`，**既没有 sessionId 也没有 workspace**（主进程建窗那一刻
     * 渲染层还没把状态报上来），于是请求不带会话 → 桥回 400 `bad-request`。
     *
     * 就算那一次拿到了，也还有个更深的问题：**查询串只在建窗时取一次**，
     * 之后主窗切了会话，侧窗永远不知道。所以把桥当作事实源、查询串只当兜底。
     *
     * @returns {Promise<{ok: boolean, sessionId: string|null, workspace: string|null, code?: string}>}
     */
    function activeContext() {
      return get("/whale/hud").then((out) => {
        if (!out.ok) return { ok: false, sessionId: null, workspace: null, code: out.code };
        const sid = out.data?.activeSessionId;
        const sessions = Array.isArray(out.data?.sessions) ? out.data.sessions : [];
        const found = sessions.filter((s) => s.sessionId === sid)[0];
        return {
          ok: true,
          sessionId: typeof sid === "string" && sid !== "" ? sid : null,
          workspace: typeof found?.workspace === "string" && found.workspace !== ""
            ? found.workspace
            : null,
        };
      });
    }

    return {
      activeContext,
      base,
      createSession,
      getSessionId: () => sessionId,
      openWorkspacePath,
      panel,
      readWorkspaceFile,
      send,
      sessionList,
      setSessionId: (id) => { sessionId = id; },
      workspaceFiles,
    };
  }

  global.WhaleSideBridge = { createSideClient, portFromLocation };
})(typeof window !== "undefined" ? window : globalThis);

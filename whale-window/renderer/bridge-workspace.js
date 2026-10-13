/*
 * 桥的「工作区 / 账号」调用包装
 *
 * 职责：把工作区文件与账号这两组低频调用从 `bridge-client.js` 拆出来。
 * 所属层：小窗（whale-window/renderer）
 *
 * ## 为什么拆
 *
 * `bridge-client.js` 是主循环（轮询、跟随活跃会话、增量流）的所在地，
 * 它已经到 500 行上限（强制 14）。而工作区文件与账号是**另一类东西**：
 * 它们由用户动作触发、不参与轮询、也不碰 `state.sessionId` 的跟随逻辑。
 *
 * ## 为什么不直接复制内部函数
 *
 * 这些调用要用到 client 内部的 `get` / `post` / `state`。所以这里导出的是
 * **工厂**：由 `bridge-client.js` 把自己的依赖传进来（与桥侧
 * `typert-bridge` 拆账号/工作区时用的是同一手法）。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleBridgeWorkspace。
 */

(function attachBridgeWorkspace(global) {
  "use strict";

  /**
   * 建工作区与账号的调用组。
   *
   * @param {object} deps
   * @param {(path: string) => Promise<object>} deps.get
   * @param {(path: string, body: object) => Promise<object>} deps.post
   * @param {() => object} deps.state 取当前状态（要读 sessionId）
   * @returns {{workspaceFiles: Function, openWorkspacePath: Function, account: Function}}
   */
  function createWorkspaceCalls(deps) {
    const { get, post, state } = deps;

    /**
     * 列工作区某个目录的条目（文件列表用）。
     *
     * `dir` 是**目录前缀**（空串 = 工作区根）；桥在宿主那条通路上
     * 把它当「列这个目录」用。返回值规整成 `{ok, dir, entries, reason?, code?}`
     * —— 调用方不必自己剥一层。
     */
    function workspaceFiles(dir) {
      const d = typeof dir === "string" ? dir : "";
      const sid = encodeURIComponent(state().sessionId ?? "");
      return get(`/whale/workspace/files?sessionId=${sid}&dir=${encodeURIComponent(d)}`)
        .then(function (out) {
          if (!out.ok) return { ok: false, code: out.code, message: out.message };
          return global.WhaleBridgeShapes.normalizeWorkspaceFiles(out.data, d);
        });
    }

    /**
     * 用系统默认程序打开工作区文件。
     *
     * ⚠️ 走**宿主**的 `session/openWorkspacePath`，桥不自己起进程 ——
     * 小窗因此不需要（也不该有）执行系统命令的权限。
     */
    function openWorkspacePath(path) {
      return post("/whale/workspace/open", { sessionId: state().sessionId ?? "", path });
    }

    /**
     * 账号信息与充值余额（侧边栏底部模块）。
     *
     * ⚠️ 与 `skills()` 一样返回 `{ok, data}`（data 是整个响应体）。
     * `profile` / `balance` 可能各自为 null（宿主那个方法失败），
     * 由调用方分别显示「—」—— 不能因为一块失败就把另一块也变空。
     */
    function account() {
      return get("/whale/account");
    }

    return { account, openWorkspacePath, workspaceFiles };
  }

  global.WhaleBridgeWorkspace = { createWorkspaceCalls };
})(typeof window !== "undefined" ? window : globalThis);

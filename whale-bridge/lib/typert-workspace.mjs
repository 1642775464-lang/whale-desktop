/**
 * 工作区文件操作的 Typert 调用
 *
 * 职责：用系统默认程序打开工作区内的文件（或用文件管理器定位它）。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么从 typert-bridge.mjs 拆出来：那个文件已到 500 行上限（强制 14），
 * 而这是**写操作 + 安全边界**相关的一组能力，与「技能目录 / 会话清单」
 * 那些只读能力不是一类改动原因。
 *
 * ## 契约（照 `dsh-api-session-controller` 的 typert.host.js 声明）
 *
 *   session/openWorkspacePath
 *     args `{ request: { path, action?: "reveal", application?: string } }`
 *       → `{ opened: true }`
 *
 * ## 为什么不自己开
 *
 * 打开走**宿主**而不是小窗起进程：
 *   · 复用宿主的**工作区边界校验**（它才是权限的持有者）；
 *   · 不给小窗开一条能执行系统命令的通道
 *     （`whale-window/lib/ipc.cjs` 的通道白名单不因此变大）。
 *
 * ⚠️ 路径的合法性由**调用方**先卡（见 handlers-workspace 的 `safeRelativePath`）；
 * 这里只做「非空字符串」的兜底，不重复那套规则（两处实现迟早会不一致）。
 */

/**
 * 建工作区文件操作能力。
 *
 * @param {object} deps
 * @param {(req: {namespace: string, method: string, args?: object}) => Promise<object>} deps.invokeRemote
 * @returns {{openWorkspacePath: (input: object) => Promise<object>}}
 */
export function createWorkspaceCalls({ invokeRemote }) {
  /**
   * 用系统默认程序打开一个**工作区内**的文件 / 用文件管理器定位它。
   *
   * @param {{path: string, reveal?: boolean, application?: string}} input
   * @returns {Promise<{ok: boolean, opened?: boolean, code?: string, message?: string}>}
   */
  async function openWorkspacePath(input) {
    const path = input?.path;
    if (typeof path !== "string" || path === "") {
      return { ok: false, code: "bad-request", message: "缺少 path" };
    }

    const request = { path };
    // 只在明确要看 reveal 时才带这个键（严格 codec：多余的键会改变语义）
    if (input?.reveal === true) request.action = "reveal";
    if (typeof input?.application === "string" && input.application !== "") {
      request.application = input.application;
    }

    const out = await invokeRemote({
      namespace: "session",
      method: "openWorkspacePath",
      args: { request },
    });
    if (!out.ok) return out;

    const value = out.value;
    if (value === null || typeof value !== "object" || value.opened !== true) {
      /*
       * 宿主没给 `opened: true` 就不算成功。
       * 不把「返回了但没打开」当成成功 —— 那正是「点了没反应」的来源。
       */
      return {
        ok: false,
        code: "session-not-ready",
        message: "宿主没有打开该路径（会话可能没有活跃 agent）",
      };
    }
    return { ok: true, opened: true };
  }

  return { openWorkspacePath };
}

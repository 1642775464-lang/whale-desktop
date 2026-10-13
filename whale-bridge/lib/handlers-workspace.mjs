/**
 * 工作区文件路由
 *
 * 职责：给小窗的「工作区文件列表」提供两件事 ——
 *       列出某目录的条目、用系统默认程序打开某个文件。
 * 所属层：桥（whale-bridge/lib）
 *
 * ## 为什么复用 `fileReferences` 而不是新建「列目录」能力
 *
 * 宿主没有「列目录」接口，但 `fileReferences.list(agent, query)` 实测有这样的性质：
 *
 *   · `query = ""`                → 工作区**顶层**条目
 *   · `query = "whale-window/"`   → 该目录下的条目
 *
 * 也就是「传目录前缀」等价于「列这个目录」（主窗口的 `@` 补全正是这么用的）。
 * 因此逐层下钻不需要新的宿主能力，复用这条即可 —— 少一处会不同步的实现。
 *
 * ## 打开文件走宿主的官方通路
 *
 * 打开**不走小窗自己的 shell 权限**：宿主的 `sessionController` 暴露了
 * `session/openWorkspacePath`（Typert），实测契约：
 *
 *   args `{ request: { path, action?: "reveal", application?: string } }`
 *     → `{ opened: true }`
 *
 * 让宿主去开，既复用它的工作区边界校验，也避免给小窗开一条能执行任意
 * 系统命令的通道（`whale-window/lib/ipc.cjs` 的白名单就不会被撑大）。
 *
 * ## 安全
 *
 * 渲染层传来的路径**不受信任**（网页内容可以伪造调用），所以：
 *   · 打开前用 `safeRelativePath` 卡死「工作区内的相对路径」（拒绝绝对路径与 `..`）；
 *   · 列目录的 `dir` 前缀同样过一遍，不让它拼出工作区外的 query。
 */

import { register } from "./routes.mjs";
import { normalizeDirPrefix, normalizeEntries, safeRelativePath } from "./workspace-files.mjs";

/**
 * GET /whale/workspace/files?sessionId=&dir=
 *
 * 列出一个目录下的条目。`dir` 省略即工作区顶层。
 *
 * 三类结果要分开（与 `/whale/files` 同一纪律）：
 *   · 缺 sessionId → 400（不能静默给空）
 *   · 会话不存在 → 404
 *   · 没有活 agent → 200 + 空清单 + reason（那是「做不到」，不是「没有文件」）
 *
 * @param {object} ctx
 * @param {object} ctx.host
 * @param {URLSearchParams} [ctx.query]
 * @returns {Promise<object>}
 */
async function workspaceFiles({ host, query }) {
  const sessionId = query?.get?.("sessionId");
  if (typeof sessionId !== "string" || sessionId === "") {
    const err = new Error("缺少 sessionId");
    err.code = "bad-request";
    err.status = 400;
    throw err;
  }

  const session = host.getSession(sessionId);
  if (session === undefined) {
    const err = new Error(`会话 ${sessionId} 不存在`);
    err.code = "session-not-found";
    err.status = 404;
    throw err;
  }

  // 目录前缀过一遍安全校验：不让它拼出工作区外的 query
  const rawDir = query?.get?.("dir");
  const dir = typeof rawDir === "string" ? rawDir : "";
  if (dir !== "") {
    const safe = safeRelativePath(dir);
    if (!safe.ok) {
      const err = new Error(`目录不合法：${safe.reason}`);
      err.code = "bad-dir";
      err.status = 400;
      throw err;
    }
  }
  const prefix = normalizeDirPrefix(dir);

  const agent = host.getAgent(sessionId);
  if (agent === undefined || agent === null) {
    /*
     * 宿主这条通路需要**活 agent**（它用 agent 做作用域与鉴权）。
     * 明确说原因 —— 否则界面会以为「这个目录是空的」。
     */
    return {
      ok: true,
      dir: prefix,
      entries: [],
      reason: "该会话当前没有活跃 agent，读不到工作区文件",
    };
  }

  const candidates = await host.fileReferences(prefix, agent);
  return {
    ok: true,
    dir: prefix,
    entries: normalizeEntries(candidates),
  };
}

/**
 * POST /whale/workspace/open —— 用系统默认程序打开工作区文件
 *
 * body `{ path }`（工作区内的相对路径）。
 *
 * 失败要**如实分档**：路径非法（400）/ 会话没有活 agent（409）/
 * 宿主那条通路不可用（503）/ 宿主拒绝（502）。不假装成功 ——
 * 「点了没反应」比「明确报错」更难查。
 *
 * @param {object} ctx
 * @param {object} ctx.body
 * @param {object} ctx.host
 * @returns {Promise<object>}
 */
async function workspaceOpen({ body, host }) {
  const sessionId = body?.sessionId;
  if (typeof sessionId !== "string" || sessionId === "") {
    const err = new Error("缺少 sessionId");
    err.code = "bad-request";
    err.status = 400;
    throw err;
  }

  const safe = safeRelativePath(body?.path);
  if (!safe.ok) {
    // 绝对路径 / `..` 都在这里被挡下，且**不回显原始输入**（避免日志里出现任意字符串）
    const err = new Error(`路径不被允许：${safe.reason}`);
    err.code = "bad-path";
    err.status = 400;
    throw err;
  }

  if (typeof host.openWorkspacePath !== "function") {
    const err = new Error("桥未装配 openWorkspacePath（typert 能力缺失）");
    err.code = "open-unavailable";
    err.status = 503;
    throw err;
  }

  const out = await host.openWorkspacePath({ sessionId, path: safe.path });
  if (out.ok === true) return { ok: true, path: safe.path, opened: out.opened === true };

  /*
   * 失败分档：`not-ready` 是「会话没有活 agent」（可重试/需先激活），
   * 其余按宿主给的原样上报。
   */
  const status = out.code === "session-not-ready" ? 409 : 502;
  const err = new Error(out.message ?? "打开失败");
  err.code = out.code ?? "open-failed";
  err.status = status;
  throw err;
}

/** 注册工作区文件路由。 */
export function registerWorkspaceRoutes() {
  register("GET", "/whale/workspace/files", workspaceFiles);
  register("POST", "/whale/workspace/open", workspaceOpen);
}

/**
 * 侧边栏数据源路由
 *
 * 职责：给小窗左侧边栏提供「主窗口那些内容」的只读数据 ——
 *       当前是技能目录（技能中心）。
 * 所属层：桥（whale-bridge/lib）
 *
 * ## 为什么走 Typert 而不是别的
 *
 * 用户要在侧边栏里放技能中心 / 任务看板 / 频道。勘查与实测结论：
 *
 *   · `taskBoard` 服务**在**，但只暴露 `registerExtension` / `isExtensionEnabled`
 *     —— 没有「列任务」的方法；
 *   · `skills` 在，但类型定义写明它是 *cold-readable skill catalog **Remote***；
 *   · 频道无对外服务，只有 HTTP `/api/dsh-im-connect/*`。
 *
 * 那两个 HTTP 端点实测要**浏览器会话凭证**（401 请先登录 DSH），
 * 而桥是宿主进程内的插件、没有那个凭证 —— **HTTP 路不通**。
 *
 * 唯一通的：宿主侧 Typert 网关 `ctx.typertGateway`（探测为在）。
 * 网关的严格模式找不到生成描述符时会走 SRC 回退，所以桥不需要那份生成产物。
 * 细节见 typert-bridge.mjs。
 *
 * ## 全部只读
 *
 * 本文件只读数据，不改任何宿主状态。失败按桥的降级纪律返回结构化错误
 * （`code` + 可读 `message`），不假装成功、不编造空清单。
 */

import { register } from "./routes.mjs";

/**
 * GET /whale/skills?sessionId= —— 技能目录（技能中心用）
 *
 * 走 Typert `skills/list`，实测契约：
 *   args `{ request: { sessionId } }` → `{ skills: [{ path?, name, description,
 *   whenToUse?, modelInvocable }] }`
 *
 * 需要 sessionId 是因为该远程方法是**按会话寻址**的（技能可见性依赖会话）。
 *
 * @param {object} ctx 处理器上下文
 * @param {object} ctx.host 宿主访问封装
 * @param {URLSearchParams} [ctx.query]
 * @returns {Promise<object>}
 */
async function skills({ host, query }) {
  const sessionId = query?.get("sessionId") ?? "";
  if (sessionId === "") {
    const err = new Error("缺少 sessionId");
    err.code = "missing-session-id";
    err.status = 400;
    throw err;
  }

  if (typeof host.listSkills !== "function") {
    // 装配问题：路由在但能力没挂上——必须明确报错，不能返回空清单冒充「没有技能」
    const err = new Error("桥未装配 listSkills（typert 能力缺失）");
    err.code = "skills-unavailable";
    err.status = 503;
    throw err;
  }

  const out = await host.listSkills(sessionId);
  if (!out.ok) {
    /*
     * 把网关的失败原样传上去。**不降级成空清单** ——
     * 「读不到」与「真的没有技能」在界面上含义完全不同，
     * 混成一个会让用户以为技能丢了。
     */
    const err = new Error(out.message ?? "读取技能目录失败");
    err.code = out.code ?? "skills-failed";
    err.status = 502;
    throw err;
  }

  return { ok: true, skills: out.skills };
}

/**
 * POST /whale/session/create —— 新建一个会话（侧边栏「新会话」）
 *
 * 走 Typert `session/create`，实测契约：
 *   `request: { workspaceId?, cwd?, sessionId?, agentPreset? }`（全部可选）
 *   → `{ sessionId, agentPreset? }`
 *
 * body 可空。**这是写操作**（会在宿主里真的建一个会话），
 * 与同文件其余只读路由不同，调用方要知道这一点。
 *
 * @param {object} ctx
 * @param {object} ctx.host
 * @param {object} [ctx.body]
 * @returns {Promise<object>}
 */
async function sessionCreate({ host, body }) {
  if (typeof host.createSession !== "function") {
    const err = new Error("桥未装配 createSession（typert 能力缺失）");
    err.code = "session-create-unavailable";
    err.status = 503;
    throw err;
  }

  // 只透传宿主认得的字段；多传的会被网关的具名参数校验拒掉
  const src = body !== null && typeof body === "object" ? body : {};
  const request = {};
  for (const key of ["workspaceId", "cwd", "sessionId", "agentPreset"]) {
    if (typeof src[key] === "string" && src[key] !== "") request[key] = src[key];
  }

  const out = await host.createSession(request);
  if (!out.ok) {
    const err = new Error(out.message ?? "新建会话失败");
    err.code = out.code ?? "session-create-failed";
    err.status = 502;
    throw err;
  }
  return { ok: true, sessionId: out.sessionId, agentPreset: out.agentPreset };
}

/**
 * GET /whale/session/list —— 可见会话清单（不唤醒冷会话）
 *
 * 走 Typert `session/list`。宿主注释写明它「Read all visible Session rows
 * without resuming an Agent」，所以这条**不会把冷会话唤醒**——
 * 侧边栏列清单用它比逐个 inspect 安全。
 *
 * @param {object} ctx
 * @param {object} ctx.host
 * @returns {Promise<object>}
 */
async function sessionList({ host }) {
  if (typeof host.listSessionsViaTypert !== "function") {
    const err = new Error("桥未装配 listSessions（typert 能力缺失）");
    err.code = "session-list-unavailable";
    err.status = 503;
    throw err;
  }

  const out = await host.listSessionsViaTypert();
  if (!out.ok) {
    const err = new Error(out.message ?? "读取会话清单失败");
    err.code = out.code ?? "session-list-failed";
    err.status = 502;
    throw err;
  }
  return { ok: true, sessions: out.sessions };
}

/** 注册侧边栏数据源路由。 */
export function registerSidebarRoutes() {
  register("GET", "/whale/skills", skills);
  register("GET", "/whale/session/list", sessionList);
  register("POST", "/whale/session/create", sessionCreate);
}

/** 本文件声明的路由数（供单测核对）。 */
export const SIDEBAR_ROUTES = 3;

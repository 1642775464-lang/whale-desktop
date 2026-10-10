/**
 * 路由处理器
 *
 * 职责：实现切片 1 的 4 条只读路由的处理器，并注册进路由表。
 * 所属层：桥（whale-bridge/lib）
 *
 * 本片全部为 GET、全部只读——不写数据、不拉进程、不向会话发消息。
 */

import { register, describeRoutes, ROUTE_DEFS } from "./routes.mjs";
import { panelPayload } from "./panel-data.mjs";

/** 插件版本；与 whale-bridge/package.json 的 version 保持一致。 */
export const BRIDGE_VERSION = "0.1.0";

/** 插件名（`/whale` 概览里报告，便于确认桥上的是哪份代码）。 */
export const BRIDGE_NAME = "whale-bridge";

/**
 * GET /whale —— 概览
 *
 * 返回版本、路由表、插件名。路由表是唯一事实源，直接由 routes.mjs 生成，
 * 每条标注 `implemented`，便于一眼看出哪些路由尚未落地。
 */
function overview() {
  const routes = describeRoutes();
  return {
    ok: true,
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    routeCount: routes.length,
    implementedCount: routes.filter((r) => r.implemented).length,
    routes,
  };
}

/**
 * GET /whale/probe —— 运行时探测
 *
 * 报告宿主各服务是否可用。**不抛错**：服务全缺也返回 200 与全 false，
 * 由调用方判断（降级原则：宁可局部失效不整体崩溃）。
 *
 * 支持 `?services=a,b,c` **按名探测**：只回答「在不在」，不读内容。
 * 加这个是因为「桥能不能拿到某个功能的数据」只能实测回答，
 * 而没有它时每验一个服务名都要改代码再重启宿主。
 *
 * @param {object} ctx
 * @param {object} ctx.host
 * @param {URLSearchParams} [ctx.query]
 */
function probe({ host, query }) {
  const wanted = (query?.get("services") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  return {
    ok: true,
    name: BRIDGE_NAME,
    version: BRIDGE_VERSION,
    host: host.probe(),
    ...(wanted.length > 0 && typeof host.serviceVisible === "function"
      ? { services: host.serviceVisible(wanted) }
      : {}),
  };
}

/**
 * GET /whale/panel —— 面板数据源
 *
 * 需 `?sessionId=`。返回小窗面板所需：消息流、任务清单、权限档位与模型档位。
 *
 * 消息流与任务清单来自折叠器（panel-data.mjs 投影）；切片 1 时它们是空数组，
 * 切片 3 起接上真实数据。档位信息仍从宿主读取，缺失给 `null`。
 *
 * 归一化原则：**取不到就给 null，不编造**（降级原则：宁可显示 – 不显示错的数）。
 *
 * @param {object} ctx 处理器上下文
 * @param {object} ctx.query
 * @param {object} ctx.host
 * @param {object} [ctx.bridge] 桥运行时依赖（含 foldSet）
 */
async function panel({ query, host, bridge }) {
  const sessionId = query.get("sessionId");
  if (sessionId === null || sessionId === "") {
    const err = new Error("缺少 sessionId 参数");
    err.code = "bad-request";
    err.status = 400;
    throw err;
  }

  /**
   * 冷会话要先从**持久层**种进折叠器。
   *
   * 宿主的 sessions 服务只认活会话（注释写明 "All **live** sessions"），
   * 重启后空闲的那条 `getSession()` 返回 undefined —— 原先这里直接 404，
   * 于是「桥明明能从持久层读到它」却「不肯交给小窗」。
   * 这是两件必须分开测的事。
   *
   * 种子会校验宿主确实认识该 id，所以不存在的会话仍然走到下面的 404。
   */
  const foldSet = bridge?.foldSet;
  const inFold = foldSet !== undefined && foldSet.sessions.has(sessionId);
  if (!inFold && bridge?.seed !== undefined) {
    await bridge.seed.ensureSeeded(sessionId);
  }

  const session = host.getSession(sessionId);
  if (session === undefined && (foldSet === undefined || !foldSet.sessions.has(sessionId))) {
    const err = new Error(`会话 ${sessionId} 不存在`);
    err.code = "session-not-found";
    err.status = 404;
    throw err;
  }

  const agent = host.getAgent(sessionId);
  const payload = foldSet === undefined
    ? null
    : panelPayload({
      foldSet,
      sessionId,
      agent,
      // 标题兜底：折叠器没有就读宿主投影（与 /whale/hud 同一口径）
      resolveTitle: bridge?.resolveTitle,
    });

  // 会话在宿主里存在、但桥还没收到它的事件时，给出骨架而不是报错：
  // 「桥还没数据」与「会话不存在」是两回事，不该混淆。
  if (payload === null) {
    return {
      ok: true,
      sessionId,
      messages: [],
      todos: [],
      permission: null,
      model: null,
      agentRunning: agent?.status === "running",
      note: "该会话尚未产生桥可见的事件",
    };
  }

  return { ok: true, ...payload };
}

/**
 * GET /whale/capability —— 提交通路能力探测
 *
 * 报告 send / command / abort / resume 是否可用。
 *
 * 判定依据（对齐宿主 dsh-api-session-controller 的真实通路）：
 * - send    需要 sessions + agents 都在
 * - command 需要 commands + agents 都在
 * - abort   需要 agents 在
 * - resume  需要 sessions 在
 *
 * 本片只报告「通路具备」，实际写操作在切片 3 落地。
 */
function capability({ host }) {
  const hasSessions = host.available.sessions;
  const hasAgents = host.available.agents;
  const hasCommands = host.available.commands;

  return {
    ok: true,
    capability: {
      send: { available: hasSessions && hasAgents, reason: pickReason(hasSessions, hasAgents, "sessions", "agents") },
      command: { available: hasCommands && hasAgents, reason: pickReason(hasCommands, hasAgents, "commands", "agents") },
      abort: { available: hasAgents, reason: hasAgents ? null : "缺少 agents 服务" },
      resume: { available: hasSessions, reason: hasSessions ? null : "缺少 sessions 服务" },
    },
  };
}

/**
 * 生成缺失原因描述。
 * @param {boolean} aHas
 * @param {boolean} bHas
 * @param {string} aName
 * @param {string} bName
 * @returns {string | null}
 */
function pickReason(aHas, bHas, aName, bName) {
  const missing = [];
  if (!aHas) missing.push(aName);
  if (!bHas) missing.push(bName);
  return missing.length === 0 ? null : `缺少 ${missing.join(" 与 ")} 服务`;
}

/** 注册本片全部处理器。由 host.js 在 apply 时调用。 */
export function registerSliceOneRoutes() {
  register("GET", "/whale", overview);
  register("GET", "/whale/probe", probe);
  register("GET", "/whale/panel", panel);
  register("GET", "/whale/capability", capability);
}

/** 本片声明的路由数（供单测核对）。 */
export const SLICE_ONE_ROUTES = ROUTE_DEFS.filter((d) => d.slice === 1).length;

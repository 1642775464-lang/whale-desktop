/**
 * 切片 3 只读路由
 *
 * 职责：实现切片 3 的 8 条 GET 路由——SSE 双端点、悬浮条全量快照、
 *       小窗进程列表、模型目录、审批查询、主窗跟随流。
 * 所属层：桥（whale-bridge/lib）
 *
 * 全部只读：不发消息、不拉进程、不改任何宿主状态。
 * 写操作在 handlers-slice3-write.mjs。
 *
 * 降级纪律（《边界与 NFR》四条原则）：
 *   - 取不到的值给 `null`，不编造（宁可显示 `–` 不显示错的数）
 *   - 某一路数据缺失不影响其他字段（宁可局部失效不整体崩溃）
 *   - 失败必有出口：错误体带 `code` 与可读 `message`
 */

import { register } from "./routes.mjs";
import { HANDLED } from "./server.mjs";
import { CHANNEL_EVENTS, CHANNEL_HUD } from "./sse.mjs";
import { hudSnapshot } from "./fold-view.mjs";

/**
 * 把 SSE 客户端接入某频道，并把连接生命周期挂到响应上。
 *
 * 关键点：**客户端断开必须摘掉，否则广播会一直往死连接写**。
 * `close` 在正常断开时触发，`error` 兜底，两者都要走同一条清理路径（幂等）。
 *
 * @param {object} ctx 处理器上下文
 * @param {string} channel 频道名
 * @returns {symbol} HANDLED
 */
function streamTo(ctx, channel) {
  const { res, req, bridge } = ctx;
  const hub = bridge?.sse;

  if (hub === undefined) {
    // 没有广播表说明装配有问题——这种情况必须明确报错，不能假装连上了
    const err = new Error("SSE 广播表未装配");
    err.code = "sse-unavailable";
    err.status = 503;
    throw err;
  }

  const lastEventId = parseLastEventId(req);
  const info = hub.connect(channel, res, { lastEventId });

  if (!info.connected) {
    // 连接一开始就是死的：header 已尝试写过，不能再 sendError，直接结束
    try {
      res.end();
    } catch {
      // 已经断了的连接 end 会抛，忽略
    }
    return HANDLED;
  }

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    hub.disconnect(info.clientId);
  };

  res.on("close", cleanup);
  res.on("error", cleanup);
  req.on("close", cleanup);

  return HANDLED;
}

/**
 * 解析 `Last-Event-ID`。
 *
 * 同时接受请求头与 `?lastEventId=` 查询参数：SSE 标准走头，
 * 但手工用 curl 调试时给查询参数更方便。
 *
 * 非法值一律当作「没带」——回补逻辑本身能处理任意值，不需要在这里报错。
 *
 * @param {object} req
 * @param {URLSearchParams} [query]
 * @returns {number | null}
 */
export function parseLastEventId(req, query = undefined) {
  const fromQuery = query?.get?.("lastEventId");
  const raw = typeof req?.headers?.["last-event-id"] === "string"
    ? req.headers["last-event-id"]
    : fromQuery;

  if (raw === undefined || raw === null || raw === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

/** GET /whale/events —— 会话事件 SSE。 */
function eventsStream(ctx) {
  return streamTo(ctx, CHANNEL_EVENTS);
}

/** GET /whale/hud/events —— 悬浮条 SSE 增量推送。 */
function hudStream(ctx) {
  return streamTo(ctx, CHANNEL_HUD);
}

/**
 * GET /whale/hud —— 悬浮条全量快照。
 *
 * 这是客户端启动时拉的第一份数据，也是断线补不全（`missed: true`）后的兜底。
 */
function hud({ bridge }) {
  const foldSet = bridge?.foldSet;
  if (foldSet === undefined) {
    const err = new Error("折叠器未装配");
    err.code = "fold-unavailable";
    err.status = 503;
    throw err;
  }
  return {
    ok: true,
    ...hudSnapshot(foldSet, {
      version: bridge.version,
      port: bridge.port,
      startedAt: bridge.startedAt,
      now: Date.now(),
      // 标题兜底：折叠器没有就问宿主投影（详见 host.js 的 resolveTitle 注释）
      resolveTitle: bridge.resolveTitle,
    }),
  };
}

/**
 * GET /whale/follow —— 主窗跟随流。
 *
 * 与 `/whale/events` 同为 SSE，但只推「活跃会话水位」这一条轻量通道：
 * 主窗只要知道「该跟哪个会话、它到哪了」，不必收全量事件。
 * 这样主窗可以常驻连接而几乎不耗带宽。
 */
function follow(ctx) {
  return streamTo(ctx, CHANNEL_HUD);
}

/**
 * GET /whale/windows —— 已拉起的小窗进程列表。
 */
function windows({ bridge }) {
  const registry = bridge?.windows;
  if (registry === undefined) {
    return { ok: true, windows: [], total: 0, note: "小窗管理器未装配" };
  }
  const list = registry.list();
  return { ok: true, windows: list, total: list.length };
}

/**
 * GET /whale/models —— 模型目录。
 *
 * 探测不到就返回空数组 + 明确 `reason`。
 * **不猜、不硬编码模型名**：错的模型列表比没有列表更糟（用户会照着它切换）。
 */
function models({ host }) {
  const list = host.listModels();
  if (!Array.isArray(list) || list.length === 0) {
    return {
      ok: true,
      models: [],
      total: 0,
      reason: "宿主未暴露模型目录服务，或尚未选择模型",
    };
  }
  return { ok: true, models: list, total: list.length };
}

/**
 * GET /whale/commands —— 斜杠命令目录（宿主真命令）。
 *
 * 为什么要这条路由：命令面板原先只显示桥里硬编码的三条，
 * 而宿主实际有二十多条（文件 / 目标 / 计划 / 压缩 / 权限 / 模型…）。
 * 靠硬编码永远追不上宿主的命令表，**必须问宿主**。
 *
 * 需要 `sessionId`：命令按 agent 可见性过滤（不同会话可见集合可能不同）。
 * 取不到 agent 时返回空表 + `reason`，不编造。
 */
function commands({ host, query }) {
  // ⚠️ query 是 URLSearchParams，**必须用 .get() 取**。
  // 写成 `query?.sessionId` 会恒为 undefined（属性访问取不到查询串），
  // 表现是接口永远回「需要 sessionId」—— 而我明明传了。
  // handlers-slice1/slice2 里都有同样的注释，这是桥的既有约定。
  const sessionId = query?.get?.("sessionId");
  if (typeof sessionId !== "string" || sessionId === "") {
    return {
      ok: true,
      commands: [],
      total: 0,
      reason: "需要 sessionId：命令表按会话可见性过滤",
    };
  }

  const agent = host.getAgent(sessionId);
  if (agent === undefined) {
    return {
      ok: true,
      commands: [],
      total: 0,
      reason: `会话 ${sessionId} 的 agent 不可用`,
    };
  }

  const list = host.listCommands(agent);
  return { ok: true, commands: list, total: list.length };
}

/**
 * GET /whale/approval —— 待确认权限请求。
 *
 * 桥只报告「当前是否有挂起的审批请求」，实际应答走 POST /whale/approval。
 */
function approval({ bridge }) {
  const gate = bridge?.approval;
  if (gate === undefined) {
    return { ok: true, pending: [], total: 0, note: "审批桥未装配" };
  }
  const pending = gate.listPending();
  return {
    ok: true,
    pending,
    total: pending.length,
    policy: gate.policyOf?.(),
  };
}

/**
 * GET /whale/capability 之外，切片 3 还需要一条「桥自身运行态」的路由吗？
 *
 * 不需要——`/whale/probe` 已经承担该职责。新增路由会让 22 条的数字对不上 PRD。
 */

/** 注册本片全部只读处理器。 */
export function registerSliceThreeReadRoutes(deps) {
  // SSE 需要 hub；其余只读路由从 ctx.bridge 取依赖，无需闭包捕获
  register("GET", "/whale/events", eventsStream);
  register("GET", "/whale/hud/events", hudStream);
  register("GET", "/whale/follow", follow);
  register("GET", "/whale/hud", hud);
  register("GET", "/whale/windows", windows);
  register("GET", "/whale/models", models);
  register("GET", "/whale/approval", approval);

  // 切片 7 新增：命令目录。取名字不同（commands 而非 slice3 前缀），
  // 因为它是二期第一条路由，切片归属写在路由表的 slice 字段里。
  register("GET", "/whale/commands", commands);

  // deps 目前只用来自检装配是否完整；保留参数便于后续扩展
  void deps;
}

/** 本片只读路由条数（供单测核对）。 */
export const SLICE_THREE_READ_ROUTES = 7;

/** 切片 7 新增的只读路由条数（单测核对用；与 slice3 分开计数，便于追溯）。 */
export const SLICE_SEVEN_READ_ROUTES = 1;

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
 *
 * ⚠️ 折叠器为空时先做一次**冷会话种子**。
 * 折叠器只由 `session/event` 填充，而宿主重启后那条会话是空闲的、
 * 不再产生任何事件 —— 于是 hud 会给出「零个会话」，小窗拿不到 sessionId，
 * 权限/切模型/发命令全部 bad-request（用户报的原始症状）。
 * 轮询救不了这个：会话继续空闲就永远没有事件。
 * 只有读宿主的**持久层**才能看到它（见 seed.mjs）。
 *
 * 只在折叠器真的为空时种——事件流一填上就再也走不到这里，
 * 不会和实时状态抢位置。
 *
 * @returns {Promise<object>}
 */
async function hud({ bridge }) {
  const foldSet = bridge?.foldSet;
  if (foldSet === undefined) {
    const err = new Error("折叠器未装配");
    err.code = "fold-unavailable";
    err.status = 503;
    throw err;
  }

  if (foldSet.sessions.size === 0 && bridge.seed !== undefined) {
    await bridge.seed.seedRecent();
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
 * 两种形状都返回，各有用途：
 *   - `groups` / `default` / `failures`：**宿主的原目录**，含各模型的推理档位
 *     （小窗的模型 + 思考强度选择器读它）
 *   - `models`：扁平的 `{provider, model}` 列表，兼容既有客户端
 *
 * 真因记录：原先只找 `models` 服务，而宿主根本没有这个服务 → 一直返回 0。
 * 真正的目录在 `sessionController.modelCatalog()` 上（宿主 UI 也读它）。
 *
 * 拿不到就返回空 + 明确 `reason`。**不猜、不硬编码模型名**：
 * 错的模型列表比没有列表更糟（用户会照着它切换）。
 *
 * @returns {Promise<object>}
 */
async function models({ host }) {
  const catalog = await host.modelCatalog();
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];

  if (groups.length === 0) {
    // 退回旧的会话扫描（有些部署没有 sessionController）
    const fallback = host.listModels();
    if (Array.isArray(fallback) && fallback.length > 0) {
      return { ok: true, models: fallback, total: fallback.length, groups: [], default: null, failures: [] };
    }
    return {
      ok: true,
      models: [],
      groups: [],
      default: null,
      failures: [],
      total: 0,
      reason: catalog === null
        ? "宿主未提供 sessionController，读不到模型目录"
        : "宿主模型目录为空（可能没有任何 provider 可用）",
    };
  }

  // 扁平化给旧客户端用
  const flat = [];
  for (const group of groups) {
    for (const model of Array.isArray(group?.models) ? group.models : []) {
      flat.push({ provider: group.id, model: model.id });
    }
  }

  return {
    ok: true,
    groups,
    default: catalog.default ?? null,
    failures: Array.isArray(catalog.failures) ? catalog.failures : [],
    routableProviders: Array.isArray(catalog.routableProviders) ? catalog.routableProviders : [],
    models: flat,
    total: flat.length,
  };
}

/**
 * GET /whale/summon —— 取走该目标的「唤起请求」（切片 7 第三批）。
 *
 * 为什么需要这条：用户报「已重启，但是点击无法唤起」。真因是**复用 ≠ 唤起**——
 * 点鲸鱼时桥走复用分支只回 `{reused:true}`，从不把已存在的窗口显示出来，
 * 于是悬浮条收成球之后、或小窗被压住之后再点就是「点了没反应」。
 *
 * 桥**无法主动推**给窗口（窗口是独立进程，靠环境变量拿到桥端口后自己来连），
 * 所以做成「桥留标记、窗口用已有轮询来取」。**取走即消费**，
 * 否则窗口每轮都会看到旧标记、反复把自己弹出来。
 *
 * target 缺省为 window（与 /whale/open 同口径）。
 */
function summon({ bridge, query }) {
  const target = query?.get?.("target") || "window";
  const windows = bridge?.windows;
  if (windows === undefined || typeof windows.takeSummon !== "function") {
    return { ok: true, summon: false };
  }
  return { ok: true, ...windows.takeSummon(target) };
}

/**
 * GET /whale/presets —— 权限档位清单与当前档位。
 *
 * 档位**以宿主的 permissionPresets 为准**，不硬编码：
 * 小窗原先写死三档（read-only / workspace-write / danger-full-access），
 * 而宿主实际还有 `auto`（且 `auto` 是运行期注册的，预先写死必然漏）。
 *
 * 取不到就返回空 + `reason`，不编造档位。
 */
function presets({ host, query }) {
  const sessionId = query?.get?.("sessionId");
  const info = host.permissionPresets(
    typeof sessionId === "string" ? sessionId : "",
  );
  if (info === null) {
    return {
      ok: true,
      options: [],
      current: null,
      reason: "宿主未提供 permissionPresets 服务，读不到档位清单",
    };
  }
  return { ok: true, options: info.options, current: info.current };
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
  // 切片 7 第二批：权限档位清单（以宿主的 permissionPresets 为准）
  register("GET", "/whale/presets", presets);
  // 切片 7 第三批：唤起请求（复用 ≠ 唤起）
  register("GET", "/whale/summon", summon);

  // deps 目前只用来自检装配是否完整；保留参数便于后续扩展
  void deps;
}

/** 本片只读路由条数（供单测核对）。 */
export const SLICE_THREE_READ_ROUTES = 7;

/** 切片 7 新增的只读路由条数（单测核对用；与 slice3 分开计数，便于追溯）。 */
export const SLICE_SEVEN_READ_ROUTES = 3;

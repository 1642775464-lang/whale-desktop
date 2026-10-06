/**
 * 宿主桥插件入口
 *
 * 职责：插件生命周期——apply 时装配服务与路由并监听端口，
 *       dispose 时关闭服务（PRD F1：卸载钩子主动关服务）。
 * 所属层：桥（whale-bridge）
 *
 * 插件形态：Cordis 插件（宿主 DSH Desktop 加载）。
 * `apply` 由宿主调用并注入 ctx；`dispose` 在卸载时调用。
 *
 * 铁律 A-2：桥是呈现层与宿主之间的唯一通路，只对外暴露 HTTP。
 */

import { createHostAccess } from "./lib/host-ctx.mjs";
import { registerSliceOneRoutes, BRIDGE_NAME, BRIDGE_VERSION } from "./lib/handlers-slice1.mjs";
import { registerSliceTwoRoutes } from "./lib/handlers-slice2.mjs";
import { registerSliceThreeReadRoutes } from "./lib/handlers-slice3-read.mjs";
import { registerSliceThreeWriteRoutes } from "./lib/handlers-slice3-write.mjs";
import { close, createBridgeServer, listen, PORT, HOST } from "./lib/server.mjs";
import { validateRouteTable } from "./lib/routes.mjs";
import { createEventPipeline } from "./lib/events.mjs";
import { createFoldSet } from "./lib/fold.mjs";
import { CHANNEL_EVENTS, CHANNEL_HUD, createSseHub } from "./lib/sse.mjs";
import { snapshotOf } from "./lib/fold-view.mjs";
import { createApprovalBridge } from "./lib/approval-bridge.mjs";
import { createHostActions } from "./lib/host-actions.mjs";
import { createWindowManager } from "./lib/windows.mjs";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** 心跳间隔（PRD F7）：每 2 秒重算一次速度并推 tick。 */
export const HEARTBEAT_MS = 2000;

/** 仓库根：host.js 位于 <仓库根>/whale-bridge/host.js。 */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 插件显示名。 */
export const name = "whale-bridge";

/**
 * 本插件依赖的宿主服务。
 *
 * **这一条是必需的，漏了会「事件能收到、服务全没有」。**
 *
 * Cordis 只把 inject 里列出的服务装进插件 ctx。不声明的话：
 *   - `ctx.on("session/event")` 照样能收到事件（事件不走服务容器）
 *   - 而 `ctx.sessions` / `ctx.agents` 全是 undefined
 * 表现极具迷惑性：桥能看见会话在跑、能推会话事件，但一发消息就回
 * `session-not-found`（因为拿不到 agent）。
 *
 * 实测对照：宿主自己的插件无例外都声明了，例如
 *   dsh-compaction-image-offload → ["agents", "sessions"]
 *   dsh-command-compact          → ["commands", "compaction"]
 *   dsh-file-reference-local     → ["agents"]
 *
 * 原先本插件没有这条，装进真实宿主后 `/whale/probe` 报
 * `sessions:false agents:false commands:false`，写操作全部不可用。
 *
 * ⚠️ **只声明确定存在的服务名**。
 * Cordis 的语义是「inject 里声明的服务就绪之前不 apply」——
 * 写上一个**不存在**的服务名，插件会**永远不被启动**，而且不报错。
 * 所以这里只列宿主自有插件真实用过的名字（实测取自它们的 inject）：
 *   dsh-compaction-image-offload → ["agents", "sessions"]
 *   dsh-command-compact          → ["commands", "compaction"]
 *   dsh-agent-preset-registry    → ["loader", "sessionProjections"]
 *
 * 曾经把 `projections` / `attachments` / `models` 也写进来（想「可选也声明」），
 * 结果插件再也不启动。可选服务改用 `ctx.get(name)` 按需取——
 * 那个 API 不经过 inject 守卫，取不到就降级。
 */
export const inject = ["sessions", "agents", "commands", "sessionProjections"];

/**
 * 校验端口值，非法一律当作没给。
 *
 * @param {unknown} value
 * @returns {number | null}
 */
function normalizePort(value) {
  if (typeof value !== "number" || !Number.isInteger(value)) return null;
  if (value < 1 || value > 65535) return null;
  return value;
}

/**
 * 插件装配。
 *
 * @param {object} ctx 宿主插件上下文
 * @param {{ port?: number }} [options] 仅供自动化测试指定监听端口
 * @returns {Promise<void>}
 */
export async function apply(ctx, options = {}) {
  const log = (msg) => {
    // 宿主环境优先走框架日志，缺失时退回 console
    if (ctx !== null && ctx !== undefined && typeof ctx.logger?.info === "function") {
      ctx.logger.info(msg);
      return;
    }
    console.log(msg);
  };

  // 端口默认恒为 19387。测试可以显式传 options.port 让各测试文件各占一个，
  // 否则 Node 测试运行器并发执行时它们会抢同一个端口。
  // 不读配置文件、不做端口探测：宿主调用时不传第二参，行为完全不变。
  const port = normalizePort(options.port) ?? PORT;

  // 路由表自检：声明不一致时立即暴露，不要让错误配置跑到运行时
  const problems = validateRouteTable();
  if (problems.length > 0) {
    for (const p of problems) log(`[${BRIDGE_NAME}] 路由表自检失败：${p}`);
    throw new Error(`${BRIDGE_NAME}: 路由表自检失败，共 ${problems.length} 项`);
  }

  registerSliceOneRoutes();

  // 折叠器与事件管线：先建集合，再建管线（管线依赖集合）
  const startedAt = Date.now();
  const foldSet = createFoldSet();
  const sse = createSseHub();
  const pipeline = createEventPipeline({ foldSet, log, startedAt });

  // 管线每接一条事件就立刻广播，**不等心跳**（PRD F7 实时性）。
  // 心跳只负责重算速度——速度是「时间的函数」，没有新事件时也得动。
  pipeline.subscribe((event, meta) => {
    const payload = { sessionId: meta.sessionId, accepted: meta.accepted, event };
    sse.broadcast(CHANNEL_EVENTS, "session", payload);
    sse.broadcast(CHANNEL_HUD, "session", payload);
  });

  registerSliceTwoRoutes({
    foldSet: () => foldSet,
    pipeline: () => pipeline,
    meta: { version: BRIDGE_VERSION, port },
  });

  const bridge = {
    foldSet,
    sse,
    pipeline,
    version: BRIDGE_VERSION,
    port,
    startedAt,
  };

  const host = createHostAccess(ctx);
  const windows = createWindowManager({ repoRoot: REPO_ROOT, log });
  const approval = createApprovalBridge({ log });
  const hostActions = createHostActions({ host });

  bridge.windows = windows;
  bridge.approval = approval;
  bridge.hostActions = hostActions;

  // 只读与写操作路由都在桥的全部依赖就位之后再注册，
  // 避免出现「路由已注册但依赖还没装上」的中间态
  registerSliceThreeReadRoutes({ bridge });
  registerSliceThreeWriteRoutes();

  const server = createBridgeServer({ host, bridge, log });

  // 订阅宿主事件：必须在服务起来之前挂上，避免漏掉启动窗口期的事件
  const disposers = pipeline.attach(ctx);
  // 审批瀑布监听器与事件订阅同批管理，卸载时一起撤
  disposers.push(...approval.attach(ctx));

  let heartbeat = undefined;

  try {
    await listen(server, { port, host: HOST });
  } catch (err) {
    // PRD F1：端口占用必须明确落日志，不静默
    log(`[${BRIDGE_NAME}] 启动失败：${err.message}（code=${err.code ?? "unknown"}）`);
    // 端口没起来就要把已挂的订阅撤掉，避免留下悬空监听
    for (const off of disposers) {
      try {
        off();
      } catch {
        // 退订失败无需处理
      }
    }
    throw err;
  }

  heartbeat = setInterval(() => {
    heartbeatTick(sse, foldSet);
  }, HEARTBEAT_MS);
  // 心跳不应拖住宿主进程退出
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  log(`[${BRIDGE_NAME}] 已监听 http://${HOST}:${port}/whale（v${BRIDGE_VERSION}）`);
  log(`[${BRIDGE_NAME}] 宿主服务：${describeAvailable(host.available)}`);
  log(`[${BRIDGE_NAME}] 事件订阅：${disposers.length} 路已挂载`);

  // 保存句柄供 dispose 使用
  state.server = server;
  state.host = host;
  state.ctx = ctx;
  state.foldSet = foldSet;
  state.pipeline = pipeline;
  state.sse = sse;
  state.windows = windows;
  state.heartbeat = heartbeat;
  state.disposers = disposers;
}

/**
 * 心跳一次：重算各会话速度并推轻量 tick。
 *
 * 为什么不一并推全量快照：悬浮条每秒都在动，推全量会让带宽随会话数线性增长。
 * tick 只带「会随时间变化的三个数」（速度 / 占用 / 窗口），其余字段客户端本就有。
 *
 * 无客户端连接时**仍然重算但不推**——重算本身很便宜，推才是开销。
 *
 * @param {object} sse 广播表
 * @param {object} foldSet 折叠集
 * @param {number} [now] 注入当前时刻（测试用）
 * @returns {{at: number, sessions: number}}
 */
export function heartbeatTick(sse, foldSet, now = Date.now()) {
  const sessions = [];
  for (const sessionId of foldSet.sessions.keys()) {
    const snap = snapshotOf(foldSet, sessionId, now);
    if (snap === null) continue;
    sessions.push({
      sessionId,
      tokPerSec: snap.speed.tokPerSec,
      contextUsed: snap.contextUsed,
      contextWindow: snap.contextWindow,
      phase: snap.speed.phase,
    });
  }

  const payload = { kind: "tick", at: now, sessions };
  if (sse.countOf(CHANNEL_HUD) > 0) sse.broadcast(CHANNEL_HUD, "tick", payload);
  if (sse.countOf(CHANNEL_EVENTS) > 0) sse.broadcast(CHANNEL_EVENTS, "tick", payload);

  return { at: now, sessions: sessions.length };
}

/**
 * 插件卸载。
 *
 * 顺序：先关服务再清引用。关服务失败不抛出——卸载流程必须能走完，
 * 否则宿主可能卡在卸载中。
 */
export async function dispose() {
  const { server, ctx, disposers, sse, heartbeat, windows } = state;

  // 停心跳：它持有折叠集引用，不停会让对象无法释放
  if (heartbeat !== undefined) {
    clearInterval(heartbeat);
  }

  // 顺序照 PRD F3：**先关自己拉起的小窗**，再关 HTTP 服务，最后退订。
  // 先关小窗的理由：小窗靠桥活着，桥先没了小窗会进入断连态再被留下，
  // 用户看到的就是一个连不上任何东西的孤儿窗口。
  if (windows !== undefined) {
    try {
      const closed = windows.closeAll();
      if (closed.closed > 0) logTo(ctx, `[${BRIDGE_NAME}] 已关闭 ${closed.closed} 个小窗`);
    } catch (err) {
      logTo(ctx, `[${BRIDGE_NAME}] 关闭小窗出错（已忽略）：${err.message}`);
    }
  }

  // 断开全部 SSE 客户端。必须早于 close(server)：
  // 长连接会拖住 server.close()，先让它们收尾能让关闭更快也更确定。
  if (sse !== undefined) {
    try {
      sse.closeAll();
    } catch (err) {
      logTo(ctx, `[${BRIDGE_NAME}] 断开 SSE 客户端出错（已忽略）：${err.message}`);
    }
  }

  // 再退订，避免关闭服务后仍有事件打进来
  for (const off of disposers ?? []) {
    try {
      off();
    } catch (err) {
      logTo(ctx, `[${BRIDGE_NAME}] 退订出错（已忽略）：${err.message}`);
    }
  }

  if (server !== undefined) {
    try {
      await close(server);
      logTo(ctx, `[${BRIDGE_NAME}] 服务已关闭`);
    } catch (err) {
      logTo(ctx, `[${BRIDGE_NAME}] 关闭服务出错（已忽略）：${err.message}`);
    }
  }
  state.server = undefined;
  state.host = undefined;
  state.ctx = undefined;
  state.foldSet = undefined;
  state.pipeline = undefined;
  state.sse = undefined;
  state.windows = undefined;
  state.heartbeat = undefined;
  state.disposers = undefined;
}

/** 插件内部状态。模块级单例——宿主一次只加载一份桥。 */
const state = {
  /** @type {import("node:http").Server | undefined} */
  server: undefined,
  /** @type {object | undefined} */
  host: undefined,
  /** @type {object | undefined} */
  ctx: undefined,
  /** @type {object | undefined} */
  foldSet: undefined,
  /** @type {object | undefined} */
  pipeline: undefined,
  /** @type {object | undefined} */
  sse: undefined,
  /** @type {object | undefined} */
  windows: undefined,
  /** @type {ReturnType<typeof setInterval> | undefined} */
  heartbeat: undefined,
  /** @type {Array<() => void> | undefined} */
  disposers: undefined,
};

/**
 * 把可用服务列表转成一行可读文本。
 * @param {Record<string, boolean>} available
 * @returns {string}
 */
function describeAvailable(available) {
  const on = Object.entries(available)
    .filter(([, v]) => v)
    .map(([k]) => k);
  return on.length === 0 ? "（未检测到任何服务）" : on.join(", ");
}

/**
 * 在 dispose 里安全地写日志。
 * @param {object | undefined} ctx
 * @param {string} msg
 */
function logTo(ctx, msg) {
  if (ctx !== null && ctx !== undefined && typeof ctx.logger?.info === "function") {
    ctx.logger.info(msg);
    return;
  }
  console.log(msg);
}

/** 导出给单测与冒烟测试用。 */
export { PORT, HOST };

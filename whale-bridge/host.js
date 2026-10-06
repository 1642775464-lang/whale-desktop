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
import { close, createBridgeServer, listen, PORT, HOST } from "./lib/server.mjs";
import { validateRouteTable } from "./lib/routes.mjs";
import { createEventPipeline } from "./lib/events.mjs";
import { createFoldSet } from "./lib/fold.mjs";

/** 插件显示名。 */
export const name = "whale-bridge";

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
  const foldSet = createFoldSet();
  const pipeline = createEventPipeline({ foldSet, log, startedAt: Date.now() });

  registerSliceTwoRoutes({
    foldSet: () => foldSet,
    pipeline: () => pipeline,
    meta: { version: BRIDGE_VERSION, port },
  });

  const host = createHostAccess(ctx);
  const server = createBridgeServer({ host, log });

  // 订阅宿主事件：必须在服务起来之前挂上，避免漏掉启动窗口期的事件
  const disposers = pipeline.attach(ctx);

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

  log(`[${BRIDGE_NAME}] 已监听 http://${HOST}:${port}/whale（v${BRIDGE_VERSION}）`);
  log(`[${BRIDGE_NAME}] 宿主服务：${describeAvailable(host.available)}`);
  log(`[${BRIDGE_NAME}] 事件订阅：${disposers.length} 路已挂载`);

  // 保存句柄供 dispose 使用
  state.server = server;
  state.host = host;
  state.ctx = ctx;
  state.foldSet = foldSet;
  state.pipeline = pipeline;
  state.disposers = disposers;
}

/**
 * 插件卸载。
 *
 * 顺序：先关服务再清引用。关服务失败不抛出——卸载流程必须能走完，
 * 否则宿主可能卡在卸载中。
 */
export async function dispose() {
  const { server, ctx, disposers } = state;

  // 先退订，避免关闭服务后仍有事件打进来
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

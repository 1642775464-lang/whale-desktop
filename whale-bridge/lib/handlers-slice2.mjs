/**
 * 切片 2 处理器
 *
 * 职责：实现折叠器状态查询路由，并注册进路由表。
 * 所属层：桥（whale-bridge/lib）
 *
 * 本片只有 1 条路由：`GET /whale/fold`——查询折叠器状态。
 * 它主要给「桥是否真的收到了宿主事件」提供可观测性：
 * 收到多少、接受多少、跳过了什么类型。
 *
 * 处理器是同步函数（无 IO）：数据都在内存里的折叠集上。
 */

import { register } from "./routes.mjs";
import { foldViewOf } from "./fold-view.mjs";

/** 本片声明的路由数（供单测核对）。 */
export const SLICE_TWO_ROUTES = 1;

/**
 * 注册本片全部处理器。
 *
 * 依赖桥的运行时状态（折叠集与管线统计），由 host.js 在 apply 时传入。
 *
 * @param {object} deps
 * @param {() => object} deps.foldSet 取折叠集
 * @param {() => object} deps.pipeline 取事件管线
 */
export function registerSliceTwoRoutes(deps) {
  register("GET", "/whale/fold", (ctx) => foldStatus(ctx, deps));
}

/**
 * GET /whale/fold —— 折叠器状态。
 *
 * 传 sessionId 时返回该会话的折叠视图（含 tail）；
 * 不传时返回全部会话的概览，便于一眼看出有没有在收数据。
 *
 * @param {object} ctx 处理器上下文（含 query）
 * @param {object} deps 运行时依赖
 */
function foldStatus(ctx, deps) {
  const foldSet = deps.foldSet();
  const pipeline = deps.pipeline();

  // 带 sessionId：返回该会话的详细折叠视图
  // 注意 query 是 URLSearchParams，必须用 get() 取值
  const requested = ctx?.query?.get?.("sessionId");
  if (typeof requested === "string" && requested.length > 0) {
    const view = foldViewOf(foldSet, requested);
    if (view === null) {
      const err = new Error(`会话 ${requested} 不在折叠器里`);
      err.code = "session-not-found";
      err.status = 404;
      throw err;
    }
    return { ok: true, pipeline: pipeline.snapshot(), fold: view };
  }

  // 不带 sessionId：返回概览
  const sessionIds = [...foldSet.sessions.keys()];
  return {
    ok: true,
    pipeline: pipeline.snapshot(),
    sessionCount: sessionIds.length,
    sessionIds,
    foldSetUnknownTypes: foldSet.unknownTypes,
    activeSessionId: foldSet.activeSessionId,
  };
}

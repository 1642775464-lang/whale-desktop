/**
 * 宿主事件订阅与分发
 *
 * 职责：订阅宿主 `session/event` 与 `agent/status`，把事件分发给折叠器与广播表。
 * 所属层：桥（whale-bridge/lib）
 *
 * 实时性关键路径（架构草案 §5.3，NFR P-5）：
 *   宿主 append 事件 → 本模块回调（进程内，零延迟）→ 折叠器（纯内存加法）→ 广播
 *   这条链上没有轮询、没有文件 IO、没有跨进程跳转。
 *
 * 一条纪律：**订阅与分发都不许抛错**。宿主在一个事件上抛异常会污染整条
 * 事件管线，影响的就不只是桥了。故本模块把所有回调包在 try 里，
 * 失败只计数并记日志。
 */

import { applyEvent } from "./fold.mjs";

/**
 * 创建事件管线。
 *
 * @param {object} deps 依赖
 * @param {object} deps.foldSet 折叠集（createFoldSet() 的返回值）
 * @param {number} [deps.bridgeVersion] 桥版本号
 * @param {(msg: string) => void} [deps.log] 日志函数
 * @returns {object} 管线对象
 */
export function createEventPipeline(deps) {
  const foldSet = deps.foldSet;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const startedAt = typeof deps.startedAt === "number" ? deps.startedAt : Date.now();

  const listeners = new Set();
  const stats = {
    eventsReceived: 0,
    eventsAccepted: 0,
    eventsSkipped: 0,
    callbackErrors: 0,
    startedAt,
  };

  /**
   * 订阅一份宿主事件回调。
   *
   * @param {(event: object, meta: object) => void} listener 监听器
   * @returns {() => void} 退订函数
   */
  function subscribe(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  /**
   * 处理一条宿主事件。
   *
   * `session/event` 的载荷形如 (session, event)，其中 session 有 id/header，
   * event 有 seq/type/data。
   *
   * @param {object} session 宿主会话对象
   * @param {object} event 事件
   */
  function onSessionEvent(session, event) {
    stats.eventsReceived += 1;
    try {
      const sessionId = sessionIdOf(session, event);
      const result = applyEvent(foldSet, event, { sessionId });
      if (result.accepted) stats.eventsAccepted += 1;
      else stats.eventsSkipped += 1;

      // 首个出现的会话视为活跃（宿主尚未提供显式活跃标记）
      if (foldSet.activeSessionId === null) foldSet.activeSessionId = sessionId;

      // 立即分发，不等心跳（P-5）
      for (const listener of listeners) {
        try {
          listener(event, { sessionId, accepted: result.accepted, reason: result.reason });
        } catch {
          stats.callbackErrors += 1;
        }
      }
    } catch (err) {
      // 绝不把异常抛回宿主的事件管线
      stats.callbackErrors += 1;
      log(`[桥] 事件处理失败：${err?.message ?? err}`);
    }
  }

  /**
   * 处理 agent 状态变化。
   *
   * @param {{ agent?: object, status?: string }} payload
   */
  function onAgentStatus(payload) {
    try {
      const status = payload?.status;
      const sessionId = payload?.agent?.session?.id ?? payload?.agent?.id ?? foldSet.activeSessionId;
      if (sessionId === null || sessionId === undefined) return;
      const fold = foldSet.sessions.get(sessionId);
      if (fold === undefined) return;

      if (status === "running") {
        fold.phase = "running";
        fold.running = true;
        fold.frozen = false;
      } else if (status === "idle") {
        fold.phase = "idle";
        fold.running = false;
        fold.frozen = true;
      }
    } catch (err) {
      stats.callbackErrors += 1;
      log(`[桥] 状态处理失败：${err?.message ?? err}`);
    }
  }

  /** 把管线挂到宿主 ctx 上。返回退订函数数组。 */
  function attach(ctx) {
    const disposers = [];
    if (typeof ctx?.on === "function") {
      try {
        const offEvent = ctx.on("session/event", onSessionEvent);
        if (typeof offEvent === "function") disposers.push(offEvent);
      } catch (err) {
        log(`[桥] 订阅 session/event 失败：${err?.message ?? err}`);
      }
      try {
        const offStatus = ctx.on("agent/status", onAgentStatus);
        if (typeof offStatus === "function") disposers.push(offStatus);
      } catch (err) {
        log(`[桥] 订阅 agent/status 失败：${err?.message ?? err}`);
      }
    } else {
      log("[桥] 宿主 ctx 不支持 on()，事件订阅跳过（降级为空折叠器）");
    }
    return disposers;
  }

  /** 只读统计快照。 */
  function snapshot() {
    return { ...stats, listenerCount: listeners.size };
  }

  return { subscribe, onSessionEvent, onAgentStatus, attach, snapshot };
}

/** 从宿主传入的 session 与 event 里尽力取出会话 id，取不到给占位符。 */
function sessionIdOf(session, event) {
  const fromSession = session?.id ?? session?.header?.id;
  if (typeof fromSession === "string" && fromSession.length > 0) return fromSession;
  const fromEvent = event?.sessionId;
  if (typeof fromEvent === "string" && fromEvent.length > 0) return fromEvent;
  return "unknown-session";
}

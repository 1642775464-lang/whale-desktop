/**
 * 折叠态投影
 *
 * 职责：把折叠器内部状态投影成对外可读的形状（快照 / 视图）。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么与 fold.mjs 分开：折叠器管「怎么把事件折进去」，本模块管
 * 「折完怎么对外呈现」。两者改动原因不同——加一种事件类型动 fold.mjs，
 * 改一个字段口径动本模块。合在一个文件里会让 300 行上限先被撑破。
 *
 * 投影纪律：取不到的字段给 `null`，**不给 0**——界面上「0」与「没有值」
 * 含义不同（降级原则：宁可显示 `–` 不显示错的数）。
 */

import { speedAt } from "./usage-stats.mjs";

/** 小窗折叠器保留的渲染事件条数上限（F3）。 */
export const TAIL_LIMIT = 40;

/**
 * 生成某会话的悬浮条快照。
 *
 * @param {object} foldSet 折叠集
 * @param {string} sessionId 会话 id
 * @param {number} now 当前时刻（epoch ms）
 * @param {(sessionId: string) => (string | null)} [resolveTitle]
 *        标题兜底：折叠器没有标题时向它要（读宿主投影）。
 *        为什么需要：桥只等 `session/title` 事件，而那个事件只在**标题被写入**时产生；
 *        对「会话早有标题、桥后挂上来」的情形永远等不到，
 *        表现就是**悬浮条与小窗都识别不到会话标题**（实测踩过）。
 * @returns {object | null} 会话不在折叠器里时 null
 */
export function snapshotOf(foldSet, sessionId, now, resolveTitle = undefined) {
  const fold = foldSet.sessions.get(sessionId);
  if (fold === undefined) return null;

  // 折叠器有就用折叠器的；没有才问投影——
  // 这样事件路径仍然是最新的，投影只补「桥没收到过标题事件」那一种情况
  let title = fold.title;
  if ((title === null || title === undefined || title === "") && typeof resolveTitle === "function") {
    title = resolveTitle(sessionId) ?? null;
    // 回填到折叠器：下一轮不必再问投影
    if (typeof title === "string" && title !== "") fold.title = title;
  }

  const speed = speedAt(fold.samples, now);
  return {
    sessionId: fold.sessionId,
    title,
    workspace: fold.workspace,
    speed: {
      phase: fold.phase,
      // 非运行中一律报 0：静止时不假装能动
      tokPerSec: fold.running ? speed.tokPerSec : 0,
      frozen: fold.frozen,
    },
    contextUsed: fold.contextUsed,
    contextWindow: fold.contextWindow,
    totalInput: fold.totals.totalInput,
    totalOutput: fold.totals.totalOutput,
    totalCacheRead: fold.totals.totalCacheRead,
    totalCacheWrite: fold.totals.totalCacheWrite,
    steps: fold.steps,
    turns: fold.turns,
    lastUsageAt: fold.lastUsageAt,
  };
}

/**
 * 生成全量快照（`GET /whale/hud` 的载荷）。
 *
 * @param {object} foldSet 折叠集
 * @param {{ version: string, port: number, startedAt: number, now: number,
 *           resolveTitle?: (sessionId: string) => (string | null) }} meta
 * @returns {object}
 */
export function hudSnapshot(foldSet, meta) {
  const sessions = [];
  for (const sessionId of foldSet.sessions.keys()) {
    const snap = snapshotOf(foldSet, sessionId, meta.now, meta.resolveTitle);
    if (snap !== null) sessions.push(snap);
  }
  return {
    bridge: {
      version: meta.version,
      port: meta.port,
      uptimeMs: Math.max(0, meta.now - meta.startedAt),
    },
    sessions,
    activeSessionId: foldSet.activeSessionId,
    unknownTypes: foldSet.unknownTypes,
  };
}

/**
 * 生成小窗用的折叠态视图（含 tail 副本）。
 *
 * tail 返回**副本**：调用方改动它不得影响折叠态。
 *
 * @param {object} foldSet 折叠集
 * @param {string} sessionId 会话 id
 * @returns {object | null}
 */
export function foldViewOf(foldSet, sessionId) {
  const fold = foldSet.sessions.get(sessionId);
  if (fold === undefined) return null;
  return {
    sessionId: fold.sessionId,
    lastSeq: fold.lastSeq,
    tailLimit: TAIL_LIMIT,
    tailCount: fold.tail.length,
    tail: fold.tail.slice(),
    eventsSeen: fold.eventsSeen,
    unknownTypes: fold.unknownTypes,
    phase: fold.phase,
  };
}

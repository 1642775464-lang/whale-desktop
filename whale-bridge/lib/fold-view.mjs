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
  /*
   * 最近活动时间：取两个来源里**较新的那个**。
   *
   * 为什么需要它：小窗首次打开、桥还没给出活跃指针时，`follow.js` 会
   * 「退回清单第一项」当作默认会话。而清单若是按**插入顺序**输出的，
   * 第一项就不是最近一次 —— 用户报的「首次打开进的会话和最近一次不匹配」
   * 正是这个原因（实测插入顺序第一条最后活动 21:44，第二条 01:29）。
   *
   * 为什么是「取较新」而不是「种子优先」：
   *   · `seededUpdatedAt` 来自**宿主持久层**，是冷会话唯一的来源
   *     （冷会话没有事件，lastUsageAt 可能是旧的或没有）；
   *   · `lastUsageAt` 来自 **usage 事件**，活跃会话用它更实时；
   *   · 两者语义不同但都是「这条会话最近有多新」的证据，
   *     哪个更新就更能代表当下。只取其中之一都可能排错。
   *
   * 取不到给 null，不给 0：界面上「0」与「没有值」含义不同（投影纪律），
   * 排序时 null 一律排最后（不是当成最早）。
   */
  const candidates = [fold.seededUpdatedAt, fold.lastUsageAt]
    .filter(function (v) { return typeof v === "number"; });
  const updatedAt = candidates.length === 0 ? null : Math.max.apply(null, candidates);

  return {
    sessionId: fold.sessionId,
    title,
    workspace: fold.workspace,
    updatedAt,
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

  /*
   * 按最近活动**倒序**输出。
   *
   * ⚠️ 不能用 Map 的插入顺序：那取决于哪条会话先被种进折叠器，
   * 与「最近一次」无关。而小窗在拿不到活跃指针时会退回 `list[0]`
   * 当作默认会话 —— 顺序错了，小窗首次打开就会进错会话（用户报的现象）。
   *
   * 排序口径收敛在这里一处：`follow.js` 的「清单第一项＝最近一次」假设
   * 因此成立，界面上的会话列表顺序也随之正确，不必两处各排各的。
   *
   * 没有 updatedAt 的排最后（不是当成 0 —— 那会把「不知道」当成「最早」）。
   */
  sessions.sort(function (l, r) {
    const lt = l.updatedAt;
    const rt = r.updatedAt;
    if (lt === null && rt === null) return 0;
    if (lt === null) return 1;
    if (rt === null) return -1;
    return rt - lt;
  });

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

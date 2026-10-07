/**
 * 冷会话种子
 *
 * 职责：桥刚起来、折叠器还是空的时候，从宿主的**持久层**把
 *       「最近一次会话」连同它的历史消息读进来并折进折叠器。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么需要它（真实事故）：
 * 用户报「权限显示读不到档位清单、思考强度点了没反应」。三个浮层唯一的
 * 共同依赖是 sessionId，而它的来源链在这里断了：
 *
 *   折叠器只由 `session/event` 事件填充
 *     → 宿主重启后那条会话是**空闲的**，不再产生任何事件
 *     → 折叠器为空、`activeSessionId` 恒 null
 *     → 小窗拿不到 sessionId → 权限/切模型/发命令全部 bad-request
 *
 *   而且**轮询救不了**：会话继续空闲就永远没有事件，是永久性空窗。
 *   宿主的 `sessions.list()` 注释写明只含 "All **live** sessions"，
 *   冷会话连清单都不在 —— 必须走 sessionController 的持久层读法。
 *
 * 三条纪律：
 *   1. **复用 applyEvent**，不自己实现第二套折法。
 *      自己折一遍等于维护两份逻辑，宿主加一个事件类型就会出现
 *      「热路径认识、冷路径不认识」这种最难查的不一致。
 *   2. **不抢已有状态**：折叠器已经有会话就说明事件流正在喂它，
 *      此时种子必须让路——否则会把实时会话的活跃指针抢走。
 *   3. **失败一律降级**（返回 null / 空数组），绝不把异常冒到 HTTP 层。
 */

import { applyEvent, ensureSession } from "./fold.mjs";

/** 空窗时的重试冷却（毫秒）。 */
export const EMPTY_RETRY_MS = 60_000;

/**
 * 建一个冷会话种子。
 *
 * @param {object} deps
 * @param {object} deps.host 宿主访问封装（用 recentSessions / sessionEvents）
 * @param {object} deps.foldSet 折叠集
 * @param {(msg: string) => void} [deps.log]
 * @param {() => number} [deps.now] 取当前毫秒（便于单测控时间）
 * @returns {{ seedRecent: () => Promise<string|null>, ensureSeeded: (id: string) => Promise<boolean> }}
 */
export function createColdSeed({ host, foldSet, log = () => {}, now = () => Date.now() }) {
  /** 已经种过的会话 id：持久层读取不便宜，同一会话只读一次。 */
  const seeded = new Set();

  /**
   * 在持久层清单里**查不到**的会话 id → 上次查不到的时刻。
   *
   * 见 ensureSeeded 的限流说明。与 lastEmptyAt 分开记：
   * 前者是「压根没会话」，后者是「这个 id 不存在」，
   * 两者的重试节奏互不牵制。
   */
  const missed = new Map();

  /**
   * 上一次「读到空」的时刻。
   *
   * 种子自己引入的新风险：折叠器为空是**稳定状态**（没会话），
   * 而小窗每 5 秒问一次 hud —— 不限流就是每 5 秒读一次宿主持久层，
   * 常驻空窗会变成持续的后台负载。
   * 读失败同理（宿主那条路坏了也不该被每 5 秒敲一次）。
   */
  let lastEmptyAt = null;

  /**
   * 把一批事件折进某会话。
   *
   * **原样交给 applyEvent**（见文件头纪律 1）。
   *
   * @param {string} sessionId
   * @param {Array<object>} events
   */
  function foldEvents(sessionId, events) {
    for (const event of events) {
      const accepted = applyEvent(foldSet, event, { sessionId });
      if (accepted.accepted === false && accepted.reason !== "unknown-type" && accepted.reason !== "duplicate-seq") {
        log(`[桥] 种子事件被拒：${accepted.reason}`);
      }
    }
  }

  /**
   * 种上「最近一次会话」。
   *
   * 顺序以宿主给的为准（它按 updatedAt 降序排过，第一项就是最近的）。
   *
   * @returns {Promise<string|null>} 种上的会话 id；没有/不必要时给 null
   */
  async function seedRecent() {
    // 已经有会话就说明事件流正在喂折叠器，种子必须让路（纪律 2）
    if (foldSet.sessions.size > 0) return null;

    // 空窗限流：见 lastEmptyAt 注释
    if (lastEmptyAt !== null && now() - lastEmptyAt < EMPTY_RETRY_MS) return null;

    let list;
    try {
      list = await host.recentSessions();
    } catch (err) {
      lastEmptyAt = now();
      log(`[桥] 读会话清单失败：${err?.message ?? err}`);
      return null;
    }
    if (!Array.isArray(list) || list.length === 0) {
      lastEmptyAt = now();
      return null;
    }

    const recent = list[0];
    const sessionId = recent?.sessionId;
    if (typeof sessionId !== "string" || sessionId === "") {
      lastEmptyAt = now();
      return null;
    }

    if (!(await seedOne(sessionId, recent))) return null;
    // 种上了就清掉冷却标记：下次折叠器若被清空（dispose 之类）还能立刻重试
    lastEmptyAt = null;

    // 活跃指针挪过去：小窗是靠 /whale/hud 的 activeSessionId 拿 sessionId 的，
    // 只把会话塞进折叠器而不设指针，小窗还是拿不到（症状一模一样）。
    // 只在没有指针时才设——不抢已有会话的位置。
    if (foldSet.activeSessionId === null || foldSet.activeSessionId === undefined) {
      foldSet.activeSessionId = sessionId;
    }
    log(`[桥] 已从持久层种上会话 ${sessionId}`);
    return sessionId;
  }

  /**
   * 种上**点名**的某条会话（小窗直接问一条冷会话的面板时用）。
   *
   * @param {string} sessionId
   * @param {object} [row] 清单行（带 title / running，能省一次读）
   * @returns {Promise<boolean>}
   */
  async function seedOne(sessionId, row = undefined) {
    // 先占位建 fold，让并发的第二次请求看到 size>0 就让路
    const fold = ensureSession(foldSet, sessionId);
    // 标题：冷会话不会有 title 事件，只能从清单的投影里带
    if (typeof row?.title === "string" && row.title !== "" && (fold.title === null || fold.title === undefined)) {
      fold.title = row.title;
    }
    if (typeof row?.cwd === "string" && row.cwd !== "" && fold.workspace === null) {
      fold.workspace = row.cwd;
    }

    let events;
    try {
      events = await host.sessionEvents(sessionId);
    } catch (err) {
      log(`[桥] 读会话历史失败：${err?.message ?? err}`);
      events = [];
    }
    if (Array.isArray(events) && events.length > 0) foldEvents(sessionId, events);

    /**
     * ⚠️ 折完必须把「回合运行中」归位。
     *
     * 上次宿主进程可能在回合中途被杀掉，落盘日志的最后一条就是 turn/start，
     * 照原样折会把 running 置真 → 小窗显示「回合运行中」、中断键点亮，
     * 而实际**根本没有活的 agent 在跑**。
     * 宿主的 `running` 字段才是事实，冷会话的 agentAvailable 恒为 false。
     */
    if (row?.running !== true) {
      fold.running = false;
      fold.frozen = true;
      fold.phase = "idle";
    }

    seeded.add(sessionId);
    return true;
  }

  /**
   * 确保某会话已经在折叠器里（不在就从持久层种上）。
   *
   * ⚠️ **必须先确认宿主持久层认识这个 id。**
   * 不加这道校验时，任意乱写的 id 也会被建出一个 fold 并返回 true，
   * 后果是 `/whale/panel` 对不存在的会话**静默返回空面板而不是 404**——
   * 把「会话不存在」与「会话是空的」混成一件，而这两件必须区分。
   *
   * ⚠️ 查不到的 id 要进冷却：小窗会重试同一个 sessionId
   * （比如它手里握着一条已被归档的会话），不限流就是每问一次读一遍清单。
   *
   * @param {string} sessionId
   * @returns {Promise<boolean>} 宿主不认识该会话时 false
   */
  async function ensureSeeded(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    // 事件流或前一次种子已经填上了
    if (foldSet.sessions.has(sessionId)) return true;
    if (seeded.has(sessionId)) return false;
    // 该 id 正在冷却中，不重复读持久层
    const missAt = missed.get(sessionId);
    if (missAt !== undefined && now() - missAt < EMPTY_RETRY_MS) return false;

    let row;
    try {
      const list = await host.recentSessions();
      row = Array.isArray(list) ? list.filter((s) => s.sessionId === sessionId)[0] : undefined;
    } catch {
      row = undefined;
    }
    if (row === undefined) {
      missed.set(sessionId, now());
      return false;
    }
    missed.delete(sessionId);
    return seedOne(sessionId, row);
  }

  return { ensureSeeded, seedRecent };
}

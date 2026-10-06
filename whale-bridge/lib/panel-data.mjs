/**
 * 面板数据投影
 *
 * 职责：把折叠态投影成小窗面板所需的载荷（消息流 + 任务清单 + 档位）。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么单独成模块：`/whale/panel` 与 `/whale/fold` 是**两个不同用途**的读数。
 * fold 给小窗做增量渲染（带水位、tail 上限、事件计数），panel 给面板做整体展示
 * （消息列表、任务清单）。它们的字段口径会各自演化，合在一起会让
 * 「改 panel 的字段」不小心动到 fold 的增量水位语义。
 *
 * 投影纪律：取不到的字段给 `null`，**不给 0、不编造**
 * （降级原则：宁可显示 `–` 不显示错的数）。
 */

import { TAIL_LIMIT } from "./fold-view.mjs";

/** 渲染事件种类 → 对外的面板条目类型。 */
const MESSAGE_KINDS = new Set(["user", "assistant"]);

/**
 * 生成面板载荷。
 *
 * @param {object} deps
 * @param {object} deps.foldSet 折叠集
 * @param {string} deps.sessionId 会话 id
 * @param {object} [deps.agent] 宿主 agent（用于报告运行态）
 * @param {object | null} [deps.gates] 档位信息，由调用方从宿主读取
 * @returns {object | null} 会话不在折叠器里时 null
 */
export function panelPayload({ foldSet, sessionId, agent = undefined, gates = null }) {
  const fold = foldSet.sessions.get(sessionId);
  if (fold === undefined) return null;

  return {
    sessionId,
    title: fold.title,
    workspace: fold.workspace,
    messages: messagesOf(fold),
    todos: todosOf(fold),
    // 档位取不到就给 null，不编造（小窗会渲染成 `–`）
    permission: gates?.permission ?? null,
    model: gates?.model ?? null,
    agentRunning: agent?.status === "running",
    phase: fold.phase,
  };
}

/**
 * 从 tail 里挑出消息与工具调用，投影成面板条目。
 *
 * 为什么用 tail 而不是全量历史：小窗面板显示的是「最近发生了什么」，
 * 40 条 tail 就是为它准备的。全量历史另有 `/whale/resume` 通路。
 *
 * 每条带上 `seq`，客户端可据此去重与排序，不必依赖到达顺序。
 *
 * @param {object} fold
 * @returns {Array<object>}
 */
export function messagesOf(fold) {
  const out = [];
  for (const item of fold.tail) {
    if (item === null || typeof item !== "object") continue;

    if (MESSAGE_KINDS.has(item.kind)) {
      const text = typeof item.text === "string" ? item.text : "";
      // 空文本的消息没有展示价值（多是纯工具调用的占位）
      if (text === "") continue;
      out.push({ kind: item.kind, text, seq: item.seq });
      continue;
    }

    if (item.kind === "tool") {
      out.push({
        kind: "tool",
        name: typeof item.name === "string" ? item.name : null,
        state: typeof item.state === "string" ? item.state : "done",
        seq: item.seq,
      });
    }
  }
  return out;
}

/**
 * 取最近一次任务清单。
 *
 * todo/write 是**整体覆盖**语义（宿主每次写都发全量），所以取最后一条就够，
 * 不需要把历史 todo 累加起来——累加反而会得到一份错误的合并清单。
 *
 * @param {object} fold
 * @returns {Array<{content: string, status: string}>}
 */
export function todosOf(fold) {
  for (let i = fold.tail.length - 1; i >= 0; i -= 1) {
    const item = fold.tail[i];
    if (item !== null && typeof item === "object" && item.kind === "todo") {
      const todos = Array.isArray(item.todos) ? item.todos : [];
      return todos.map((t) => ({
        content: typeof t?.content === "string" ? t.content : "",
        status: typeof t?.status === "string" ? t.status : "pending",
      }));
    }
  }
  return [];
}

/** 本模块的面板裁剪上限，与 tail 上限一致（便于调用方核对）。 */
export const PANEL_TAIL_LIMIT = TAIL_LIMIT;

/**
 * 双折叠器
 *
 * 职责：把宿主事件流折成两套状态——全量聚合（悬浮条用）与最近 40 条（小窗用）。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么是两个而不是一个（架构草案 §4.2）：
 *   悬浮条要**累计数字**（四桶、步数、回合数），不能设 tail，设了就丢历史；
 *   小窗要**最近消息流**，不能全量存，存了会随会话无限增长。
 *   两者用途不同、保留策略相反，合并成一个会互相牵制。
 *
 * 三条必须守住的纪律：
 *   1. 按 seq 去重——宿主可能重放事件（Last-Event-ID 续传），重复计会翻倍。
 *   2. 未知事件类型**跳过并计数**，不抛错——落盘有约 60 种已注册类型，
 *      将来还会加新的；折叠器不认识某类型是正常情况，不是错误。
 *   3. 纯函数 + 显式时间——不读时钟、不读文件，时间由调用方传入，便于单测。
 */

import { emptyTotals, addUsage, pressureFrom, pushSample } from "./usage-stats.mjs";

/** 小窗折叠器保留的渲染事件条数上限（F3）。 */
export const TAIL_LIMIT = 40;

/**
 * 新建一个会话的折叠态。
 *
 * @param {string} sessionId 会话 id
 * @returns {object} 折叠态
 */
export function createSessionFold(sessionId) {
  return {
    sessionId,
    lastSeq: -1,
    totals: emptyTotals(),
    contextUsed: null,
    contextWindow: null,
    steps: 0,
    turns: 0,
    lastUsageAt: null,
    samples: [],
    phase: "unknown",
    frozen: false,
    running: false,
    title: null,
    workspace: null,
    tail: [],
    unknownTypes: 0,
    eventsSeen: 0,
  };
}

/** 新建折叠器集合。 */
export function createFoldSet() {
  return {
    sessions: new Map(),
    activeSessionId: null,
    unknownTypes: 0,
  };
}

/**
 * 取（必要时新建）某会话的折叠态。
 *
 * @param {object} foldSet createFoldSet() 的返回值
 * @param {string} sessionId 会话 id
 * @returns {object} 折叠态（引用，可直接改）
 */
export function ensureSession(foldSet, sessionId) {
  let fold = foldSet.sessions.get(sessionId);
  if (fold === undefined) {
    fold = createSessionFold(sessionId);
    foldSet.sessions.set(sessionId, fold);
  }
  return fold;
}

/**
 * 把一个事件折进折叠集。
 *
 * @param {object} foldSet 折叠集
 * @param {object} event 事件 {seq, time, type, data}
 * @param {{ now?: number, sessionId?: string }} [options] 上下文；sessionId 可从事件取
 * @returns {{ accepted: boolean, reason?: string }} 是否被接受
 */
export function applyEvent(foldSet, event, options = {}) {
  if (event === null || typeof event !== "object") return { accepted: false, reason: "invalid-event" };
  const sessionId = options.sessionId ?? event.sessionId ?? foldSet.activeSessionId ?? "unknown";
  const fold = ensureSession(foldSet, sessionId);

  // 按 seq 去重：宿主可能重放
  const seq = typeof event.seq === "number" ? event.seq : null;
  if (seq !== null && seq <= fold.lastSeq) return { accepted: false, reason: "duplicate-seq" };
  if (seq !== null) fold.lastSeq = seq;

  fold.eventsSeen += 1;
  const now = typeof options.now === "number" ? options.now : (typeof event.time === "number" ? event.time : 0);
  const data = event.data ?? {};

  switch (event.type) {
    case "session":
      fold.title = typeof data.title === "string" ? data.title : fold.title;
      fold.workspace = typeof data.cwd === "string" ? data.cwd : fold.workspace;
      return { accepted: true };

    case "session/title":
      if (typeof data.title === "string") fold.title = data.title;
      return { accepted: true };

    case "request/context":
      if (typeof data.contextWindow === "number") fold.contextWindow = data.contextWindow;
      return { accepted: true };

    case "assistant/message": {
      const usage = data.usage;
      fold.totals = addUsage(fold.totals, usage);
      const pressure = pressureFrom(usage);
      if (pressure !== null) {
        fold.contextUsed = pressure;
        fold.lastUsageAt = now;
        const outputTokens = typeof usage?.outputTokens === "number" ? usage.outputTokens : 0;
        const pushed = pushSample(fold.samples, { at: now, outputTokens }, now);
        fold.samples = pushed.samples;
      }
      const text = textOfMessage(data.message);
      if (text.length > 0) pushTail(fold, { kind: "assistant", text, seq: seq ?? -1 });
      return { accepted: true };
    }

    case "user/message": {
      const text = textOfMessage(data);
      if (text.length > 0) pushTail(fold, { kind: "user", text, seq: seq ?? -1 });
      return { accepted: true };
    }

    case "tool/call":
      pushTail(fold, {
        kind: "tool",
        name: typeof data.name === "string" ? data.name : "?",
        state: "running",
        seq: seq ?? -1,
      });
      return { accepted: true };

    case "tool/result": {
      // 把最近一条同名 running 的工具改成 done
      for (let i = fold.tail.length - 1; i >= 0; i -= 1) {
        if (fold.tail[i].kind === "tool" && fold.tail[i].state === "running") {
          fold.tail[i] = { ...fold.tail[i], state: data.isError === true ? "error" : "done" };
          break;
        }
      }
      return { accepted: true };
    }

    case "step/start":
    case "step/end":
      fold.steps += 1;
      return { accepted: true };

    case "turn/start":
      fold.turns += 1;
      fold.phase = "running";
      fold.running = true;
      fold.frozen = false;
      fold.samples = [];
      return { accepted: true };

    case "turn/end":
      fold.phase = "idle";
      fold.running = false;
      fold.frozen = true;
      return { accepted: true };

    case "todo/write":
      if (Array.isArray(data.todos)) pushTail(fold, { kind: "todo", todos: data.todos, seq: seq ?? -1 });
      return { accepted: true };

    default:
      // 未知类型：跳过并计数，绝不抛错（否则一个新事件类型就能打断整条链路）
      fold.unknownTypes += 1;
      foldSet.unknownTypes += 1;
      return { accepted: false, reason: "unknown-type" };
  }
}

/**
 * 批量折入事件。
 *
 * @param {object} foldSet 折叠集
 * @param {Array<object>} events 事件数组
 * @param {{ now?: number }} [options]
 * @returns {{ accepted: number, skipped: number }}
 */
export function applyEvents(foldSet, events, options = {}) {
  let accepted = 0;
  let skipped = 0;
  for (const event of Array.isArray(events) ? events : []) {
    if (applyEvent(foldSet, event, options).accepted) accepted += 1;
    else skipped += 1;
  }
  return { accepted, skipped };
}

/**
 * 追加一条渲染事件，超出上限时从头截断。
 *
 * 截断而不是停写：小窗要的是「最近发生的事」，旧消息滚出去是设计如此。
 *
 * @param {object} fold 会话折叠态
 * @param {object} item 渲染事件
 */
function pushTail(fold, item) {
  fold.tail.push(item);
  if (fold.tail.length > TAIL_LIMIT) fold.tail.splice(0, fold.tail.length - TAIL_LIMIT);
}

/**
 * 从消息里取出纯文本。
 *
 * 只认 `type === "text"` 的块：`tool-call` 块的 arguments 是一坨 JSON，
 * 混进小窗消息流会把界面冲垮。取不到就返回空串，调用方据此决定不推送。
 *
 * @param {object} message 消息对象（`{ content: [...] }`）
 * @returns {string}
 */
function textOfMessage(message) {
  if (message === null || typeof message !== "object") return "";
  const blocks = Array.isArray(message.content) ? message.content : [];
  let out = "";
  for (const block of blocks) {
    if (block !== null && typeof block === "object" && block.type === "text" && typeof block.text === "string") {
      out += block.text;
    }
  }
  return out;
}

/**
 * SSE 事件环形缓冲
 *
 * 职责：保存最近若干条已推送事件，支持按 Last-Event-ID 取「之后的事件」。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么要有上限：SSE 断线重连靠 Last-Event-ID 补事件，所以必须留一段历史。
 * 但如果留全量历史，一个跑几天的会话就能把桥的内存吃光。故用**有界环形缓冲**：
 * 只留最近 `capacity` 条，超出丢最旧的。
 *
 * 丢最旧的代价是「断线太久就补不全」。这是**有意接受的降级**：
 * 补不全比内存无限增长好，且客户端补不到时会走全量快照兜底（`GET /whale/hud`）。
 *
 * 纯数据结构：不碰网络、不读时钟、不读文件，故可脱离宿主与网络单测。
 */

/** 默认容量。500 条事件足够覆盖「离开一会儿再回来」的场景。 */
export const DEFAULT_CAPACITY = 500;

/**
 * 新建一个环形缓冲。
 *
 * @param {number} [capacity] 容量上限，必须为正整数
 * @returns {object} 缓冲对象
 */
export function createRingBuffer(capacity = DEFAULT_CAPACITY) {
  const size = Number.isInteger(capacity) && capacity > 0 ? capacity : DEFAULT_CAPACITY;
  return {
    capacity: size,
    /** @type {Array<{id: number, channel: string, event: string, data: string}>} */
    items: [],
    /** 已丢弃的最旧 id 的下界（用于判断 id 是否已过旧） */
    droppedUpTo: 0,
  };
}

/**
 * 压入一条事件。
 *
 * id 由调用方给（通常用递增序号），必须是整数。
 *
 * @param {object} buffer createRingBuffer() 的返回值
 * @param {{id: number, channel: string, event: string, data: string}} item
 * @returns {void}
 */
export function push(buffer, item) {
  buffer.items.push(item);
  while (buffer.items.length > buffer.capacity) {
    const dropped = buffer.items.shift();
    // 记下被丢弃的最大 id，供丢失判定使用
    if (dropped !== undefined && dropped.id > buffer.droppedUpTo) {
      buffer.droppedUpTo = dropped.id;
    }
  }
}

/**
 * 取某条 id **之后**的事件。
 *
 * 三种情形：
 *   - `sinceId` 命中缓冲 → 返回它之后的全部事件；
 *   - `sinceId` 已被丢弃（过旧）→ 返回 `missed: true`，把现有全部给它，
 *     让客户端知道「中间有洞，建议拉全量快照」；
 *   - `sinceId` 超前或不存在（客户端数据比桥还新）→ 返回空数组且 `missed: false`，
 *     **不报错**：客户端状态与桥不同步是正常的，不是错误。
 *
 * @param {object} buffer createRingBuffer() 的返回值
 * @param {number | null} sinceId
 * @returns {{items: Array<object>, missed: boolean}}
 */
export function since(buffer, sinceId) {
  if (sinceId === null || sinceId === undefined || !Number.isInteger(sinceId)) {
    // 没带 Last-Event-ID：全新连接，不回补历史（历史走全量快照）
    return { items: [], missed: false };
  }

  if (sinceId < buffer.droppedUpTo) {
    // 要的 id 已经不在缓冲里了——中间有洞
    return { items: buffer.items.slice(), missed: true };
  }

  const items = buffer.items.filter((item) => item.id > sinceId);
  return { items, missed: false };
}

/** 当前存了几条。 */
export function sizeOf(buffer) {
  return buffer.items.length;
}

/** 最新一条的 id；空缓冲返回 null。 */
export function latestId(buffer) {
  if (buffer.items.length === 0) return null;
  return buffer.items[buffer.items.length - 1].id;
}

/**
 * 把一条事件渲染成 SSE 线格式。
 *
 * 字段顺序固定为 `id` → `event` → `data`，末尾一个空行（SSE 要求）。
 * 多行 data 按 SSE 规范逐行加 `data: ` 前缀。
 *
 * @param {{id: number, event: string, data: string}} item
 * @returns {string}
 */
export function formatSseFrame(item) {
  const lines = [`id: ${item.id}`, `event: ${item.event}`];
  for (const line of String(item.data).split("\n")) {
    lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}

/**
 * SSE 广播表
 *
 * 职责：管理两个 SSE 端点的在线客户端，把事件按频道推给所有人，
 *       并维护「可回补的历史」（委托 sse-buffer）。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么单独成模块：SSE 的「连接生命周期」与「事件生产」是两件不同的事。
 * 前者要处理客户端上下线、断线续传、心跳；后者只关心「有条事件要发」。
 * 混在一起会让两者互相牵制——比如心跳要遍历客户端，而事件生产要读折叠器。
 *
 * 本模块**不做网络 IO**：它拿到的是已经写好的 res 对象，
 * 真正的 HTTP 细节由调用方（server.mjs 的自管响应通路）处理。
 * 这样它就能在测试里被完整驱动，不需要真的开端口。
 */

import { DEFAULT_CAPACITY, createRingBuffer, formatSseFrame, push, since } from "./sse-buffer.mjs";

/** 频道名。两个 SSE 端点各一个。 */
export const CHANNEL_EVENTS = "events";
export const CHANNEL_HUD = "hud";

/**
 * 建立广播表。
 *
 * @param {{capacity?: number, now?: () => number}} [options]
 * @returns {object} 广播表
 */
export function createSseHub(options = {}) {
  const now = options.now ?? (() => Date.now());
  const buffers = new Map([
    [CHANNEL_EVENTS, createRingBuffer(options.capacity ?? DEFAULT_CAPACITY)],
    [CHANNEL_HUD, createRingBuffer(options.capacity ?? DEFAULT_CAPACITY)],
  ]);

  /** @type {Map<number, {channel: string, res: object, connectedAt: number}>} */
  const clients = new Map();
  let nextClientId = 1;
  let nextEventId = 1;

  const stats = { connected: 0, totalConnected: 0, pushed: 0, dropped: 0, writeErrors: 0 };

  /**
   * 把一个客户端接入某频道。
   *
   * @param {string} channel 频道名
   * @param {object} res 原始 http 响应对象
   * @param {{lastEventId?: number | null}} [init]
   * @returns {{clientId: number, missed: boolean, replayed: number}}
   */
  function connect(channel, res, init = {}) {
    const buffer = buffers.get(channel);
    if (buffer === undefined) throw new Error(`未知频道：${channel}`);

    const clientId = nextClientId;
    nextClientId += 1;

    // 先写响应头，再回补历史——顺序不能反，否则回补的内容会被当成响应体开头丢掉。
    // 但连接可能在 writeHead 时就已经死了（客户端刚好断开），此时**不能抛**：
    // 一次接入失败不该让 HTTP 层的请求处理崩掉，登记后由广播时的写失败把它摘掉。
    let alive = writeHead(res);

    const replay = since(buffer, init.lastEventId ?? null);
    if (replay.missed) stats.dropped += 1;
    if (alive) {
      for (const item of replay.items) {
        if (!writeTo(res, formatSseFrame(item))) {
          alive = false;
          stats.writeErrors += 1;
          break;
        }
      }
    }

    if (!alive) {
      // 连头都写不进去，说明连接从一开始就是死的，不必登记
      return { clientId: 0, missed: replay.missed, replayed: 0, connected: false };
    }

    clients.set(clientId, { channel, res, connectedAt: now() });
    stats.connected += 1;
    stats.totalConnected += 1;

    return { clientId, missed: replay.missed, replayed: replay.items.length, connected: true };
  }

  /** 断开一个客户端。**幂等**：重复断不会出错。 */
  function disconnect(clientId) {
    if (clients.delete(clientId)) stats.connected -= 1;
  }

  /**
   * 向某频道推一条事件。
   *
   * 事件 id 自增，先入缓冲（供回补）再发给所有在线客户端。
   * 单个客户端写失败**不影响其他人**，只计数——一个坏连接不能拖垮广播。
   *
   * @param {string} channel
   * @param {string} event 事件名
   * @param {unknown} payload 会被 JSON 序列化
   * @returns {{id: number, delivered: number}}
   */
  function broadcast(channel, event, payload) {
    const buffer = buffers.get(channel);
    if (buffer === undefined) throw new Error(`未知频道：${channel}`);

    const id = nextEventId;
    nextEventId += 1;

    const item = { id, channel, event, data: safeStringify(payload) };
    push(buffer, item);
    stats.pushed += 1;

    const frame = formatSseFrame(item);
    let delivered = 0;
    for (const [clientId, client] of clients) {
      if (client.channel !== channel) continue;
      if (writeTo(client.res, frame)) {
        delivered += 1;
      } else {
        // 写失败说明连接已死，就地清理，避免僵尸客户端越积越多
        stats.writeErrors += 1;
        disconnect(clientId);
      }
    }
    return { id, delivered };
  }

  /** 当前某频道的在线数。 */
  function countOf(channel) {
    let count = 0;
    for (const client of clients.values()) {
      if (client.channel === channel) count += 1;
    }
    return count;
  }

  /** 主动断开全部客户端（卸载时用）。 */
  function closeAll() {
    for (const [clientId, client] of clients) {
      try {
        client.res.end();
      } catch {
        // 已断的连接再 end 会抛，忽略——卸载路径不能因为清理失败而中断
      }
      clients.delete(clientId);
    }
    stats.connected = 0;
  }

  return {
    connect,
    disconnect,
    broadcast,
    countOf,
    closeAll,
    stats,
    latestIdOf: (channel) => {
      const buffer = buffers.get(channel);
      return buffer === undefined || buffer.items.length === 0
        ? null
        : buffer.items[buffer.items.length - 1].id;
    },
    bufferSizeOf: (channel) => buffers.get(channel)?.items.length ?? 0,
  };
}

/**
 * 写 SSE 响应头。成功返回 true，失败返回 false（连接已死，不抛）。
 *
 * `x-accel-buffering: no` 是给中间反代看的：不写它，某些代理会把流攒起来再发，
 * 实时性就没了。桥只在回环上跑，一般没有反代，但写上不亏。
 */
export function writeHead(res) {
  try {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    // 立刻写一个注释行，让客户端尽早确认连接已建立
    res.write(": connected\n\n");
    return true;
  } catch {
    return false;
  }
}

/** 往响应里写一段文本。失败返回 false，不抛。 */
function writeTo(res, text) {
  try {
    res.write(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * 安全序列化。
 *
 * 事件载荷理论上都来自桥自己构造的普通对象，但折叠器里的值可能来自宿主事件，
 * 万一有循环引用，JSON.stringify 会抛——那会打断整条广播链。
 * 这里退回一个可读的错误载荷，而不是让广播挂掉。
 */
function safeStringify(payload) {
  try {
    return JSON.stringify(payload ?? null);
  } catch {
    return JSON.stringify({ error: "unserializable" });
  }
}

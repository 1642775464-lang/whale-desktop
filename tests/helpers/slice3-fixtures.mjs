/**
 * 切片 3 冒烟测试夹具
 *
 * 职责：提供假宿主 ctx、SSE 连接读取器、HTTP 小工具与事件构造器。
 * 所属层：测试（tests/helpers）
 *
 * 为什么单独成文件：主冒烟测试文件已经逼近 500 行上限，而夹具与用例
 * 的修改原因完全不同——夹具随被测接口变化，用例随验收标准变化。
 * 挤在一个文件里会让「改接口」和「加用例」互相推高行数。
 */

import { request as httpRequest } from "node:http";

/**
 * 假宿主 ctx（与 smoke-slice2 同形，另加 agent 注入与审批瀑布模拟，
 * 以便写操作路由与审批接管都能被真实驱动）。
 *
 * @param {{port: number, liveSessionId?: string}} config
 * @returns {object}
 */
export function createFakeCtx({ liveSessionId = "s-live" } = {}) {
  const listeners = new Map();
  const agents = new Map();

  return {
    sessions: { list: () => [], get: (id) => (id === liveSessionId ? { id } : undefined) },
    agents: { get: (id) => agents.get(id) },
    commands: { list: () => [] },
    logger: { info: () => {} },

    /** 测试用：塞一个 agent 进去 */
    __setAgent(id, agent) {
      agents.set(id, agent);
    },

    /**
     * 测试用：模拟宿主发起一次审批瀑布。
     *
     * 宿主的真实调用是 `ctx.waterfall(agent, "approval/request", req, fallback)`。
     * 这里用 `on()` 注册的监听器手工复现同样语义：链上每个监听器拿到
     * `(request, next)`，返回非 `unavailable` 即为最终答案。
     *
     * @param {object} request
     * @param {() => Promise<string>} fallback 瀑布兜底（宿主给的是返回 unavailable）
     * @returns {Promise<string>}
     */
    async __callApproval(request, fallback) {
      const chain = [...(listeners.get("approval/request") ?? [])];
      const run = async (index) => {
        if (index >= chain.length) return fallback();
        return chain[index](request, () => run(index + 1));
      };
      return run(0);
    },

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
    listenerCount: (event) => (listeners.get(event) ?? new Set()).size,
  };
}

/**
 * 造一条带用量的 assistant/message 事件。
 *
 * @param {number} seq
 * @param {number} inputTokens
 * @param {number} cacheReadTokens
 * @param {number} [outputTokens]
 */
export function assistantEvent(seq, inputTokens, cacheReadTokens, outputTokens = 10) {
  return {
    seq,
    time: 1000 + seq,
    type: "assistant/message",
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [{ type: "text", text: `第 ${seq} 条` }] },
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens },
    },
  };
}

/** 造一个会话对象（宿主 `session/event` 的第一个参数）。 */
export function sessionRef(id) {
  return { id, header: { id } };
}

/**
 * 造一对 HTTP 小工具，绑定到指定端口。
 *
 * @param {number} port
 * @returns {{getJson: Function, postJson: Function, rawGet: Function}}
 */
export function createHttpTools(port) {
  const base = `http://127.0.0.1:${port}`;

  /** 发 GET 并解析 JSON。 */
  async function getJson(path) {
    const res = await fetch(`${base}${path}`);
    return { status: res.status, json: await res.json() };
  }

  /** 发 POST JSON 并解析响应。 */
  async function postJson(path, body) {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  /**
   * 用 node:http 直发一个 GET。
   *
   * 为什么不用 fetch：`Host` 属于受控请求头，undici 会忽略调用方给的值。
   * 要测「伪造 Host 被拒」就只能绕开 fetch，自己拼请求。
   *
   * @param {string} path
   * @param {Record<string, string>} headers
   */
  function rawGet(path, headers) {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (c) => {
          raw += c;
        });
        res.on("end", () => {
          let json;
          try {
            json = JSON.parse(raw);
          } catch {
            json = { raw };
          }
          resolve({ status: res.statusCode, json });
        });
      });
      req.on("error", reject);
      req.end();
    });
  }

  return { getJson, postJson, rawGet };
}

/**
 * 打开一个 SSE 连接，返回读取器。
 *
 * 用原生 fetch 的流式响应读，不引入第三方库。
 *
 * @param {number} port
 * @param {string} path
 * @param {{headers?: Record<string,string>, timeoutMs?: number}} [options]
 * @returns {Promise<{res: object, readFrame: (ms?: number) => Promise<string|null>, close: () => Promise<void>}>}
 */
export async function openSse(port, path, options = {}) {
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    headers: options.headers,
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  /** 读到至少一个「完整帧」（以空行结尾）或超时。 */
  async function readFrame(timeoutMs = 1000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = buffer.indexOf("\n\n");
      if (idx >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        return frame;
      }
      const remaining = deadline - Date.now();
      const chunk = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), remaining)),
      ]);
      if (chunk.timeout === true) break;
      if (chunk.done === true) break;
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    return null;
  }

  return {
    res,
    readFrame,
    async close() {
      controller.abort();
      try {
        await reader.cancel();
      } catch {
        // 已经关了
      }
    },
  };
}

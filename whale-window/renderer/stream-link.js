/**
 * 小窗的事件流连接（SSE）
 *
 * 职责：连桥的事件流、把**具名事件**分派给回调、管重连退避。
 * 所属层：呈现层（whale-window/renderer）
 *
 * ## 为什么单独成模块
 *
 * 1. 它是**协议细节**（EventSource + 具名事件 + 退避），与「状态怎么折、
 *    面板怎么拉」不是同一职责；
 * 2. `bridge-client.js` 已到 500 行上限（开发规范 强制 14），
 *    按业务域把这块拆出来。
 *
 * ## ⚠️ 这里踩过一个坑：具名事件不能用 onmessage
 *
 * 桥推的是**具名事件**（`event: touch` / `event: tick`），而
 * `EventSource.onmessage` **只接默认的 `message` 类型** —— 具名事件根本
 * 不会触发它。原先 `bridge-client.js` 就是写 `stream.onmessage = ...`，
 * 结果那个处理函数**从来没被调用过**，消息只能靠 5 秒轮询更新
 * （用户报「小窗重启后最新消息没有同步」，实际是要等好几秒）。
 *
 * 所以这里一律用 `addEventListener(<具名>)`，`onmessage` 只作兼容兜底。
 */

"use strict";

(function attachStreamLink(global) {
  "use strict";

  /** 重连退避上限。 */
  const RECONNECT_MAX_MS = 15000;

  /**
   * 建一条事件流连接。
   *
   * @param {object} deps
   * @param {string} deps.url 事件流地址
   * @param {() => object} deps.eventSourceCtor `EventSource` 构造器（注入便于测试）
   * @param {(payload: object) => void} deps.onTouch 某会话有新事件（`touch`）
   * @param {(payload: object) => void} deps.onTick 状态心跳（`tick`）
   * @param {(payload: object) => void} [deps.onMessage] 默认类型事件（兼容兜底）
   * @param {() => void} deps.onOpen 连上（含重连成功）
   * @param {() => void} deps.onError 出错/断开
   * @returns {{open: () => void, close: () => void, delay: () => number}}
   */
  function createStreamLink(deps) {
    let source = null;
    let reconnectDelay = 1000;

    /** 解析事件数据；不是对象一律忽略（不炸）。 */
    function parse(event) {
      try {
        const payload = JSON.parse(event?.data);
        if (payload === null || typeof payload !== "object") return null;
        return payload;
      } catch {
        return null;
      }
    }

    function open() {
      const Ctor = deps.eventSourceCtor === undefined ? global.EventSource : deps.eventSourceCtor;
      if (typeof Ctor !== "function") {
        global.console.warn("环境没有 EventSource，退化为轮询");
        return;
      }
      source = new Ctor(deps.url);

      source.onopen = function () {
        reconnectDelay = 1000;
        // 重连成功后必须补拉全量：断线期间的口径可能已经变了
        deps.onOpen();
      };

      // ⚠️ 具名事件必须用 addEventListener —— 见文件头注释
      source.addEventListener("touch", function (event) {
        const payload = parse(event);
        if (payload !== null) deps.onTouch(payload);
      });

      source.addEventListener("tick", function (event) {
        const payload = parse(event);
        if (payload !== null) deps.onTick(payload);
      });

      // 兼容：万一桥将来推默认类型的 message
      source.onmessage = function (event) {
        if (typeof deps.onMessage !== "function") return;
        const payload = parse(event);
        if (payload !== null) deps.onMessage(payload);
      };

      source.onerror = function () {
        deps.onError();
        // EventSource 自己会重连，这里只把退避间隔记下来供界面显示
        if (reconnectDelay < RECONNECT_MAX_MS) reconnectDelay *= 2;
      };
    }

    function close() {
      if (source !== null && typeof source.close === "function") source.close();
      source = null;
    }

    return { open, close, delay: () => reconnectDelay };
  }

  global.WhaleStreamLink = { createStreamLink, RECONNECT_MAX_MS };
})(typeof window !== "undefined" ? window : globalThis);

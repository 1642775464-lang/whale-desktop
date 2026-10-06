/**
 * 服务器
 *
 * 职责：创建并管理 HTTP 服务——监听回环端口、校验 Host 头、
 *       处理 CORS 预检、分发到路由处理器、统一错误响应。
 * 所属层：桥（whale-bridge/lib）
 *
 * 服务只绑 127.0.0.1（PRD F1 + 开发规范 强制 29），不接受外部连接。
 */

import { createServer } from "node:http";

import {
  corsHeaders,
  isAllowedHost,
  isAllowedOrigin,
  parseUrl,
  readJsonBody,
  sendError,
  sendJson,
} from "./http-util.mjs";
import { getHandler } from "./routes.mjs";

/** 桥的监听端口（PRD F1）。 */
export const PORT = 19387;

/** 监听地址：只回环。 */
export const HOST = "127.0.0.1";

/**
 * 处理器上下文：处理器拿到的全部输入。
 * @typedef {object} HandlerCtx
 * @property {string} method
 * @property {string} path
 * @property {URLSearchParams} query
 * @property {Record<string, unknown>} body
 * @property {object} host    宿主访问封装（host-ctx.mjs 产出）
 */

/**
 * 创建 HTTP 服务实例（不自动监听）。
 *
 * @param {object} options
 * @param {object} options.host           宿主访问封装
 * @param {(msg: string) => void} [options.log]
 * @returns {import("node:http").Server}
 */
export function createBridgeServer({ host, log = () => {} }) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin;
    const cors = corsHeaders(typeof origin === "string" ? origin : undefined);

    // Host 头校验（强制 30：防 DNS rebinding）
    const hostHeader = req.headers.host;
    if (!isAllowedHost(typeof hostHeader === "string" ? hostHeader : undefined)) {
      sendError(res, 403, "host-not-allowed", "Host 头必须是本机回环地址", cors);
      return;
    }

    // 来源校验
    if (!isAllowedOrigin(typeof origin === "string" ? origin : undefined)) {
      sendError(res, 403, "origin-not-allowed", "来源不被信任", {});
      return;
    }

    // CORS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }

    const { pathname, query } = parseUrl(req.url ?? "/");
    const method = req.method ?? "GET";

    const handler = getHandler(method, pathname);
    if (handler === undefined) {
      const known = getHandler(method === "GET" ? "POST" : "GET", pathname) !== undefined;
      if (known) {
        sendError(res, 405, "method-not-allowed", `${pathname} 不接受 ${method}`, cors);
      } else {
        sendError(res, 404, "not-found", `未知路由 ${method} ${pathname}`, cors);
      }
      return;
    }

    let body = {};
    if (method === "POST") {
      try {
        body = await readJsonBody(req);
      } catch (err) {
        sendError(res, 400, err.code ?? "body-invalid", err.message, cors);
        return;
      }
    }

    /** @type {HandlerCtx} */
    const ctx = { method, path: pathname, query, body, host };

    try {
      const result = await handler(ctx);
      sendJson(res, 200, result, cors);
    } catch (err) {
      const code = err.code ?? "internal";
      const status = err.status ?? 500;
      // 内部错误落日志，对外只给有限信息
      if (status >= 500) {
        log(`[桥] 处理器异常 ${method} ${pathname}: ${err.stack ?? err.message}`);
      }
      sendError(res, status, code, err.message ?? "内部错误", cors);
    }
  });

  return server;
}

/**
 * 启动服务并等待监听完成。
 *
 * 端口占用时抛出带 `code = "port-in-use"` 的错误，由调用方明确落日志
 * （PRD F1：不静默）。
 *
 * @param {import("node:http").Server} server
 * @param {{port?: number, host?: string}} [options]
 * @returns {Promise<{port: number, host: string}>}
 */
export function listen(server, options = {}) {
  const port = options.port ?? PORT;
  const host = options.host ?? HOST;

  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener("listening", onListening);
      if (err.code === "EADDRINUSE") {
        const wrapped = new Error(`端口 ${port} 已被占用，桥无法启动`);
        wrapped.code = "port-in-use";
        reject(wrapped);
        return;
      }
      reject(err);
    };

    const onListening = () => {
      server.removeListener("error", onError);
      resolve({ port, host });
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * 关闭服务并等待全部连接结束。
 * @param {import("node:http").Server} server
 * @returns {Promise<void>}
 */
export function close(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((err) => (err ? reject(err) : resolve()));
    // 已建立的 keep-alive 连接会拖住 close，主动断开
    if (typeof server.closeAllConnections === "function") {
      server.closeAllConnections();
    }
  });
}

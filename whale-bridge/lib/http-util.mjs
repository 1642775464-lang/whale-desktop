/**
 * HTTP 工具
 *
 * 职责：提供发 JSON 响应、发错误响应、读请求体、CORS 判定等无状态小工具。
 * 所属层：桥（whale-bridge/lib）
 *
 * 本模块不持有任何状态，也不依赖宿主 ctx，可独立单测。
 */

import { Buffer } from "node:buffer";

/** 允许跨域的来源前缀（PRD F1：桥只对本地页面开放）。 */
const ALLOWED_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

/** 允许的 Host 头（PRD F1 + 开发规范 强制 30：防 DNS rebinding）。 */
const ALLOWED_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

/** 请求体上限：桥只收小 JSON，防止内存被大 body 打爆。 */
export const MAX_BODY_BYTES = 1024 * 1024;

/**
 * 判定跨域来源是否允许。
 * @param {string | undefined} origin
 * @returns {boolean}
 */
export function isAllowedOrigin(origin) {
  if (origin === undefined || origin === "") return true;
  return ALLOWED_ORIGIN.test(origin);
}

/**
 * 判定 Host 头是否为本机回环。
 *
 * 缺失 Host 头时放行：HTTP/1.0 客户端可能不带，且此时请求已由监听地址
 * 限定为回环，不存在 DNS rebinding 风险。
 *
 * @param {string | undefined} host
 * @returns {boolean}
 */
export function isAllowedHost(host) {
  if (host === undefined || host === "") return true;
  return ALLOWED_HOST.test(host);
}

/**
 * 组装 CORS 响应头。
 * @param {string | undefined} origin
 * @returns {Record<string, string>}
 */
export function corsHeaders(origin) {
  if (origin === undefined || origin === "" || !isAllowedOrigin(origin)) {
    return {};
  }
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, last-event-id",
    "access-control-max-age": "600",
  };
}

/**
 * 发送 JSON 响应。
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} payload
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(body.length),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * 发送错误响应。错误体形状与宿主 RemoteError 保持可对齐：
 * `{ ok: false, error: { code, message } }`
 *
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, string>} [extraHeaders]
 */
export function sendError(res, status, code, message, extraHeaders = {}) {
  sendJson(res, status, { ok: false, error: { code, message } }, extraHeaders);
}

/**
 * 读取并解析 JSON 请求体。
 *
 * 超过 MAX_BODY_BYTES 抛错并中断连接；空体返回 `{}`。
 *
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<Record<string, unknown>>}
 */
export async function readJsonBody(req) {
  const chunks = [];
  let size = 0;

  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error(`请求体超过上限 ${MAX_BODY_BYTES} 字节`);
      err.code = "body-too-large";
      throw err;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") return {};

  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      const err = new Error("请求体必须是 JSON 对象");
      err.code = "body-invalid";
      throw err;
    }
    return parsed;
  } catch (err) {
    if (err.code === "body-invalid") throw err;
    const wrapped = new Error("请求体不是合法 JSON");
    wrapped.code = "body-invalid";
    throw wrapped;
  }
}

/**
 * 从请求 URL 解析查询参数。
 * @param {string} rawUrl
 * @param {string} [base]
 * @returns {{ pathname: string, query: URLSearchParams }}
 */
export function parseUrl(rawUrl, base = "http://127.0.0.1") {
  const url = new URL(rawUrl, base);
  return { pathname: url.pathname, query: url.searchParams };
}

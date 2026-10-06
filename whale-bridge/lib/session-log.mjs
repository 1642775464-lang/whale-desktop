/**
 * 落盘会话读取兜底
 *
 * 职责：宿主服务不可用或需回填历史时，直接读会话日志文件。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么需要兜底：宿主服务是首选数据源，但两个场景需要直读——
 *   1. 桥启动时回填已有会话的累计量（宿主只推增量事件）；
 *   2. 历史会话（`/whale/resume`）宿主当前没加载，拿不到服务接口。
 *
 * 实测的存储布局（见 references/session-events.md）：
 *   <会话根>/<projectKey(cwd)>/<sessionId>/session.v4.jsonl.zstd
 *   projectKey 规则：把 / \ : 折叠为单个 -，其他非 [A-Za-z0-9._-] 字符转 ~XXXX
 *   （大写 4 位十六进制），最终形如 --<可读部分>--。
 *   例：D:\DEEPSEEK\悬浮窗 → --D-DEEPSEEK-~60AC~6D6E~7A97--
 *
 * 本模块负责「找文件 + 解码 + 解析」，IO 集中在底部三个函数里，
 * 纯计算部分（projectKey、解析行）可单独测。
 */

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { decompressLines } from "./zstd-frame.mjs";

/** 会话日志文件名（v4 格式，zstd 压缩）。 */
export const SESSION_FILE = "session.v4.jsonl.zstd";

/**
 * 由工作目录路径算出会话项目目录名。
 *
 * @param {string} cwd 会话的工作目录
 * @returns {string} 项目目录名
 */
export function projectKey(cwd) {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  let out = "";
  for (const ch of cwd) {
    if (ch === "/" || ch === "\\" || ch === ":") {
      // 折叠为单个 -，但避免连续 -
      if (!out.endsWith("-")) out += "-";
    } else if (/[A-Za-z0-9._-]/.test(ch)) {
      out += ch;
    } else {
      out += `~${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return out.slice(0, 251);
}

/**
 * 解析一行 JSON。失败返回 null（不抛错——日志可能有截断行）。
 *
 * @param {string} line 文本行
 * @returns {object | null}
 */
export function parseEventLine(line) {
  if (typeof line !== "string" || line.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(line);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 把解码出的文本行解析成事件数组。
 *
 * 首行是会话头（无 seq），其余事件都带 seq。
 *
 * @param {string[]} lines 文本行
 * @returns {{ header: object | null, events: Array<object>, badLines: number }}
 */
export function parseSessionLines(lines) {
  let header = null;
  const events = [];
  let badLines = 0;

  for (const line of Array.isArray(lines) ? lines : []) {
    const parsed = parseEventLine(line);
    if (parsed === null) {
      badLines += 1;
      continue;
    }
    if (header === null && parsed.type === "session") {
      header = parsed;
      continue;
    }
    events.push(parsed);
  }

  return { header, events, badLines };
}

/**
 * 解码一份会话日志缓冲（不读文件，便于单测）。
 *
 * @param {Buffer} buffer 文件内容
 * @returns {{ header: object | null, events: Array<object>, badLines: number,
 *   frameCount: number, failedFrames: number }}
 */
export function decodeSessionBuffer(buffer) {
  const { lines, frameCount, failedFrames } = decompressLines(buffer);
  const { header, events, badLines } = parseSessionLines(lines);
  return { header, events, badLines, frameCount, failedFrames };
}

/**
 * 列出某工作目录下的全部会话目录。
 *
 * @param {string} sessionsRoot 会话根目录（通常是 ~/.dsh/sessions）
 * @param {string} cwd 工作目录
 * @returns {Array<{ sessionId: string, dir: string }>}
 */
export function listSessionDirs(sessionsRoot, cwd) {
  const dir = join(sessionsRoot, projectKey(cwd));
  if (!existsSync(dir)) return [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith("session-"))
    .map((e) => ({ sessionId: e.name, dir: join(dir, e.name) }));
}

/**
 * 读取一份会话日志并解码。
 *
 * 任何失败都返回 `{ ok: false, reason }`，**不抛错**——调用方据此降级为
 * 「无数据」，而不是让整个请求挂掉。
 *
 * @param {string} sessionDir 会话目录
 * @returns {{ ok: true, header: object|null, events: Array<object>,
 *   frameCount: number, failedFrames: number } | { ok: false, reason: string }}
 */
export function readSessionLog(sessionDir) {
  const file = join(sessionDir, SESSION_FILE);
  if (!existsSync(file)) return { ok: false, reason: "file-not-found" };

  let buffer;
  try {
    buffer = readFileSync(file);
  } catch {
    return { ok: false, reason: "read-failed" };
  }

  try {
    const decoded = decodeSessionBuffer(buffer);
    return {
      ok: true,
      header: decoded.header,
      events: decoded.events,
      frameCount: decoded.frameCount,
      failedFrames: decoded.failedFrames,
    };
  } catch {
    return { ok: false, reason: "decode-failed" };
  }
}

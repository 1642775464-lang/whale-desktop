/**
 * 悬浮条日志
 *
 * 职责：把主进程的日志写到 `whale-hud/.userdata/whale-hud.log`，
 *       并在超过上限时轮转一次。
 * 所属层：悬浮条（whale-hud/lib）
 *
 * **为什么路径必须惰性解析**：PRD 5.2 实测过，`app.getPath('userData')` 在
 * Electron 里若早于 `app.setPath` 调用，会让进程**原生崩溃**（退出码 `0xFFFF7003`），
 * 不抛 JS 异常、try/catch 接不住。所以模块顶层**不碰任何路径**，
 * 一律等第一次真正写日志时再解析。
 *
 * 任何写失败都不得抛给调用方：日志写不出去是次要问题，
 * 让窗口起不来才是主要问题。
 */

"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** 默认单文件上限；超过就轮转一次。 */
const DEFAULT_MAX_BYTES = 512 * 1024;

/**
 * 建一个日志器。
 *
 * @param {object} [options]
 * @param {() => string | undefined} [options.resolveDir] 惰性给出日志目录（首次写入时才调用）
 * @param {string} [options.fileName]
 * @param {number} [options.maxBytes]
 * @param {boolean} [options.consoleFallback] 是否同时打到 stdout（默认打）
 * @returns {{info: Function, warn: Function, error: Function, pathOf: () => string | null}}
 */
function createLogger(options = {}) {
  const resolveDir = typeof options.resolveDir === "function" ? options.resolveDir : () => undefined;
  const fileName = typeof options.fileName === "string" ? options.fileName : "whale-hud.log";
  const maxBytes = Number.isInteger(options.maxBytes) ? options.maxBytes : DEFAULT_MAX_BYTES;
  const toConsole = options.consoleFallback !== false;

  /** 惰性解析出来的日志文件路径。 */
  let filePath = null;

  /**
   * 解析日志路径（只解析一次）。
   *
   * @returns {string | null} 拿不到目录时给 null，由调用方退回 stdout
   */
  function ensurePath() {
    if (filePath !== null) return filePath;
    const dir = resolveDir();
    if (typeof dir !== "string" || dir === "") return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      return null;
    }
    filePath = path.join(dir, fileName);
    return filePath;
  }

  /** 超过上限就改名为 `.1`（只留一代，不做无限轮转）。 */
  function rotateIfNeeded(target) {
    try {
      const stat = fs.statSync(target);
      if (stat.size <= maxBytes) return;
      fs.renameSync(target, `${target}.1`);
    } catch {
      // 文件不存在或改名失败都不影响继续写
    }
  }

  /**
   * 写一行。
   *
   * @param {string} level
   * @param {string} message
   */
  function write(level, message) {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    if (toConsole) console.log(line.trimEnd());

    const target = ensurePath();
    if (target === null) return;
    try {
      rotateIfNeeded(target);
      fs.appendFileSync(target, line, "utf8");
    } catch {
      // 写不进去就算了：不能因为日志让窗口起不来
    }
  }

  return {
    info: (message) => write("info", message),
    warn: (message) => write("warn", message),
    error: (message) => write("error", message),
    pathOf: () => filePath,
  };
}

module.exports = { DEFAULT_MAX_BYTES, createLogger };

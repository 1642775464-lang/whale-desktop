/**
 * 读宿主的会话日志（诊断用）
 *
 * 职责：定位并解压 `.dsh/sessions` 下的会话日志，取出原始事件。
 * 所属层：工程工具（tools/）
 *
 * 为什么要共用：核对「消息过滤判据」时写了好几个诊断脚本，
 * 每个都要定位日志 + 解压 zstd。各带一份必然漂移 ——
 * 而这类脚本的结论是要拿来做决定的（比如「真人消息有没有 source 字段」），
 * 一份过时的解压逻辑会给出**看起来正常但错误**的结论。
 *
 * ⚠️ 日志是**多段追加**的：每行是一个独立的 zstd 帧，不是一个大帧。
 * 整体 `zstdDecompressSync` 只解出第一段（实测 21897 行里只得到 1 行），
 * 看起来像「日志里没有这条事件」—— 正是最容易得出错误结论的地方。
 * 所以下面按 zstd 魔数切帧，逐帧解。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { join } from "node:path";
import { homedir } from "node:os";

/** zstd 帧魔数。 */
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 找一份会话日志。
 *
 * @param {string} [sessionIdPart] 会话 id 的一部分（用于在多个会话里挑一个）
 * @returns {string|null} 日志文件路径
 */
export function findSessionLog(sessionIdPart) {
  const root = join(homedir(), ".dsh", "sessions");
  if (!existsSync(root)) return null;
  for (const workspace of readdirSync(root)) {
    const dir = join(root, workspace);
    let entries = [];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (sessionIdPart !== undefined && !name.includes(sessionIdPart)) continue;
      const file = join(dir, name, "session.v4.jsonl.zstd");
      if (existsSync(file)) return file;
    }
  }
  return null;
}

/**
 * 按帧解压整个日志，返回文本。
 *
 * @param {string} file
 * @returns {string}
 */
export function decodeSessionLog(file) {
  const raw = readFileSync(file);
  const starts = [];
  let at = raw.indexOf(MAGIC, 0);
  while (at !== -1) { starts.push(at); at = raw.indexOf(MAGIC, at + 4); }
  starts.push(raw.length);

  let out = "";
  for (let i = 0; i < starts.length - 1; i += 1) {
    // 尾部可能有残帧（正在写入），解析失败就跳过它，不影响已完整的部分
    try { out += zstdDecompressSync(raw.subarray(starts[i], starts[i + 1])).toString("utf8"); } catch { /* 残帧 */ }
  }
  return out;
}

/**
 * 取某类事件的全部实例。
 *
 * @param {string} file
 * @param {string} type 事件类型（如 `user/message`）
 * @returns {Array<object>}
 */
export function eventsOfType(file, type) {
  const out = [];
  for (const line of decodeSessionLog(file).split("\n")) {
    if (line.trim() === "") continue;
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === type) out.push(ev);
  }
  return out;
}

/**
 * 取一条 user/message 里可显示的文本（只有 text 块算）。
 *
 * 图片、附件等块没有可显示的文本 —— 折叠器会跳过这类消息，
 * 那是「本来就没有文本」，与「被过滤掉」是两回事，判定时要分开。
 *
 * @param {object} event
 * @returns {string}
 */
export function userTextOf(event) {
  return (event?.data?.content ?? [])
    .filter((c) => c?.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");
}

/** 取一条 user/message 的来源标识（`user` 表示真人）。 */
export function sourceKindOf(event) {
  const kind = event?.data?.source?.kind;
  return typeof kind === "string" && kind !== "" ? kind : "(无 source)";
}

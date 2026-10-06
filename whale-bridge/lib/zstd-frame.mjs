/**
 * 逐帧 zstd 解码
 *
 * 职责：把多帧拼接的 zstd 缓冲解成完整 Buffer。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么需要它（实测教训，见 references/node-native-api.md）：
 * 会话日志 session.v4.jsonl.zstd 是**多帧**格式——实测 959269 字节的文件里
 * 有 562 个独立 zstd 帧。Node 的 zlib.zstdDecompressSync(buffer) 只解**第一帧**
 * （203 字节，仅 session 头），zlib.createZstdDecompress() 流式同样只出第一帧。
 *
 * 正确解法：扫描 zstd 魔数找每帧起点，按 [起始, 下一帧起始) 切片，逐帧解压再拼接。
 *
 * 本模块是纯函数：不读文件、不碰网络。
 */

import { zstdDecompressSync } from "node:zlib";

/** zstd 帧魔数：0x28 0xB5 0x2F 0xFD。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 扫描缓冲里所有 zstd 帧的起始偏移。
 *
 * @param {Buffer} buffer 待扫描的缓冲
 * @returns {number[]} 升序的帧起始偏移数组；无帧时为空数组
 */
export function frameOffsets(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < ZSTD_MAGIC.length) return [];

  const offsets = [];
  // 从第 0 字节起找；每找到一帧就从该位置继续往后找
  let at = buffer.indexOf(ZSTD_MAGIC, 0);
  while (at !== -1) {
    offsets.push(at);
    at = buffer.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length);
  }
  return offsets;
}

/**
 * 逐帧解压并拼接。
 *
 * 单帧解压失败时**跳过该帧并计数**，不整体抛错——会话日志可能被截断，
 * 此时应尽量交出已解出的部分（降级原则：宁可局部失效不整体崩溃）。
 *
 * @param {Buffer} buffer 多帧 zstd 缓冲
 * @returns {{ data: Buffer, frameCount: number, failedFrames: number }}
 */
export function decompressAllFrames(buffer) {
  const offsets = frameOffsets(buffer);
  if (offsets.length === 0) {
    return { data: Buffer.alloc(0), frameCount: 0, failedFrames: 0 };
  }

  const parts = [];
  let failedFrames = 0;
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buffer.length;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(start, end)));
    } catch {
      failedFrames += 1;
    }
  }

  return {
    data: Buffer.concat(parts),
    frameCount: offsets.length,
    failedFrames,
  };
}

/**
 * 逐帧解压并按行切分，返回非空文本行。
 *
 * @param {Buffer} buffer 多帧 zstd 缓冲
 * @returns {{ lines: string[], frameCount: number, failedFrames: number }}
 */
export function decompressLines(buffer) {
  const { data, frameCount, failedFrames } = decompressAllFrames(buffer);
  const lines = data
    .toString("utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return { lines, frameCount, failedFrames };
}

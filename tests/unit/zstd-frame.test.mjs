/**
 * 逐帧 zstd 解码单测
 *
 * 职责：验证魔数扫描、多帧拼接、降级容忍。
 * 所属层：测试（tests/unit）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { zstdCompressSync } from "node:zlib";

import {
  ZSTD_MAGIC,
  frameOffsets,
  decompressAllFrames,
  decompressLines,
} from "../../whale-bridge/lib/zstd-frame.mjs";

/** 把多段文本各自压成一帧，再拼成一个缓冲——模拟真实会话日志的多帧结构。 */
function multiFrame(...texts) {
  return Buffer.concat(texts.map((t) => zstdCompressSync(Buffer.from(t, "utf8"))));
}

test("ZSTD_MAGIC 是 4 字节标准魔数", () => {
  assert.equal(ZSTD_MAGIC.length, 4);
  assert.deepEqual([...ZSTD_MAGIC], [0x28, 0xb5, 0x2f, 0xfd]);
});

test("frameOffsets 扫出全部帧起点", () => {
  const buf = multiFrame("a", "b", "c");
  assert.equal(frameOffsets(buf).length, 3);
});

test("frameOffsets 对空缓冲返回空数组", () => {
  assert.deepEqual(frameOffsets(Buffer.alloc(0)), []);
});

test("frameOffsets 对非 Buffer 返回空数组", () => {
  assert.deepEqual(frameOffsets("not a buffer"), []);
  assert.deepEqual(frameOffsets(null), []);
});

test("frameOffsets 对无魔数的缓冲返回空数组", () => {
  assert.deepEqual(frameOffsets(Buffer.from("hello world")), []);
});

test("decompressAllFrames 解出全部帧内容并拼接", () => {
  const buf = multiFrame("第一行\n", "第二行\n", "第三行\n");
  const { data, frameCount, failedFrames } = decompressAllFrames(buf);
  assert.equal(frameCount, 3);
  assert.equal(failedFrames, 0);
  assert.equal(data.toString("utf8"), "第一行\n第二行\n第三行\n");
});

test("单帧也能正确解出（不是只解第一帧就丢后面的）", () => {
  const buf = multiFrame("only");
  const { data } = decompressAllFrames(buf);
  assert.equal(data.toString("utf8"), "only");
});

test("空缓冲降级为空结果，不抛错", () => {
  const r = decompressAllFrames(Buffer.alloc(0));
  assert.equal(r.frameCount, 0);
  assert.equal(r.data.length, 0);
});

test("中间帧损坏时跳过该帧、其余帧仍解出", () => {
  const good1 = zstdCompressSync(Buffer.from("A"));
  const good2 = zstdCompressSync(Buffer.from("C"));
  // 伪造一个魔数开头但内容无效的「帧」
  const broken = Buffer.concat([ZSTD_MAGIC, Buffer.from([0x00, 0x01, 0x02])]);
  const buf = Buffer.concat([good1, broken, good2]);

  const { frameCount, failedFrames, data } = decompressAllFrames(buf);
  assert.equal(frameCount, 3);
  assert.equal(failedFrames, 1);
  assert.equal(data.toString("utf8"), "AC");
});

test("decompressLines 按行切分并去掉空行", () => {
  const buf = multiFrame('{"a":1}\n', '\n{"b":2}\n', "\n");
  const { lines, frameCount } = decompressLines(buf);
  assert.equal(frameCount, 3);
  assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
});

test("真实会话日志形状：首帧仅头 + 多帧事件，全部解出", () => {
  const header = '{"type":"session","version":4,"cwd":"D:\\\\x"}\n';
  const events = Array.from({ length: 5 }, (_, i) => `{"seq":${i},"type":"step/start"}\n`);
  const buf = multiFrame(header, ...events);
  const { lines, frameCount, failedFrames } = decompressLines(buf);
  assert.equal(frameCount, 6);
  assert.equal(failedFrames, 0);
  assert.equal(lines.length, 6);
  assert.equal(JSON.parse(lines[0]).type, "session");
  assert.equal(JSON.parse(lines[5]).seq, 4);
});

/**
 * sse-buffer 单测
 *
 * 这个模块是纯数据结构，所以这里只测数据行为，不起网络、不装宿主。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CAPACITY,
  createRingBuffer,
  formatSseFrame,
  latestId,
  push,
  since,
  sizeOf,
} from "../../whale-bridge/lib/sse-buffer.mjs";

/** 造一条事件。 */
function item(id, event = "message", data = `{"id":${id}}`) {
  return { id, channel: "hud", event, data };
}

test("新建缓冲：容量与空状态", () => {
  const buf = createRingBuffer(3);
  assert.equal(buf.capacity, 3);
  assert.equal(sizeOf(buf), 0);
  assert.equal(latestId(buf), null);
  assert.equal(buf.droppedUpTo, 0);
});

test("非法容量退回默认值", () => {
  assert.equal(createRingBuffer(0).capacity, DEFAULT_CAPACITY);
  assert.equal(createRingBuffer(-5).capacity, DEFAULT_CAPACITY);
  assert.equal(createRingBuffer(1.5).capacity, DEFAULT_CAPACITY);
  assert.equal(createRingBuffer("x").capacity, DEFAULT_CAPACITY);
  assert.equal(createRingBuffer(undefined).capacity, DEFAULT_CAPACITY);
});

test("push 与 latestId", () => {
  const buf = createRingBuffer(5);
  push(buf, item(1));
  push(buf, item(2));
  assert.equal(sizeOf(buf), 2);
  assert.equal(latestId(buf), 2);
});

test("有界性：超出容量丢最旧的", () => {
  const buf = createRingBuffer(3);
  for (let i = 1; i <= 10; i += 1) push(buf, item(i));

  assert.equal(sizeOf(buf), 3, "不得超过容量");
  assert.equal(latestId(buf), 10);
  assert.deepEqual(
    buf.items.map((x) => x.id),
    [8, 9, 10],
    "只留最近三条",
  );
});

test("有界性：容量为 1 也能正确工作", () => {
  const buf = createRingBuffer(1);
  for (let i = 1; i <= 5; i += 1) push(buf, item(i));
  assert.equal(sizeOf(buf), 1);
  assert.equal(latestId(buf), 5);
});

test("droppedUpTo 只在真的丢了东西时前进", () => {
  const buf = createRingBuffer(2);
  push(buf, item(7));
  assert.equal(buf.droppedUpTo, 0, "没丢过就还是 0");

  push(buf, item(8));
  assert.equal(buf.droppedUpTo, 0, "刚好装满，仍未丢");

  push(buf, item(9));
  assert.equal(buf.droppedUpTo, 7, "丢掉 7 后记录下界");
});

test("since：不带 id 不回补历史", () => {
  const buf = createRingBuffer(5);
  push(buf, item(1));
  push(buf, item(2));

  for (const absent of [null, undefined, "abc", 1.5]) {
    const out = since(buf, absent);
    assert.deepEqual(out.items, [], `id=${String(absent)} 应不回补`);
    assert.equal(out.missed, false);
  }
});

test("since：id 命中缓冲，返回其后的事件", () => {
  const buf = createRingBuffer(10);
  for (let i = 1; i <= 5; i += 1) push(buf, item(i));

  const out = since(buf, 2);
  assert.deepEqual(
    out.items.map((x) => x.id),
    [3, 4, 5],
  );
  assert.equal(out.missed, false);
});

test("since：id 正是最新一条，返回空", () => {
  const buf = createRingBuffer(10);
  for (let i = 1; i <= 3; i += 1) push(buf, item(i));

  const out = since(buf, 3);
  assert.deepEqual(out.items, []);
  assert.equal(out.missed, false);
});

test("since：id 过旧被丢弃 → 报 missed 并给现有全部", () => {
  const buf = createRingBuffer(3);
  for (let i = 1; i <= 10; i += 1) push(buf, item(i));

  const out = since(buf, 5);
  assert.equal(out.missed, true, "5 已不在缓冲里，必须报洞");
  assert.deepEqual(
    out.items.map((x) => x.id),
    [8, 9, 10],
    "给出现有全部，让客户端自己决定要不要拉全量",
  );
});

test("since：id 超前（客户端比桥新）→ 空且不报错", () => {
  const buf = createRingBuffer(5);
  push(buf, item(1));

  const out = since(buf, 999);
  assert.deepEqual(out.items, []);
  assert.equal(out.missed, false, "客户端状态超前是正常情况，不是错误");
});

test("since：空缓冲上带任意 id 都安全", () => {
  const buf = createRingBuffer(5);
  for (const id of [0, 1, 100]) {
    const out = since(buf, id);
    assert.deepEqual(out.items, []);
    assert.equal(out.missed, false);
  }
});

test("formatSseFrame：单行 data 的基本形状", () => {
  const frame = formatSseFrame({ id: 7, event: "tick", data: '{"a":1}' });
  assert.equal(frame, 'id: 7\nevent: tick\ndata: {"a":1}\n\n');
});

test("formatSseFrame：多行 data 逐行加前缀", () => {
  const frame = formatSseFrame({ id: 1, event: "x", data: "line1\nline2" });
  assert.equal(frame, "id: 1\nevent: x\ndata: line1\ndata: line2\n\n");
});

test("formatSseFrame：以双换行结尾（SSE 分帧要求）", () => {
  const frame = formatSseFrame({ id: 1, event: "x", data: "{}" });
  assert.ok(frame.endsWith("\n\n"), "帧必须以空行结束");
  assert.ok(!frame.endsWith("\n\n\n"), "不能多出空行");
});

test("formatSseFrame：非字符串 data 被安全转换", () => {
  const frame = formatSseFrame({ id: 1, event: "x", data: 42 });
  assert.ok(frame.includes("data: 42"));
});

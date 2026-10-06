/**
 * token 口径统计内核单测
 *
 * 职责：验证 pressureFrom 口径、四桶求和、缺字段兜底、速度窗口。
 * 所属层：测试（tests/unit）
 *
 * 关键被测约束（K-10）：落盘 usage 无 cacheWriteTokens，该项恒 0，不得虚构。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SPEED_WINDOW_MS,
  emptyTotals,
  pressureFrom,
  addUsage,
  sumUsage,
  latestPressure,
  contextWindowOf,
  pushSample,
  speedAt,
  usagePercent,
} from "../../whale-bridge/lib/usage-stats.mjs";

/** 实测样本：宿主落盘的真实 usage 形状（4 个字段，无 cacheWriteTokens）。 */
const REAL_USAGE = { inputTokens: 983, outputTokens: 81, totalTokens: 93352, cacheReadTokens: 92288 };

test("SPEED_WINDOW_MS 为 8000", () => {
  assert.equal(SPEED_WINDOW_MS, 8000);
});

test("pressureFrom 按 input + cacheRead + cacheWrite 计算", () => {
  // 983 + 92288 + 0 = 93271（与实测一致）
  assert.equal(pressureFrom(REAL_USAGE), 93271);
});

test("pressureFrom 对无效输入返回 null（而不是 0）", () => {
  assert.equal(pressureFrom(null), null);
  assert.equal(pressureFrom(undefined), null);
  assert.equal(pressureFrom("x"), null);
  assert.equal(pressureFrom({}), null);
});

test("pressureFrom 遇 cacheWriteTokens 缺失按 0 兜底，不虚构", () => {
  assert.equal(pressureFrom({ inputTokens: 100, cacheReadTokens: 50 }), 150);
  assert.equal(pressureFrom({ inputTokens: 100 }), 100);
});

test("pressureFrom 认 cacheWriteTokens（若宿主将来提供）", () => {
  assert.equal(pressureFrom({ inputTokens: 100, cacheReadTokens: 50, cacheWriteTokens: 25 }), 175);
});

test("pressureFrom 不用 totalTokens（它含缓存读，会重复计）", () => {
  // totalTokens=93352 明显大于真实占用，若误用则结果不是 93271
  assert.notEqual(pressureFrom(REAL_USAGE), REAL_USAGE.totalTokens);
});

test("addUsage 累加四桶且不修改入参", () => {
  const before = emptyTotals();
  const after = addUsage(before, REAL_USAGE);
  assert.equal(after.totalInput, 983);
  assert.equal(after.totalOutput, 81);
  assert.equal(after.totalCacheRead, 92288);
  assert.equal(after.totalCacheWrite, 0);
  assert.deepEqual(before, emptyTotals(), "入参不应被修改");
});

test("addUsage 对无效 usage 返回原值副本", () => {
  const totals = { totalInput: 5, totalOutput: 6, totalCacheRead: 7, totalCacheWrite: 8 };
  assert.deepEqual(addUsage(totals, null), totals);
  assert.deepEqual(addUsage(totals, undefined), totals);
  assert.notEqual(addUsage(totals, null), totals, "应返回新对象");
});

test("sumUsage 只累加 assistant/message 的 usage", () => {
  const events = [
    { type: "session", data: {} },
    { type: "assistant/message", data: { usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 1000 } } },
    { type: "step/start", data: {} },
    { type: "assistant/message", data: { usage: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 2000 } } },
    { type: "tool/call", data: {} },
  ];
  const totals = sumUsage(events);
  assert.equal(totals.totalInput, 300);
  assert.equal(totals.totalOutput, 30);
  assert.equal(totals.totalCacheRead, 3000);
  assert.equal(totals.totalCacheWrite, 0);
});

test("sumUsage 对空数组与非数组返回零值", () => {
  assert.deepEqual(sumUsage([]), emptyTotals());
  assert.deepEqual(sumUsage(null), emptyTotals());
});

test("sumUsage 容忍缺 usage 的 assistant/message", () => {
  const totals = sumUsage([
    { type: "assistant/message", data: {} },
    { type: "assistant/message", data: { usage: { inputTokens: 7 } } },
  ]);
  assert.equal(totals.totalInput, 7);
});

test("latestPressure 取最后一条有效 usage", () => {
  const events = [
    { type: "assistant/message", data: { usage: { inputTokens: 1, cacheReadTokens: 1 } } },
    { type: "assistant/message", data: { usage: { inputTokens: 100, cacheReadTokens: 50 } } },
  ];
  assert.equal(latestPressure(events), 150);
});

test("latestPressure 跳过无 usage 的尾部事件", () => {
  const events = [
    { type: "assistant/message", data: { usage: { inputTokens: 100 } } },
    { type: "tool/call", data: {} },
  ];
  assert.equal(latestPressure(events), 100);
});

test("latestPressure 无 usage 时返回 null", () => {
  assert.equal(latestPressure([{ type: "session", data: {} }]), null);
  assert.equal(latestPressure([]), null);
});

test("contextWindowOf 取 request/context 的 contextWindow", () => {
  const events = [
    { type: "request/context", data: { contextWindow: 1000000 } },
    { type: "assistant/message", data: {} },
  ];
  assert.equal(contextWindowOf(events), 1000000);
});

test("contextWindowOf 无该事件时返回 null", () => {
  assert.equal(contextWindowOf([{ type: "session", data: {} }]), null);
  assert.equal(contextWindowOf(null), null);
});

test("pushSample 在窗口内累加并算速度", () => {
  const now = 1_000_000;
  const r1 = pushSample([], { at: now - 4000, outputTokens: 400 }, now);
  assert.equal(r1.samples.length, 1);
  // 400 token / 4 秒 = 100 tok/s
  assert.equal(r1.tokPerSec, 100);
});

test("pushSample 丢弃窗口外过期采样", () => {
  const now = 1_000_000;
  const old = [{ at: now - SPEED_WINDOW_MS - 1, outputTokens: 9999 }];
  const r = pushSample(old, { at: now, outputTokens: 10 }, now);
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0].outputTokens, 10);
});

test("pushSample 窗口内全过期时速度为 0（累计数字不动）", () => {
  const now = 1_000_000;
  const r = pushSample([{ at: now - 100000, outputTokens: 5000 }], { at: now, outputTokens: 0 }, now);
  assert.equal(r.tokPerSec, 0);
});

test("speedAt 不修改采样数组", () => {
  const now = 1_000_000;
  const samples = [{ at: now - 8000 - 1, outputTokens: 1 }, { at: now - 1000, outputTokens: 100 }];
  const snapshot = JSON.parse(JSON.stringify(samples));
  const r = speedAt(samples, now);
  assert.equal(r.samples.length, 1);
  assert.deepEqual(samples, snapshot, "入参不应被修改");
});

test("usagePercent 按占用与窗口算百分比", () => {
  assert.equal(usagePercent(93271, 1000000), 9.33);
});

test("usagePercent 缺任一项返回 null（界面显示短横）", () => {
  assert.equal(usagePercent(null, 1000000), null);
  assert.equal(usagePercent(100, null), null);
  assert.equal(usagePercent(100, 0), null);
  assert.equal(usagePercent(100, -5), null);
});

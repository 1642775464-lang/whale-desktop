/**
 * 悬浮条状态机单测
 *
 * 职责：盯住「形态转换规则」与「定时器生命周期」这两件最容易出错的事。
 * 所属层：测试（tests/unit）
 *
 * 用假定时器而不是真 setTimeout：真时钟测出来的要么慢（等 3 秒）、
 * 要么飘（180ms 抖动）。状态机的正确性与真实时间无关，只与**事件顺序**有关。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  COLLAPSE_MS,
  DETAIL_FALLBACK_MS,
  EXPAND_MS,
  HOVER_RETRACT_MS,
  createHudState,
} = require("../../whale-hud/lib/state.cjs");

/**
 * 假调度器：把定时器记在表里，由测试显式推进。
 *
 * @returns {{schedule: Function, cancel: Function, tick: (ms: number) => void, pending: () => number}}
 */
function fakeClock() {
  let seq = 0;
  const timers = new Map();

  return {
    schedule(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: ms, cancelled: false });
      return seq;
    },
    cancel(handle) {
      const t = timers.get(handle);
      if (t !== undefined) t.cancelled = true;
    },
    /** 推进时间：触发所有到期且未取消的定时器。 */
    tick(ms) {
      for (const t of timers.values()) {
        if (t.cancelled || t.at > ms) continue;
        t.cancelled = true;
        t.fn();
      }
    },
    pending: () => [...timers.values()].filter((t) => !t.cancelled).length,
  };
}

/** 造一个带假时钟的状态机，返回状态机与时钟。 */
function makeState() {
  const clock = fakeClock();
  const changes = [];
  const state = createHudState({
    schedule: clock.schedule,
    cancel: clock.cancel,
    onChange: (form, reason) => changes.push({ form, reason }),
  });
  return { state, clock, changes };
}

test("常量与前端设计规范 1.6 一致", () => {
  assert.equal(HOVER_RETRACT_MS, 180);
  assert.equal(DETAIL_FALLBACK_MS, 3000);
  assert.equal(COLLAPSE_MS, 275);
  assert.equal(EXPAND_MS, 335);
});

test("初始形态是条", () => {
  const { state } = makeState();
  assert.equal(state.form(), "bar");
  assert.deepEqual(state.pendingTimers(), { retract: false, fallback: false });
});

test("悬停进入详情，再移出在 180ms 后缩回", () => {
  const { state, clock, changes } = makeState();

  state.hoverEnter();
  assert.equal(state.form(), "detail");

  state.hoverLeave();
  assert.equal(state.form(), "detail", "180ms 之内不能缩回，否则鼠标到不了浮层");
  clock.tick(HOVER_RETRACT_MS);
  assert.equal(state.form(), "bar");
  assert.deepEqual(changes, [
    { form: "detail", reason: "hover-enter" },
    { form: "bar", reason: "hover-leave" },
  ]);
});

test("3 秒兜底：漏收 mouseleave 也会自己缩回", () => {
  const { state, clock } = makeState();
  state.hoverEnter();
  assert.deepEqual(state.pendingTimers(), { retract: false, fallback: true });

  clock.tick(DETAIL_FALLBACK_MS);
  assert.equal(state.form(), "bar", "没有兜底定时器时窗口会一直高着，成为隐形点击陷阱");
});

test("兜底触发后不残留定时器", () => {
  const { state, clock } = makeState();
  state.hoverEnter();
  clock.tick(DETAIL_FALLBACK_MS);
  assert.deepEqual(state.pendingTimers(), { retract: false, fallback: false });
  assert.equal(clock.pending(), 0);
});

test("移出后再移入：缩回定时器被撤掉，不会误缩", () => {
  const { state, clock } = makeState();
  state.hoverEnter();
  state.hoverLeave();
  state.hoverEnter();

  clock.tick(HOVER_RETRACT_MS * 2);
  assert.equal(state.form(), "detail", "重新进入后旧的缩回定时器必须失效");
});

test("球形态下悬停不弹详情", () => {
  const { state } = makeState();
  state.collapse();
  state.hoverEnter();
  assert.equal(state.form(), "ball", "88×88 的球不该突然变成 588×340 的高窗口");
});

test("收起时清掉全部定时器", () => {
  const { state, clock } = makeState();
  state.hoverEnter();
  state.hoverLeave();
  assert.equal(clock.pending(), 2, "此时应有缩回 + 兜底两个定时器");

  state.collapse();
  assert.equal(state.form(), "ball");
  assert.equal(clock.pending(), 0, "不清定时器的话，缩回会在球形态里把窗口改回 72 高");

  clock.tick(DETAIL_FALLBACK_MS * 2);
  assert.equal(state.form(), "ball", "收起后旧定时器不得再改形态");
});

test("展开回到条形态", () => {
  const { state, changes } = makeState();
  state.collapse();
  state.expand();
  assert.equal(state.form(), "bar");
  assert.deepEqual(changes.map((c) => c.reason), ["collapse", "expand"]);
});

test("同形态重复调用不产生回调（避免窗口反复 setBounds 闪烁）", () => {
  const { state, changes } = makeState();
  state.hoverEnter();
  state.hoverEnter();
  state.hoverEnter();
  assert.equal(changes.length, 1);
});

test("球形态下 hoverLeave 无副作用", () => {
  const { state, clock } = makeState();
  state.collapse();
  state.hoverLeave();
  assert.equal(state.form(), "ball");
  assert.equal(clock.pending(), 0, "不该为一个不会发生的缩回安排定时器");
});

test("restore 恢复形态（F7 重新加载界面用）", () => {
  const { state, clock } = makeState();
  state.collapse();
  state.restore("ball");
  assert.equal(state.form(), "ball");

  state.restore("bar");
  assert.equal(state.form(), "bar");
  assert.equal(clock.pending(), 0, "恢复时必须清掉旧定时器");
});

test("restore 未知形态明确抛错，不静默接受", () => {
  const { state } = makeState();
  assert.throws(() => state.restore("飞起来"), /未知形态/);
  assert.equal(state.form(), "bar", "抛错后形态不该被改坏");
});

test("dispose 之后不再回调", () => {
  const { state, clock, changes } = makeState();
  state.hoverEnter();
  const before = changes.length;
  state.dispose();
  clock.tick(DETAIL_FALLBACK_MS * 2);
  assert.equal(changes.length, before, "卸下后旧定时器不得再改形态");
});

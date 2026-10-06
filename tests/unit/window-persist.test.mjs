/**
 * 小窗窗口状态持久化单测
 *
 * 职责：钉住两条「换个写法就会错」的判据——位置有效性用交集面积 ≥25%、
 *       写盘防抖但退出补写。
 * 所属层：测试（tests/unit）
 *
 * 这两条都容易写出「看起来对、边界上错」的实现：
 *   - 用「完全包含」判有效性 → 贴边窗口被反复重置
 *   - 用「左上角在屏内」→ 拖到边缘的窗口被误判为有效
 * 所以每个判据都配了边界样例。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  DEBOUNCE_MS,
  MIN_VISIBLE_RATIO,
  createStateStore,
  intersectionArea,
  isPositionUsable,
  normalizeState,
} = require("../../whale-window/lib/persist.cjs");

/** 主屏工作区。 */
const MAIN = { x: 0, y: 0, width: 2560, height: 1400 };
/** 左侧外接屏。 */
const LEFT = { x: -1920, y: 0, width: 1920, height: 1080 };

/** 假定时器。 */
function fakeClock() {
  let seq = 0;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: ms, dead: false });
      return seq;
    },
    cancel(h) {
      const t = timers.get(h);
      if (t) t.dead = true;
    },
    fire() {
      for (const t of [...timers.values()]) {
        if (t.dead) continue;
        t.dead = true;
        t.fn();
      }
    },
    pending: () => [...timers.values()].filter((t) => !t.dead).length,
  };
}

/** 造一个存储器；`initial` 是「磁盘上已有的内容」。 */
function makeStore(initial = "", areas = [MAIN, LEFT]) {
  const clock = fakeClock();
  const writes = [];
  const store = createStateStore({
    read: () => initial,
    write: (text) => writes.push(text),
    workAreas: () => areas,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });
  return { store, clock, writes };
}

test("常量与 PRD F12 一致", () => {
  assert.equal(DEBOUNCE_MS, 400);
  assert.equal(MIN_VISIBLE_RATIO, 0.25);
});

test("intersectionArea：相交、包含、相离", () => {
  assert.equal(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 }), 25);
  assert.equal(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 0, y: 0, width: 20, height: 20 }), 100);
  assert.equal(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 100, y: 100, width: 10, height: 10 }), 0);
  // 仅贴边不算相交
  assert.equal(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 }), 0);
});

test("正中屏幕的窗口判为有效", () => {
  const bounds = { x: 1000, y: 300, width: 492, height: 710 };
  const r = isPositionUsable(bounds, [MAIN]);
  assert.equal(r.valid, true);
  assert.equal(r.bestRatio, 1);
});

test("贴边窗口（略微超出）仍判为有效 —— 不能用「完全包含」", () => {
  // 右缘超出 10px：用户故意贴边。完全包含判据会把它判成无效
  const bounds = { x: MAIN.width - 482, y: 300, width: 492, height: 710 };
  const r = isPositionUsable(bounds, [MAIN]);
  assert.equal(r.valid, true, "贴边是合理位置，不得判无效");
  assert.ok(r.bestRatio > 0.97);
});

test("大部分在屏外的位置判为无效 —— 不能用「左上角在屏内」", () => {
  // 左上角在屏内，但 90% 在外面
  const bounds = { x: MAIN.width - 40, y: 300, width: 492, height: 710 };
  const r = isPositionUsable(bounds, [MAIN]);
  assert.equal(r.valid, false, "这种位置对用户没意义");
  assert.ok(r.bestRatio < 0.1);
});

test("恰好 25% 可见判为有效（含边界）", () => {
  // 宽度 400 的窗口，只露出 100 → 25%
  const bounds = { x: MAIN.width - 100, y: 300, width: 400, height: 700 };
  const r = isPositionUsable(bounds, [MAIN]);
  assert.equal(r.bestRatio, 0.25);
  assert.equal(r.valid, true, "判据是 ≥25%，等于也要通过");
});

test("24.9% 可见判为无效", () => {
  const bounds = { x: MAIN.width - 99, y: 300, width: 400, height: 700 };
  const r = isPositionUsable(bounds, [MAIN]);
  assert.ok(r.bestRatio < 0.25);
  assert.equal(r.valid, false);
});

test("窗口完全在第二块屏上：按最佳交集判定", () => {
  const bounds = { x: -1500, y: 200, width: 492, height: 710 };
  const r = isPositionUsable(bounds, [MAIN, LEFT]);
  assert.equal(r.valid, true);
  assert.equal(r.bestAreaIndex, 1, "应命中左侧那块屏");
});

test("拔掉外接屏后，原位置判为无效", () => {
  const bounds = { x: -1500, y: 200, width: 492, height: 710 };
  assert.equal(isPositionUsable(bounds, [MAIN, LEFT]).valid, true, "两屏时有效");
  assert.equal(isPositionUsable(bounds, [MAIN]).valid, false, "只剩主屏时无效");
});

test("没有显示器时判为无效", () => {
  assert.equal(isPositionUsable({ x: 0, y: 0, width: 100, height: 100 }, []).valid, false);
});

test("矩形非法时判为无效，不抛错", () => {
  for (const bad of [null, undefined, 42, {}, { x: 0, y: 0, width: 0, height: 10 }]) {
    assert.equal(isPositionUsable(bad, [MAIN]).valid, false, `${JSON.stringify(bad)} 应无效`);
  }
});

test("normalizeState：合法值取整保留", () => {
  assert.deepEqual(normalizeState({ x: 10.4, y: 20.6, width: 492.2, height: 710.8 }), {
    x: 10, y: 21, width: 492, height: 711,
  });
});

test("normalizeState：任一字段不合法就整条丢弃", () => {
  // 半对不对的位置比没有位置更糟：窗口会出现在屏外或尺寸错乱
  for (const bad of [null, {}, { x: 0, y: 0 }, { x: 0, y: 0, width: 0, height: 10 }, { x: "a", y: 0, width: 1, height: 1 }]) {
    assert.equal(normalizeState(bad), null, `${JSON.stringify(bad)} 应被丢弃`);
  }
});

test("restore：没有记忆时给 no-memory", () => {
  const { store } = makeStore("");
  assert.deepEqual(store.restore(), { bounds: null, reason: "no-memory" });
});

test("restore：JSON 损坏时给 corrupt-json", () => {
  const { store } = makeStore("{ 这不是 JSON");
  assert.equal(store.restore().reason, "corrupt-json");
});

test("restore：字段缺失时给 invalid-fields", () => {
  const { store } = makeStore(JSON.stringify({ x: 1, y: 2 }));
  assert.equal(store.restore().reason, "invalid-fields");
});

test("restore：位置在屏外时给 off-screen（B13 判据）", () => {
  const { store } = makeStore(JSON.stringify({ x: 9000, y: 9000, width: 492, height: 710 }));
  const r = store.restore();
  assert.equal(r.bounds, null);
  assert.equal(r.reason, "off-screen", "位置失效必须能被上层识别并落日志");
});

test("restore：正常位置原样返回", () => {
  const saved = { x: 1000, y: 300, width: 492, height: 710 };
  const { store } = makeStore(JSON.stringify(saved));
  const r = store.restore();
  assert.equal(r.reason, "ok");
  assert.deepEqual(r.bounds, saved);
});

test("remember：高频调用只写一次盘（400ms 防抖）", () => {
  const { store, clock, writes } = makeStore();
  for (let i = 0; i < 20; i += 1) {
    store.remember({ x: i, y: 0, width: 492, height: 710 });
  }
  assert.equal(writes.length, 0, "防抖期内不应写盘");
  assert.equal(clock.pending(), 1, "只应留一个待触发的定时器");

  clock.fire();
  assert.equal(writes.length, 1, "防抖到期后只写一次");
  assert.deepEqual(JSON.parse(writes[0]), { x: 19, y: 0, width: 492, height: 710 }, "写的是最后一次位置");
});

test("flush：退出时立即补写（否则「拖完马上关」丢最后一次位置）", () => {
  const { store, clock, writes } = makeStore();
  store.remember({ x: 700, y: 100, width: 492, height: 710 });
  assert.equal(writes.length, 0, "防抖中还没写");

  store.flush();
  assert.equal(writes.length, 1, "退出必须补写");
  assert.deepEqual(JSON.parse(writes[0]), { x: 700, y: 100, width: 492, height: 710 });
  assert.equal(clock.pending(), 0, "补写后不该再有待触发定时器");
});

test("flush：没有改动时不写盘", () => {
  const { store, writes } = makeStore();
  assert.equal(store.flush(), false);
  assert.equal(writes.length, 0);
});

test("hasPending 反映是否还有未落盘改动", () => {
  const { store, clock } = makeStore();
  assert.equal(store.hasPending(), false);
  store.remember({ x: 1, y: 1, width: 492, height: 710 });
  assert.equal(store.hasPending(), true);
  clock.fire();
  assert.equal(store.hasPending(), false);
});

test("remember：非法尺寸被忽略，不污染已记住的状态", () => {
  const { store, clock, writes } = makeStore();
  store.remember({ x: 5, y: 6, width: 492, height: 710 });
  store.remember({ x: 9, y: 9, width: 0, height: 0 });
  clock.fire();
  assert.deepEqual(JSON.parse(writes[0]), { x: 5, y: 6, width: 492, height: 710 }, "非法输入不得覆盖好值");
});

test("pinned 状态一并记住", () => {
  const { store, clock, writes } = makeStore();
  store.remember({ x: 1, y: 2, width: 492, height: 710, pinned: true });
  clock.fire();
  assert.equal(JSON.parse(writes[0]).pinned, true);
});

test("restore 能读回 pinned", () => {
  const saved = { x: 1000, y: 300, width: 492, height: 710, pinned: true };
  const { store } = makeStore(JSON.stringify(saved));
  assert.equal(store.restore().bounds.pinned, true);
});

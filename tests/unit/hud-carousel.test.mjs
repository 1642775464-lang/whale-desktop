/**
 * 滚筒单测
 *
 * 职责：钉住自动轮播的时序、锁定规则、以及两个防御机制（代际号 / 看门狗）。
 * 所属层：测试（tests/unit）
 *
 * renderer/carousel.js 是浏览器 script（不能 import），所以用 node:vm 造一个
 * 带假 window 与假定时器的沙箱把它加载进来，再取出 window.WhaleCarousel。
 *
 * 这套测试**不代替实地跑**：它证明的是时序与状态转换正确，
 * 证明不了 CSS 过渡、堆叠顺序这些渲染效果（那些靠契约测试与真窗口）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CAROUSEL_FILE = join(ROOT, "whale-hud", "renderer", "carousel.js");

/** 在一个假 window 里加载 carousel.js，取回它挂上去的 API。 */
function loadCarousel() {
  const sandbox = { window: {}, setTimeout, clearTimeout, console };
  sandbox.window.setTimeout = setTimeout;
  sandbox.window.clearTimeout = clearTimeout;
  createContext(sandbox);
  runInContext(readFileSync(CAROUSEL_FILE, "utf8"), sandbox, { filename: CAROUSEL_FILE });
  return sandbox.window.WhaleCarousel;
}

const carousel = loadCarousel();

/** 造一个会话。 */
function session(id, phase, title) {
  return { sessionId: id, title: title ?? `会话 ${id}`, speed: { phase, tokPerSec: 1, frozen: false } };
}

/**
 * 假时钟。
 *
 * 关键实现细节：触发时**先快照再执行**。回调里往往会安排新定时器，
 * 若边遍历边执行，新定时器会在同一次 tick 里被再次触发，
 * 3000ms 的排期会无限自我续命——测试表现为堆内存爆掉，
 * 而不是给出一个能读懂的失败。
 *
 * 所以：tick 先把 now 推到目标时刻，只触发**快照里**已到期的那批。
 */
function fakeClock() {
  let seq = 0;
  let now = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      seq += 1;
      timers.set(seq, { fn, at: now + ms, dead: false });
      return seq;
    },
    clearTimeout(handle) {
      const t = timers.get(handle);
      if (t !== undefined) t.dead = true;
    },
    /**
     * 推进 ms 毫秒。
     *
     * @param {number} ms
     */
    tick(ms) {
      now += ms;
      const due = [...timers.values()].filter((t) => !t.dead && t.at <= now);
      for (const t of due) {
        t.dead = true;
        t.fn();
      }
    },
    pending: () => [...timers.values()].filter((t) => !t.dead).length,
    now: () => now,
  };
}

/** 最小 DOM 桩：只实现 carousel.js 真正用到的几处。 */
function fakeDom() {
  const classes = new Set();
  const el = () => ({
    textContent: "",
    offsetWidth: 1,
    classList: {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    },
  });
  const dom = { reel: el(), faceB: el(), faceF: el() };
  dom.classes = classes;
  return dom;
}

test("时长常量与《前端设计规范》1.6 一致", () => {
  assert.equal(carousel.DWELL_MS, 3000);
  assert.equal(carousel.FLIP_HALF_MS, 250);
  assert.equal(carousel.FLIP_PERIOD_MS, 3500);
});

test("runningSessions 只挑 phase=running 的", () => {
  const list = [
    session("a", "running"),
    session("b", "idle"),
    session("c", "unknown"),
    session("d", "running"),
  ];
  assert.deepEqual(
    carousel.runningSessions(list).map((s) => s.sessionId),
    ["a", "d"],
  );
});

test("runningSessions 用 phase 判据，不靠「最近有没有出 token」", () => {
  // 工具执行阶段根本不产 token，但回合在跑。用 token 判会把这类会话误判成空闲。
  const toolRunning = { sessionId: "t", title: "跑工具", speed: { phase: "running", tokPerSec: null } };
  assert.equal(carousel.runningSessions([toolRunning]).length, 1);
});

test("单会话不翻转", () => {
  const plan = carousel.planReel([session("a", "running")], {});
  assert.equal(plan.shouldRoll, false, "单会话时标题必须静止");
  assert.equal(plan.current.sessionId, "a");
});

test("两个及以上进行中会话才翻转", () => {
  assert.equal(carousel.planReel([session("a", "running"), session("b", "running")], {}).shouldRoll, true);
  // 一个 running + 一个 idle 仍然算单会话
  assert.equal(carousel.planReel([session("a", "running"), session("b", "idle")], {}).shouldRoll, false);
});

test("锁定后不翻转，且固定在锁定项", () => {
  const list = [session("a", "running"), session("b", "running")];
  const plan = carousel.planReel(list, { lockedId: "b", index: 0 });
  assert.equal(plan.shouldRoll, false);
  assert.equal(plan.current.sessionId, "b");
  assert.equal(plan.lockedId, "b");
});

test("锁定的会话掉出列表时自动清锁", () => {
  // 否则会出现「只剩一个会话、🔒 还挂着」——那个锁无法解释，点了也没反应
  const list = [session("a", "running")];
  const plan = carousel.planReel(list, { lockedId: "b", index: 0 });
  assert.equal(plan.lockedId, null, "锁定项不在了就必须清锁");
});

test("index 越界时取模回环，不抛错", () => {
  const list = [session("a", "running"), session("b", "running")];
  assert.equal(carousel.planReel(list, { index: 5 }).current.sessionId, "b");
  assert.equal(carousel.planReel(list, { index: -1 }).current.sessionId, "b");
});

test("全空闲时没有可显示项，也不翻转", () => {
  const plan = carousel.planReel([session("a", "idle")], {});
  assert.equal(plan.current, null);
  assert.equal(plan.shouldRoll, false);
});

test("翻转时序：停留 3000ms 后开始上半程，再 250ms 完成下半程", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const list = [session("a", "running"), session("b", "running")];
  const reel = carousel.createReel({
    getSessions: () => list,
    dom,
    clock,
  });

  reel.renderNow();
  assert.equal(reel.currentTitle(), "会话 a");
  reel.schedule();

  // 3000ms 之前不该动
  clock.tick(2999);
  assert.equal(dom.classes.has("out"), false, "停留期内不该开始翻转");

  // 停留结束 → 上半程
  clock.tick(3000);
  assert.equal(dom.classes.has("out"), true, "上半程应把 front 翻下去");

  // 上半程结束 → 文字在此刻改写（front 已侧立、不可见）
  clock.tick(3250);
  assert.equal(reel.currentTitle(), "会话 b", "下半程应换成下一个标题");
  assert.equal(dom.classes.has("in"), true, "下半程应把 front 翻回来");
});

test("A7：写文字那一刻 front 必须处于不可见状态", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const list = [session("a", "running"), session("b", "running")];
  const reel = carousel.createReel({ getSessions: () => list, dom, clock });

  reel.renderNow();
  reel.schedule();
  clock.tick(3000);

  // 上半程进行中：front 带 out，正在转出去
  assert.equal(dom.faceF.textContent, "会话 a", "翻转途中不得提前改写文字");

  clock.tick(3250);
  // 文字是在 primed（侧立、不可见）那一瞬写的，写完才转回来
  assert.equal(dom.faceF.textContent, "会话 b");
});

test("看门狗：rolling 卡住时被强制放掉", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const list = [session("a", "running"), session("b", "running")];
  const reel = carousel.createReel({ getSessions: () => list, dom, clock });

  reel.renderNow();
  reel.schedule();
  clock.tick(3000);
  assert.equal(reel.isRolling(), true, "翻转中应持有互斥锁");

  // 模拟「下半程的回调被降频/异常中断，没人放锁」
  clock.tick(carousel.WATCHDOG_MS + carousel.FLIP_PERIOD_MS);
  assert.equal(reel.isRolling(), false, "看门狗必须把锁放掉，否则标题再也不动且毫无报错");
});

test("代际号：DOM 重建后旧定时器作废，不去改孤儿节点", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const list = [session("a", "running"), session("b", "running")];
  const reel = carousel.createReel({ getSessions: () => list, dom, clock });

  reel.renderNow();
  reel.schedule();
  clock.tick(3000); // 上半程开始

  const textBefore = dom.faceF.textContent;
  reel.invalidate(); // DOM 重建
  clock.tick(3250); // 旧回调到期

  assert.equal(dom.faceF.textContent, textBefore, "旧回调不得再改文字");
  assert.equal(reel.isRolling(), false, "作废的回调也要把锁放掉，不能留下永久 true");
});

test("toggleLock：两会话时锁定当前项，再点解锁", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const list = [session("a", "running"), session("b", "running")];
  const reel = carousel.createReel({ getSessions: () => list, dom, clock });
  reel.renderNow();

  const locked = reel.toggleLock();
  assert.equal(locked.locked, true);
  assert.equal(reel.lockedId(), "a");

  const unlocked = reel.toggleLock();
  assert.equal(unlocked.locked, false);
  assert.equal(reel.lockedId(), null);
});

test("toggleLock：单会话时拒绝锁定并说明原因", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const reel = carousel.createReel({ getSessions: () => [session("a", "running")], dom, clock });
  const out = reel.toggleLock();
  assert.equal(out.locked, false);
  assert.equal(out.reason, "single-session", "本来就沒在滚，锁一个没有意义");
});

test("select：点下拉项会跳转并顺手锁定", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const list = [session("a", "running"), session("b", "running")];
  const picked = [];
  const reel = carousel.createReel({
    getSessions: () => list,
    dom,
    clock,
    onSelect: (id) => picked.push(id),
  });
  reel.renderNow();

  const out = reel.select("b");
  assert.equal(out.ok, true);
  assert.equal(reel.lockedId(), "b", "不锁定的话 3 秒后又翻走，用户会以为点错了");
  assert.equal(reel.currentTitle(), "会话 b");
  assert.deepEqual(picked, ["b"]);
});

test("select：选一个没在跑的会话 → 明确拒绝", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const reel = carousel.createReel({ getSessions: () => [session("a", "running")], dom, clock });
  const out = reel.select("没有这个");
  assert.equal(out.ok, false);
  assert.equal(out.code, "session-not-running");
});

test("会话掉到 1 个：轮播停止并回到静态标题", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  let list = [session("a", "running"), session("b", "running")];
  const reel = carousel.createReel({ getSessions: () => list, dom, clock });

  reel.renderNow();
  reel.schedule();
  assert.ok(clock.pending() > 0, "两会话时应有排期");

  list = [session("a", "running")];
  reel.update();
  assert.equal(clock.pending(), 0, "单会话时不该留定时器");
  assert.equal(reel.currentTitle(), "会话 a");
});

test("stop 后不再有任何排期", () => {
  const clock = fakeClock();
  const dom = fakeDom();
  const list = [session("a", "running"), session("b", "running")];
  const reel = carousel.createReel({ getSessions: () => list, dom, clock });
  reel.renderNow();
  reel.schedule();
  reel.stop();
  assert.equal(clock.pending(), 0);
  assert.equal(reel.isRolling(), false);
});

/**
 * 小窗崩溃自愈单测
 *
 * 职责：钉住「重载上限 3、第 4 次落兜底页」「退避 400×n」
 *       与「只有加载成功才算恢复」这三条。
 * 所属层：测试（tests/unit）
 *
 * 第三条最容易被写错：若在「发出 reload 请求」时就清零计数，
 * 一个必然崩溃的页面会无限重载——用户看到的是窗口不停闪，
 * 而日志里全是「第 1 次重载」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const {
  BACKOFF_MS,
  CRASHED_PAGE,
  PHASE,
  RENDERER_RELOAD_MAX,
  createRecovery,
} = require("../../whale-window/lib/recovery.cjs");

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
    /** 触发全部到期定时器，返回被触发的 ms 列表。 */
    fire() {
      const fired = [];
      for (const t of [...timers.values()]) {
        if (t.dead) continue;
        t.dead = true;
        fired.push(t.at);
        t.fn();
      }
      return fired;
    },
    pending: () => [...timers.values()].filter((t) => !t.dead).length,
  };
}

/** 造一个状态机，记录 reload / fallback 调用。 */
function makeRecovery() {
  const clock = fakeClock();
  const calls = [];
  const rec = createRecovery({
    reload: () => calls.push("reload"),
    loadFallback: () => calls.push("fallback"),
    schedule: clock.schedule,
    cancel: clock.cancel,
    log: () => {},
  });
  return { rec, clock, calls };
}

test("常量与 PRD F11 一致", () => {
  assert.equal(RENDERER_RELOAD_MAX, 3);
  assert.equal(BACKOFF_MS, 400);
  assert.equal(CRASHED_PAGE, "crashed.html");
});

test("初始形态是 running，计数为 0", () => {
  const { rec } = makeRecovery();
  assert.equal(rec.phase(), PHASE.RUNNING);
  assert.equal(rec.crashCount(), 0);
});

test("第一次崩溃：安排重载，退避 400ms", () => {
  const { rec, clock, calls } = makeRecovery();
  const out = rec.onRendererGone({ reason: "crashed" });

  assert.equal(out.action, "reload");
  assert.equal(out.delayMs, 400, "退避 = 400 × 第几次");
  assert.equal(calls.length, 0, "退避期内不该立刻重载");
  clock.fire();
  assert.deepEqual(calls, ["reload"]);
});

test("退避递增：第 2 次 800ms，第 3 次 1200ms", () => {
  const { rec, clock } = makeRecovery();
  rec.onRendererGone({});
  clock.fire();
  assert.equal(rec.onRendererGone({}).delayMs, 800);
  clock.fire();
  assert.equal(rec.onRendererGone({}).delayMs, 1200);
});

test("**只有加载成功才清零**：重载请求发出后计数仍在", () => {
  const { rec, clock } = makeRecovery();
  rec.onRendererGone({});
  clock.fire(); // 重载已发出
  assert.equal(rec.crashCount(), 1, "发出重载 ≠ 恢复；不清零才能发现「一直崩」");

  rec.onLoaded();
  assert.equal(rec.crashCount(), 0, "加载成功才清零");
});

test("必崩页面不会无限重载：第 4 次崩溃落兜底页", () => {
  const { rec, clock, calls } = makeRecovery();

  // 前 3 次：重载
  for (let i = 1; i <= 3; i += 1) {
    const out = rec.onRendererGone({ reason: "crashed" });
    assert.equal(out.action, "reload", `第 ${i} 次应重载`);
    clock.fire();
  }

  // 第 4 次：兜底页
  const fourth = rec.onRendererGone({ reason: "crashed" });
  assert.equal(fourth.action, "fallback");
  assert.equal(rec.phase(), PHASE.FALLBACK);

  const reloads = calls.filter((c) => c === "reload").length;
  assert.equal(reloads, 3, "恰好重载 3 次（PRD 的上限）");
  assert.deepEqual(calls.filter((c) => c === "fallback"), ["fallback"]);
});

test("上限与 references 示例的差异是被有意选定的（PRD 优先）", () => {
  // references/electron-patterns.md 写 crashCount <= 2（最多两次）；
  // PRD 写 3。冲突裁决顺序 PRD > ARCHITECTURE > STATUS，故取 3。
  // 这条测试把这个取舍钉住，避免以后有人「照 references 改回去」。
  assert.equal(RENDERER_RELOAD_MAX, 3, "按 PRD 取 3；改这个数前先改 PRD");
});

test("崩溃计数跨崩溃累积（不是每次重置）", () => {
  const { rec, clock } = makeRecovery();
  rec.onRendererGone({});
  rec.onRendererGone({});
  rec.onRendererGone({});
  assert.equal(rec.crashCount(), 3);
  clock.fire();
  assert.equal(rec.stats.reloaded, 1, "同一个时刻只留一个待触发的重载");
});

test("成功恢复后计数归零，下次崩溃从头开始", () => {
  const { rec, clock } = makeRecovery();
  rec.onRendererGone({});
  clock.fire();
  rec.onLoaded();
  assert.equal(rec.crashCount(), 0);
  assert.equal(rec.phase(), PHASE.RUNNING);

  rec.onRendererGone({});
  clock.fire();
  assert.equal(rec.stats.reloaded, 2);
  assert.equal(rec.crashCount(), 1);
});

test("恢复计数只在确实恢复过时增加", () => {
  const { rec } = makeRecovery();
  rec.onLoaded(); // 首次正常加载，不算「恢复」
  assert.equal(rec.stats.recovered, 0);

  const { rec: rec2, clock } = makeRecovery();
  rec2.onRendererGone({});
  clock.fire();
  rec2.onLoaded();
  assert.equal(rec2.stats.recovered, 1, "崩溃后加载成功才算恢复");
});

test("待触发的重载会被后来的崩溃取消（避免两次重载打架）", () => {
  const { rec, clock, calls } = makeRecovery();
  rec.onRendererGone({});
  assert.equal(rec.hasPending(), true);
  rec.onRendererGone({}); // 退避期还没到就又崩了
  assert.equal(clock.pending(), 1, "只应留一个待触发的重载");
  clock.fire();
  assert.equal(calls.filter((c) => c === "reload").length, 1);
});

test("onLoaded 会取消待触发的重载", () => {
  const { rec, clock, calls } = makeRecovery();
  rec.onRendererGone({});
  rec.onLoaded();
  assert.equal(rec.hasPending(), false);
  clock.fire();
  assert.deepEqual(calls, [], "已经恢复了就不该再重载");
});

test("兜底页「再试一次」：计数清零并重载", () => {
  const { rec, clock, calls } = makeRecovery();
  for (let i = 0; i < 4; i += 1) {
    rec.onRendererGone({});
    clock.fire();
  }
  assert.equal(rec.phase(), PHASE.FALLBACK);

  calls.length = 0;
  const out = rec.retry();
  assert.equal(out.ok, true);
  assert.deepEqual(calls, ["reload"]);
  assert.equal(rec.crashCount(), 0, "再试一次要重新给满额机会");
});

test("再试一次后若又崩够 3 次，仍会落兜底页", () => {
  const { rec, clock } = makeRecovery();
  for (let i = 0; i < 4; i += 1) {
    rec.onRendererGone({});
    clock.fire();
  }
  rec.retry();
  rec.onRendererGone({});
  clock.fire();
  let last = null;
  for (let i = 0; i < 3; i += 1) {
    last = rec.onRendererGone({});
    clock.fire();
  }
  assert.equal(last.action, "fallback");
});

test("加载失败只落日志，不计入崩溃计数", () => {
  const { rec } = makeRecovery();
  rec.onLoadFailed({ errorCode: -6, errorDescription: "net::ERR_FILE_NOT_FOUND" });
  assert.equal(rec.crashCount(), 0, "加载失败不是渲染进程崩溃，不该触发自愈");
  assert.equal(rec.stats.reloadFailed, 1);
});

test("dispose 取消待触发的重载", () => {
  const { rec, clock, calls } = makeRecovery();
  rec.onRendererGone({});
  rec.dispose();
  clock.fire();
  assert.deepEqual(calls, [], "卸下之后不该再重载");
});

test("stats 记录各类事件", () => {
  const { rec, clock } = makeRecovery();
  rec.onRendererGone({});
  clock.fire();
  rec.onLoaded();
  rec.onRendererGone({});
  rec.onRendererGone({});
  clock.fire();
  assert.equal(rec.stats.gone, 3);
  assert.equal(rec.stats.reloaded, 2);
  assert.equal(rec.stats.recovered, 1);
  assert.equal(rec.stats.fallbackShown, 0);
});

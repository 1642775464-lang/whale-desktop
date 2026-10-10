/**
 * 会话清单的顺序：必须是「最近一次在前」
 *
 * 职责：钉住 `GET /whale/hud` 的 sessions 顺序按**最近活动倒序**。
 * 所属层：测试（tests/unit）
 *
 * ## 用户报的现象
 *
 * > 首次打开小窗，进入的会话和最近一次会话不匹配，
 * > 我要求的是首次打开小窗默认进入最近一次会话
 *
 * ## 根因
 *
 * `follow.js` 在桥没给 activeSessionId 时，会「退回清单第一项」：
 *
 *     active = list[0].sessionId;
 *
 * 而 `hudSnapshot` 是**遍历 `foldSet.sessions.keys()` 的插入顺序**输出的 ——
 * 插入顺序取决于哪条会话先被种进折叠器，**与最近活动无关**。
 *
 * 实测两条会话：插入顺序第一条最后活动 21:44，第二条 23:27。
 * 于是「清单第一项」恰好**不是**最近一次。
 *
 * ## 修法方向
 *
 * 排序是**桥**的职责：把最近活动时间带进快照，并按它倒序输出。
 * 这样 `follow.js` 的「清单第一项＝最近一次」这个假设才真的成立，
 * 界面上的会话列表顺序也随之正确（同一个口径，不是两处各排各的）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFoldSet, ensureSession } from "../../whale-bridge/lib/fold.mjs";
import { hudSnapshot } from "../../whale-bridge/lib/fold-view.mjs";

const META = { version: "t", port: 1, startedAt: 0, now: 1000 };

/** 造两条会话，指定各自的「最近活动」时间。 */
function twoSessions() {
  const foldSet = createFoldSet();
  // 故意先插「较早」那条：插入顺序与最近活动顺序相反，
  // 这样按插入顺序输出一定出错，测试才有意义。
  const older = ensureSession(foldSet, "older");
  older.seededUpdatedAt = 1000;
  older.title = "较早的会话";
  const newer = ensureSession(foldSet, "newer");
  newer.seededUpdatedAt = 5000;
  newer.title = "最近的会话";
  return foldSet;
}

test("hud 的会话清单按最近活动倒序（最近一次排第一）", () => {
  const snap = hudSnapshot(twoSessions(), META);

  assert.deepEqual(
    snap.sessions.map((s) => s.sessionId),
    ["newer", "older"],
    "最近活动的会话必须排在最前 —— 小窗首次打开会退回清单第一项，顺序错了就进错会话",
  );
});

test("快照要带出最近活动时间（否则上层无从排序）", () => {
  const snap = hudSnapshot(twoSessions(), META);
  const first = snap.sessions[0];

  assert.equal(
    first.updatedAt,
    5000,
    "快照必须带 updatedAt —— 没有它，界面和跟随规则都只能靠数组顺序猜",
  );
});

test("没有 updatedAt 的会话排在最后（不给 0，与「没有值」区分开）", () => {
  /*
   * 投影纪律：取不到给 null，不给 0。界面上 0 与「没有值」含义不同。
   * 所以不知道时间的会话明确排在有时间的后面，而不是当成最早。
   */
  const foldSet = createFoldSet();
  const known = ensureSession(foldSet, "known");
  known.seededUpdatedAt = 3000;
  ensureSession(foldSet, "unknown");      // 没设时间

  const snap = hudSnapshot(foldSet, META);
  assert.equal(snap.sessions[0].sessionId, "known", "有时间的在前");
  assert.equal(snap.sessions[1].sessionId, "unknown", "没时间的排最后，且 updatedAt 为 null 而不是 0");
  assert.equal(snap.sessions[1].updatedAt, null, "没有值要给 null");
});

test("排序不影响指针本身", () => {
  const foldSet = twoSessions();
  foldSet.activeSessionId = "older";
  const snap = hudSnapshot(foldSet, META);
  assert.equal(snap.activeSessionId, "older", "排序只改显示顺序，不改活跃指针");
});

test("updatedAt 取「种子时间」与「usage 时间」里较新的那个", () => {
  /*
   * 两个来源语义不同但都是「这条会话最近有多新」的证据：
   *   · seededUpdatedAt 来自宿主持久层（冷会话唯一来源）
   *   · lastUsageAt 来自 usage 事件（活跃会话更实时）
   * 只取其中之一都可能排错 —— 实测两条真实会话都只有 lastUsageAt，
   * 而冷会话可能只有种子的时间。
   */
  const foldSet = createFoldSet();

  const a = ensureSession(foldSet, "seeded-newer");
  a.seededUpdatedAt = 9000;
  a.lastUsageAt = 1000;          // 种子更新 → 用 9000

  const b = ensureSession(foldSet, "usage-newer");
  b.seededUpdatedAt = 1000;
  b.lastUsageAt = 8000;          // usage 更新 → 用 8000

  const snap = hudSnapshot(foldSet, META);
  assert.equal(snap.sessions[0].sessionId, "seeded-newer", "谁更新谁在前");
  assert.equal(snap.sessions[0].updatedAt, 9000, "取较新的那个（种子）");
  assert.equal(snap.sessions[1].updatedAt, 8000, "取较新的那个（usage）");
});

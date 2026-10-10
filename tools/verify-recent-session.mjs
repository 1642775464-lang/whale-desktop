/**
 * 用真实会话数据验证排序（真实数据 → 真实排序逻辑）
 *
 * 职责：把运行中的桥返回的两条真实会话，按新逻辑排一遍，
 *       确认「最近一次」排在最前。所属层：工程工具（tools/）
 *
 * 为什么值得单独跑：用户报的「首次打开小窗进的会话不是最近一次」
 * 是**真实数据顺序**问题 —— 单元测试的夹具是我手写的。
 * 这里用桥刚刚返回的真实 lastUsageAt 值核对。
 *
 * 用法：node tools/verify-recent-session.mjs --from-hud
 */

import { createFoldSet, ensureSession } from "../whale-bridge/lib/fold.mjs";
import { hudSnapshot } from "../whale-bridge/lib/fold-view.mjs";

const PORT = Number(process.env.WHALE_BRIDGE_PORT ?? 19387);

const res = await fetch(`http://127.0.0.1:${PORT}/whale/hud`);
if (!res.ok) {
  console.error(`桥没响应（HTTP ${res.status}）—— 确认宿主在跑`);
  process.exit(1);
}
const hud = await res.json();
console.log(`桥返回 ${hud.sessions.length} 条会话，activeSessionId = ${hud.activeSessionId}\n`);

console.log("桥当前给的顺序（可能是旧的插入顺序）：");
for (const s of hud.sessions) {
  console.log(`  ${s.sessionId.padEnd(52)} lastUsageAt=${s.lastUsageAt ?? "无"}`);
}

// 用真实数据喂给新的排序逻辑
const foldSet = createFoldSet();
for (const s of hud.sessions) {
  const fold = ensureSession(foldSet, s.sessionId);
  fold.title = s.title ?? null;
  if (typeof s.lastUsageAt === "number") fold.lastUsageAt = s.lastUsageAt;
}
const sorted = hudSnapshot(foldSet, { version: "t", port: PORT, startedAt: 0, now: Date.now() });

console.log("\n按新逻辑（updatedAt 倒序）排出来：");
for (const s of sorted.sessions) {
  console.log(`  ${s.sessionId.padEnd(52)} updatedAt=${s.updatedAt ?? "无"}`);
}

const first = sorted.sessions[0]?.sessionId ?? null;
console.log("");
if (first === null) {
  console.log("没有会话 —— 无法判断。");
  process.exit(0);
}
// 「最近一次」的判据：有指针时以指针为准（那是宿主的活动事实）
const expected = hud.activeSessionId ?? first;
if (first === expected || hud.activeSessionId === null) {
  console.log(`结论：排序后第一条是 ${first}，与宿主活动一致 ✓`);
  process.exit(0);
}
console.log(
  `结论：排序后第一条是 ${first}，而宿主活跃指针是 ${expected} —— 需要核实`,
);
process.exit(1);

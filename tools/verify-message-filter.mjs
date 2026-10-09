/**
 * 用真实会话日志验证消息过滤（真实数据 → 真实折叠器）
 *
 * 职责：从宿主会话日志取出**全部真实 user/message 事件**，原样喂给
 *       `applyEvent`，比对「该显示的」与「实际显示的」。
 * 所属层：工程工具（tools/）
 *
 * 为什么不能只靠单元测试：单元测试的夹具是我**手写**的，形状对不对
 * 只能靠人去核对。这个脚本用的是用户会话里真实落盘的事件 ——
 * 真实数据里 `source.kind` 有哪些取值、真人消息长什么样，由它说了算。
 *
 * 它已经拦下过一次严重后果：我最初按「有没有 source 字段」判断注入，
 * 而真实日志显示**每一条** user/message 都有 source.kind
 * （真人消息是 `kind: "user"`）—— 那个判据会把用户说的每句话都吃掉。
 * 单元测试当时全绿，因为我的夹具里「真人消息」没有 source 字段。
 *
 * 用法：node tools/verify-message-filter.mjs [sessionId]
 */

import { createFoldSet, applyEvent } from "../whale-bridge/lib/fold.mjs";
import {
  findSessionLog,
  eventsOfType,
  userTextOf,
  sourceKindOf,
} from "./session-log.mjs";

/** 每条事件单独喂一次用的会话 id（只要是个稳定的串就行）。 */
const SID = "session-verify-filter";

const file = findSessionLog(process.argv[2]);
if (file === null) { console.error("找不到会话日志（可传 sessionId 的一部分）"); process.exit(1); }
console.log(`真实数据：${file}`);

const userEvents = eventsOfType(file, "user/message");
console.log(`真实 user/message：${userEvents.length} 条\n`);

// 真实分布（判据就是照着它定的）
const byKind = new Map();
for (const ev of userEvents) {
  const k = sourceKindOf(ev);
  byKind.set(k, (byKind.get(k) ?? 0) + 1);
}
console.log("source.kind 实际分布：");
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

/*
 * 逐条喂给真实的折叠器，看它收下还是丢掉。
 *
 * 每条用**独立的 foldSet**：同一会话里 seq 必须递增，而真实事件的 seq
 * 在大范围里跳跃（中间夹着别的类型）。独立喂 = 只问
 * 「这一条会不会进消息流」，正是要验的事。
 *
 * ⚠️ 判定要区分两种情况，不能都算「被过滤」：
 *   · **有文本却被过滤** → 过滤生效（注入）或过滤误伤（真人）；
 *   · **本来就没有文本**（纯图片消息）→ 折叠器按「没有可显示的文本」跳过，
 *     与过滤无关。真实日志里就有 3 条这样的消息，第一版脚本把它们
 *     错报成「真人消息被丢掉」，白查一轮。
 */
let kept = 0;
let dropped = 0;
let noText = 0;
const droppedKinds = new Map();
const keptKinds = new Map();

for (const ev of userEvents) {
  if (userTextOf(ev) === "") { noText += 1; continue; }
  const foldSet = createFoldSet();
  applyEvent(foldSet, ev, { sessionId: SID });
  const kind = sourceKindOf(ev);
  if (foldSet.sessions.get(SID).tail.length > 0) {
    kept += 1;
    keptKinds.set(kind, (keptKinds.get(kind) ?? 0) + 1);
  } else {
    dropped += 1;
    droppedKinds.set(kind, (droppedKinds.get(kind) ?? 0) + 1);
  }
}

console.log(`\n结果：有文本的 ${kept + dropped} 条 —— 收下 ${kept}，丢掉 ${dropped}`);
console.log(`  （另有 ${noText} 条没有文本块，如纯图片消息，折叠器按无内容跳过）`);
const fmt = (m) => [...m].map(([k, n]) => `${k}×${n}`).join(" ") || "(无)";
console.log("  收下的 kind：", fmt(keptKinds));
console.log("  丢掉的 kind：", fmt(droppedKinds));

// 断言：真人的必须全在，注入的必须全不在
const problems = [];
if (!keptKinds.has("user")) problems.push("真人消息一条都没留下 —— 过滤把用户的话吃掉了");
if (droppedKinds.has("user")) problems.push(`有真人消息被丢掉：user×${droppedKinds.get("user")}`);
for (const [k] of keptKinds) {
  if (k !== "user" && k !== "(无 source)") problems.push(`系统注入「${k}」漏进了消息流`);
}

if (problems.length === 0) {
  console.log("\n结论：真人消息全部保留，系统注入全部过滤 ✓");
  process.exit(0);
}
console.log(`\n结论：${problems.join("；")}`);
process.exit(1);

/**
 * 用真实会话日志验证消息过滤（真实数据 → 真实折叠器）
 *
 * 职责：从宿主会话日志取出**全部真实 user/message 与 assistant/message**，
 *       原样喂给 `applyEvent`，比对「该显示的」与「实际显示的」。
 * 所属层：工程工具（tools/）
 *
 * 为什么不能只靠单元测试：单元测试的夹具是我**手写**的，形状对不对只能靠
 * 人去核对。这个脚本用的是用户会话里真实落盘的事件。它已经拦下过两次
 * 「测试全绿但真实数据是错的」：
 *
 *   1. user/message 的过滤判据 —— 我原按「有没有 source 字段」写，
 *      真实数据显示**每条都有**（真人 = `kind: "user"`），那个判据会把
 *      用户说的每句话都吃掉。
 *   2. assistant/message 的过滤判据 —— 我只过滤了「独立的工具消息」，
 *      而真实数据里 **2097 条是「文本 + 工具」混在一条消息里**，全漏了。
 *
 * 用法：node tools/verify-message-filter.mjs [sessionId]
 */

import { createFoldSet, applyEvent } from "../whale-bridge/lib/fold.mjs";
import { findSessionLog, eventsOfType, userTextOf, sourceKindOf } from "./session-log.mjs";

/** 每条事件单独喂一次用的会话 id（只要是个稳定的串就行）。 */
const SID = "session-verify-filter";

/** 这条 assistant 消息里有没有工具调用块。 */
function hasToolCall(ev) {
  const blocks = ev?.data?.message?.content ?? [];
  return blocks.some((b) => b?.type === "tool-call");
}

/** 取 stream 里 finish 的 reason.kind（取不到返回 null）。 */
function finishKind(ev) {
  const stream = ev?.data?.stream ?? [];
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i]?.chunk;
    if (chunk?.type === "finish") return chunk.reason?.kind ?? null;
  }
  return null;
}

/** 取 assistant 消息的可见文本。 */
function assistantText(ev) {
  return (ev?.data?.message?.content ?? [])
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
}

const file = findSessionLog(process.argv[2]);
if (file === null) { console.error("找不到会话日志（可传 sessionId 的一部分）"); process.exit(1); }
console.log(`真实数据：${file}\n`);

const problems = [];

// ── 一、user/message ──────────────────────────────────────────
const userEvents = eventsOfType(file, "user/message");
const byKind = new Map();
for (const ev of userEvents) {
  const k = sourceKindOf(ev);
  byKind.set(k, (byKind.get(k) ?? 0) + 1);
}
console.log(`user/message ${userEvents.length} 条，source.kind 分布：`);
for (const [k, n] of [...byKind].sort((a, b) => b[1] - a[1])) console.log(`  ${k}: ${n}`);

let uKept = 0;
let uDropped = 0;
let uNoText = 0;
const uKeptKinds = new Map();
const uDroppedKinds = new Map();
for (const ev of userEvents) {
  if (userTextOf(ev) === "") { uNoText += 1; continue; }
  const foldSet = createFoldSet();
  applyEvent(foldSet, ev, { sessionId: SID });
  const kind = sourceKindOf(ev);
  if (foldSet.sessions.get(SID).tail.length > 0) {
    uKept += 1;
    uKeptKinds.set(kind, (uKeptKinds.get(kind) ?? 0) + 1);
  } else {
    uDropped += 1;
    uDroppedKinds.set(kind, (uDroppedKinds.get(kind) ?? 0) + 1);
  }
}
const fmt = (m) => [...m].map(([k, n]) => `${k}×${n}`).join(" ") || "(无)";
console.log(`\n  有文本的 ${uKept + uDropped} 条 —— 收下 ${uKept}，丢掉 ${uDropped}`);
console.log(`  （另 ${uNoText} 条没有文本块，如纯图片消息，按无内容跳过）`);
console.log("  收下：", fmt(uKeptKinds));
console.log("  丢掉：", fmt(uDroppedKinds));
if (!uKeptKinds.has("user")) problems.push("真人消息一条都没留下");
if (uDroppedKinds.has("user")) problems.push(`真人消息被丢掉 ${uDroppedKinds.get("user")} 条`);

// ── 二、assistant/message ────────────────────────────────────
const asstEvents = eventsOfType(file, "assistant/message");
console.log(`\nassistant/message ${asstEvents.length} 条`);

const shapes = new Map();
for (const ev of asstEvents) {
  const t = assistantText(ev) !== "";
  const c = hasToolCall(ev);
  const key = `${t ? "文本" : "无文本"}+${c ? "工具" : "无工具"}`;
  shapes.set(key, (shapes.get(key) ?? 0) + 1);
}
console.log("  形状分布：");
for (const [k, n] of [...shapes].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${n}`);

let aKept = 0;
let aDropped = 0;
let aNoText = 0;
const aKeptShapes = new Map();
const aDroppedShapes = new Map();
for (const ev of asstEvents) {
  const text = assistantText(ev);
  if (text === "") { aNoText += 1; continue; }
  const foldSet = createFoldSet();
  applyEvent(foldSet, ev, { sessionId: SID });
  const shape = `${hasToolCall(ev) ? "带工具" : "无工具"}/${finishKind(ev) ?? "无 finish"}`;
  if (foldSet.sessions.get(SID).tail.length > 0) {
    aKept += 1;
    aKeptShapes.set(shape, (aKeptShapes.get(shape) ?? 0) + 1);
  } else {
    aDropped += 1;
    aDroppedShapes.set(shape, (aDroppedShapes.get(shape) ?? 0) + 1);
  }
}
console.log(`\n  有文本的 ${aKept + aDropped} 条 —— 收下 ${aKept}，丢掉 ${aDropped}`);
console.log(`  （另 ${aNoText} 条没有文本）`);
console.log("  收下：", fmt(aKeptShapes));
console.log("  丢掉：", fmt(aDroppedShapes));

// 断言：带工具的一条都不该显示
for (const [shape, n] of aKeptShapes) {
  if (shape.startsWith("带工具")) problems.push(`带工具的中间旁白漏了 ${n} 条（形状 ${shape}）`);
}
// 断言：无工具但 finish=tool-calls 的也不该显示
for (const [shape, n] of aKeptShapes) {
  if (shape.includes("tool-calls")) problems.push(`finish=tool-calls 的漏了 ${n} 条（形状 ${shape}）`);
}

console.log("");
if (problems.length === 0) {
  console.log("结论：真人消息与最终回答全部保留，过程消息全部过滤 ✓");
  process.exit(0);
}
console.log(`结论：${problems.join("；")}`);
process.exit(1);

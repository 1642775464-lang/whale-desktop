/**
 * 看一条系统注入事件的原始形态
 *
 * 职责：从真实会话日志里找出注入事件，把它的 `data` 原样打出来 ——
 *       用来**核对过滤判据**在真实数据里站不站得住。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须看真实数据：判据（`data.source.kind`）是我从 DSH 源码里
 * 读出来的。源码说 `event.data.source.kind === name` 表示注入，
 * 但**真实落盘的事件里字段叫什么、嵌在哪一层**，只有日志能给准话。
 * 靠猜字段名的过滤写错了不会报错，只会「静默地什么都没过滤掉」。
 *
 * 用法：node tools/find-injection-event.mjs [sessionId]
 */

import { findSessionLog, eventsOfType, sourceKindOf } from "./session-log.mjs";

const file = findSessionLog(process.argv[2]);
if (file === null) { console.error("找不到会话日志（可传 sessionId 的一部分）"); process.exit(1); }
console.log(`真实数据：${file}\n`);

const userMsgs = eventsOfType(file, "user/message");
const injected = userMsgs.filter((ev) => {
  const k = sourceKindOf(ev);
  return k !== "user" && k !== "(无 source)";
});

console.log(`注入类事件 ${injected.length} 条，按来源分组：`);
const byKind = new Map();
for (const ev of injected) {
  const k = sourceKindOf(ev);
  if (!byKind.has(k)) byKind.set(k, []);
  byKind.get(k).push(ev);
}
for (const [k, list] of byKind) console.log(`  ${k}: ${list.length} 条`);

// 挑几种各打一条完整结构
const demos = ["time-context", "dsh-mnemon", "model-selection"];
for (const kind of demos) {
  const list = byKind.get(kind);
  if (list === undefined) continue;
  const ev = list[0];
  console.log(`\n=== ${kind} 的首条（seq ${ev.seq}）===`);
  console.log("type:", ev.type);
  console.log("data 顶层键:", Object.keys(ev.data ?? {}).join(", "));
  console.log("data.source =", JSON.stringify(ev.data?.source).slice(0, 300));
  console.log("data 完整（截断 400 字）:", JSON.stringify(ev.data).slice(0, 400));
}

// 关键结论
console.log("\n判据核对：");
console.log("  真人标识 = source.kind === \"user\"");
console.log(`  实测真人 ${byKind.has("user") ? "已被归入注入统计?" : userMsgs.length - injected.length} 条，注入 ${injected.length} 条`);

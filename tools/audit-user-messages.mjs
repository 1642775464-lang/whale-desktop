/**
 * 查真实 user/message 的 source 字段分布
 *
 * 职责：回答「过滤判据该怎么写」这个问题 —— 真人消息带不带 source、
 *       系统注入的 source.kind 有哪些取值。所属层：工程工具（tools/）
 *
 * ⚠️ 这个脚本改过一次判据，值得记下来：
 *   我最初以为「真人消息没有 source 字段」，于是判据写成
 *   「有 source 就当注入」。跑一次真实数据就发现**每条都有** source.kind，
 *   真人消息是 `kind: "user"` —— 那个判据会把用户说的每句话都吃掉。
 *   单元测试当时全绿，因为夹具里的「真人消息」没有 source 字段。
 *
 * 用法：node tools/audit-user-messages.mjs [sessionId]
 */

import { findSessionLog, eventsOfType, sourceKindOf, userTextOf } from "./session-log.mjs";

const file = findSessionLog(process.argv[2]);
if (file === null) { console.error("找不到会话日志（可传 sessionId 的一部分）"); process.exit(1); }
console.log(`真实数据：${file}\n`);

const userMsgs = eventsOfType(file, "user/message");
console.log(`user/message 共 ${userMsgs.length} 条`);

const kinds = new Map();
let noSource = 0;
for (const ev of userMsgs) {
  const k = sourceKindOf(ev);
  if (k === "(无 source)") noSource += 1;
  kinds.set(k, (kinds.get(k) ?? 0) + 1);
}

console.log(`  不带 source.kind：${noSource} 条`);
console.log("  source.kind 分布：");
for (const [k, n] of [...kinds].sort((a, b) => b[1] - a[1])) console.log(`    ${k}: ${n}`);

console.log("\n真人消息样例（kind = user，必须保留）：");
const realOnes = userMsgs.filter((ev) => sourceKindOf(ev) === "user");
for (const ev of realOnes.slice(0, 5)) {
  console.log(`  - ${JSON.stringify(userTextOf(ev).slice(0, 50))}`);
}

console.log("\n系统注入样例（必须过滤）：");
const injected = userMsgs.filter((ev) => {
  const k = sourceKindOf(ev);
  return k !== "user" && k !== "(无 source)";
});
for (const ev of injected.slice(0, 5)) {
  console.log(`  - [${sourceKindOf(ev)}] ${JSON.stringify(userTextOf(ev).slice(0, 50))}`);
}

// 判据安全性：真人消息里有没有可能被误判成注入的
const danger = realOnes.filter((ev) => ev.data?.source?.kind !== "user").length;
console.log(
  danger === 0
    ? "\n判据安全：`source.kind === \"user\"` 就是真人，按它过滤不会误伤"
    : "\n⚠️ 有真人消息的 source.kind 不是 user，判据需要复核",
);

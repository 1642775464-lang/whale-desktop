/**
 * 消息来源甄别：真人说的话 vs 系统注入
 *
 * 职责：钉住「只有人说的话才进消息流」这条规则。
 * 所属层：测试（tests/unit）
 *
 * 用户报：小窗里冒出一条
 * 「Time sampled while preparing turn 140, step 1: 2026-10-09T03:38:28-04:00…」
 * —— 那是宿主在发起请求前注入的**运行时上下文**，不是他说的话。
 * 它和真正的对话混在一条流里，看着像自己发的。
 *
 * 从 fold.test.mjs 拆出来，是因为文件顶到了 500 行上限（开发规范 强制 14），
 * 而这一块本身就是一个独立职责（甄别来源），与折叠器的
 * seq 去重 / tail 容量 / phase 流转不是一回事。
 *
 * ## 判据是查真实日志定下来的
 *
 * 判据来自**真实会话日志**（386 条 user/message，全部带 `source.kind`）：
 *
 *     user 138 / time-context 126 / dsh-mnemon 45 / model-selection 36
 *     user-approval 13 / runtime-context 13 / skill-catalog 7 /
 *     compact-checkpoint 4 / whale-hud 3 / tool-jobs 1
 *
 * 只有 `kind === "user"` 是真人，其余都是系统注入。
 *
 * ⚠️ **夹具必须按真实形状写**：真人消息也带 `source.kind = "user"`。
 * 第一版夹具里的「真人消息」没有 source 字段 —— 于是「有 source 就算注入」
 * 这个错判据**照样全绿**，而它会把用户说的每一句话都吃掉。
 * 是 `tools/audit-user-messages.mjs` 去查真实日志才把这个错拦下来的。
 * 教训：夹具形状与真实数据不符时，测试写再多也守不住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createFoldSet,
  applyEvent,
  applyEvents,
} from "../../whale-bridge/lib/fold.mjs";

const SID = "session-test-injection";

/** 造一条真人用户消息（形状取自真实日志）。 */
function realUserEvent(seq, text) {
  return {
    seq,
    type: "user/message",
    data: {
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text }],
    },
  };
}

/** 造一条系统注入消息（形状取自真实日志）。 */
function injectedEvent(seq, kind, text) {
  return {
    seq,
    type: "user/message",
    data: {
      role: "user",
      source: { kind, form: "snapshot", sections: [{ name: kind, text }] },
      content: [{ type: "text", text }],
    },
  };
}

/** 跑一条事件，取回该会话的折叠态。 */
function foldAfter(events) {
  const foldSet = createFoldSet();
  if (Array.isArray(events)) applyEvents(foldSet, events, { sessionId: SID });
  else applyEvent(foldSet, events, { sessionId: SID });
  return foldSet.sessions.get(SID);
}

test("带 source 标记的系统注入不当作用户消息（用户报的「Time sampled…」）", () => {
  const fold = foldAfter(
    injectedEvent(1, "time-context", "Time sampled while preparing turn 140, step 1: 2026-10-09T03:38:28-04:00\nElapsed: 19m 15s."),
  );
  assert.equal(
    fold.tail.length,
    0,
    "系统注入不该进消息尾巴 —— 它会在小窗里冒充用户说的话",
  );
});

test("真人消息（source.kind = user）必须留下", () => {
  // ⚠️ 这条是最重要的防线。
  // 真实日志里**每一条** user/message 都有 source.kind，
  // 写成「有 source 就当注入」会把用户说的每句话都吃掉。
  const fold = foldAfter(realUserEvent(1, "测试"));
  assert.equal(fold.tail.length, 1, "真人消息不能因为带 source 就被丢掉");
  assert.equal(fold.tail[0].text, "测试");
});

test("真人消息与注入混在一起时，只留真人那条", () => {
  const fold = foldAfter([
    realUserEvent(1, "测试"),
    injectedEvent(2, "time-context", "Time sampled …"),
  ]);
  assert.equal(fold.tail.length, 1, "只该留下真人那条");
  assert.equal(fold.tail[0].text, "测试");
});

test("各类系统注入都不进消息流（按真实日志里的取值逐个验）", () => {
  // 这些取值全部来自真实日志的 source.kind 分布 —— 不是编的。
  const kinds = [
    "time-context", "dsh-mnemon", "model-selection", "user-approval",
    "runtime-context", "skill-catalog", "compact-checkpoint", "whale-hud", "tool-jobs",
  ];
  for (const kind of kinds) {
    const fold = foldAfter(injectedEvent(1, kind, `注入内容（${kind}）`));
    assert.equal(fold.tail.length, 0, `${kind} 不该进消息流`);
  }
});

test("没有 source 字段的消息照常进入（保守：不认识的形状按真人处理）", () => {
  // 宿主将来若改了事件形状、去掉了 source，宁可多显示一条，
  // 也不要把用户的话静默吃掉。
  const fold = foldAfter({
    seq: 1,
    type: "user/message",
    data: { content: [{ type: "text", text: "正常消息" }] },
  });
  assert.equal(fold.tail.length, 1, "没有 source 标记的按真人处理");
  assert.equal(fold.tail[0].text, "正常消息");
});

test("source 存在但不是对象（畸形数据）也不当注入处理", () => {
  const fold = foldAfter({
    seq: 1,
    type: "user/message",
    data: { source: "oops", content: [{ type: "text", text: "真人消息" }] },
  });
  assert.equal(fold.tail.length, 1, "畸形 source 不该让消息消失");
});

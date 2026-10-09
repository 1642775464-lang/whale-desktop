/**
 * 助手消息的可见性：最终回答 vs 中间旁白
 *
 * 职责：钉住「只有这一轮说完了的那条才显示成助手的回答」。
 * 所属层：测试（tests/unit）
 *
 * 用户报：小窗里冒出「课 审计确认判据安全。跑全量 + lint + gate.」
 * 这种句子 —— 那是边干活边说的话，不是给他的回答。
 *
 * 判据取真实会话日志（tools/verify-message-filter.mjs 查出来的）：
 *   assistant/message 的 `stream` 里最后一个 chunk 是 `finish`，
 *   它的 `reason.kind` 为 `stop` 时表示**这一轮说完了**（最终回答）；
 *   为 `tool-calls` 时表示**还要继续干活**（中间旁白 + 工具调用）。
 *
 * 真实分布（同一份日志，4114 条 assistant/message）：
 *
 *     文本 + 工具  2102 条 → finish = tool-calls   ← 中间旁白，占绝大多数
 *     纯工具       1907 条 → finish = tool-calls
 *     纯文本        105 条 → finish = stop         ← 真正的回答
 *
 * ⚠️ 上一轮只过滤了「独立的工具消息」，漏掉了「文本与工具混在一条消息里」
 * 这种形状 —— 而它才是绝大多数。**夹具不够真实，过滤就漏了一大片。**
 * 所以这里的夹具按真实形状写：带工具调用的消息里**同时**有文本块。
 *
 * 从 fold.test.mjs 拆出来（文件顶到 500 行上限，开发规范 强制 14）：
 * 这一块是**消息可见性**，与折叠器的 seq 去重 / tail 容量 / phase 流转
 * 不是一回事。姊妹文件是 fold-injection.test.mjs（用户消息的可见性）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createFoldSet, applyEvent } from "../../whale-bridge/lib/fold.mjs";

const SID = "session-test-assistant-visibility";

/** 跑一条事件，取回该会话的折叠态。 */
function foldAfter(event) {
  const foldSet = createFoldSet();
  applyEvent(foldSet, event, { sessionId: SID });
  return foldSet.sessions.get(SID);
}

/** 造一条带 stream 的 assistant 消息（finish 决定它是不是最终回答）。 */
function assistantWithFinish(seq, text, finishKind) {
  return {
    seq,
    type: "assistant/message",
    data: {
      message: { content: [{ type: "text", text }] },
      stream: [
        { type: "chunk", chunk: { type: "block-start", blockType: "text" } },
        { type: "chunk", chunk: { type: "finish", reason: { kind: finishKind } } },
      ],
    },
  };
}

test("assistant 只有文本块时进 tail，纯工具调用不进", () => {
  const foldSet = createFoldSet();
  applyEvent(foldSet, assistantWithFinish(1, "有话说", "stop"), { sessionId: SID });
  applyEvent(
    foldSet,
    {
      seq: 2,
      type: "assistant/message",
      data: { usage: {}, message: { content: [{ type: "tool-call", name: "pwsh", arguments: "{}" }] } },
    },
    { sessionId: SID },
  );
  const fold = foldSet.sessions.get(SID);
  assert.equal(fold.tail.length, 1, "只有那条最终回答该留下");
  assert.equal(fold.tail[0].text, "有话说");
});

test("中间旁白（finish = tool-calls）不进消息流", () => {
  const fold = foldAfter(assistantWithFinish(1, "我先看看这个文件。", "tool-calls"));
  assert.equal(fold.tail.length, 0, "还在干活时的旁白不该当成回答显示");
});

test("最终回答（finish = stop）进消息流", () => {
  const fold = foldAfter(assistantWithFinish(1, "改好了，两处都动了。", "stop"));
  assert.equal(fold.tail.length, 1, "说完了的那条要显示");
  assert.equal(fold.tail[0].text, "改好了，两处都动了。");
});

test("文本与工具混在一条消息里（finish = tool-calls）也不显示", () => {
  // 这是真实日志里**最多**的形状（2102 条），上一轮全漏了。
  const fold = foldAfter({
    seq: 1,
    type: "assistant/message",
    data: {
      message: {
        content: [
          { type: "text", text: "我先把文件读出来。" },
          { type: "tool-call", name: "read" },
        ],
      },
      stream: [{ type: "chunk", chunk: { type: "finish", reason: { kind: "tool-calls" } } }],
    },
  });
  assert.equal(fold.tail.length, 0, "带工具调用的那条属于过程，不该显示");
});

test("带工具调用但 stream 被截断时也要拦住（只靠 finish 会漏）", () => {
  // 真实日志里有些消息的 stream 看不到 finish —— 判据必须不依赖它。
  const fold = foldAfter({
    seq: 1,
    type: "assistant/message",
    data: {
      message: {
        content: [
          { type: "text", text: "旁白" },
          { type: "tool-call", name: "read" },
        ],
      },
    },
  });
  assert.equal(fold.tail.length, 0, "消息里有工具调用就说明是过程，不该显示");
});

test("没有 stream 字段时按「最终回答」处理（保守：宁可多显示）", () => {
  // 宿主将来若改了事件形状、去掉了 stream，宁可多显示一条，
  // 也不要把助手的回答静默吃掉。
  const fold = foldAfter({
    seq: 1,
    type: "assistant/message",
    data: { message: { content: [{ type: "text", text: "没有 stream 的回答" }] } },
  });
  assert.equal(fold.tail.length, 1, "认不出形状时按最终回答处理");
});

test("stream 里没有 finish chunk 时也按最终回答处理（保守）", () => {
  const fold = foldAfter({
    seq: 1,
    type: "assistant/message",
    data: {
      message: { content: [{ type: "text", text: "回答了" }] },
      stream: [{ type: "chunk", chunk: { type: "block-start", blockType: "text" } }],
    },
  });
  assert.equal(fold.tail.length, 1, "看不到 finish 时不该把回答吃掉");
});

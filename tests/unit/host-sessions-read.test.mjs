/**
 * 冷会话种子：小窗启动时默认绑上「最近一次会话」并回显其历史
 *
 * 职责：钉住两件事——
 *   1. 桥能从宿主的**持久层**读到会话清单与历史事件（不激活 agent）
 *   2. 折叠器为空时会被种上最近一次会话，小窗因此拿得到 sessionId
 * 所属层：测试（tests/unit）
 *
 * 为什么值得专门一组测试（真实事故）：
 * 用户报「权限显示读不到档位清单、思考强度点了没反应」。
 * 三个浮层唯一的共同依赖是 sessionId，而它的来源链断在桥这里：
 *
 *   折叠器只由 session/event 事件填充
 *     → 宿主重启后那条会话是**空闲的**，不再产生事件
 *     → 折叠器为空、activeSessionId 恒 null
 *     → 小窗 fetchActiveSessionId 拿不到 id → 权限/切模型/发命令全部 bad-request
 *
 * 而且**轮询救不了**：会话继续空闲就永远没有事件，这是永久性空窗。
 * 宿主的 sessions.list() 注释写明只含 "All live sessions"，冷会话连清单都没有
 * —— 必须走 sessionController.list / inspect（"without activating an Agent"）。
 *
 * ── 契约来源（逐字段核过宿主已发布代码，不是猜的）──
 *
 *   sessionController.list(_request, signal)
 *     → { items: [{ sessionId, updatedAt, agentAvailable, running, blank,
 *                  cwd?, projections? }] }
 *     宿主内部 `items.sort((l, r) => r.updatedAt - l.updatedAt)`
 *     → **第一项就是最近一次会话**，桥不需要自己再排
 *
 *   sessionController.inspect(sessionId, signal)
 *     → { meta, inheritedEventCount, events }
 *     事件形状 `{ seq, type, data, time }` —— 与折叠器吃的一字不差
 *     （宿主 dsh-session-query 里就是 `event.data.content`、
 *       `event.data.message.content`，类型名 user/message、assistant/message
 *       等也完全相同）
 *
 *   ⚠️ 冷会话行**没有 title**：宿主的 `listFields(header)` 只返回
 *   parentSessionId / origin / cwd。标题在 `projections.values.title`
 *   （dsh-session-title 注册的投影）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHostAccess } from "../../whale-bridge/lib/host-ctx.mjs";

/** 造一个带 ctx.get 的假宿主 ctx。 */
function gettableCtx(services, injected = []) {
  const declared = new Set(injected);
  return {
    on: () => () => {},
    get: (name) => (Object.hasOwn(services, name) ? services[name] : undefined),
    ...Object.fromEntries(Object.entries(services).filter(([n]) => declared.has(n))),
  };
}

// ── 宿主侧读取：会话清单与历史事件 ────────────────────

test("recentSessions：走 sessionController.list，并传 request + AbortSignal", async () => {
  let seen = null;
  const host = createHostAccess(gettableCtx({
    sessionController: {
      // 真实签名 list(_request, signal)：两个参数都在
      list: async (request, signal) => {
        seen = { request, signal };
        return { items: [{ sessionId: "a", updatedAt: 2 }, { sessionId: "b", updatedAt: 9 }] };
      },
    },
  }));

  const out = await host.recentSessions();
  assert.ok(seen.request !== undefined && seen.request !== null, "第一参要传（哪怕空对象）");
  assert.ok(seen.signal instanceof AbortSignal, "第二参要 AbortSignal，否则宿主 signal.throwIfAborted 会崩");
  // 顺序以宿主给的为准（它按 updatedAt 降序排过）
  assert.deepEqual(out.map((s) => s.sessionId), ["a", "b"], "桥不能自己重排——以宿主口径为准");
});

test("recentSessions：归一化出 sessionId 与标题（标题在 projections.values.title）", async () => {
  const host = createHostAccess(gettableCtx({
    sessionController: {
      list: async () => ({
        items: [
          {
            sessionId: "s1",
            updatedAt: 100,
            cwd: "D:\\x",
            running: false,
            projections: { values: { title: "从PRD重新实施" } },
          },
          { sessionId: "s2", updatedAt: 90 },
        ],
      }),
    },
  }));

  const out = await host.recentSessions();
  assert.equal(out[0].sessionId, "s1");
  assert.equal(out[0].title, "从PRD重新实施", "标题要从投影里取");
  assert.equal(out[0].cwd, "D:\\x");
  assert.equal(out[1].title, null, "取不到给 null，不编造");
});

test("recentSessions：兼容裸数组返回（宿主版本差异不该让桥抛错）", async () => {
  const host = createHostAccess(gettableCtx({
    sessionController: {
      list: async () => [{ sessionId: "x", title: "裸数组" }],
    },
  }));
  const out = await host.recentSessions();
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "裸数组");
});

test("recentSessions：没有 sessionController 或抛错时给空数组（不抛）", async () => {
  assert.deepEqual(await createHostAccess(gettableCtx({})).recentSessions(), []);
  const bad = createHostAccess(gettableCtx({
    sessionController: { list: async () => { throw new Error("持久层不可用"); } },
  }));
  assert.deepEqual(await bad.recentSessions(), []);
});

test("sessionEvents：走 inspect(sessionId, signal)，事件**原样**交给折叠器", async () => {
  let seenArgs = null;
  // 持久层的真实形状：data（不是 payload）、type 名与折叠器一致
  const events = [
    { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "你好" }] }, time: 10 },
    { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "在的" }] } }, time: 11 },
  ];
  const host = createHostAccess(gettableCtx({
    sessionController: {
      inspect: async (sessionId, signal) => {
        seenArgs = { sessionId, signal };
        return { meta: { id: sessionId }, inheritedEventCount: 0, events };
      },
    },
  }));

  const out = await host.sessionEvents("s1");
  assert.equal(seenArgs.sessionId, "s1");
  assert.ok(seenArgs.signal instanceof AbortSignal, "inspect 第二参要 AbortSignal");
  // 关键：**不做任何形状转换**。持久层已经用 event.data，与折叠器口径相同；
  // 多一层「归一化」只会制造两个真相。
  assert.equal(out[0], events[0], "事件必须是宿主给的那个对象（原样透传）");
  assert.equal(out.length, 2);
});

test("sessionEvents：会话不存在时给空数组，不抛错", async () => {
  const host = createHostAccess(gettableCtx({
    sessionController: { inspect: async () => { throw new Error("session not found"); } },
  }));
  assert.deepEqual(await host.sessionEvents("没有"), []);
});

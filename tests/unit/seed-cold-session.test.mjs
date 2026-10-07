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
import { createColdSeed } from "../../whale-bridge/lib/seed.mjs";
import { createFoldSet, applyEvent } from "../../whale-bridge/lib/fold.mjs";

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

// ── 种子：把最近一次会话折进折叠器 ────────────────────

test("seedRecent：折叠器为空时绑上最近一次会话，历史消息可回显", async () => {
  const foldSet = createFoldSet();
  const host = {
    recentSessions: async () => [{ sessionId: "s1", title: "从PRD重新实施" }],
    sessionEvents: async () => [
      { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "第一条" }] } },
      { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "第二条" }] } } },
    ],
  };

  const seed = createColdSeed({ host, foldSet, log: () => {} });
  const picked = await seed.seedRecent();

  assert.equal(picked, "s1", "应返回被种上的会话 id");
  assert.equal(foldSet.activeSessionId, "s1", "活跃指针必须挪过去，否则小窗还是拿不到");
  const fold = foldSet.sessions.get("s1");
  assert.ok(fold !== undefined, "折叠器里要有这个会话");
  assert.equal(fold.title, "从PRD重新实施", "冷会话没有 title 事件，标题要从清单带上");
  assert.deepEqual(fold.tail.map((t) => t.text), ["第一条", "第二条"], "历史消息要能回显");
});

test("seedRecent：复用折叠器本体，不自己实现一套折法", async () => {
  // 种子必须把事件交给 applyEvent —— 自己再写一遍折法等于维护第二份逻辑，
  // 宿主加一个事件类型就会让「热路径」和「冷路径」表现不一致。
  const foldSet = createFoldSet();
  const events = [
    { seq: 1, type: "turn/start", data: {} },
    { seq: 2, type: "step/start", data: {} },
    { seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "甲" }] } } },
    { seq: 4, type: "turn/end", data: { reason: { kind: "completed" } } },
  ];
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s1" }],
      sessionEvents: async () => events,
    },
  });
  await seed.seedRecent();

  // 与直接折同一批事件的折叠态对齐（回合数、步数、running 归位）
  const reference = createFoldSet();
  for (const e of events) applyEvent(reference, e, { sessionId: "s1" });

  const fold = foldSet.sessions.get("s1");
  assert.equal(fold.turns, reference.sessions.get("s1").turns, "回合计数要和折叠器一致");
  assert.equal(fold.steps, reference.sessions.get("s1").steps, "步数要和折叠器一致");
  assert.equal(fold.running, false, "turn/end 折过之后不该显示运行中");
});

test("seedRecent：已经种过就不再读持久层（每次请求都读代价太大）", async () => {
  let reads = 0;
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s1" }],
      sessionEvents: async () => { reads += 1; return []; },
    },
  });

  await seed.seedRecent();
  await seed.seedRecent();
  await seed.seedRecent();
  assert.equal(reads, 1, "同一会话只读一次持久层");
});

test("seedRecent：折叠器已经有会话时不抢已有状态", async () => {
  const foldSet = createFoldSet();
  // 模拟「会话正在跑、事件流已经把它填上了」
  applyEvent(foldSet, { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "实时消息" }] } }, { sessionId: "live" });
  foldSet.activeSessionId = "live";

  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "cold" }],
      sessionEvents: async () => [{ seq: 1, type: "user/message", data: { content: [{ type: "text", text: "冷会话" }] } }],
    },
  });

  const picked = await seed.seedRecent();
  assert.equal(picked, null, "已有会话就不该再种");
  assert.equal(foldSet.activeSessionId, "live", "不能把活跃指针从实时会话抢走");
});

test("ensureSeeded：小窗点名某条冷会话时也要能把它种上", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      // 点名种会话的前提是**持久层清单认识它**，所以清单要有这一行
      recentSessions: async () => [{ sessionId: "s-cold", title: "历史里的会话" }],
      sessionEvents: async () => [{ seq: 1, type: "user/message", data: { content: [{ type: "text", text: "冷启动前的话" }] } }],
    },
  });

  assert.equal(await seed.ensureSeeded("s-cold"), true);
  const fold = foldSet.sessions.get("s-cold");
  assert.ok(fold !== undefined, "点名的会话也要能被种上");
  assert.equal(fold.tail[0].text, "冷启动前的话");
  assert.equal(fold.title, "历史里的会话", "标题从清单带上");
});

test("ensureSeeded：宿主持久层不认识该 id 时给 false（保住 404）", async () => {
  // 不加这道校验时，任意乱写的 id 也会被建出一个 fold 并返回 true，
  // 于是 /whale/panel 对不存在的会话**静默返回空面板而不是 404**——
  // 把「会话不存在」与「会话是空的」混成一件，而这两件必须区分。
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s-real" }],
      sessionEvents: async () => [{ seq: 1, type: "user/message", data: { content: [{ type: "text", text: "别的会话" }] } }],
    },
  });

  assert.equal(await seed.ensureSeeded("编的一个id"), false);
  assert.equal(foldSet.sessions.has("编的一个id"), false, "不该为不存在的会话建折叠态");
});

test("未知事件类型不崩，且能从折叠器计数里看见（形状错了不会静默）", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s1" }],
      sessionEvents: async () => [
        { seq: 1, type: "some/newtype", data: {} },
        { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "还能用" }] } } },
      ],
    },
  });

  await seed.seedRecent();
  assert.ok(foldSet.unknownTypes >= 1, "未知类型要能被观测到——否则形状错了就是静默失败");
  assert.equal(foldSet.sessions.get("s1").tail[0].text, "还能用", "未知类型不能影响其它事件");
});

test("冷会话折完不该点亮「回合运行中」（持久日志可能停在 turn/start）", async () => {
  // 上次的宿主进程可能在回合中途被杀掉，落盘日志的最后一条就是 turn/start。
  // 照原样折会把 running 置真 → 小窗显示「回合运行中」、中断键点亮、
  // 而实际上**根本没有活的 agent 在跑**。宿主那行的 running 字段才是事实。
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s1", running: false }],
      sessionEvents: async () => [
        { seq: 1, type: "turn/start", data: {} },
        { seq: 2, type: "assistant/message", data: { message: { content: [{ type: "text", text: "说到一半" }] } } },
      ],
    },
  });
  await seed.seedRecent();

  const fold = foldSet.sessions.get("s1");
  assert.equal(fold.tail[0].text, "说到一半", "历史消息仍要回显");
  assert.equal(fold.running, false, "宿主说没在跑，折完也不该点亮中断键");
});

test("ensureSeeded：同一个查不到的 id 不反复读持久层", async () => {
  // 与 seedRecent 同一类风险：小窗会重试同一个 sessionId
  //（比如它在面板里握着一条已被归档的会话）。
  // 不限流就是每次重试都读一遍宿主持久层清单。
  let reads = 0;
  let now = 1_000;
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    now: () => now,
    host: {
      recentSessions: async () => { reads += 1; return [{ sessionId: "s-real" }]; },
      sessionEvents: async () => [],
    },
  });

  assert.equal(await seed.ensureSeeded("s-gone"), false);
  assert.equal(await seed.ensureSeeded("s-gone"), false);
  assert.equal(reads, 1, "查不到的 id 要进冷却，不能每问一次读一次");

  now += 61_000;
  assert.equal(await seed.ensureSeeded("s-gone"), false);
  assert.equal(reads, 2, "冷却过后要重试（用户可能刚把它恢复/重命名）");
});

test("ensureSeeded：冷却不影响能查到的 id", async () => {
  // 反向确认限流没把正常路径挡死。
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s1", title: "甲" }],
      sessionEvents: async () => [{ seq: 1, type: "user/message", data: { content: [{ type: "text", text: "话" }] } }],
    },
  });
  assert.equal(await seed.ensureSeeded("s1"), true);
  assert.equal(foldSet.sessions.get("s1").tail[0].text, "话");
});

test("持久层一条会话都没有时，短时间内不反复读（小窗每 5 秒轮询 hud）", async () => {
  // 这是种子自己引入的新风险：折叠器为空是「没会话」的稳定状态，
  // 而小窗每 5 秒问一次 hud —— 不设限就是每 5 秒读一次宿主持久层，
  // 常驻空窗会变成持续的后台负载。
  let reads = 0;
  let now = 1_000;
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    now: () => now,
    host: { recentSessions: async () => { reads += 1; return []; }, sessionEvents: async () => [] },
  });

  await seed.seedRecent();
  await seed.seedRecent();
  assert.equal(reads, 1, "空结果也要限流——否则常驻空窗会持续读持久层");

  // 过了冷却期就该重试：用户可能在这期间开了会话
  now += 61_000;
  await seed.seedRecent();
  assert.equal(reads, 2, "冷却期过后要重试，不能永久封死");
});

test("种成功的那个会话不必再限流：它已在折叠器里，走不到读持久层那步", async () => {
  // 反向确认限流不会把正常路径挡死：种上之后 seedRecent 开头就让路，
  // 不消耗冷却名额。
  let reads = 0;
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => { reads += 1; return [{ sessionId: "s1" }]; },
      sessionEvents: async () => [],
    },
  });

  await seed.seedRecent();
  assert.equal(reads, 1);
  await seed.seedRecent();
  assert.equal(reads, 1, "折叠器已有会话就不该再读持久层");
  assert.equal(foldSet.sessions.size, 1);
});

test("持久层没有任何会话时如实给 null（小窗保持待机，不编造）", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: { recentSessions: async () => [], sessionEvents: async () => [] },
  });
  assert.equal(await seed.seedRecent(), null);
  assert.equal(foldSet.activeSessionId, null, "没会话就不该设活跃指针");
});

test("持久层读取失败不能打断请求：seed 抛错被吞并返回 null", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => { throw new Error("宿主挂了"); },
      sessionEvents: async () => [],
    },
  });
  assert.equal(await seed.seedRecent(), null, "种子失败要让调用方走降级，不是把异常冒到 HTTP 层");
});

/**
 * 冷会话种子：折叠器为空时绑上「最近一次会话」并回显历史
 *
 * 职责：钉住种子的**行为**——绑上谁、折什么、什么时候让路、什么时候限流、
 *       失败怎么降级、冷会话的 running 怎么归位。
 * 所属层：测试（tests/unit）
 *
 * 宿主侧「怎么从持久层读」的契约在另一份：
 *   tests/unit/host-sessions-read.test.mjs
 * 分开的理由：两者的失败原因不同（一个是宿主接口形状变了，
 * 一个是种子的判断逻辑错了），混在一起会让红了的用例指错方向。
 *
 * 为什么需要这个种子（真实事故）：
 * 用户报「权限显示读不到档位清单、思考强度点了没反应」。三个浮层唯一的
 * 共同依赖是 sessionId，而它的来源链断在桥这里：
 *
 *   折叠器只由 session/event 事件填充
 *     → 宿主重启后那条会话是**空闲的**，不再产生事件
 *     → 折叠器为空、activeSessionId 恒 null
 *     → 小窗拿不到 id → 权限/切模型/发命令全部 bad-request
 *
 * 轮询救不了：会话继续空闲就永远没有事件，是永久性空窗。
 * 宿主的 sessions.list() 只含 "All **live** sessions"，冷会话连清单都不在。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createColdSeed } from "../../whale-bridge/lib/seed.mjs";
import { createFoldSet, applyEvent } from "../../whale-bridge/lib/fold.mjs";
import { createEventPipeline } from "../../whale-bridge/lib/events.mjs";
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

test("读不到持久层时必须落一条日志（静默空窗无法归因）", async () => {
  // 「小窗还是没会话」在重启后要有原因：宿主没这个服务 / 方法没提供 /
  // 真的没会话，三者表现完全一样。不给日志就得分清只能靠猜——
  // 这正是本项目反复踩的那类静默失败。
  const logged = [];
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: (m) => logged.push(m),
    host: {
      available: { sessionController: false },
      recentSessions: async () => [],
      sessionEvents: async () => [],
    },
  });

  assert.equal(await seed.seedRecent(), null);
  assert.ok(
    logged.some((m) => m.includes("sessionController")),
    `要指出是服务不可用，实际日志：${JSON.stringify(logged)}`,
  );
});

test("空清单也要落日志：与「服务不可用」区分开", async () => {
  const logged = [];
  const foldSet = createFoldSet();
  const now = 1_000;
  const seed = createColdSeed({
    foldSet,
    log: (m) => logged.push(m),
    now: () => now,
    host: {
      available: { sessionController: true },
      recentSessions: async () => [],
      sessionEvents: async () => [],
    },
  });

  await seed.seedRecent();
  assert.ok(
    logged.some((m) => m.includes("持久层") || m.includes("待机")),
    `要说清是「真的没会话」，实际日志：${JSON.stringify(logged)}`,
  );
});

test("「服务不可用」只报一次（小窗每 5 秒轮询，重复报会淹掉日志）", async () => {
  const logged = [];
  const foldSet = createFoldSet();
  let now = 1_000;
  const seed = createColdSeed({
    foldSet,
    log: (m) => logged.push(m),
    now: () => now,
    host: {
      available: { sessionController: false },
      recentSessions: async () => [],
      sessionEvents: async () => [],
    },
  });

  for (let i = 0; i < 5; i += 1) {
    now += 5_000;
    await seed.seedRecent();
  }
  const hits = logged.filter((m) => m.includes("sessionController"));
  assert.equal(hits.length, 1, `同一原因只该报一次，实际报了 ${hits.length} 次`);
});

test("宿主没这个服务时不去读清单（不白敲一次）", async () => {
  let reads = 0;
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      available: { sessionController: false },
      recentSessions: async () => { reads += 1; return []; },
      sessionEvents: async () => [],
    },
  });
  await seed.seedRecent();
  assert.equal(reads, 0);
});

test("冷种子让位给真实活动：新会话的第一条事件要把活跃指针顶掉", async () => {
  // 这是「要跟」在**桥侧**的一半（另一半在小窗的 refresh，见 window-follow.test.mjs）。
  //
  // events.mjs 原先的规则是「活跃指针为空才认第一个会话」。
  // 冷种子把指针填上之后它就不再为空了 → **新会话永远认领不了**，
  // 小窗也就没有可跟的目标。两处必须一起改，否则出现
  // 「桥没跟、窗也没得跟」，或者反过来「窗想跟、桥不给」。
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s-old", title: "旧会话" }],
      sessionEvents: async () => [{ seq: 1, type: "user/message", data: { content: [{ type: "text", text: "旧话" }] } }],
    },
  });
  await seed.seedRecent();
  assert.equal(foldSet.activeSessionId, "s-old", "前置：种子先绑上旧会话");

  // 接上事件管线（与 host.js 装配同一份）
  const pipeline = createEventPipeline({ foldSet, log: () => {} });
  const ctx = {
    on(event, fn) {
      if (event === "session/event") ctx.__onSessionEvent = fn;
      return () => {};
    },
  };
  pipeline.attach(ctx);

  // 用户在宿主里开了新会话，产生第一条事件
  ctx.__onSessionEvent(
    { id: "s-new", header: { id: "s-new" } },
    { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "新话" }] } },
  );

  assert.equal(
    foldSet.activeSessionId,
    "s-new",
    "真实活动必须顶掉冷种子的默认值——否则小窗没有可跟的目标",
  );
});

test("用户手动切会话后，让位规则不得反噬（activate 要清掉种子标记）", async () => {
  // /whale/activate 是**用户显式**的选择，必须压过一切自动规则。
  // 不清 activeIsSeed 的后果：用户手动切到某会话后，
  // 下一个产生事件的其他会话会把他的选择顶掉——表现是「我明明切了它又跳回去」。
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [{ sessionId: "s-old" }],
      sessionEvents: async () => [],
    },
  });
  await seed.seedRecent();
  assert.equal(foldSet.activeIsSeed, true, "前置：种子设的指针要有标记");

  // 用户手动切到 s-manual（走 /whale/activate 同一行代码）
  foldSet.activeSessionId = "s-manual";
  foldSet.activeIsSeed = false;

  // 之后别的会话产生事件
  const pipeline = createEventPipeline({ foldSet, log: () => {} });
  const ctx = {
    on(event, fn) {
      if (event === "session/event") ctx.__onSessionEvent = fn;
      return () => {};
    },
  };
  pipeline.attach(ctx);
  ctx.__onSessionEvent(
    { id: "s-other", header: {} },
    { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "别处的活动" }] } },
  );

  assert.equal(
    foldSet.activeSessionId,
    "s-manual",
    "用户手动选的会话不能被自动规则顶掉",
  );
});

test("真实活动接管之后，后续事件不再乱改活跃指针", async () => {
  // 「让位」只发生一次：接管之后活跃指针就由它自己（与 /whale/activate）说了算，
  // 否则多个会话交替产生事件时指针会来回跳，小窗跟着闪。
  const foldSet = createFoldSet();
  const pipeline = createEventPipeline({ foldSet, log: () => {} });
  const ctx = {
    on(event, fn) {
      if (event === "session/event") ctx.__onSessionEvent = fn;
      return () => {};
    },
  };
  pipeline.attach(ctx);

  ctx.__onSessionEvent({ id: "a", header: {} }, { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "1" }] } });
  assert.equal(foldSet.activeSessionId, "a", "第一条真实事件接管");

  ctx.__onSessionEvent({ id: "b", header: {} }, { seq: 1, type: "user/message", data: { content: [{ type: "text", text: "2" }] } });
  assert.equal(foldSet.activeSessionId, "a", "接管之后不该被别的事件顶掉，否则小窗会来回跳");
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


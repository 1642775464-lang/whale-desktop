/**
 * 宿主访问封装单测
 *
 * 职责：钉住「服务取不到时，必须能区分」这件事——
 *       是宿主没提供，还是插件**没声明 inject**。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得一条测试：真实踩过一次严重的。
 * Cordis 只把 `inject` 里列出的服务装进插件 ctx，访问未声明的服务会抛
 * `cannot get property "X" without inject`。而 host-ctx 原先一律 catch 成
 * undefined —— 于是「你没声明依赖」被伪装成「宿主没这个服务」。
 * 装进真实宿主后的表现极具迷惑性：
 *   桥能收到 session/event（事件不走服务容器）、能看到会话在跑，
 *   但一发消息就 session-not-found（拿不到 agent）。
 * 这个 bug 在假 ctx 上是看不出来的（假 ctx 不实现 inject 守卫），
 * 所以这里用一个**模拟 Cordis 守卫的 Proxy** 来复现。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHostAccess } from "../../whale-bridge/lib/host-ctx.mjs";
import { createGuardedCtx, createGettableCtx } from "../helpers/host-ctx-double.mjs";

const fakeSessions = { get: () => ({ id: "s1" }), list: () => [] };
const fakeAgents = { get: () => ({ status: "idle" }) };

test("已声明的服务能取到", () => {
  const ctx = createGuardedCtx({ sessions: fakeSessions, agents: fakeAgents }, ["sessions", "agents"]);
  const host = createHostAccess(ctx);
  assert.equal(host.sessions, fakeSessions);
  assert.equal(host.agents, fakeAgents);
  assert.equal(host.available.sessions, true);
  assert.equal(host.available.agents, true);
});

test("未声明 inject 的服务取不到，但**必须被记进 missingInject**", () => {
  // 这就是那次事故的最小复现：服务明明注册了，只是插件没声明
  const ctx = createGuardedCtx({ sessions: fakeSessions, agents: fakeAgents }, []);
  const host = createHostAccess(ctx);

  assert.equal(host.sessions, undefined, "取不到是预期");
  assert.deepEqual(
    host.probe().missingInject.sort(),
    ["agents", "sessions"],
    "必须记下「没声明 inject」，否则与「宿主没提供」分不开",
  );
});

test("titleOf：从会话投影读标题（标题不在 header 里）", () => {
  // 实测：dsh-api-session-controller 的 listFields(header) 只返回
  // parentSessionId / origin / cwd，**不含 title**；
  // 标题是 dsh-session-title 注册的 key="title" 会话投影，
  // 读法 sessionProjections.snapshot(session, keys) → values.title。
  const session = { id: "s1", header: { id: "s1" } };
  const projections = {
    snapshot: (s, keys) => {
      assert.equal(s, session, "必须把会话对象传进去");
      assert.deepEqual(keys, ["title"], "只取 title 一个投影，别把全部算一遍");
      return { asOfSeq: 1, values: { title: "投影来的标题" } };
    },
  };
  const host = createHostAccess(createGuardedCtx({ sessionProjections: projections }, ["sessionProjections"]));
  assert.equal(host.titleOf(session), "投影来的标题");
});

test("titleOf：没有标题、投影缺失、抛错，三种情况都返回 null（不编造）", () => {
  const session = { id: "s1" };

  // ① 投影返回 null（宿主尚无标题）
  const empty = createHostAccess(createGuardedCtx(
    { sessionProjections: { snapshot: () => ({ values: { title: null } }) } },
    ["sessionProjections"],
  ));
  assert.equal(empty.titleOf(session), null);

  // ② 宿主没提供 projections 服务
  const none = createHostAccess(createGuardedCtx({}, []));
  assert.equal(none.titleOf(session), null);

  // ③ 投影读的时候抛错 —— 不能把异常抛出去打断整条 /whale/hud
  const boom = createHostAccess(createGuardedCtx(
    { sessionProjections: { snapshot: () => { throw new Error("投影炸了"); } } },
    ["sessionProjections"],
  ));
  assert.equal(boom.titleOf(session), null, "读投影失败必须降级，不能让整个快照挂掉");
});

test("titleOf：空字符串与缺字段同等对待", () => {
  const session = { id: "s1" };
  const blank = createHostAccess(createGuardedCtx(
    { sessionProjections: { snapshot: () => ({ values: { title: "" } }) } },
    ["sessionProjections"],
  ));
  assert.equal(blank.titleOf(session), null, "空标题等于没有标题");

  const missing = createHostAccess(createGuardedCtx(
    { sessionProjections: { snapshot: () => ({ values: {} }) } },
    ["sessionProjections"],
  ));
  assert.equal(missing.titleOf(session), null);
});

test("宿主确实没有该服务时，missingInject 应为空", () => {
  // 与上面那条对照：同样是 undefined，原因不同
  const ctx = createGuardedCtx({}, []);
  const host = createHostAccess(ctx);
  assert.equal(host.sessions, undefined);
  assert.deepEqual(host.probe().missingInject, [], "宿主没有 ≠ 没声明，不该误报");
});

test("probe 如实报告可用性", () => {
  const ctx = createGuardedCtx({ sessions: fakeSessions }, ["sessions"]);
  const host = createHostAccess(ctx);
  const p = host.probe();
  assert.equal(p.sessions, true);
  assert.equal(p.agents, false);
  assert.equal(p.commands, false);
  assert.equal(p.sessionCount, 0);
  assert.deepEqual(p.missingInject, []);
});

test("ctx 为 null / undefined 时不抛错", () => {
  for (const bad of [null, undefined]) {
    const host = createHostAccess(bad);
    assert.equal(host.sessions, undefined);
    assert.deepEqual(host.listSessions(), []);
    assert.equal(host.getAgent("x"), undefined);
    assert.equal(host.getSession("x"), undefined);
  }
});

test("服务方法抛错时降级为空值，不向外抛（局部失效不整体崩溃）", () => {
  const ctx = createGuardedCtx(
    { sessions: { list: () => { throw new Error("boom"); }, get: () => { throw new Error("boom"); } } },
    ["sessions"],
  );
  const host = createHostAccess(ctx);
  assert.deepEqual(host.listSessions(), []);
  assert.equal(host.getSession("s1"), undefined);
});

test("listSessions 归一化 header 形状", () => {
  const ctx = createGuardedCtx(
    {
      sessions: {
        list: () => [
          { id: "a", header: { id: "a", cwd: "D:\\x", title: "会话A" } },
          { header: { id: "b", title: "会话B" } },
        ],
      },
    },
    ["sessions"],
  );
  const host = createHostAccess(ctx);
  const list = host.listSessions();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, "a");
  assert.equal(list[0].title, "会话A");
  assert.equal(list[1].id, "b", "裸 header 形状也要能取到 id");
});

test("projections 只读真实服务名 sessionProjections（不再猜 projections）", () => {
  // 曾经还兜一个 ctx["projections"]。后来证实宿主只注册 sessionProjections；
  // 而把一个**不存在**的名字放进 inject 会让 Cordis 一直等、插件永远不启动。
  // 所以这里只认真实服务名。
  const viaNew = createHostAccess(
    createGuardedCtx({ sessionProjections: { x: 1 } }, ["sessionProjections"]),
  );
  assert.deepEqual(viaNew.projections, { x: 1 });

  const without = createHostAccess(createGuardedCtx({}, ["sessionProjections"]));
  assert.equal(without.projections, undefined, "不存在时给 undefined，不猜第二个名字");
});

test("可选服务走 ctx.get，取不到也不抛（不经过 inject 守卫）", () => {
  // attachments / models 是可选服务。关键：ctx 上没有也不能抛，
  // 抛了会打断整个 createHostAccess；而且不能被误记成「缺 inject」。
  const ctx = createGuardedCtx({ sessions: fakeSessions }, ["sessions"]);
  const host = createHostAccess(ctx);
  assert.equal(host.attachments, undefined);
  assert.equal(host.available.attachments, false);
  assert.deepEqual(host.probe().missingInject, []);
});

// ── 可选服务必须在**调用时**解析，不能在 apply 时定死 ──────

test("可选服务要延迟解析：apply 时还没就绪、之后就绪了要能取到", async () => {
  // 真实踩过：把 `optionalServiceOf(ctx, "sessionController")` 的结果
  // 在 createHostAccess 里存进 const，之后一直用它。
  // 而 sessionController 由 dsh-api-session-controller 提供，
  // **启动顺序在桥之后**——apply 那一刻它还没就绪，于是 const 永远是 undefined，
  // /whale/probe 永远报 false、/whale/models 永远返回 0。
  // 表现极具迷惑性：路由都在、其他服务都正常，只有这两项恒空。
  const ready = { value: false };
  const ctx = {
    on: () => () => {},
    get: (name) => (name === "sessionController" && ready.value ? { modelCatalog: async () => ({}) } : undefined),
  };

  const host = createHostAccess(ctx);
  assert.equal(await host.modelCatalog(), null, "apply 时未就绪 → null");

  // 宿主的启动顺序走完，服务就绪
  ready.value = true;

  const out = await host.modelCatalog();
  assert.notEqual(out, null, "服务就绪后必须能取到——服务要延迟解析，不能 apply 时定死");
});

test("可选服务的可用性也要实时反映（probe 不能缓存旧结论）", () => {
  const ready = { value: false };
  const ctx = {
    on: () => () => {},
    get: (name) => (name === "permissionPresets" && ready.value ? { names: ["auto"] } : undefined),
  };
  const host = createHostAccess(ctx);

  assert.equal(host.available.permissionPresets, false, "初始未就绪");
  ready.value = true;
  assert.equal(host.available.permissionPresets, true, "就绪后 available 也要跟着变");
});

// ── 模型目录：必须走宿主的 sessionController ──────────────

test("modelCatalog：走宿主 sessionController，原样给出目录", async () => {
  // 为什么必须是 sessionController 而不是桥自己拼：
  // 宿主 UI 的模型选择器就是读它（buildModelCatalog 包在里面），
  // 桥复刻一遍等于维护第二份逻辑——宿主改了桥就悄悄不一致。
  let called = 0;
  const catalog = {
    default: { provider: "workbuddy-ai", model: "glm-5.3-flash" },
    routableProviders: ["workbuddy-ai"],
    groups: [
      {
        id: "workbuddy-ai",
        name: "WorkBuddy AI",
        models: [
          {
            id: "glm-5.3-flash",
            name: "GLM-5.3-Flash",
            reasoning: { efforts: [{ id: "high", name: "高" }], defaultEffort: "high" },
          },
        ],
      },
    ],
    failures: [],
  };
  const host = createHostAccess(createGettableCtx({
    sessionController: {
      modelCatalog: async () => { called += 1; return catalog; },
    },
  }));

  const out = await host.modelCatalog();
  assert.equal(called, 1, "必须真的问了 sessionController");
  assert.equal(out, catalog, "目录应原样透传（宿主已 detach，形状就是 UI 用的那份）");
});

test("modelCatalog：宿主没有 sessionController 时给 null，不抛", async () => {
  // 这是降级路径：桥要能如实说「读不到目录」，而不是整个接口 500。
  const host = createHostAccess(createGettableCtx({}));
  assert.equal(await host.modelCatalog(), null);
});

test("modelCatalog：宿主抛错时给 null 并留下原因", async () => {
  const host = createHostAccess(createGettableCtx({
    sessionController: {
      modelCatalog: async () => { throw new Error("provider 全挂了"); },
    },
  }));
  const out = await host.modelCatalog();
  assert.equal(out, null, "抛错不能冒到 HTTP 层");
});

test("selectModel：把 provider/model/effort 交给宿主，不自己改状态", async () => {
  let seen = null;
  const host = createHostAccess(createGettableCtx({
    sessionController: {
      selectModel: async (request) => { seen = request; return { selected: request }; },
    },
  }));

  const out = await host.selectModel({
    sessionId: "s1", provider: "magpie", model: "group/auto-qfmodel", reasoningEffort: "xhigh",
  });
  assert.deepEqual(seen, {
    sessionId: "s1", provider: "magpie", model: "group/auto-qfmodel", reasoningEffort: "xhigh",
  }, "请求形状必须是宿主要求的 {sessionId, provider, model, reasoningEffort}");
  assert.equal(out.ok, true);
  assert.deepEqual(out.selected, seen);
});

test("selectModel：不传 effort 时不能塞一个 undefined 字段进去", async () => {
  // 宿主用 `...request.reasoningEffort === void 0 ? {} : {...}` 的口径，
  // 桥多塞一个 undefined 键会让形状与宿主不一致。
  let seen = null;
  const host = createHostAccess(createGettableCtx({
    sessionController: {
      selectModel: async (request) => { seen = request; return { selected: request }; },
    },
  }));
  await host.selectModel({ sessionId: "s1", provider: "p", model: "m" });
  assert.equal(Object.hasOwn(seen, "reasoningEffort"), false, "没给 effort 就不该有这个键");
});

test("selectModel：宿主报错时转成可读结果，不抛", async () => {
  const host = createHostAccess(createGettableCtx({
    sessionController: {
      selectModel: async () => {
        const err = new Error("model not advertised");
        err.code = "session/model-unavailable";
        throw err;
      },
    },
  }));
  const out = await host.selectModel({ sessionId: "s1", provider: "p", model: "m" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "session/model-unavailable", "要把宿主的错误码带出来");
});

test("selectModel：没有 sessionController 时明确拒绝，不假装成功", async () => {
  const host = createHostAccess(createGettableCtx({}));
  const out = await host.selectModel({ sessionId: "s1", provider: "p", model: "m" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "model-switch-unavailable");
});

// ── 权限档位：读宿主的 permissionPresets ──────────────────

test("permissionPresets：读 names 与 current", async () => {
  // 小窗原先硬编码 3 档，而宿主还有 auto —— 硬编码就会漏档位。
  const host = createHostAccess(createGettableCtx({
    permissionPresets: {
      get names() { return ["read-only", "workspace-write", "danger-full-access", "auto"]; },
      current: () => "workspace-write",
    },
    sessions: { get: (id) => ({ id }) },
  }, ["sessions"]));

  const out = await host.permissionPresets("s1");
  assert.deepEqual(out.options, ["read-only", "workspace-write", "danger-full-access", "auto"]);
  assert.equal(out.current, "workspace-write");
});

test("permissionPresets：宿主没有该服务时给 null（不编造档位）", async () => {
  const host = createHostAccess(createGettableCtx({}));
  assert.equal(await host.permissionPresets("s1"), null);
});

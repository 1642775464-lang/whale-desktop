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

/**
 * 造一个模拟 Cordis 服务容器的 ctx。
 *
 * 关键行为与 @deepseek-ai/cordis 的 Proxy handler 一致：
 *   - 已注册且已声明的服务 → 返回实例
 *   - 已注册但**未声明 inject** → 抛 `cannot get property "X" without inject`
 *   - 未注册 → 抛普通 Error（不可用）
 *
 * @param {object} services 已注册的服务
 * @param {string[]} injected 插件声明的 inject 列表
 * @returns {object}
 */
function createGuardedCtx(services, injected) {
  const declared = new Set(injected);
  return new Proxy(
    { on: () => () => {} },
    {
      get(target, prop) {
        if (typeof prop !== "string") return Reflect.get(target, prop);
        if (Reflect.has(target, prop)) return Reflect.get(target, prop);

        if (Object.hasOwn(services, prop)) {
          if (!declared.has(prop)) {
            throw new Error(`cannot get property "${prop}" without inject`);
          }
          return services[prop];
        }
        throw new Error(`service "${prop}" not found`);
      },
    },
  );
}

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

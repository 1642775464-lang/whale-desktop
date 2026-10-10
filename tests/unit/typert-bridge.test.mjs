/**
 * Typert 远程调用封装的单测
 *
 * 职责：钉住桥调宿主 `typertGateway` 的**调用形状**与降级行为。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得单独一个文件：这条通路是「技能中心 / 任务看板 / 频道」
 * 三项的唯一希望（HTTP 路要浏览器凭证，桥没有）。而它的调用形状很容易写错 ——
 * `namespace` 与 `method` 是**分开的字段**，拼成 `"skills/list"` 传进去
 * 会被当成 namespace，网关报 `gateway/invocation-unavailable`，
 * 而那个错误看起来像「端点不存在」，很容易误判成「这项做不了」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTypertBridge } from "../../whale-bridge/lib/typert-bridge.mjs";

/** 造一个带 `get` 的假 ctx（模拟宿主服务容器）。 */
function ctxWith(services) {
  return {
    get: (name) => (Object.hasOwn(services, name) ? services[name] : undefined),
  };
}

/** 造一个假网关，记录收到的调用请求。 */
function fakeGateway(result = { ok: true }) {
  const calls = [];
  return {
    calls,
    invoke: (request) => {
      calls.push(request);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result);
    },
  };
}

test("invokeRemote：namespace 与 method 必须作为**两个字段**传给网关", async () => {
  /*
   * ⚠️ 这条是本文件最重要的一条。
   * 网关内部用 `endpointOf(request.namespace, request.method)` 自己拼 endpoint。
   * 若把 `"skills/list"` 整个塞进 namespace，SRC 解析会找不到端点，
   * 报 `gateway/invocation-unavailable` —— 那看起来像「宿主没这个端点」，
   * 而实际只是桥传错了形状。
   */
  const gateway = fakeGateway({ skills: [] });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  await bridge.invokeRemote({ namespace: "skills", method: "list", args: { request: { sessionId: "s1" } } });

  assert.equal(gateway.calls.length, 1);
  assert.equal(gateway.calls[0].namespace, "skills", "namespace 是独立字段");
  assert.equal(gateway.calls[0].method, "list", "method 是独立字段");
  assert.deepEqual(gateway.calls[0].args, { request: { sessionId: "s1" } }, "具名参数原样转交");
});

test("invokeRemote：只传 namespace/method/args 三个字段，不替调用方声明身份", async () => {
  /*
   * 网关的 `peer` 字段代表**操作者身份**。桥若顺手带上一个 peer，
   * 就是在替调用方声明它是以谁的名义在调 —— 那不是桥该决定的事。
   */
  const gateway = fakeGateway({});
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  await bridge.invokeRemote({ namespace: "skills", method: "list", args: {} });

  assert.deepEqual(
    Object.keys(gateway.calls[0]).sort(),
    ["args", "method", "namespace"],
    "不该多传 peer / uplink 之类",
  );
});

test("invokeRemote：args 缺省时给空对象（不是 undefined）", async () => {
  const gateway = fakeGateway({});
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  await bridge.invokeRemote({ namespace: "skills", method: "list" });
  assert.deepEqual(gateway.calls[0].args, {}, "缺省给 {}，避免网关那边拿到 undefined");
});

test("invokeRemote：非法 namespace / method 一律拒绝，且**不碰网关**", async () => {
  const gateway = fakeGateway({});
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  for (const bad of [
    { namespace: "skills/list", method: "list" },   // 拼好的 endpoint
    { namespace: "", method: "list" },
    { namespace: "a b", method: "list" },
    { namespace: "skills", method: "" },
    { namespace: "skills", method: "a/b" },
    { namespace: undefined, method: "list" },
  ]) {
    const out = await bridge.invokeRemote(bad);
    assert.equal(out.ok, false, `${JSON.stringify(bad)} 应被拒`);
    assert.match(out.code, /^typert\/bad-/, "错误码要指明是入参问题");
  }
  assert.equal(gateway.calls.length, 0, "入参不合法时不该发出调用");
});

test("invokeRemote：宿主没有 typertGateway 时如实说不可用", async () => {
  const bridge = createTypertBridge({ ctx: ctxWith({}) });
  const out = await bridge.invokeRemote({ namespace: "skills", method: "list" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "typert/unavailable");
  assert.equal(bridge.available(), false);
});

test("invokeRemote：网关抛错时如实回传它给的 code，不吞不改写", async () => {
  /*
   * 网关的错误码有区分度（`gateway/invocation-unavailable` 是端点不存在、
   * `gateway/ambiguous-endpoint` 是多个服务抢同一端点）。改写成统一错误
   * 会让调用方分不清「这项做不了」和「我传错了」。
   */
  const err = Object.assign(new Error("no active Remote method exports this endpoint"), {
    code: "gateway/invocation-unavailable",
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: fakeGateway(err) }) });

  const out = await bridge.invokeRemote({ namespace: "skills", method: "list" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "gateway/invocation-unavailable", "原样回传网关的 code");
  assert.match(out.message, /no active Remote method/, "原样回传消息");
});

test("invokeRemote：错误对象没有 code 时给一个稳定的兜底码", async () => {
  const bridge = createTypertBridge({
    ctx: ctxWith({ typertGateway: fakeGateway(new Error("boom")) }),
  });
  const out = await bridge.invokeRemote({ namespace: "skills", method: "list" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "typert/failed");
});

test("available：网关在但 invoke 不是函数时也算不可用", async () => {
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: { nope: 1 } }) });
  assert.equal(bridge.available(), false);
  const out = await bridge.invokeRemote({ namespace: "skills", method: "list" });
  assert.equal(out.code, "typert/unavailable");
});

test("listSkills：走 skills/list，参数形状是 {request:{sessionId}}", async () => {
  // 实测契约：SkillListRequest = { sessionId }
  const gateway = fakeGateway({ skills: [] });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  await bridge.listSkills("s1");

  assert.equal(gateway.calls[0].namespace, "skills");
  assert.equal(gateway.calls[0].method, "list");
  assert.deepEqual(
    gateway.calls[0].args,
    { request: { sessionId: "s1" } },
    "宿主声明的参数名是 request，必须精确匹配（网关会校验）",
  );
});

test("listSkills：归一化技能条目，缺字段给 null/空串，不编造", async () => {
  const gateway = fakeGateway({
    skills: [
      { name: "accessibility-review", description: "审计无障碍", whenToUse: "当你要查 a11y", path: "/x/SKILL.md", modelInvocable: true },
      { name: "只有名字" },
    ],
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.listSkills("s1");
  assert.equal(out.ok, true);
  assert.equal(out.skills.length, 2);
  assert.deepEqual(out.skills[0], {
    name: "accessibility-review",
    description: "审计无障碍",
    whenToUse: "当你要查 a11y",
    path: "/x/SKILL.md",
    modelInvocable: true,
  });
  assert.deepEqual(out.skills[1], {
    name: "只有名字",
    description: "",
    whenToUse: null,
    path: null,
    modelInvocable: false,
  });
});

test("listSkills：宿主返回畸形数据时给空清单，不崩也不编造", async () => {
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: fakeGateway(null) }) });
  const out = await bridge.listSkills("s1");
  assert.equal(out.ok, true);
  assert.deepEqual(out.skills, [], "拿不到就给空数组");
});

test("listSkills：没有 sessionId 时明确拒绝", async () => {
  const gateway = fakeGateway({ skills: [] });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });
  const out = await bridge.listSkills("");
  assert.equal(out.ok, false);
  assert.equal(out.code, "skills/bad-session");
  assert.equal(gateway.calls.length, 0);
});

test("listSkills：网关失败时把失败原样传上去，不假装成功", async () => {
  const err = Object.assign(new Error("x"), { code: "gateway/ambiguous-endpoint" });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: fakeGateway(err) }) });
  const out = await bridge.listSkills("s1");
  assert.equal(out.ok, false);
  assert.equal(out.code, "gateway/ambiguous-endpoint");
  assert.equal(out.skills, undefined, "失败时不该给一个空清单冒充成功");
});

test("服务必须延迟解析：构造时网关还没就绪，之后就绪了要能取到", async () => {
  /*
   * 与 host-ctx 里那条同源：网关由启动顺序可能在桥之后的插件提供。
   * 若在 createTypertBridge 时把网关存进 const，之后永远是 undefined。
   */
  let ready = false;
  const gateway = fakeGateway({ skills: [] });
  const ctx = { get: (name) => (name === "typertGateway" && ready ? gateway : undefined) };
  const bridge = createTypertBridge({ ctx });

  assert.equal(bridge.available(), false, "构造时还没就绪");

  ready = true;
  assert.equal(bridge.available(), true, "就绪后要能取到");
  const out = await bridge.listSkills("s1");
  assert.equal(out.ok, true, "延迟解析后才真的能调");
});

// ── 新建会话 session/create ───────────────────────────

test("createSession：走 session/create，request 至少给空对象", async () => {
  /*
   * 实测契约：SessionCreateRequest 的四个字段**全部可选**。
   * 但网关会校验具名参数，`request` 这个键本身得存在 ——
   * 传 undefined 会报参数不匹配（看起来像「宿主不认这个端点」，实为形状错）。
   */
  const gateway = fakeGateway({ sessionId: "new-1" });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.createSession();
  assert.equal(out.ok, true);
  assert.equal(gateway.calls[0].namespace, "session");
  assert.equal(gateway.calls[0].method, "create");
  assert.deepEqual(gateway.calls[0].args, { request: {} }, "不传时也要给 {request:{}}");
  assert.equal(out.sessionId, "new-1");
});

test("createSession：传入的字段原样透传（workspaceId / cwd / agentPreset）", async () => {
  const gateway = fakeGateway({ sessionId: "new-2", agentPreset: "standard" });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.createSession({ cwd: "/w", agentPreset: "standard" });
  assert.deepEqual(gateway.calls[0].args, { request: { cwd: "/w", agentPreset: "standard" } });
  assert.equal(out.agentPreset, "standard");
});

test("createSession：宿主说成功却没给 sessionId → 如实报错，不给空壳会话", async () => {
  /*
   * 没有 id 的会话是切不过去、也拉不到面板的。
   * 若这里返回一个 ok 的空对象，界面会以为自己有了新会话 —— 那更糟。
   */
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: fakeGateway({}) }) });
  const out = await bridge.createSession();
  assert.equal(out.ok, false);
  assert.equal(out.code, "session/create-no-id");
});

test("createSession：网关失败时原样回传 code", async () => {
  const err = Object.assign(new Error("boom"), { code: "session/writer-held" });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: fakeGateway(err) }) });
  const out = await bridge.createSession();
  assert.equal(out.ok, false);
  assert.equal(out.code, "session/writer-held", "写锁争用这类原因必须让调用方看见");
});

// ── 会话清单 session/list ─────────────────────────────

test("listSessions：走 session/list，参数名是 _request", async () => {
  /*
   * ⚠️ 宿主声明的参数名带下划线前缀（`_request`），不是 `request`。
   * 网关按名校验，写成 request 会被拒 —— 而那个错误看起来像端点不存在。
   */
  const gateway = fakeGateway({ sessions: [] });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  await bridge.listSessions();
  assert.equal(gateway.calls[0].namespace, "session");
  assert.equal(gateway.calls[0].method, "list");
  assert.deepEqual(gateway.calls[0].args, { _request: {} }, "参数名是 _request");
});

test("listSessions：按 SessionSummary 的真实字段名归一化", async () => {
  /*
   * ⚠️ 字段名照宿主声明写，**不能凭印象**。
   *
   * `SessionSummary` 的真实字段（dsh-api-session-controller 的 typert.host.js）：
   *   { agentAvailable, sessionId, updatedAt, running, blank,
   *     parentSessionId?, origin?, cwd?, projections? }
   *
   * **它没有 `title`** —— 我第一版写了 `s.title`，结果 55 条会话标题全 null、
   * 工作区也拿不到，界面上就是「会话列表没加载」。
   * 这类字段名错误是**静默**的：请求成功、结构正常、字段全空。
   */
  const gateway = fakeGateway({
    items: [
      {
        sessionId: "a", updatedAt: 200, cwd: "D:\\proj",
        running: true, agentAvailable: true, blank: false,
        projections: { values: { title: "会话甲" } },
      },
      { sessionId: "b", updatedAt: 100, cwd: null },
      { updatedAt: 50 },   // 没有 sessionId → 整条丢掉（它切不过去）
    ],
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.listSessions();
  assert.equal(out.ok, true);
  assert.equal(out.sessions.length, 2, "没有 sessionId 的行整条丢掉");
  assert.equal(out.sessions[0].title, "会话甲");
  assert.equal(out.sessions[0].workspacePath, "D:\\proj", "没有注册表时退回 cwd");
  assert.equal(out.sessions[1].title, null, "取不到标题给 null，不编造");
  assert.equal(out.sessions[1].workspacePath, null, "cwd 也没有时给 null");
  assert.equal(out.archivedKnown, false, "没注入注册表时如实说「判据没拿到」");
});

test("listSessions：**只列注册表里登记在册的会话**（用户报的「数目不对」）", async () => {
  /*
   * ⚠️ 这条是用户报的核心问题。
   *
   * 我原先按「会话的 cwd 等于某目录」反推归属 —— 于是把历史上所有在该目录
   * 跑过的会话（含空壳、含早已不属于该工作区的）全列了出来，数目远大于
   * 主窗口。主窗口的归属来自 Workspace registry：每个工作区有一份
   * **显式登记的** sessionIds。
   *
   * 实测对照：注册表里「悬浮窗」工作区只登记了 **3 条**，
   * 而按 cwd 反推能匹配出 8 条。
   */
  const bridge = createTypertBridge({
    ctx: ctxWith({
      typertGateway: fakeGateway({
        items: [
          { sessionId: "in-ws", updatedAt: 300, cwd: "D:\\proj" },
          { sessionId: "not-in-ws", updatedAt: 200, cwd: "D:\\proj" },   // cwd 相同但没登记
        ],
      }),
    }),
    registryOf: () => ({
      ok: true,
      workspaces: [{ id: "ws1", title: "项目", path: "D:\\proj", sessionIds: ["in-ws"], isDefault: false }],
      archivedIds: [],
      pinnedIds: [],
    }),
  });

  const out = await bridge.listSessions();
  assert.equal(out.sessions.length, 1, "没登记的会话不该出现");
  assert.equal(out.sessions[0].sessionId, "in-ws");
  assert.equal(out.sessions[0].workspaceTitle, "项目", "工作区用登记的那份（含标题）");
  assert.equal(out.sessions[0].workspaceId, "ws1");
  assert.equal(out.registryKnown, true);
});

test("listSessions：注册表读不到时不裁剪（宁可多列不可凭空藏）", async () => {
  const bridge = createTypertBridge({
    ctx: ctxWith({ typertGateway: fakeGateway({ items: [{ sessionId: "a" }, { sessionId: "b" }] }) }),
    registryOf: () => ({ ok: false, workspaces: [], archivedIds: [], pinnedIds: [] }),
  });
  const out = await bridge.listSessions();
  assert.equal(out.sessions.length, 2, "判据拿不到时如实列出全部，不裁剪");
  assert.equal(out.registryKnown, false);
  assert.equal(out.archivedKnown, false);
});

test("listSessions：归档集合来自注册表", async () => {
  const bridge = createTypertBridge({
    ctx: ctxWith({
      typertGateway: fakeGateway({ items: [{ sessionId: "keep" }, { sessionId: "gone" }] }),
    }),
    registryOf: () => ({
      ok: true,
      workspaces: [{ id: "w", title: "W", path: null, sessionIds: ["keep", "gone"], isDefault: false }],
      archivedIds: ["gone"],
      pinnedIds: [],
    }),
  });
  const out = await bridge.listSessions();
  const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId.keep.archived, false);
  assert.equal(byId.gone.archived, true);
  assert.equal(out.archivedKnown, true);
});

test("listSessions：归档判据拿不到时 archivedKnown=false（界面据此不隐藏）", async () => {
  /*
   * ⚠️ 判据拿不到时**不能**按「都没归档」处理 —— 那会让界面以为
   * 「已确认没有归档的」，而实际是「根本不知道」。
   * 界面的纪律是：只有 archivedKnown 为 true 才隐藏。
   */
  const bridge = createTypertBridge({
    ctx: ctxWith({ typertGateway: fakeGateway({ items: [{ sessionId: "x" }] }) }),
    archivedIdsOf: () => ({ ok: false, ids: [] }),
  });

  const out = await bridge.listSessions();
  assert.equal(out.archivedKnown, false);
  assert.equal(out.sessions[0].archived, false, "判据没有时不标记");
});

test("listSessions：按最近活动倒序（侧边栏直接消费，不必自己排）", async () => {
  const bridge = createTypertBridge({
    ctx: ctxWith({
      typertGateway: fakeGateway({
        items: [
          { sessionId: "old", updatedAt: 100 },
          { sessionId: "new", updatedAt: 900 },
          { sessionId: "mid", updatedAt: 500 },
        ],
      }),
    }),
  });
  const out = await bridge.listSessions();
  assert.deepEqual(out.sessions.map((s) => s.sessionId), ["new", "mid", "old"]);
});

test("listSessions：宿主返回形状不同（items）时也能认", async () => {
  const bridge = createTypertBridge({
    ctx: ctxWith({ typertGateway: fakeGateway({ items: [{ sessionId: "x" }] }) }),
  });
  const out = await bridge.listSessions();
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].sessionId, "x");
  assert.equal(out.sessions[0].title, null, "缺字段给 null 而不是 undefined");
  assert.equal(out.sessions[0].blank, false, "布尔字段缺省给 false");
});

test("listSessions：失败时不返空清单冒充「没有会话」", async () => {
  const err = Object.assign(new Error("x"), { code: "gateway/invocation-unavailable" });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: fakeGateway(err) }) });
  const out = await bridge.listSessions();
  assert.equal(out.ok, false);
  assert.equal(out.code, "gateway/invocation-unavailable");
  assert.equal(out.sessions, undefined);
});

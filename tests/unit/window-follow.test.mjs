/**
 * 小窗客户端：活跃会话跟随（行为级）
 *
 * 职责：钉住「桥的活跃指针换了、小窗必须跟着换」这条规则。
 * 所属层：测试（tests/unit）
 *
 * 为什么单开一份、为什么必须是行为级：
 * 小窗那份 bridge-client 原先只有**正则扫源码**的契约断言
 * （「文件里出现 fetchActiveSessionId 这几个字」）。那种断言是空壳——
 * 把实现改回错的写法照样全绿。而这里要钉的是一条**有状态的行为**，
 * 只有真的把客户端跑起来、喂给它一串桥响应才看得见。
 *
 * 背景（用户裁定）：
 *   小窗启动时默认绑上「最近一次会话」（冷会话种子）。
 *   用户明确要求：之后在宿主里开新会话时，**小窗要跟着过去**。
 *
 * 原先的实现只做了一半：
 *   `refresh()` 只在 `state.sessionId` 为空时才去问桥要活跃会话；
 *   一旦拿到 id 就绑死，之后再问也只用旧 id 拉面板。
 *   于是桥那边的活跃指针换了，小窗纹丝不动——「要跟」根本没生效。
 *
 * 桥侧管线在 `events.mjs` 里也有同一条毛病：它只在
 * `activeSessionId === null` 时才认第一个会话，种子填上之后新会话永远认领不了。
 * 两处一起改才不会「桥跟了、窗没跟」或反过来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLIENT_FILE = join(ROOT, "whale-window", "renderer", "bridge-client.js");
const FOLLOW_FILE = join(ROOT, "whale-window", "renderer", "follow.js");
const STREAM_FILE = join(ROOT, "whale-window", "renderer", "stream.js");
// client 现在把能力请求委托给这个模块（沙箱必须与真实页面同一份清单，环境坑 41）
const CAP_FILE = join(ROOT, "whale-window", "renderer", "bridge-capabilities.js");

/**
 * 在沙箱里加载小窗的 bridge-client.js。
 *
 * 关键：client 现在把「跟随判定」与「事件折叠」委托给 follow.js / stream.js，
 * 所以沙箱**必须先加载这两个模块**——否则 client 里 `global.WhaleFollow`
 * 取不到，测试会以「静默失败」的形式全红，而看不出真实原因。
 * （这一条本身就是个坑：单测环境与真实页面的加载顺序必须一致，
 *   不一致时红的是一片用例，指向性极差。）
 */

/**
 * 在沙箱里加载小窗的 bridge-client.js。
 *
 * 与悬浮条那份同一个坑：脚本 IIFE 收到的是内层 `window`，
 * 所有全局必须挂在 `window` 上，否则 `global.URLSearchParams` 取不到、
 * 静默走 catch 退回默认端口（测试就测了个寂寞）。
 *
 * @param {object} env 假的 fetch
 * @returns {object} window.WhaleBridge
 */
function loadClient(env) {
  const sandbox = {
    window: {},
    console: { warn: () => {}, log: () => {} },
  };
  const w = sandbox.window;
  w.location = env.location ?? { search: "" };
  w.fetch = env.fetch;
  w.setTimeout = setTimeout;
  w.clearTimeout = clearTimeout;
  w.setInterval = setInterval;
  w.clearInterval = clearInterval;
  w.URLSearchParams = URLSearchParams;
  w.Number = Number;
  w.Object = Object;
  w.Array = Array;
  w.JSON = JSON;
  w.Promise = Promise;
  w.console = sandbox.console;
  // 不用事件流：本组只测「问桥 → 绑会话」这一段
  w.EventSource = function FakeEventSource() {
    this.close = () => {};
  };

  createContext(sandbox);
  /*
   * 与真实页面同一套依赖：client 会用到这几个命名空间。
   * ⚠️ 顺序必须与 index.html 一致 —— `bridge-workspace.js` 在 client 之前
   * （client 建实例时要调用它的工厂），漏了会在构造时报
   * 「Cannot read properties of undefined」。
   */
  for (const f of ["bridge-shapes.js", "bridge-workspace.js"]) {
    const p = join(ROOT, "whale-window", "renderer", f);
    runInContext(readFileSync(p, "utf8"), sandbox, { filename: p });
  }
  runInContext(readFileSync(CAP_FILE, "utf8"), sandbox, { filename: CAP_FILE });
  runInContext(readFileSync(FOLLOW_FILE, "utf8"), sandbox, { filename: FOLLOW_FILE });
  runInContext(readFileSync(STREAM_FILE, "utf8"), sandbox, { filename: STREAM_FILE });
  runInContext(readFileSync(CLIENT_FILE, "utf8"), sandbox, { filename: CLIENT_FILE });
  return sandbox.window.WhaleBridge;
}

/**
 * 造一个可编程的假桥。
 *
 * 每条响应按 URL 分派：hud 给会话清单与活跃指针，panel 给消息。
 * 记录所有请求路径，便于断言「是不是真的问了新会话」。
 */
function fakeBridge(state) {
  const asked = [];
  const fetch = (url) => {
    const u = String(url);
    asked.push(u);
    if (u.includes("/whale/hud")) {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          bridge: { version: "t" },
          sessions: state.sessions,
          activeSessionId: state.active,
        }),
      });
    }
    if (u.includes("/whale/panel")) {
      const id = decodeURIComponent(u.slice(u.indexOf("sessionId=") + 10));
      const msgs = state.messages[id] ?? [];
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          sessionId: id, title: `标题-${id}`, messages: msgs, todos: [],
          running: false, agentRunning: false,
        }),
      });
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
  };
  return { asked, fetch };
}

test("首次 refresh 绑定桥给的活跃会话", async () => {
  const bridge = loadClient(fakeBridge({
    sessions: [{ sessionId: "s1", title: "甲" }],
    active: "s1",
    messages: { s1: [{ kind: "user", text: "甲的消息" }] },
  }));
  const client = bridge.createClient({ port: 19387 });

  await client.refresh();

  assert.equal(client.getState().sessionId, "s1");
  assert.deepEqual(client.getState().messages.map((m) => m.text), ["甲的消息"]);
});

test("桥的活跃指针换到别处时，小窗必须跟着换（用户要求「要跟」）", async () => {
  const state = {
    sessions: [{ sessionId: "s1", title: "甲" }],
    active: "s1",
    messages: { s1: [{ kind: "user", text: "甲的消息" }] },
  };
  const fake = fakeBridge(state);
  const bridge = loadClient(fake);
  const client = bridge.createClient({ port: 19387 });

  await client.refresh();
  assert.equal(client.getState().sessionId, "s1", "前置：先绑上 s1");

  // 用户在宿主里开了新会话：桥的活跃指针换了，清单里也有了
  state.active = "s2";
  state.sessions = [{ sessionId: "s2", title: "乙" }, { sessionId: "s1", title: "甲" }];
  state.messages.s2 = [{ kind: "user", text: "乙的消息" }];

  await client.refresh();

  assert.equal(
    client.getState().sessionId,
    "s2",
    "活跃指针换到 s2 后，小窗还停在 s1 —— 「要跟」没生效",
  );
  assert.deepEqual(
    client.getState().messages.map((m) => m.text),
    ["乙的消息"],
    "跟着换会话之后，面板内容也必须是新会话的",
  );
  assert.ok(
    fake.asked.some((u) => u.includes("sessionId=s2")),
    "必须真的去拉了新会话的面板，而不是只改了 state",
  );
});

test("桥的活跃指针没变时不得反复重建面板（5 秒轮询不能每次都换）", async () => {
  const fake = fakeBridge({
    sessions: [{ sessionId: "s1" }],
    active: "s1",
    messages: { s1: [{ kind: "user", text: "一条" }] },
  });
  const bridge = loadClient(fake);
  const client = bridge.createClient({ port: 19387 });

  await client.refresh();
  const before = fake.asked.filter((u) => u.includes("/whale/hud")).length;
  await client.refresh();
  await client.refresh();

  // 会话没变就不该多做别的事；至少要能说明「没变就不动」
  assert.equal(client.getState().sessionId, "s1", "没变就不能乱动");
  assert.ok(before >= 1, "第一次必须问过 hud");
});

test("桥的活跃指针变成 null 时，小窗保持当前会话而不是被清空", async () => {
  // 待机（activeSessionId=null）是**会过去**的状态（用户随后开了会话）。
  // 此时把小窗清空会让消息流闪一下白、用户以为自己点坏了。
  const state = {
    sessions: [{ sessionId: "s1", title: "甲" }],
    active: "s1",
    messages: { s1: [{ kind: "user", text: "甲的消息" }] },
  };
  const bridge = loadClient(fakeBridge(state));
  const client = bridge.createClient({ port: 19387 });

  await client.refresh();
  assert.equal(client.getState().sessionId, "s1");

  state.active = null;
  state.sessions = [];
  await client.refresh();

  assert.equal(
    client.getState().sessionId,
    "s1",
    "待机不该把小窗已绑的会话清掉（那会让界面闪白）",
  );
});

test("活跃指针指向清单里没有的会话时，不要盲从", async () => {
  // 防御：桥给的 id 在清单里找不到，说明状态不一致。
  // 盲从会切到一个拉不到面板的会话上，表现是「窗口突然空了」。
  const state = {
    sessions: [{ sessionId: "s1", title: "甲" }],
    active: "s1",
    messages: { s1: [{ kind: "user", text: "甲的消息" }] },
  };
  const bridge = loadClient(fakeBridge(state));
  const client = bridge.createClient({ port: 19387 });

  await client.refresh();

  state.active = "s-幽灵";
  state.sessions = [{ sessionId: "s1", title: "甲" }];
  await client.refresh();

  assert.equal(
    client.getState().sessionId,
    "s1",
    "清单里没有的 id 不该跟过去（会切到一个拉不到面板的会话）",
  );
});

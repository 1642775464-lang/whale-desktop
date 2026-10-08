/**
 * 冷会话种子：小窗启动时应看到「最近一次会话」及其历史（HTTP 层）
 *
 * 职责：按小窗真实会走的顺序打 HTTP，验证冷启动时种子是否真的接上了。
 * 所属层：测试（tests/）
 *
 * 为什么单开一份：这一组要自己的端口与夹具（持久层替身），
 * 与模型/上传那几组不是一类改动原因；挤在一个文件里会顶破 500 行上限
 * （强制 14，按职责拆而不是放宽）。
 *
 * 为什么必须打 HTTP 而不只测单元：
 * 单元测过了**不等于产品通了**——「创建了种子却没挂到 bridge」这种漏接线，
 * 单元层全绿、只有真链路会红。本组就是那根线的守门人
 * （注入验证：删掉 host.js 的 bridge.seed 接线 → 本组 5 条立刻变红）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { apply, dispose } from "../whale-bridge/host.js";
import { createFakeCtx, createHttpTools, sessionRef } from "./helpers/slice3-fixtures.mjs";
/**
 * 冷会话种子：桥起来时一条事件都没收到，也要能把「最近一次会话」给小窗。
 *
 * 这是用户报「权限读不到档位清单、思考强度点了没反应」的真链路复现。
 * 单元测过了**不等于产品通了**（我在这上面犯过好几次）——
 * 这一组直接打 HTTP，按小窗真实会走的顺序问：
 *   /whale/hud 拿 sessionId → /whale/panel 拿消息 → 用这个 id 发命令。
 *
 * 夹具故意**不发任何 session/event**（模拟重启后空闲的会话），
 * 只给持久层（sessionController.list / inspect）。
 * 假 ctx 的 `sessions.list()` 返回 []、`sessions.get()` 认不出冷 id
 * —— 这正是宿主的真实行为（注释写明 "All **live** sessions"）。
 */
const SLICE7_SEED_PORT = 19398;
const slice7SeedHttp = createHttpTools(SLICE7_SEED_PORT);

/**
 * 持久层里那条冷会话的历史。
 * 形状逐字段对齐宿主：`{ seq, type, data, time }`，
 * user/message 取 data.content、assistant/message 取 data.message.content。
 */
const COLD_EVENTS = [
  { seq: 1, type: "session", data: { cwd: "D:\\proj" }, time: 1 },
  { seq: 2, type: "user/message", data: { content: [{ type: "text", text: "重启前说的话" }] }, time: 2 },
  { seq: 3, type: "assistant/message", data: { message: { content: [{ type: "text", text: "重启前的回复" }] } }, time: 3 },
  // 落盘停在 turn/start：上次进程被杀时回合没结束。折完不该点亮「回合运行中」
  { seq: 4, type: "turn/start", data: {}, time: 4 },
];

function coldOnlyCtx() {
  return createFakeCtx({
    services: {
      sessionController: {
        list: async () => ({
          items: [
            {
              sessionId: "s-cold",
              updatedAt: 900,
              cwd: "D:\\proj",
              running: false,
              projections: { values: { title: "从PRD重新实施" } },
            },
          ],
        }),
        inspect: async () => ({ meta: { id: "s-cold" }, inheritedEventCount: 0, events: COLD_EVENTS }),
      },
      permissionPresets: {
        get names() { return ["read-only", "workspace-write", "danger-full-access", "auto"]; },
        current: () => "workspace-write",
      },
    },
  });
}

test("切片 7：冷启动（无事件）时 hud 与 panel 仍能给出最近一次会话", async (t) => {
  // 存进变量：下面的「手动切会话压过自动让位」要给它喂事件
  const seededCtx = coldOnlyCtx();
  await apply(seededCtx, { port: SLICE7_SEED_PORT });

  try {
    await t.test("GET /whale/hud：折叠器为空也要列出持久层的会话并设活跃指针", async () => {
      const { status, json } = await slice7SeedHttp.getJson("/whale/hud");
      assert.equal(status, 200);
      // 这一条就是用户看到「没有会话的窗口」的地方：修复前 sessions 是空的
      assert.equal(json.sessions.length, 1, "冷启动时 hud 必须给出最近一次会话");
      assert.equal(json.activeSessionId, "s-cold", "不设活跃指针，小窗还是拿不到 sessionId");
      assert.equal(json.sessions[0].title, "从PRD重新实施", "冷会话没有 title 事件，标题要从投影带");
    });

    await t.test("GET /whale/panel：冷会话要回显历史消息，且不得 404", async () => {
      // 修复前这里会 404：面板先查 host.getSession()，而宿主只认活会话。
      // 「桥能从持久层读到」与「桥肯把它交给小窗」是两件事，都得测。
      const { status, json } = await slice7SeedHttp.getJson("/whale/panel?sessionId=s-cold");
      assert.equal(status, 200, `冷会话不该被当成不存在（实际 ${status}）`);
      const texts = json.messages.map((m) => m.text);
      assert.ok(texts.includes("重启前说的话"), `历史消息要能回显，实际：${JSON.stringify(texts)}`);
      assert.ok(texts.includes("重启前的回复"));
      assert.equal(json.title, "从PRD重新实施");
    });

    await t.test("冷会话落盘停在 turn/start 时不得点亮「回合运行中」", async () => {
      const { json } = await slice7SeedHttp.getJson("/whale/panel?sessionId=s-cold");
      // 上次进程被杀时回合没结束，照原样折会让小窗显示运行中、中断键点亮，
      // 而实际根本没有活的 agent 在跑。宿主的 running 字段才是事实。
      assert.equal(json.running, false);
    });

    await t.test("用 hud 给的 sessionId 读权限档位要成功（用户报的原始症状）", async () => {
      const hud = await slice7SeedHttp.getJson("/whale/hud");
      // 必须断言这个 id 是 hud **给的**——否则修复前 hud 回 null，
      // 这条测试会因为「sessionId=null」意外走通而变成假绿。
      assert.equal(hud.json.activeSessionId, "s-cold", "前置：hud 必须先给出可用 id");
      const { status, json } = await slice7SeedHttp.getJson(
        `/whale/presets?sessionId=${encodeURIComponent(hud.json.activeSessionId)}`,
      );
      assert.equal(status, 200);
      assert.equal(json.options.length, 4, "小窗靠这个 id 才读得到档位，这是原始症状之一");
      assert.ok(json.options.includes("auto"));
    });

    await t.test("用这个 sessionId 发命令不得再报 bad-request（另一个原始症状）", async () => {
      const { json } = await slice7SeedHttp.postJson("/whale/command", {
        sessionId: "s-cold", line: "/permission read-only",
      });
      // 夹具的 commands 服务只有 list（没 execute），所以可能报不可用，
      // 但**绝不能是 bad-request** —— 那意味着 sessionId 又丢了，症状就回来了。
      assert.notEqual(json.error?.code, "bad-request", `sessionId 又丢了：${JSON.stringify(json)}`);
    });

    await t.test("宿主持久层不认识的 sessionId 必须 404，不能静默给空面板", async () => {
      // ensureSeeded 若不校验清单，任意乱写的 id 也会被建出一个 fold，
      // 后果是把「会话不存在」与「会话是空的」混成一件——
      // 而这两件必须区分（本项目的降级纪律）。
      const { status, json } = await slice7SeedHttp.getJson("/whale/panel?sessionId=编的一个id");
      assert.equal(status, 404, `编造的 id 不该得到面板（实际 ${status}）`);
      assert.equal(json.error.code, "session-not-found");
    });

    await t.test("手动切会话要压过自动让位（先有冷种子 → activate → 别处活动）", async () => {
      // 这一条必须**在冷种子存在的前提下**测，否则是空壳：
      // 没有种子时 activeIsSeed 恒为 false，让位规则压根不触发，
      // 断言删掉实现也照样绿（我第一次就是栽在这，注入验证当场抓出来：
      // 删掉 handlers-slice3-write.mjs 里那行 activeIsSeed=false → 本条立刻变红）。
      //
      // 顺序：种子已设指针 → 用户手动 activate → **另一条会话产生事件**。
      // 期望：指针留在用户选的那条上。
      const seeded = await slice7SeedHttp.getJson("/whale/hud");
      assert.equal(seeded.json.activeSessionId, "s-cold", "前置：种子的默认值已生效");

      // 手动切到一条**宿主认得**的会话（s-live 是夹具里的 live 会话；
      // 冷会话要切得先 resume，那是另一条链路，不在这里测）
      const switched = await slice7SeedHttp.postJson("/whale/activate", { sessionId: "s-live" });
      assert.equal(switched.status, 200, `用户显式切到这条会话（实际 ${switched.status}）`);

      // 别处产生活动：让位规则会想接管，但用户的选择优先
      seededCtx.emit("session/event", sessionRef("s-elsewhere"), {
        seq: 1, time: Date.now(), type: "user/message",
        data: { content: [{ type: "text", text: "别处的活动" }] },
      });

      const after = await slice7SeedHttp.getJson("/whale/hud");
      assert.equal(
        after.json.activeSessionId,
        "s-live",
        "用户显式选定的会话不能被自动让位规则顶掉",
      );
    });
  } finally {
    await dispose();
  }
});

/**
 * 有实时会话时种子必须让路。
 *
 * 这是「修复不能把原本正常的路径弄坏」的反向检查：
 * 实时会话是产品原先唯一可用的形态，种子若在它面前插一脚，
 * 就会抢走活跃指针或覆盖实时消息——那是把一个 bug 换成另一个。
 *
 * ⚠️ 端口必须与上面那组不同：同文件的顶层 test 是并发跑的，
 * 共用端口会互相掐断（见 STATUS 环境坑 18/19/37）。
 */
const SLICE7_LIVE_PORT = 19399;
const slice7LiveHttp = createHttpTools(SLICE7_LIVE_PORT);

test("切片 7：有实时会话时种子不插手", async () => {
  const ctx = coldOnlyCtx();
  await apply(ctx, { port: SLICE7_LIVE_PORT });
  try {
    // 事件流先填上一条实时会话（修复前一切正常的那条路径）
    ctx.emit("session/event", sessionRef("s-live"), {
      seq: 1, time: Date.now(), type: "user/message",
      data: { content: [{ type: "text", text: "实时消息" }] },
    });

    const { json } = await slice7LiveHttp.getJson("/whale/hud");
    const ids = json.sessions.map((s) => s.sessionId);
    assert.ok(ids.includes("s-live"), `实时会话必须还在，实际：${JSON.stringify(ids)}`);
    assert.equal(json.activeSessionId, "s-live", "活跃指针不能被种子的冷会话抢走");
    assert.ok(!ids.includes("s-cold"), "折叠器非空时不该再去读持久层");

    const panel = await slice7LiveHttp.getJson("/whale/panel?sessionId=s-live");
    assert.ok(
      panel.json.messages.map((m) => m.text).includes("实时消息"),
      "实时消息不能被覆盖",
    );
  } finally {
    await dispose();
  }
});


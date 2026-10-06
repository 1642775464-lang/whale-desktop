/**
 * 桥的独立开发服务器
 *
 * 职责：用一个假宿主 ctx 把桥起起来，专供前端（悬浮条 / 小窗）联调与验收。
 *       可选灌入若干假会话，让界面有东西可显示。
 * 所属层：工程工具（tools/）
 *
 * 为什么需要它：桥是 Cordis 插件，**没有独立启动入口**——它靠宿主 `apply(ctx)`。
 * 不写这个，悬浮条就没有真桥可连，验收只能靠手搓 `fetch`，
 * 那验的是「我造的假数据」，不是「桥真的这么回」。
 *
 * 这个服务器**不进产品代码**，只是把宿主那一侧的契约实现成一条最小可跑路径。
 *
 * ⚠️ 端口纪律：**默认端口故意避开测试占用段**。
 * 测试占用的端口是 19387（桥默认）/19388/19389（smoke-slice2）/19390/19391（smoke-slice3），
 * 开发服务器默认用 19500。若图省事让它跑在 19391 上，那条端口一旦没及时释放，
 * `smoke-slice3` 的 `apply({port:19391})` 就会 EADDRINUSE 偶发失败——
 * 表现为「闸门 3 时红时绿」，极难定位（踩过一次）。
 *
 * 用法：
 *   node tools/bridge-dev-server.mjs                    # 起在 19500
 *   node tools/bridge-dev-server.mjs --port 19501       # 换端口
 *   node tools/bridge-dev-server.mjs --seed 2           # 造 2 个正在跑的会话
 */

import { apply, dispose } from "../whale-bridge/host.js";

/**
 * 假宿主 ctx。
 *
 * 只实现桥真正会调用的那几个服务：sessions / agents / commands / attachments / logger / on。
 * 缺的那几个被桥查到时返回 undefined，桥会走它自己的降级路径——
 * 这正是我们要看的（降级不能崩）。
 *
 * @param {Array<object>} seedSessions
 * @returns {object}
 */
function createFakeCtx(seedSessions) {
  const listeners = new Map();
  const agents = new Map();

  /** 记录 agent 收到的调用，供取证（发送 / 中断到底有没有落到宿主）。 */
  const calls = [];

  /**
   * 造一个假 agent。
   *
   * 有了它，`/whale/send` 与 `/whale/abort` 才能走通真实的宿主交互路径——
   * 否则桥会正确地回 `session-not-found`，而那条错误路径验不出
   * 「消息真的发出去了」。
   *
   * @param {string} id
   * @param {"idle"|"running"} status
   */
  function makeAgent(id, status) {
    return {
      status,
      followup(msg) {
        calls.push({ pid: id, method: "followup", msg });
      },
      steer(msg) {
        calls.push({ pid: id, method: "steer", msg });
      },
      cancel(cause, options) {
        calls.push({ pid: id, method: "cancel", cause, options });
      },
    };
  }

  return {
    sessions: {
      list: () => seedSessions.map((s) => ({ id: s.sessionId, header: { id: s.sessionId } })),
      get: (id) => (seedSessions.some((s) => s.sessionId === id) ? { id } : undefined),
    },
    agents: { get: (id) => agents.get(id) },
    commands: { list: () => [], execute: () => ({ text: "（假命令输出）" }) },
    logger: { info: (m) => console.log(`[桥] ${m}`) },

    /** 测试用：塞一个 agent 进去。 */
    __setAgent(id, agent) {
      agents.set(id, agent);
    },

    /** 测试用：给所有种子会话装上假 agent（status 决定发送是排队还是直发）。 */
    __installAgents(status) {
      for (const s of seedSessions) agents.set(s.sessionId, makeAgent(s.sessionId, status));
    },

    /** 测试用：读 agent 收到的调用。 */
    __calls: () => calls,

    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },

    /** 往桥里灌一条宿主事件。 */
    __emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },
  };
}

/**
 * 造一条带用量的 assistant/message 事件。
 *
 * @param {number} seq
 * @param {number} inputTokens
 * @param {number} cacheReadTokens
 * @param {number} outputTokens
 * @returns {object}
 */
function assistantEvent(seq, inputTokens, cacheReadTokens, outputTokens) {
  return {
    seq,
    time: Date.now(),
    type: "assistant/message",
    data: {
      turn: 1,
      step: seq,
      message: { role: "assistant", content: [{ type: "text", text: `第 ${seq} 条` }] },
      usage: { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, cacheReadTokens },
    },
  };
}

/**
 * 灌一批假会话进桥。
 *
 * 会话先「跑起来」（turn/start）再发带用量的事件，
 * 这样 `speed.phase` 才是 running —— 悬浮条的绿点与滚筒都依赖这个判据。
 *
 * 同时灌一条**用户发言**：小窗的消息流要能区分「你」与「DSH」，
 * 只有助手消息时看不出分流对不对。
 *
 * @param {object} ctx
 * @param {number} count
 * @param {Array<string>} titles
 */
function seed(ctx, count, titles) {
  for (let i = 0; i < count; i += 1) {
    const sessionId = `s-seed-${i + 1}`;
    const session = { id: sessionId, header: { id: sessionId } };
    ctx.__emit("session/event", session, {
      seq: 1,
      time: Date.now(),
      type: "request/context",
      data: { contextWindow: 1000000 },
    });
    ctx.__emit("session/event", session, {
      seq: 2,
      time: Date.now(),
      type: "turn/start",
      data: { turn: 1 },
    });
    // 用户发言（只有第 1 个会话灌，便于分辨）
    //
    // 注意**事件封套不同**：宿主的 user/message 把内容直接放在 `data.content`，
    // 没有 `message` 包裹；而 assistant/message 是 `data.message.content`。
    // 这不是笔误——references/session-events.md 实测如此，两者形状确实不同。
    if (i === 0) {
      // 工具调用 + 任务清单：让小窗的状态条（「正在运行 bash」）与任务坞
      // 有东西可显示。缺了它们，这两个界面块永远测不到。
      ctx.__emit("session/event", session, {
        seq: 3,
        time: Date.now(),
        type: "tool/call",
        data: { name: "bash", id: "call_seed" },
      });
      ctx.__emit("session/event", session, {
        seq: 4,
        time: Date.now(),
        type: "user/message",
        data: { role: "user", content: [{ type: "text", text: "帮我看下这个项目" }] },
      });
      ctx.__emit("session/event", session, {
        seq: 5,
        time: Date.now(),
        type: "todo/write",
        data: {
          todos: [
            { content: "读源码事实", status: "completed" },
            { content: "产出两份 PRD", status: "in_progress" },
            { content: "写状态汇报", status: "pending" },
          ],
        },
      });
    }
    ctx.__emit("session/event", session, assistantEvent(6 + i, 983, 92288, 120 + i * 40));
  }
  console.log(`[桥] 已灌入 ${count} 个假会话：${titles.slice(0, count).join(" / ")}`);
}

/**
 * 开发服务器默认端口。
 *
 * 刻意避开测试占用段（19387–19391）：本文件与测试同时跑过，
 * 撞端口会让闸门 3 偶发红，归属极难判断。
 */
const DEV_PORT = 19500;

/** 解析命令行参数。 */
function parseArgs(argv) {
  const out = { port: DEV_PORT, seed: 0, idle: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--port") out.port = Number(argv[i + 1]);
    if (argv[i] === "--seed") out.seed = Number(argv[i + 1]);
    // --idle：灌完后补一条 turn/end，把会话置为「空闲」。
    // 「回合运行中」与「回合空闲」是两种必须分别验的场景：
    // 前者验中断键与状态条，后者验发送进真会话。
    if (argv[i] === "--idle") out.idle = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

/** 假会话标题：多会话时用来看滚筒翻转。 */
const TITLES = ["继续开发豆包式小窗口", "AI热点新闻总结", "上周的调研"];

const ctx = createFakeCtx(Array.from({ length: args.seed }, (_v, i) => ({ sessionId: `s-seed-${i + 1}` })));

await apply(ctx, { port: args.port });

if (args.seed > 0) {
  seed(ctx, Math.min(args.seed, TITLES.length), TITLES);
}

// 置空闲：把每个会话的回合收掉，让发送键回到「发送」而不是「中断」
if (args.idle) {
  for (let i = 0; i < Math.min(args.seed, TITLES.length); i += 1) {
    const sessionId = `s-seed-${i + 1}`;
    ctx.__emit("session/event", { id: sessionId, header: { id: sessionId } }, {
      seq: 900 + i,
      time: Date.now(),
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });
  }
  console.log("[桥] 已置为空闲（回合结束）");
}

// 装假 agent：没有它 /whale/send 与 /whale/abort 会正确地回 session-not-found，
// 而那是错误路径，验不出「消息真的交给了宿主」。
// agent 的 status 与桥观察到的回合状态保持一致：
//   运行中 → running（发送走排队、中断真的 cancel）
//   空闲   → idle（发送走 followup、中断被护栏挡成 409）
if (args.seed > 0) {
  ctx.__installAgents(args.idle ? "idle" : "running");
  console.log(`[桥] 已装上假 agent（status=${args.idle ? "idle" : "running"}）`);
}

/** 取证端口：让探针能读 agent 收到了什么（只读，仅联调用）。 */
if (args.seed > 0) {
  const { createServer } = await import("node:http");
  createServer((req, res) => {
    if (req.url === "/probe/calls") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(ctx.__calls()));
      return;
    }
    res.writeHead(404).end();
  }).listen(args.port + 1, "127.0.0.1", () => {
    console.log(`[桥] 取证端口 http://127.0.0.1:${args.port + 1}/probe/calls`);
  });
}

console.log(`[桥] 就绪：http://127.0.0.1:${args.port}/whale`);

// 常驻：收到 SIGINT / SIGTERM 时干净卸载（会先关自己拉起的小窗，再关服务）
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    console.log(`[桥] 收到 ${signal}，正在卸载…`);
    dispose()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
  });
}

// 心跳 tick 每 2 秒一次，这里额外定期补一脚用量事件，
// 让 tokPerSec 有真实增量可算（否则速度永远是 0，验不出 F5）
if (args.seed > 0) {
  setInterval(() => {
    for (let i = 0; i < Math.min(args.seed, TITLES.length); i += 1) {
      const sessionId = `s-seed-${i + 1}`;
      const session = { id: sessionId, header: { id: sessionId } };
      ctx.__emit("session/event", session, assistantEvent(100 + Math.floor(Date.now() / 1000) + i, 983, 92288, 90));
    }
  }, 1000).unref();
}

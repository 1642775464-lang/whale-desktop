/**
 * 用**真实 Cordis**验证 inject 对插件启动的影响
 *
 * 职责：回答两个决定成败的问题：
 *   1. 声明了 inject、但其中有一个服务**永不存在** → 插件会不会启动？
 *   2. 声明了 inject 且这些服务都注册了 → 插件能不能启动并读到服务？
 *
 * 为什么必须用真库：我自己模拟的守卫可能被我写错，
 * 而结论一旦错了，代价是让用户再重启一次宿主。
 *
 * 用法：node tools/cordis-inject-verify.mjs
 */

import { pathToFileURL } from "node:url";

const CORDIS = "C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js";
const report = {};

const cordis = await import(pathToFileURL(CORDIS).href);
const { Context } = cordis;
report.hasContext = typeof Context === "function";
if (!report.hasContext) {
  console.log(`INJECT_VERIFY ${  JSON.stringify(report, null, 2)}`);
  process.exit(0);
}

/** 起一个最小应用，注入若干服务，然后挂一个插件，看 apply 有没有被调用。 */
function trial({ provided, inject, label }) {
  const out = { label, applied: false, sawSessions: null, error: null };
  const root = new Context();

  for (const [name, value] of Object.entries(provided)) {
    try {
      root.provide(name, value);
    } catch (err) {
      out.error = `provide(${name}) 失败: ${err.message}`;
    }
  }

  const plugin = {
    name: "trial",
    inject,
    apply(ctx) {
      out.applied = true;
      try {
        out.sawSessions = typeof ctx.sessions;
      } catch (err) {
        out.sawSessions = `throw: ${err.message}`;
      }
    },
  };

  try {
    const fork = root.plugin(plugin);
    if (fork && typeof fork.start === "function") fork.start();
    // cordis 的 plugin() 可能已同步启动；也可能返回 fork 需显式 start
    if (fork && typeof fork.then === "function") return out; // 不等待异步，避免挂住
  } catch (err) {
    out.error = String(err.message ?? err);
  }
  return out;
}

const fakeSessions = { list: () => [], get: () => undefined };
const fakeAgents = { get: () => undefined };
const fakeCommands = { list: () => [], execute: () => ({ text: "ok" }) };

// 场景 1：inject 里全是真实服务
report.allReal = trial({
  provided: { sessions: fakeSessions, agents: fakeAgents, commands: fakeCommands },
  inject: ["sessions", "agents", "commands"],
  label: "全为真实服务",
});

// 场景 2：inject 里混一个不存在的服务（这就是第二次重启失败的形状）
report.withGhost = trial({
  provided: { sessions: fakeSessions, agents: fakeAgents, commands: fakeCommands },
  inject: ["sessions", "agents", "commands", "projections"],
  label: "混入不存在的 projections",
});

// 场景 3：不声明 inject
report.noInject = trial({
  provided: { sessions: fakeSessions },
  inject: undefined,
  label: "不声明 inject",
});

console.log(`INJECT_VERIFY ${  JSON.stringify(report, null, 2)}`);

/**
 * 装插件前的预检：用**真实宿主服务形状**的假 ctx 试跑一次桥
 *
 * 职责：在动宿主文件之前，验证桥能对着「按宿主接口文档搭出来的 ctx」装配成功，
 *       而不是只在自建的极简假 ctx 上跑通过。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须做：装插件要重启宿主。若桥在真实 ctx 上抛错，宿主的插件加载会失败，
 * 而那会连带影响你手头正在用的环境。宁可在外面先撞一次墙。
 *
 * 这里的 ctx 按 references/host-interfaces.md 的真实签名搭：
 *   ctx.on / ctx.sessions.{get,list,prepare,enter} / ctx.agents.get /
 *   ctx.commands.{list,execute} / ctx.models.list / ctx.attachments.admitPromptContent
 *
 * 用法：node tools/bridge-preflight.mjs
 */

import { apply, dispose, HOST } from "../whale-bridge/host.js";

/** 记录调用，便于看桥到底碰了哪些服务。 */
const touched = new Set();

/** 造一个「按文档签名」的宿主 ctx。 */
function createDocumentedCtx() {
  const listeners = new Map();
  const agents = new Map();
  const sessions = new Map();

  // 一个真实形状的会话 + agent
  const sessionId = "preflight-session";
  const session = { id: sessionId, header: { id: sessionId, title: "预检会话" } };
  sessions.set(sessionId, session);

  const agent = {
    id: sessionId,
    status: "idle",
    session,
    followup(msg) {
      touched.add("agent.followup");
      return { accepted: true, message: msg };
    },
    steer(msg) {
      touched.add("agent.steer");
      return { accepted: true, message: msg };
    },
    cancel(cause, options) {
      touched.add("agent.cancel");
      return { accepted: true, cause, options };
    },
  };
  agents.set(sessionId, agent);

  return {
    // 事件订阅：宿主用 ctx.on 注册
    on(event, fn) {
      touched.add(`ctx.on(${event})`);
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    emit(event, ...args) {
      for (const fn of listeners.get(event) ?? []) fn(...args);
    },

    // 服务：桥通过 ctx.<name> 取用
    sessions: {
      get: (id) => { touched.add("sessions.get"); return sessions.get(id); },
      list: () => { touched.add("sessions.list"); return [...sessions.values()]; },
      prepare: () => { touched.add("sessions.prepare"); return session; },
      enter: () => { touched.add("sessions.enter"); },
    },
    agents: {
      get: (id) => { touched.add("agents.get"); return agents.get(id); },
      list: () => [...agents.values()],
    },
    commands: {
      list: () => { touched.add("commands.list"); return []; },
      execute: () => { touched.add("commands.execute"); return { text: "ok" }; },
    },
    models: {
      list: () => { touched.add("models.list"); return [{ id: "m1", name: "模型一" }]; },
    },
    attachments: {
      admitPromptContent: (content) => { touched.add("attachments.admitPromptContent"); return content; },
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  };
}

const report = { phases: [] };
const ctx = createDocumentedCtx();

// ── 1) 装配 ──
try {
  await apply(ctx, { port: 19610 });
  report.phases.push({ phase: "apply", ok: true });
} catch (err) {
  report.phases.push({ phase: "apply", ok: false, error: err.message, stack: err.stack?.split("\n").slice(0, 4) });
  console.log(`PREFLIGHT_RESULT ${  JSON.stringify(report, null, 2)}`);
  process.exit(1);
}

// ── 2) 起来之后真发几个请求 ──
const BASE = "http://127.0.0.1:19610";

/** 发请求并解析。 */
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

try {
  const hud = await call("GET", "/whale/hud");
  report.phases.push({ phase: "GET /whale/hud", status: hud.status, ok: hud.status === 200 });

  const routes = await call("GET", "/whale");
  report.phases.push({
    phase: "GET /whale",
    status: routes.status,
    routeCount: routes.json?.routes?.length,
    implemented: routes.json?.routes?.filter((r) => r.implemented).length,
  });

  const models = await call("GET", "/whale/models");
  report.phases.push({ phase: "GET /whale/models", status: models.status, total: models.json?.total });

  const send = await call("POST", "/whale/send", { sessionId: "preflight-session", text: "预检消息" });
  report.phases.push({ phase: "POST /whale/send", status: send.status, json: send.json });

  const abortRes = await call("POST", "/whale/abort", { sessionId: "preflight-session" });
  report.phases.push({ phase: "POST /whale/abort", status: abortRes.status, json: abortRes.json });

  const panel = await call("GET", "/whale/panel?sessionId=preflight-session");
  report.phases.push({ phase: "GET /whale/panel", status: panel.status, running: panel.json?.running });
} catch (err) {
  report.phases.push({ phase: "requests", ok: false, error: err.message });
}

// ── 3) 卸载必须干净 ──
try {
  await dispose();
  report.phases.push({ phase: "dispose", ok: true });
  // 卸载后端口应拒绝连接
  let refused = false;
  try {
    await fetch(`${BASE}/whale`);
  } catch {
    refused = true;
  }
  report.phases.push({ phase: "port-closed-after-dispose", ok: refused });
} catch (err) {
  report.phases.push({ phase: "dispose", ok: false, error: err.message });
}

report.touchedServices = [...touched].sort();
report.host = HOST;
report.checks = {
  appliedOk: report.phases.some((p) => p.phase === "apply" && p.ok === true),
  allRoutesImplemented: report.phases.find((p) => p.phase === "GET /whale")?.implemented === 22,
  sendLanded: report.phases.find((p) => p.phase === "POST /whale/send")?.json?.ok === true,
  abortGuarded: report.phases.find((p) => p.phase === "POST /whale/abort")?.json?.error?.code === "no-active-turn",
  disposeClean: report.phases.some((p) => p.phase === "port-closed-after-dispose" && p.ok === true),
};
report.verdict = Object.values(report.checks).every(Boolean) ? "pass" : "fail";

console.log(`PREFLIGHT_RESULT ${  JSON.stringify(report, null, 2)}`);
process.exit(report.verdict === "pass" ? 0 : 1);

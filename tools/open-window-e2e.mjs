/**
 * 拉窗链路的端到端取证（回补切片 3 的 C7/C8/C12）
 *
 * 职责：用**真实的桥**跑一遍「拉窗 → 复用 → 关闭」，验证
 *       C7 拉窗可用、C8 拉窗复用、C12 卸载时关窗。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须真跑一次：切片 3 交付时这三条验不了（当时没有 whale-window/），
 * 只能验「降级路径明确报错」。而这条链路里藏过一个真实缺陷——
 * spawn 的入口是仓库根相对的 `whale-window/main.cjs`，cwd 却已经是
 * `<仓库根>/whale-window`，两者一拼成不存在的路径，小窗永远起不来。
 * 旧单测分两句断言「入口对不对」「cwd 对不对」，两句各自都过。
 *
 * 所以这里直接**看进程是否真的活着**，而不是看参数对不对。
 *
 * 用法：node tools/open-window-e2e.mjs
 */

import { apply, dispose } from "../whale-bridge/host.js";
import { execFileSync } from "node:child_process";

/** 用假宿主 ctx 起桥（只实现拉窗需要的服务）。 */
function createFakeCtx() {
  const listeners = new Map();
  return {
    sessions: { list: () => [], get: () => undefined },
    agents: { get: () => undefined },
    commands: { list: () => [] },
    logger: { info: () => {} },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
  };
}

const PORT = 19600;
const BASE = `http://127.0.0.1:${PORT}`;

const ctx = createFakeCtx();
const report = { steps: [] };

/** 发一个 POST。 */
async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** 发一个 GET。 */
async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** 进程是否还活着。 */
function isAlive(pid) {
  try {
    const out = execFileSync("powershell", [
      "-NoProfile",
      "-Command",
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { 'alive' } else { 'dead' }`,
    ], { encoding: "utf8" });
    return out.trim() === "alive";
  } catch {
    return false;
  }
}

await apply(ctx, { port: PORT });
console.log(`[取证] 桥已起在 ${PORT}`);

// ── C7：拉窗可用 ──
const opened = await post("/whale/open", { reason: "e2e" });
report.c7 = { status: opened.status, json: opened.json };
if (opened.json?.ok === true && typeof opened.json.pid === "number") {
  // 给它一点时间真正起来
  await new Promise((r) => setTimeout(r, 4000));
  report.c7.processAlive = isAlive(opened.json.pid);
  report.c7.reusedFlag = opened.json.reused;
}

// ── C8：连续两次 open，第二次必须复用 ──
const second = await post("/whale/open", { reason: "e2e-again" });
report.c8 = { status: second.status, json: second.json };

// 窗口列表应只有 1 个
const listed = await get("/whale/windows");
report.c8.windowsList = { status: listed.status, total: listed.json?.total, items: listed.json?.windows };

// ── C12：卸载时关窗 ──
const pidToCheck = report.c7.json?.pid;
await dispose();
await new Promise((r) => setTimeout(r, 1500));
report.c12 = {
  disposed: true,
  pidWas: pidToCheck,
  processAliveAfterDispose: typeof pidToCheck === "number" ? isAlive(pidToCheck) : null,
};

// 判定
report.checks = {
  okC7: report.c7.status === 200 && report.c7.json?.ok === true && report.c7.processAlive === true,
  okC8: report.c8.json?.ok === true && report.c8.json?.reused === true && report.c8.windowsList?.total === 1,
  okC12: report.c12.processAliveAfterDispose === false,
};
report.verdict = report.checks.okC7 && report.checks.okC8 && report.checks.okC12 ? "pass" : "fail";

console.log(`E2E_RESULT ${  JSON.stringify(report, null, 2)}`);
process.exit(0);

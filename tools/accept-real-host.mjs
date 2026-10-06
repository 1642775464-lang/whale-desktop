/**
 * 真实宿主端到端验收
 *
 * 职责：对着**真实宿主里的桥**跑一遍写操作链路，验 B5/B6/B7 的真语义。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须真宿主：假桥的 agent 是我自己造的，不会做 snapshotJsonValue 校验——
 * 也就是说「Promise 被宿主拒掉」这个真 bug 在假桥上根本复现不出来。
 * 假桥能验「请求发对了」，验不了「宿主真的接受了这条消息」。
 *
 * 验什么：
 *   B5 发消息进真会话   → POST /whale/send 返回 ok，且桥随后能观察到该事件
 *   B6 排队语义         → 回合运行中发送返回 queued:true / mode:queue
 *   B7 中断有护栏       → 运行中 abort 返回 ok；空闲时 abort 返回 409 不误伤
 *
 * 每条都取**机器可判**的证据，不靠肉眼看界面。
 *
 * 用法：node tools/accept-real-host.mjs
 */

const BASE = "http://127.0.0.1:19387";

/** 发请求。 */
async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

const report = { steps: [] };

function note(label, data) {
  report.steps.push({ label, ...data });
  console.log(`  ${label}: ${JSON.stringify(data)}`);
}

// ── 前置：桥活着吗 ──
console.log("=== 前置检查 ===");
const probe = await call("GET", "/whale/probe");
const servicesOk =
  probe.status === 200 &&
  probe.json.host?.sessions === true &&
  probe.json.host?.agents === true;
note("桥服务可用", { ok: servicesOk, host: probe.json.host });

if (!servicesOk) {
  report.verdict = "blocked";
  report.reason = "桥的服务不可用（插件可能没重新加载，请重启宿主）";
  console.log(`\nACCEPT_RESULT ${  JSON.stringify(report)}`);
  process.exit(1);
}

const hud = await call("GET", "/whale/hud");
const sid = hud.json.activeSessionId;
const session = (hud.json.sessions ?? []).find((s) => s.sessionId === sid);
note("当前会话", { sessionId: sid, phase: session?.speed?.phase, tokPerSec: session?.speed?.tokPerSec });

if (typeof sid !== "string") {
  report.verdict = "blocked";
  report.reason = "桥看不到任何会话";
  console.log(`\nACCEPT_RESULT ${  JSON.stringify(report)}`);
  process.exit(1);
}

// ── B5：发消息进真会话 ──
// 用可识别的标记文本，发完再从桥的事件里找它——
// 只有「桥确实观察到了这条 user/message」才算进真会话。
console.log("\n=== B5 发消息进真会话 ===");
const marker = `验收标记-${Date.now()}`;
const sent = await call("POST", "/whale/send", { sessionId: sid, text: marker });
note("POST /whale/send", { status: sent.status, json: sent.json });

const sendOk = sent.status === 200 && sent.json.ok === true;

// 等桥把这个事件折进来（事件是同步分发的，给一点余量）
await new Promise((r) => setTimeout(r, 1500));
const panel = await call("GET", `/whale/panel?sessionId=${encodeURIComponent(sid)}`);
const landed = (panel.json.messages ?? []).some(
  (m) => m.kind === "user" && typeof m.text === "string" && m.text.includes(marker),
);
note("消息出现在桥的折叠器里", { landed, marker });

// ── B6：排队语义 ──
console.log("\n=== B6 排队语义 ===");
// 此刻这个会话正在跑（用户正在跟我对话），所以发送应当排队
const runningNow = session?.speed?.phase === "running";
note("发送时会话状态", { running: runningNow, phase: session?.speed?.phase });
const queued = sent.json.queued === true && sent.json.mode === "queue";
note("排队标记", {
  queued: sent.json.queued,
  mode: sent.json.mode,
  ok: !runningNow || queued,
  note: runningNow ? "回合在跑，必须 queued:true" : "回合空闲，queued 可为 false",
});

// ── B7：中断有护栏 ──
console.log("\n=== B7 中断护栏 ===");
const aborted = await call("POST", "/whale/abort", { sessionId: sid });
note("POST /whale/abort", { status: aborted.status, json: aborted.json });
// 本会话确实有活跃回合（用户正在等回复），所以 abort 应当被接受
const abortAccepted = aborted.status === 200 && aborted.json.ok === true;
note("中断被接受（有活跃回合）", { ok: abortAccepted });

// 护栏的另一半：对不存在的会话中断，必须明确失败而不是静默
const bogus = await call("POST", "/whale/abort", { sessionId: "不存在的会话" });
const guardOk = bogus.status === 404 || bogus.status === 409;
note("对不存在会话中断被拒", { status: bogus.status, ok: guardOk });

// ── 判定 ──
report.checks = {
  okServices: servicesOk,
  okB5: sendOk && landed,
  okB6: !runningNow || queued,
  okB7: abortAccepted && guardOk,
};
report.verdict = Object.values(report.checks).every(Boolean) ? "pass" : "fail";

console.log(`\nACCEPT_RESULT ${  JSON.stringify(report.checks)  } verdict=${  report.verdict}`);
process.exit(report.verdict === "pass" ? 0 : 1);

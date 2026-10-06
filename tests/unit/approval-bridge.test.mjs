/**
 * approval-bridge 单测
 *
 * 核心验证「无人应答时才接管」这条语义——
 * 它是本模块唯一真正容易写错、且写错了用户会直接察觉的地方
 * （点了按钮没反应 / 框都没弹就被答了）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  APPROVAL_OUTCOMES,
  APPROVAL_TIMEOUT_MS,
  createApprovalBridge,
} from "../../whale-bridge/lib/approval-bridge.mjs";

/** 造一个「下游立即给出某答案」的 next。 */
function nextReturning(value) {
  const calls = [];
  const fn = async () => {
    calls.push(1);
    return value;
  };
  fn.calls = calls;
  return fn;
}

test("超时常量与宿主 OUTCOMES 对齐", () => {
  assert.equal(APPROVAL_TIMEOUT_MS, 30000);
  assert.deepEqual(APPROVAL_OUTCOMES, ["allowed-once", "rejected", "cancelled", "unavailable"]);
});

test("下游给出明确答案时桥不插手", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 50 });
  const next = nextReturning("allowed-once");

  const out = await bridge.onApprovalRequest({ sessionId: "s1" }, next);

  assert.equal(out, "allowed-once", "尊重宿主 UI 的答案");
  assert.equal(bridge.stats.delegated, 1);
  assert.equal(bridge.stats.requested, 0, "有人答了就不该登记为挂起");
});

test("下游答 rejected 同样被尊重", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 50 });
  const out = await bridge.onApprovalRequest({}, nextReturning("rejected"));
  assert.equal(out, "rejected");
  assert.equal(bridge.stats.delegated, 1);
});

test("下游答 unavailable 时桥接管并登记为挂起", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 5000 });
  const promise = bridge.onApprovalRequest({ sessionId: "s1" }, nextReturning("unavailable"));

  // 等到登记完成
  await tick();

  const pending = bridge.listPending();
  assert.equal(pending.length, 1, "无人应答就该出现在待确认清单里");
  assert.equal(pending[0].sessionId, "s1");
  assert.equal(bridge.hasPending(), true);

  // 用户从悬浮窗答
  bridge.answer(pending[0].id, "allowed-once");

  assert.equal(await promise, "allowed-once");
  assert.equal(bridge.hasPending(), false, "答完就该摘掉");
});

test("超时后返回 unavailable，不挂住宿主回合", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 30 });

  const started = Date.now();
  const out = await bridge.onApprovalRequest({}, nextReturning("unavailable"));
  const elapsed = Date.now() - started;

  assert.equal(out, "unavailable");
  assert.ok(elapsed >= 25, `应确实等过一段时间（实测 ${elapsed}ms）`);
  assert.equal(bridge.stats.timedOut, 1);
  assert.equal(bridge.hasPending(), false, "超时后不得残留挂起项");
});

test("下游监听器抛错时返回 unavailable，不把异常抛回宿主", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 50 });
  const out = await bridge.onApprovalRequest({}, async () => {
    throw new Error("下游炸了");
  });

  assert.equal(out, "unavailable");
  assert.equal(bridge.stats.rejected, 1);
});

test("answer：非法 outcome 被拒绝", () => {
  const bridge = createApprovalBridge();
  const out = bridge.answer("ap-1", "yes-please");
  assert.equal(out.ok, false);
  assert.equal(out.code, "bad-request");
});

test("answer：未知 id 被拒绝", () => {
  const bridge = createApprovalBridge();
  const out = bridge.answer("ap-999", "allowed-once");
  assert.equal(out.ok, false);
  assert.equal(out.code, "approval-not-found");
});

test("answer：重复应答同一条，第二次报 not-found（已被摘掉）", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 5000 });
  const promise = bridge.onApprovalRequest({}, nextReturning("unavailable"));
  await tick();

  const id = bridge.listPending()[0].id;
  assert.equal(bridge.answer(id, "rejected").ok, true);
  await promise;

  const second = bridge.answer(id, "rejected");
  assert.equal(second.ok, false);
  assert.equal(second.code, "approval-not-found");
});

test("attach：宿主不支持 on() 时返回空数组且不抛", () => {
  const bridge = createApprovalBridge();
  const logs = [];
  const b = createApprovalBridge({ log: (m) => logs.push(m) });

  assert.deepEqual(bridge.attach({}), []);
  assert.deepEqual(b.attach(null), []);
  assert.ok(logs.length > 0, "应说明为何没挂上");
});

test("attach：正常挂载并返回退订函数", () => {
  const handlers = new Map();
  const ctx = {
    on(event, fn) {
      handlers.set(event, fn);
      return () => handlers.delete(event);
    },
  };
  const bridge = createApprovalBridge();

  const disposers = bridge.attach(ctx);

  assert.equal(disposers.length, 1);
  assert.ok(handlers.has("approval/request"), "必须挂在 approval/request 瀑布上");
  disposers[0]();
  assert.equal(handlers.has("approval/request"), false);
});

test("attach：on() 抛错时降级，不影响插件加载", () => {
  const bridge = createApprovalBridge({ log: () => {} });
  const ctx = {
    on() {
      throw new Error("宿主不接受该事件");
    },
  };

  assert.doesNotThrow(() => bridge.attach(ctx));
  assert.deepEqual(bridge.attach(ctx), []);
});

test("listPending：不泄漏宿主请求对象", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 5000 });
  const promise = bridge.onApprovalRequest(
    { sessionId: "s1", summary: "要执行命令", internalRef: { deep: true } },
    nextReturning("unavailable"),
  );
  await tick();

  const [entry] = bridge.listPending();
  assert.equal(entry.sessionId, "s1");
  assert.equal(entry.summary, "要执行命令");
  assert.equal(entry.internalRef, undefined, "内部引用不得外传");

  bridge.answer(entry.id, "cancelled");
  await promise;
});

test("会话 id 从 agent 上兜底取", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 5000 });
  const promise = bridge.onApprovalRequest(
    { agent: { session: { id: "from-agent" } } },
    nextReturning("unavailable"),
  );
  await tick();

  assert.equal(bridge.listPending()[0].sessionId, "from-agent");
  bridge.answer(bridge.listPending()[0].id, "rejected");
  await promise;
});

test("快照统计反映全过程", async () => {
  const bridge = createApprovalBridge({ timeoutMs: 20 });
  await bridge.onApprovalRequest({}, nextReturning("allowed-once"));
  await bridge.onApprovalRequest({}, nextReturning("unavailable"));

  const snap = bridge.snapshot();
  assert.equal(snap.delegated, 1);
  assert.equal(snap.timedOut, 1);
  assert.equal(snap.pendingCount, 0);
});

/** 让出事件循环，等挂起登记完成。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

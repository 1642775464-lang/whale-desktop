/**
 * 用系统默认程序打开工作区文件（Typert 调用）
 *
 * 职责：钉住 `openWorkspacePath()` 的调用形状与「没打开就不算成功」。
 * 所属层：测试（tests/unit）
 *
 * 契约来源（`dsh-api-session-controller` 的 typert.host.js）：
 *   session/openWorkspacePath
 *     args `{ request: { path, action?: "reveal", application?: string } }`
 *       → `{ opened: true }`
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTypertBridge } from "../../whale-bridge/lib/typert-bridge.mjs";

function ctxWith(services) {
  return {
    get: (name) => (Object.hasOwn(services, name) ? services[name] : undefined),
  };
}

function recordingGateway(handler) {
  const calls = [];
  return {
    calls,
    invoke: (request) => {
      calls.push(request);
      return handler(request);
    },
  };
}

test("openWorkspacePath：传 {request:{path}}，按 opened 判定成功", async () => {
  const gateway = recordingGateway(() => Promise.resolve({ opened: true }));
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.openWorkspacePath({ path: "docs/readme.md" });
  assert.equal(out.ok, true);
  assert.equal(out.opened, true);
  assert.deepEqual(gateway.calls[0], {
    namespace: "session",
    method: "openWorkspacePath",
    args: { request: { path: "docs/readme.md" } },
  });
});

test("openWorkspacePath：只在需要时才带 action / application 键", async () => {
  /*
   * 严格 codec：多带一个键会改变调用语义，所以按需带上、不默认填。
   */
  const gateway = recordingGateway(() => Promise.resolve({ opened: true }));
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  await bridge.openWorkspacePath({ path: "a.txt" });
  assert.deepEqual(gateway.calls[0].args.request, { path: "a.txt" }, "不给就不要带可选键");

  await bridge.openWorkspacePath({ path: "a.txt", reveal: true });
  assert.equal(gateway.calls[1].args.request.action, "reveal");

  await bridge.openWorkspacePath({ path: "a.txt", application: "code" });
  assert.equal(gateway.calls[2].args.request.application, "code");
});

test("openWorkspacePath：宿主没给 opened:true 就**不算成功**", async () => {
  /*
   * ⚠️ 这是「点了没反应」的来源：宿主返回了一个对象但没真打开。
   * 把它当成功，界面就不会给用户任何反馈。
   */
  const gateway = recordingGateway(() => Promise.resolve({ opened: false }));
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.openWorkspacePath({ path: "a.txt" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "session-not-ready");
});

test("openWorkspacePath：缺 path 明确拒绝，不去敲宿主", async () => {
  const gateway = recordingGateway(() => Promise.resolve({ opened: true }));
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  assert.equal((await bridge.openWorkspacePath({})).code, "bad-request");
  assert.equal((await bridge.openWorkspacePath({ path: "" })).code, "bad-request");
  assert.equal(gateway.calls.length, 0, "参数不全就别发请求");
});

test("openWorkspacePath：网关失败时原样回传 code", async () => {
  const gateway = recordingGateway(() =>
    Promise.reject(Object.assign(new Error("x"), { code: "gateway/invocation-unavailable" })));
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.openWorkspacePath({ path: "a.txt" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "gateway/invocation-unavailable");
});

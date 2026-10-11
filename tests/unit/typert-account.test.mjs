/**
 * 账号信息与余额的 Typert 调用
 *
 * 职责：钉住 `accountInfo()` 的调用形状（必填 `client`）与「两块各自独立」。
 * 所属层：测试（tests/unit）
 *
 * 为什么从 typert-bridge.test.mjs 拆出来：那个文件顶到 500 行上限（强制 14）。
 * account 这条与「会话清单 / 技能目录」不是同一类数据源，
 * 失败模式也不同（两块可分别失败），拆开让红了的用例指对方向。
 *
 * 契约来源：`dsh-api-account-controller` 的 typert.host.js ——
 *   account/getProfile  args:{client:{version,locale,timezoneOffsetSeconds}}
 *     → {status:"ready", value:{id,name,contact,avatarUrl?}} | {status:"failed"}
 *   account/getBalance  同上 args
 *     → {status:"ready", value:[{currency,balance}], bonusWallets:[...]} | {status:"failed"}
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createTypertBridge } from "../../whale-bridge/lib/typert-bridge.mjs";

/** 造一个带 `get` 的假 ctx。 */
function ctxWith(services) {
  return {
    get: (name) => (Object.hasOwn(services, name) ? services[name] : undefined),
  };
}

/** 造一个可编程的假网关（记录调用）。 */
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

test("accountInfo：调 account/getProfile 与 account/getBalance，带必填 client", async () => {
  /*
   * ⚠️ `client` 是**必填**参数（AccountClientMetadata，严格 codec）——
   * 缺字段会被整条拒掉，表现是「账号模块永远读不到」。
   *
   * ⚠️ 为什么要读 getState：`getProfile` 无凭证时返回 `null`，
   * 光看它分不出「未登录」与「读取被中断」。
   */
  const gateway = recordingGateway((request) => {
    if (request.method === "getState") {
      return Promise.resolve({
        status: "credential-stored",
        links: { usageUrl: "u", topUpUrl: "t" },
        attempt: null,
      });
    }
    if (request.method === "getProfile") {
      return Promise.resolve({
        status: "ready",
        value: { id: "u1", name: "张三", contact: "a@b.com", avatarUrl: null },
      });
    }
    return Promise.resolve({
      status: "ready",
      value: [{ currency: "CNY", balance: "9.5534315800000000" }],
      bonusWallets: [{ currency: "CNY", balance: "1.00" }],
    });
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.accountInfo();
  assert.equal(out.ok, true);
  assert.equal(out.signedIn, true, "getState 的 status 决定登录状态");
  assert.deepEqual(out.profile, { name: "张三", contact: "a@b.com", avatarUrl: null });
  // 余额原样透传高精度串，截位交给界面（界面才知道显示需求）
  assert.deepEqual(out.balance.wallets, [{ currency: "CNY", balance: "9.5534315800000000" }]);
  assert.deepEqual(out.balance.bonusWallets, [{ currency: "CNY", balance: "1.00" }]);

  // 三个方法都在 account 命名空间，且 client 必填字段齐全
  assert.deepEqual(gateway.calls.map((c) => [c.namespace, c.method]), [
    ["account", "getState"],
    ["account", "getProfile"],
    ["account", "getBalance"],
  ]);
  for (const c of gateway.calls) {
    assert.equal(typeof c.args.client.version, "string", "version 必填");
    assert.equal(typeof c.args.client.locale, "string", "locale 必填");
    assert.equal(typeof c.args.client.timezoneOffsetSeconds, "number", "偏移必填");
  }
});

test("accountInfo：getState 说未登录时 signedIn=false", async () => {
  const gateway = recordingGateway((request) => {
    if (request.method === "getState") {
      // 未登录时 getProfile 返回 null（宿主实现：stored === null → return null）
      return Promise.resolve({ status: "signed-out", links: {}, attempt: null });
    }
    if (request.method === "getProfile") return Promise.resolve(null);
    return Promise.resolve({ status: "failed" });
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.accountInfo();
  assert.equal(out.signedIn, false, "界面据此说「未登录」");
  assert.equal(out.profile, null);
});

test("accountInfo：getState 取不到时 signedIn 为 null（不猜是哪种）", async () => {
  const gateway = recordingGateway((request) => {
    if (request.method === "getState") {
      return Promise.reject(Object.assign(new Error("x"), { code: "typert/unavailable" }));
    }
    return Promise.resolve({ status: "failed" });
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.accountInfo();
  assert.equal(out.signedIn, null, "不知道就说不知道");
  assert.equal(out.stateCode, "typert/unavailable");
});

test("accountInfo：资料失败不影响余额（各自独立）", async () => {
  /*
   * 宿主 `status:"failed"` 时该块给 null + Code，另一块照常 ——
   * 资料读不到不该让余额也空白。
   */
  const gateway = recordingGateway((request) => {
    if (request.method === "getProfile") return Promise.resolve({ status: "failed" });
    return Promise.resolve({
      status: "ready",
      value: [{ currency: "CNY", balance: "3.00" }],
      bonusWallets: [],
    });
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.accountInfo();
  assert.equal(out.ok, true);
  assert.equal(out.profile, null);
  assert.equal(out.profileCode, "account/not-ready");
  assert.equal(out.balance.wallets[0].balance, "3.00", "另一块照常");
});

test("accountInfo：余额失败不影响资料", async () => {
  const gateway = recordingGateway((request) => {
    if (request.method === "getBalance") return Promise.resolve({ status: "failed" });
    return Promise.resolve({ status: "ready", value: { id: null, name: "李四", contact: null } });
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.accountInfo();
  assert.equal(out.balance, null);
  assert.equal(out.balanceCode, "account/not-ready");
  assert.equal(out.profile.name, "李四");
});

test("accountInfo：网关不可用时两块都 null 且带 Code，不抛", async () => {
  const gateway = recordingGateway(() => {
    const err = Object.assign(new Error("x"), { code: "typert/unavailable" });
    return Promise.reject(err);
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.accountInfo();
  assert.equal(out.ok, true, "整体仍算「查过了」，只是两块都拿不到");
  assert.equal(out.profile, null);
  assert.equal(out.balance, null);
  assert.equal(out.profileCode, "typert/unavailable");
  assert.equal(out.balanceCode, "typert/unavailable");
});

test("accountInfo：缺失字段给 null，不编造", async () => {
  const gateway = recordingGateway((request) => {
    if (request.method === "getProfile") {
      return Promise.resolve({ status: "ready", value: { id: "u", name: null, contact: null } });
    }
    return Promise.resolve({ status: "ready", value: [], bonusWallets: [] });
  });
  const bridge = createTypertBridge({ ctx: ctxWith({ typertGateway: gateway }) });

  const out = await bridge.accountInfo();
  assert.equal(out.profile.name, null);
  assert.equal(out.profile.contact, null);
  assert.equal(out.profile.avatarUrl, null);
  assert.deepEqual(out.balance.wallets, [], "空钱包是空数组，不是 null");
});

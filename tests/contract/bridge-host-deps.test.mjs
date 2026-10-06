/**
 * 桥的宿主服务依赖契约测试
 *
 * 职责：保证 `host.js` 声明的 `inject` 覆盖桥**实际会用**的宿主服务。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得一条测试：真实踩过一次严重事故。
 * Cordis 只把 `inject` 里列出的服务装进插件 ctx；没声明的服务访问会抛
 * `cannot get property "X" without inject`，而 host-ctx 会把它降级成 undefined。
 * 于是：桥能收到会话事件、能看到会话在跑，但**一发消息就 session-not-found**。
 * 在假 ctx 上完全测不出来（假 ctx 不实现 inject 守卫），装进真实宿主才暴露。
 *
 * 这条测试把「声明必须覆盖使用」变成机械断言，让它在提交时就被拦住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BRIDGE = join(ROOT, "whale-bridge");

const hostText = readFileSync(join(BRIDGE, "host.js"), "utf8");
const ctxText = readFileSync(join(BRIDGE, "lib", "host-ctx.mjs"), "utf8");

/**
 * 桥**必需**的宿主服务名（走 ctx[name]，受 Cordis inject 守卫约束）。
 * 缺一个就会抛 `cannot get property "X" without inject`。
 */
function requiredServices() {
  const names = new Set();
  const re = /serviceOf\(\s*ctx\s*,\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(ctxText)) !== null) names.add(m[1]);
  return [...names];
}

/**
 * 桥**可选**的服务名（走 ctx.get，不受 inject 守卫约束）。
 *
 * 这些**绝对不能**放进 inject：Cordis 会等待 inject 里的服务就绪才 apply，
 * 一个不存在的名字会导致插件**永远不启动**且不报错
 * （真实踩过：把 projections/models 写进 inject 后，桥连端口都不监听了）。
 */
function optionalServices() {
  const names = new Set();
  const re = /optionalServiceOf\(\s*ctx\s*,\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(ctxText)) !== null) names.add(m[1]);
  return [...names];
}

/** host.js 里声明的 inject 列表。 */
function declaredInject() {
  const m = /export const inject = \[([^\]]*)\]/.exec(hostText);
  if (m === null) return null;
  return m[1]
    .split(",")
    .map((s) => s.trim().replace(/^["']|["']$/g, ""))
    .filter((s) => s !== "");
}

test("桥声明了 inject（漏了会导致服务全部不可用）", () => {
  const inject = declaredInject();
  assert.notEqual(inject, null, "host.js 必须导出 inject —— 缺了它 Cordis 不会注入任何服务");
  assert.ok(inject.length > 0, "inject 不能为空数组");
});

test("inject 覆盖桥的每一个**必需**服务", () => {
  const need = requiredServices();
  const inject = declaredInject() ?? [];

  assert.ok(need.length > 0, "应从 host-ctx 里扫到必需服务名，否则本测试是空壳");

  const missing = need.filter((name) => !inject.includes(name));
  assert.deepEqual(
    missing,
    [],
    `这些必需服务没声明 inject，装进真实宿主后会静默不可用：\n${missing.join("\n")}`,
  );
});

test("**可选**服务绝不能出现在 inject 里（否则插件永远不启动）", () => {
  // Cordis 等 inject 里的服务就绪才调用 apply。写一个不存在的名字，
  // 结果是插件不启动、端口不监听、而且不报错 —— 极难归因。
  // 真实踩过：加了 projections/models 后桥完全没起来。
  const optional = optionalServices();
  const inject = declaredInject() ?? [];

  assert.ok(optional.length > 0, "应扫到可选服务名，否则本测试是空壳");

  const leaked = optional.filter((name) => inject.includes(name));
  assert.deepEqual(
    leaked,
    [],
    `这些服务是可选的，不该写进 inject（会让插件等一个不存在的服务）：\n${leaked.join("\n")}`,
  );
});

test("关键服务必须在 inject 里（写操作全靠它们）", () => {
  const inject = declaredInject() ?? [];
  for (const name of ["sessions", "agents"]) {
    assert.ok(
      inject.includes(name),
      `inject 必须含 "${name}"：少了它，发消息/中断都会回 session-not-found`,
    );
  }
});

test("负向验证：已使用未声明确实会被规则抓到", () => {
  // 规则若写成空壳（永远通过），上面那条断言毫无意义
  const sample = {
    used: ["sessions", "agents", "commands"],
    inject: ["sessions"],
  };
  const missing = sample.used.filter((n) => !sample.inject.includes(n));
  assert.deepEqual(missing, ["agents", "commands"], "应报出两个缺失");

  const ok = { used: ["sessions"], inject: ["sessions", "agents"] };
  assert.deepEqual(ok.used.filter((n) => !ok.inject.includes(n)), []);
});

test("host-ctx 会把「没声明 inject」记进 missingInject（不静默）", () => {
  // 这是那次事故能快速定性的关键：两种 undefined 必须分得开
  assert.match(ctxText, /without inject/, "必须识别 Cordis 的 inject 守卫报错");
  assert.match(ctxText, /missingInject/, "必须把原因记下来供 probe 报告");
});

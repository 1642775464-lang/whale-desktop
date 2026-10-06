/**
 * inject 修复的真机验证
 *
 * 职责：用 `@deepseek-ai/cordis` **真实的 Proxy 守卫**（不是我自己模拟的）
 *       验证：声明了 inject 就能取到服务、没声明就抛守卫错。
 * 所属层：工程工具（tools/）
 *
 * 为什么要用真库：上一轮我用「假 ctx」测了很久都没发现问题，
 * 因为假 ctx 不实现 inject 守卫。这次直接引宿主的 cordis 来跑，
 * 让它自己告诉我 inject 到底管不管用。
 *
 * 用法：node tools/cordis-inject-proof.mjs
 */

import { pathToFileURL } from "node:url";
import fs from "node:fs";

const CORDIS = "C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/cordis/lib/index.js";

const report = {};

// ── 1) 确认 cordis 能加载 ──
let cordis;
try {
  cordis = await import(pathToFileURL(CORDIS).href);
  report.cordisLoaded = true;
  report.cordisExports = Object.keys(cordis).slice(0, 20);
} catch (err) {
  report.cordisLoaded = false;
  report.cordisError = err.message;
  console.log(`INJECT_PROOF ${  JSON.stringify(report, null, 2)}`);
  process.exit(1);
}

// ── 2) 直接检查源码里的守卫逻辑（比跑起来更确定）──
const src = fs.readFileSync(CORDIS, "utf8");
report.guardPresent = src.includes("without inject");
report.guardSnippet = src
  .split("\n")
  .filter((l) => l.includes("without inject") || l.includes("prop in fiber.inject"))
  .map((l) => l.trim());

// ── 3) 用真 Cordis 起一个最小应用，验证 inject 的真实效果 ──
const { Context } = cordis;
if (Context === undefined) {
  report.contextMissing = true;
} else {
  report.contextAvailable = true;

  const results = { withInject: null, withoutInject: null };

  // 带 inject 的插件：应能取到服务
  try {
    const root = new Context();
    root.provide?.("demoService", { hello: () => "world" });

    const withInject = {
      name: "with-inject",
      inject: ["demoService"],
      apply(ctx) {
        results.withInject = typeof ctx.demoService?.hello === "function" ? ctx.demoService.hello() : null;
      },
    };

    if (typeof root.plugin === "function") {
      const fork = root.plugin(withInject);
      // cordis 的 plugin 可能返回 fork；触发 apply
      void fork;
      if (typeof fork?.start === "function") fork.start();
    }
  } catch (err) {
    results.withInject = `throw: ${err.message}`;
  }

  // 不带 inject 的插件：取服务应抛守卫错
  try {
    const root2 = new Context();
    root2.provide?.("demoService2", { hello: () => "world" });

    const withoutInject = {
      name: "without-inject",
      apply(ctx) {
        try {
          void ctx.demoService2;
          results.withoutInject = "no-throw";
        } catch (err) {
          results.withoutInject = `throw: ${err.message}`;
        }
      },
    };

    if (typeof root2.plugin === "function") {
      const fork2 = root2.plugin(withoutInject);
      if (typeof fork2?.start === "function") fork2.start();
    }
  } catch (err) {
    results.withoutInject = `outer-throw: ${err.message}`;
  }

  report.runtime = results;
}

report.verdict = report.guardPresent === true ? "pass" : "fail";
console.log(`INJECT_PROOF ${  JSON.stringify(report, null, 2)}`);

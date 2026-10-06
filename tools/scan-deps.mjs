/**
 * 闸门 5 · 依赖扫描
 *
 * 职责：检查运行时第三方依赖数，检出非白名单依赖。
 * 所属层：工程工具（tools/）
 *
 * 铁律（技术栈选型说明书 §7）：运行时第三方依赖计数必须为 0。
 *
 * 退出码：0 = 通过；1 = 发现问题
 *
 * 用法：node tools/scan-deps.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { globSync } from "node:fs";

/** 允许出现的依赖：全部为开发期工具。 */
const ALLOWED_DEV = new Set(["eslint"]);

/**
 * 被扫描的包定义位置。
 * 每个条目：包目录、是否允许有运行时依赖。
 */
const PACKAGES = [
  { dir: "whale-bridge", allowRuntime: false },
  { dir: "whale-hud", allowRuntime: false },
  { dir: "whale-window", allowRuntime: false },
  { dir: "whale-button", allowRuntime: false },
];

/** 宿主注入的依赖：由宿主提供，不计入我们的运行时依赖。 */
const HOST_PROVIDED = /^@deepseek-ai\//;

/** Electron 由 runtime/ 目录的二进制提供，不是 npm 依赖。 */
const RUNTIME_BINARIES = new Set(["electron"]);

const problems = [];

for (const pkg of PACKAGES) {
  const manifestPath = `${pkg.dir}/package.json`;
  if (!existsSync(manifestPath)) continue;

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    problems.push(`${manifestPath} 不是合法 JSON：${err.message}`);
    continue;
  }

  const deps = manifest.dependencies ?? {};
  for (const name of Object.keys(deps)) {
    if (RUNTIME_BINARIES.has(name)) {
      problems.push(
        `${manifestPath} 把 ${name} 列为 npm 依赖。` +
          `Electron 由 runtime/ 目录的二进制提供，不应走 npm。`,
      );
      continue;
    }
    if (HOST_PROVIDED.test(name)) continue;
    problems.push(
      `${manifestPath} 存在运行时依赖 "${name}"。` +
        `运行时第三方依赖必须为 0（技术栈选型说明书 §7）。`,
    );
  }

  const devDeps = manifest.devDependencies ?? {};
  for (const name of Object.keys(devDeps)) {
    if (!ALLOWED_DEV.has(name)) {
      problems.push(
        `${manifestPath} 存在开发依赖 "${name}"，不在白名单内。` +
          `白名单：${[...ALLOWED_DEV].join(", ")}。`,
      );
    }
  }
}

// 检查源码里是否直接 require 了外部包
for (const pkg of PACKAGES) {
  if (!existsSync(pkg.dir)) continue;
  let files = [];
  try {
    files = globSync(`${pkg.dir}/**/*.{js,mjs,cjs}`, {
      exclude: (name) => name === "node_modules",
    });
  } catch {
    continue;
  }
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const requireRe = /\brequire\(\s*["'`]([^"'`.][^"'`]*)["'`]\s*\)/g;
    const importRe = /\bfrom\s+["'`]([^"'`.][^"'`]*)["'`]/g;
    for (const re of [requireRe, importRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const spec = m[1];
        if (spec.startsWith("node:")) continue;
        if (HOST_PROVIDED.test(spec)) continue;
        const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        const builtin = new Set([
          "fs", "path", "http", "https", "url", "zlib", "os", "events", "stream",
          "child_process", "util", "crypto", "assert", "buffer", "net", "tty",
          "worker_threads", "readline", "process", "module", "timers", "v8", "vm",
        ]);
        if (builtin.has(bare)) continue;
        problems.push(
          `${file} 引用了外部包 "${spec}"。运行时只允许 node: 内置模块与宿主注入。`,
        );
      }
    }
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(`[依赖] ${p}`);
  console.error(`\n闸门 5 失败：${problems.length} 项问题。`);
  process.exit(1);
}

console.log("闸门 5 通过：运行时第三方依赖为 0。");

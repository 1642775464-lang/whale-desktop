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

/**
 * 浏览器侧允许的裸模块名。
 *
 * 客户端半侧跑在页面里，模块由宿主的模块表提供
 * （`window.__ModuleLoader__.load({factory(require){...}})`），
 * 不是 npm 依赖。本机同槽位的 dsh-agnes-image 也是这么写的。
 *
 * React 属于宿主模块表里的基线模块，所以无需在 dsh.client 里声明 external。
 */
const BROWSER_MODULES = new Set(["react", "react-dom", "react/jsx-runtime"]);

/**
 * 从 package.json 找出「浏览器侧文件」的绝对路径集合。
 *
 * 判据是 `exports["./client"]` —— 这是声明客户端入口的唯一权威位置，
 * 不靠文件名猜（文件名可以改，声明不会骗人）。
 *
 * @param {string} dir 包目录
 * @param {object} manifest
 * @returns {Set<string>}
 */
function browserFilesOf(dir, manifest) {
  const out = new Set();
  const entry = manifest.exports?.["./client"];
  if (typeof entry === "string") out.add(`${dir}/${entry.replace(/^\.\//, "")}`);
  return out;
}

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

  // 该包的浏览器侧文件（按 exports["./client"] 判定，不按文件名猜）
  let browserFiles = new Set();
  const manifestPath = `${pkg.dir}/package.json`;
  if (existsSync(manifestPath)) {
    try {
      browserFiles = browserFilesOf(pkg.dir, JSON.parse(readFileSync(manifestPath, "utf8")));
    } catch {
      // 清单坏了上面那条循环已经报过，这里不重复报
    }
  }

  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // 路径分隔符在 Windows 上是反斜杠，统一成正斜杠再比
    const norm = file.replace(/\\/g, "/");
    const isBrowser = browserFiles.has(norm);

    const requireRe = /\brequire\(\s*["'`]([^"'`.][^"'`]*)["'`]\s*\)/g;
    const importRe = /\bfrom\s+["'`]([^"'`.][^"'`]*)["'`]/g;
    for (const re of [requireRe, importRe]) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text)) !== null) {
        const spec = m[1];
        if (spec.startsWith(".")) continue;

        // ── 浏览器侧：口径**更严** ──
        //
        // 这类文件跑在页面里，Node 从不加载它。所以：
        //   · 宿主模块表的基线模块（react 等）→ 允许
        //   · node: 内置模块 → **禁止**（浏览器里根本不存在，引了必崩）
        //   · 其它任何包 → 禁止
        //
        // 为什么不是简单「跳过这个文件」：跳过会留个洞，
        // 将来往客户端里 import 个 fs 也没人拦。这里换的是一把更严的尺子。
        if (isBrowser) {
          if (BROWSER_MODULES.has(spec)) continue;
          if (spec.startsWith("node:")) {
            problems.push(
              `${file} 是浏览器侧文件，不能引用 Node 内置模块 "${spec}"（浏览器里不存在）。`,
            );
            continue;
          }
          const bareB = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
          const builtinB = new Set([
            "fs", "path", "http", "https", "url", "zlib", "os", "events", "stream",
            "child_process", "util", "crypto", "assert", "buffer", "net", "tty",
            "worker_threads", "readline", "process", "module", "timers", "v8", "vm",
          ]);
          if (builtinB.has(bareB)) {
            problems.push(
              `${file} 是浏览器侧文件，不能引用 Node 内置模块 "${spec}"（浏览器里不存在）。`,
            );
            continue;
          }
          problems.push(
            `${file} 是浏览器侧文件，引用了模块 "${spec}"。` +
              `浏览器侧只允许宿主模块表提供的：${[...BROWSER_MODULES].join(", ")}。`,
          );
          continue;
        }

        // ── 宿主 / 主进程侧：维持原口径 ──
        if (spec.startsWith("node:")) continue;
        if (HOST_PROVIDED.test(spec)) continue;
        const bare = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
        // Electron 由 runtime/ 的二进制提供，不是 npm 依赖（与上面 dependencies 检查同一口径）。
        // 主进程与 preload 引它是正当的：它是运行时，不是第三方库。
        if (RUNTIME_BINARIES.has(bare)) continue;
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

/**
 * 检查「桥的改动到底有没有生效」
 *
 * 职责：比较桥源文件的最后修改时间与宿主进程的启动时间 ——
 *       宿主启动**早于**桥改动，就说明跑的还是旧代码。
 * 所属层：工程工具（tools/）
 *
 * ## 为什么必须有这个检查
 *
 * 桥是宿主进程内的插件（`whale-bridge/host.js`），**没有热重载** ——
 * 改了 `.mjs` 之后，必须**重启宿主**才会生效。
 *
 * 这个坑真实发生过，而且是连续几轮：用户连报三次「还是展示出来了」，
 * 每次我都改了代码、跑了测试、提交了，然后回答「已修复」。
 * 而他那边的桥是三个多小时前启动的，我的改动**一行都没跑到过**。
 *
 * 代价不对称得厉害：
 *   · 我这边：测试全绿、闸门全过、提交干净 → 看起来完全可信
 *   · 他那一边：现象一模一样，只是又浪费一轮
 *
 * 所以这件事**不能靠记性**，要靠机械检查。改完桥跑一次，它会直接告诉你
 * 「还没生效，去重启宿主」。
 *
 * 用法：
 *   node tools/check-bridge-freshness.mjs            # 检查
 *   node tools/check-bridge-freshness.mjs --port 19387
 *
 * 退出码：0 = 已生效（或桥没在跑）；1 = 改动未生效，需要重启宿主。
 */

import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BRIDGE = path.join(ROOT, "whale-bridge");

/**
 * 从命令行取参数。
 *
 * 另支持 `--started-ms <毫秒时间戳>`：**注入**一个假的宿主启动时间。
 * 这是为了能测「旧桥」这个场景 —— 真实环境里宿主通常恰好是新鲜的，
 * 没有它就无法验证「工具真的会报旧」，而一条无法验证的防线等于没有。
 */
function parseArgs() {
  const argv = process.argv.slice(2);
  const portAt = argv.indexOf("--port");
  const startedAt = argv.indexOf("--started-ms");
  return {
    port: portAt === -1 ? 19387 : Number(argv[portAt + 1]),
    startedMs: startedAt === -1 ? null : Number(argv[startedAt + 1]),
  };
}

/**
 * 找出监听某端口的进程。
 *
 * 用 `netstat -ano`（Windows 自带），避免引入依赖。
 *
 * @param {number} port
 * @returns {number|null} pid
 */
function pidListening(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (!line.includes(`:${port}`) || !line.includes("LISTENING")) continue;
      const parts = line.trim().split(/\s+/);
      const pid = Number(parts[parts.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  } catch {
    return null;
  }
}

/** 取进程启动时间（毫秒）。 */
function processStartMs(pid) {
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`],
      { encoding: "utf8" },
    );
    // ToFileTimeUtc 是 1601 年起的 100ns 单位；转成 Unix 毫秒
    const fileTime = Number(out.trim());
    if (!Number.isFinite(fileTime)) return null;
    return fileTime / 10000 - 11644473600000;
  } catch {
    return null;
  }
}

/** 递归取目录下所有源文件，返回 {file, mtimeMs} 列表。 */
function sourceFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) sourceFiles(full, out);
    else if (/\.(mjs|js|cjs)$/.test(name)) out.push({ file: full, mtimeMs: st.mtimeMs });
  }
  return out;
}

const { port, startedMs: injectedStart } = parseArgs();
const pid = pidListening(port);
if (pid === null) {
  console.log(`端口 ${port} 上没有桥在跑 —— 下次拉起时自然是最新代码，无需处理。`);
  process.exit(0);
}

// 允许注入启动时间（测「旧桥」场景用）；不注入就真的去读进程
const startedMs = injectedStart ?? processStartMs(pid);
if (startedMs === null || !Number.isFinite(startedMs)) {
  console.log(`拿到了 pid ${pid}，但读不到它的启动时间（权限不足？）—— 无法判断，请人工确认。`);
  process.exit(0);
}

const files = sourceFiles(BRIDGE);
// 只关心「比宿主启动还新」的文件 —— 那些就是没生效的改动
const stale = files.filter((f) => f.mtimeMs > startedMs + 1000);

console.log(`桥端口      ${port}（pid ${pid}）`);
console.log(`宿主启动于  ${new Date(startedMs).toLocaleString()}`);
console.log(`桥源文件    ${files.length} 个，最后改动 ${new Date(Math.max(...files.map((f) => f.mtimeMs))).toLocaleString()}`);
console.log("");

if (stale.length === 0) {
  console.log("桥是新鲜的：没有比宿主启动更晚的改动，跑的就是磁盘上这份代码。");
  process.exit(0);
}

console.log(`!! 有 ${stale.length} 个桥文件比宿主启动还新 —— 这些改动**还没生效**：`);
for (const f of stale.slice(0, 10)) {
  console.log(`   ${path.relative(ROOT, f.file)}  (${new Date(f.mtimeMs).toLocaleString()})`);
}
console.log("");
console.log("桥是宿主进程内的插件，没有热重载 —— 必须**重启宿主**才会生效。");
console.log("在此之前，任何「已修复」的说法对用户都是不成立的。");
process.exit(1);

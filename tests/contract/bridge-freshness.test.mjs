/**
 * 桥新鲜度检查工具的契约测试
 *
 * 职责：钉住「改了桥的代码但没重启宿主」这件事能被机械发现。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得单独一个测试文件：
 *
 * 桥是宿主进程内的插件（`whale-bridge/host.js`），**没有热重载** ——
 * 改了 `.mjs` 必须**重启宿主**才生效。这个坑真实连续发生过几轮：
 * 用户三次报「还是展示出来了」，我每次改完代码、跑绿测试、提交、
 * 回答「已修复」，而他那边跑的是三个多小时前启动的旧桥，
 * 我的改动**一行都没跑到过**。
 *
 * 代价不对称得厉害 —— 我这边一切信号都是绿的，他那边现象一模一样。
 * 所以这件事不能靠记性，必须有工具、且工具本身要被守住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TOOL = join(ROOT, "tools", "check-bridge-freshness.mjs");

test("桥新鲜度检查工具存在", () => {
  assert.ok(existsSync(TOOL), "缺 tools/check-bridge-freshness.mjs —— 改了桥就无法机械确认有没有生效");
});

test("桥没有热重载（若哪天支持了，这个检查就该改口径）", () => {
  // 这条不是为了「证明没有」，而是为了**在前提变化时提醒**：
  // 一旦桥支持热重载，check-bridge-freshness 的结论就不再成立。
  const host = readFileSync(join(ROOT, "whale-bridge", "host.js"), "utf8");
  const bridgeDir = join(ROOT, "whale-bridge");
  const files = ["lib/fold.mjs", "lib/message-visibility.mjs", "lib/server.mjs"];
  for (const f of files) {
    assert.ok(existsSync(join(bridgeDir, f)), `桥缺少 ${f}`);
  }
  assert.ok(host.length > 0, "host.js 不该为空");
  // 桥目录里没有任何 watch/reload 机制
  const all = files.map((f) => readFileSync(join(bridgeDir, f), "utf8")).join("\n");
  assert.doesNotMatch(
    all,
    /\bchokidar\b|fs\.watch\(/,
    "如果桥开始监听文件变化（热重载），请同步更新 check-bridge-freshness 的口径",
  );
});

test("工具在宿主没跑时优雅通过（不能因为没开宿主就报错）", () => {
  // 用一个几乎不可能被占用的端口，模拟「宿主没跑」
  const res = spawnSync(process.execPath, [TOOL, "--port", "19379"], {
    encoding: "utf8",
    cwd: ROOT,
  });
  assert.equal(
    res.status,
    0,
    `宿主没跑时应通过（实际退出码 ${res.status}，输出：${res.stdout}${res.stderr}）`,
  );
  assert.match(res.stdout, /没有桥在跑|新鲜的/, "要说清是「没在跑」还是「是新鲜的」");
});

test("工具真的会读源文件的修改时间（不是永远说「新鲜」）", () => {
  // 这是防「工具本身腐烂」的关键一条：
  // 如果它不读文件时间、永远输出「新鲜」，那它就是一条假防线。
  const src = readFileSync(TOOL, "utf8");
  assert.match(src, /statSync|mtimeMs/, "必须读源文件的修改时间");
  assert.match(src, /StartTime|startedMs/, "必须读进程的启动时间");
  assert.match(src, /stale/, "必须能判定「比宿主启动还新」的文件");
});

test("行为级：注入一个很旧的启动时间时，工具必须报「未生效」并以 1 退出", () => {
  /*
   * ⚠️ 这条是**阴性注入逼出来的**。
   *
   * 只查源码里「有没有 stale 这个词」时，把判定改成 `const stale = []`
   * （永远报新鲜）照样全绿 —— 一条看着有效、实际拦不住腐烂的断言。
   *
   * 所以这里做行为级验证：给它一个**很旧的启动时间**（2000 年），
   * 桥源文件一定比它新，工具就必须报「未生效」。
   * 需要宿主在跑（工具的端口探测依赖它）；没跑就跳过，并说明原因。
   */
  const probePort = 19387;
  const probe = spawnSync(process.execPath, [TOOL, "--port", String(probePort)], {
    encoding: "utf8",
    cwd: ROOT,
  });
  if (probe.status === 0 && /没有桥在跑/.test(probe.stdout)) {
    // 宿主没跑：跳过（不把环境缺失报成产品缺陷）
    return;
  }

  const res = spawnSync(
    process.execPath,
    [TOOL, "--port", String(probePort), "--started-ms", String(Date.UTC(2000, 0, 1))],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(
    res.status,
    1,
    `启动时间早于所有源文件时必须报「未生效」（实际退出码 ${res.status}）\n${res.stdout}`,
  );
  assert.match(res.stdout, /还没生效|必须.*重启宿主/, "要说清怎么办");
});

test("行为级：注入一个很新的启动时间时，工具必须报「新鲜」", () => {
  // 反向对照：不能永远报「旧」，那同样是一条假防线。
  const probePort = 19387;
  const probe = spawnSync(process.execPath, [TOOL, "--port", String(probePort)], {
    encoding: "utf8", cwd: ROOT,
  });
  if (probe.status === 0 && /没有桥在跑/.test(probe.stdout)) return;

  const future = Date.now() + 365 * 24 * 3600 * 1000;
  const res = spawnSync(
    process.execPath,
    [TOOL, "--port", String(probePort), "--started-ms", String(future)],
    { encoding: "utf8", cwd: ROOT },
  );
  assert.equal(res.status, 0, `启动时间晚于所有源文件时应报新鲜（实际 ${res.status}）\n${res.stdout}`);
  assert.match(res.stdout, /新鲜的/, "要明确说「跑的就是磁盘上这份代码」");
});

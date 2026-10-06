/**
 * 七道闸门统一入口
 *
 * 职责：按顺序执行《开发规范》§4 定义的七道质量闸门，汇总结果，
 *       并把执行记录追加到 tools/gate-log.ndjson。
 * 所属层：工程工具（tools/）
 *
 * 闸门清单：
 *   1 语法检查   node --check 全部源码
 *   2 Lint       npx eslint .
 *   3 单测覆盖率 node --test tests/  （纯函数模块需 ≥80%）
 *   4 密钥扫描   tools/scan-secrets.mjs
 *   5 依赖扫描   tools/scan-deps.mjs
 *   6 规范扫描   tools/scan-rules.mjs
 *   7 正文守门器自检 tools/check-reply.mjs --selftest
 *
 * 模式：
 *   node tools/gate.mjs            执行全部七道
 *   node tools/gate.mjs --quick    只执行 1/4/5/6（不需要 eslint、不需要测试）
 *   node tools/gate.mjs --commit   提交前模式，等同全部（预提交钩子用）
 *
 * 退出码：0 = 全部通过；1 = 有闸门失败
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const quick = args.has("--quick");

/** 七道闸门定义。 */
const GATES = [
  {
    id: 1,
    name: "语法检查",
    cmd: () => [process.execPath, ["tools/check-syntax.mjs"]],
    skipInQuick: false,
  },
  {
    id: 2,
    name: "Lint",
    // 直接以 node 执行 eslint 的入口脚本。
    // 不走 .cmd 包装：Node 24 在无 shell 时 spawn .cmd 会报 EINVAL，
    // 而开 shell 又会让参数拼接与非零退出码失真。
    cmd: () => [process.execPath, ["node_modules/eslint/bin/eslint.js", "."]],
    skipInQuick: true,
    requiresTool: () => existsSync("node_modules/eslint/bin/eslint.js"),
    missingNote: "eslint 尚未安装，请先运行 npm install",
  },
  {
    id: 3,
    name: "单测覆盖率",
    // Node 24 的 --test 需要 glob，不接受裸目录
    cmd: () => [process.execPath, ["--test", "tests/**/*.test.mjs"]],
    skipInQuick: true,
    requiresTestsDir: true,
  },
  {
    id: 4,
    name: "密钥扫描",
    cmd: () => [process.execPath, ["tools/scan-secrets.mjs"]],
    skipInQuick: false,
  },
  {
    id: 5,
    name: "依赖扫描",
    cmd: () => [process.execPath, ["tools/scan-deps.mjs"]],
    skipInQuick: false,
  },
  {
    id: 6,
    name: "规范扫描",
    cmd: () => [process.execPath, ["tools/scan-rules.mjs"]],
    skipInQuick: false,
  },
  {
    id: 7,
    name: "正文守门器自检",
    // 这条闸门检查的不是项目代码，而是「防止内部摘要混进用户回复」的
    // 拦截规则本身是否有效（正样例必须被拦、反样例必须放行）。
    // 它进闸门的理由：空壳规则比没有规则更危险——会让人以为纪律被执行了。
    cmd: () => [process.execPath, ["tools/check-reply.mjs", "--selftest"]],
    skipInQuick: false,
  },
];

function runGate(gate) {
  if (gate.requiresTestsDir && !existsSync("tests")) {
    return { status: "skip", note: "tests/ 目录尚未建立" };
  }
  if (quick && gate.skipInQuick) {
    return { status: "skip", note: "--quick 模式跳过" };
  }

  // 工具可用性检查：必须显式确认，不能靠「输出像不像找不到命令」来猜。
  if (gate.requiresTool && !gate.requiresTool()) {
    return { status: "skip", note: gate.missingNote ?? "工具尚未安装" };
  }

  const [cmd, cmdArgs] = gate.cmd();
  const res = spawnSync(cmd, cmdArgs, {
    encoding: "utf8",
    // 不用 shell：避免参数拼接与非零退出码被 cmd 包装吞掉。
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (res.error) {
    return { status: "fail", output: String(res.error.message ?? res.error) };
  }

  const output = `${res.stdout ?? ""}${res.stderr ?? ""}`.trim();
  if (res.status !== 0) {
    return { status: "fail", output };
  }
  return { status: "pass", output };
}

const results = [];
const startedAt = new Date();

console.log("=== 七道质量闸门 ===\n");

for (const gate of GATES) {
  process.stdout.write(`闸门 ${gate.id} ${gate.name} ... `);
  const r = runGate(gate);
  results.push({ ...gate, ...r });

  if (r.status === "pass") console.log("通过");
  else if (r.status === "skip") console.log(`跳过（${r.note}）`);
  else console.log("失败");

  if (r.status === "fail" && r.output) {
    console.log(
      r.output
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n"),
    );
  }
}

// 汇总
const failed = results.filter((r) => r.status === "fail");
const passed = results.filter((r) => r.status === "pass");
const skipped = results.filter((r) => r.status === "skip");

console.log("");
console.log(`通过 ${passed.length} 道 / 跳过 ${skipped.length} 道 / 失败 ${failed.length} 道`);

// 写闸门执行记录（开发规范 强制 25）
const record = {
  at: startedAt.toISOString(),
  durationMs: Date.now() - startedAt.getTime(),
  quick,
  gates: results.map((r) => ({ id: r.id, name: r.name, status: r.status, note: r.note })),
  verdict: failed.length === 0 ? "pass" : "fail",
};
try {
  appendFileSync("tools/gate-log.ndjson", `${JSON.stringify(record)}\n`, "utf8");
} catch {
  console.log("（未能写入 tools/gate-log.ndjson）");
}

if (failed.length > 0) {
  console.log("\n闸门未全过，禁止提交。");
  process.exit(1);
}

console.log("\n全部闸门通过，可以提交。");

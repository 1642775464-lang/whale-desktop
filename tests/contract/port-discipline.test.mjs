/**
 * 端口纪律测试
 *
 * 职责：保证「测试 / 开发服务器 / 桥」三方不会抢同一个端口。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得单独一条：撞端口的表现是**偶发**失败——闸门 3 时红时绿，
 * 而单独跑那个文件永远绿。实测踩过一次：开发服务器默认 19391，
 * 与 smoke-slice3 的端口重合，Electron 探针没收干净时就会 EADDRINUSE。
 * 这种故障的代价不在修，而在**定位**（会先怀疑产品代码、再怀疑并发模型）。
 *
 * 所以把端口占用表变成可机械检查的断言，而不是靠谁记得住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, globSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * 端口占用登记表。
 *
 * 每个端口列出「谁在用」。同一个端口出现两次即视为冲突，
 * 除非在 SHARED 里显式声明为有意共用。
 */
const SHARED = new Set([]);

/**
 * 端口占用登记表。
 *
 * 只有**真的会监听**的写法才算占用：`apply(ctx, {port})`、`server.listen`、
 * `--port` 的默认值。仅仅在假 fetch 里引用一个端口（例如桥客户端单测把
 * 19391 当假地址）不会 bind，不构成冲突——第一次写这条规则时把它算进去了，
 * 属于规则过宽。
 */
const LISTEN_PATTERNS = [
  /PORT\s*=\s*(\d{5})/,
  /DEV_PORT\s*=\s*(\d{5})/,
  /apply\(ctx,\s*\{\s*port:\s*(\d{5})/,
];

/**
 * 从源码里扫出真正的端口声明。
 *
 * 必须先剥掉注释：本文件与开发服务器的**说明文字里**就写着那些端口号，
 * 拿全文匹配会把「解释为什么不能撞 19391」的这段话当成一次真实占用，
 * 于是规则被自己的文档绊倒（第一次写就撞上了）。
 *
 * @param {string[]} patterns glob（相对仓库根）
 * @returns {Array<{file: string, port: number, line: number}>}
 */
function collect(patterns) {
  const found = [];
  const files = globSync(patterns, { cwd: ROOT, exclude: (n) => n === "node_modules" });
  for (const rel of files) {
    const raw = readFileSync(join(ROOT, rel), "utf8");
    const lines = raw.split("\n");
    let inBlock = false;

    lines.forEach((line, index) => {
      const trimmed = line.trim();

      if (inBlock) {
        if (trimmed.includes("*/")) inBlock = false;
        return;
      }
      if (trimmed.startsWith("/*") && !trimmed.includes("*/")) {
        inBlock = true;
        return;
      }
      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return;

      // 去行尾注释后再匹配，避免 `const PORT = 19500; // 曾用 19391` 这类误伤
      const code = line.split("//")[0];
      for (const re of LISTEN_PATTERNS) {
        const m = new RegExp(re.source).exec(code);
        if (m !== null) {
          found.push({ file: rel.replace(/\\/g, "/"), port: Number(m[1]), line: index + 1 });
          break;
        }
      }
    });
  }
  return found;
}

const SOURCES = collect([
  "tests/**/*.test.mjs",
  "tools/*.mjs",
  "whale-bridge/lib/server.mjs",
]);

test("扫到了端口声明（防止本测试变成空壳）", () => {
  // 应扫到：桥 19387、smoke-slice2 19389、smoke-slice3 19391、开发服务器 19500
  assert.ok(SOURCES.length >= 4, `只扫到 ${SOURCES.length} 处端口声明，规则可能失效了`);
  const ports = new Set(SOURCES.map((s) => s.port));
  assert.ok(ports.has(19387), "应扫到桥的默认端口");
  assert.ok(ports.has(19500), "应扫到开发服务器端口");
});

test("同一个端口不得被两个文件同时监听", () => {
  const byPort = new Map();
  for (const { file, port } of SOURCES) {
    if (SHARED.has(port)) continue;
    if (!byPort.has(port)) byPort.set(port, new Set());
    byPort.get(port).add(file);
  }

  const conflicts = [];
  for (const [port, files] of byPort) {
    if (files.size > 1) conflicts.push(`${port} 被 ${[...files].join(" 与 ")} 同时占用`);
  }

  assert.deepEqual(
    conflicts,
    [],
    `端口冲突会让闸门偶发失败、且极难定位：\n${conflicts.join("\n")}`,
  );
});

test("测试端口集中在 1938x–1939x 段", () => {
  const testPorts = SOURCES.filter((s) => s.file.startsWith("tests/")).map((s) => s.port);
  for (const p of testPorts) {
    assert.ok(p >= 19380 && p <= 19399, `测试端口 ${p} 跑到约定段之外了，容易与工具撞车`);
  }
});

test("开发服务器端口避开测试段", () => {
  const dev = SOURCES.filter((s) => s.file.includes("bridge-dev-server"));
  assert.ok(dev.length > 0, "应能扫到开发服务器的端口");
  for (const { port } of dev) {
    assert.ok(
      port < 19380 || port > 19399,
      `开发服务器端口 ${port} 落在测试段里，探针没收干净时会让闸门 3 偶发 EADDRINUSE`,
    );
  }
});

test("桥的默认端口仍是 PRD 规定的 19387", () => {
  const bridge = SOURCES.filter((s) => s.file === "whale-bridge/lib/server.mjs");
  assert.equal(bridge.length, 1, `应恰好扫到桥的一处端口声明，实际 ${bridge.length} 处`);
  assert.equal(bridge[0].port, 19387, "桥的默认端口是 PRD F1 定死的，不得改");
});

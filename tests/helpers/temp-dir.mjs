/**
 * 测试用临时目录
 *
 * 职责：给测试一个**确定可写**的临时目录，并在结束时清理。
 * 所属层：测试（tests/helpers）
 *
 * ## 为什么不能直接 `mkdtempSync(join(tmpdir(), ...))`
 *
 * 本机踩过：系统 `%TEMP%` 被加固策略锁住（新建目录直接 `EPERM`），
 * 于是 `workspace-registry` / `fallback-catalog` / `smoke-workspace-read`
 * 这批测试**全部报 EPERM**、预提交钩子直接把提交拦掉 ——
 * 而**代码本身完全正常**（换个可写目录跑 951 全绿）。
 *
 * 测试依赖「系统临时目录一定可写」这个假设是脆弱的。所以这里：
 *
 *   1. 先试系统临时目录（正常环境走这条，不污染仓库）；
 *   2. 不可写就回退到**仓库内**的 `.tmp-tests/`（已在 .gitignore）；
 *   3. 两处都不可写才抛错 —— 这时确实是环境问题，报清楚。
 *
 * ## 用法
 *
 * ```js
 * import { makeTempDir } from "./helpers/temp-dir.mjs";
 *
 * test("...", async (t) => {
 *   const dir = makeTempDir("whale-ws-");
 *   t.after(() => removeTempDir(dir));
 *   // ...
 * });
 * ```
 */

"use strict";

import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 仓库内的回退目录（已在 .gitignore）。 */
const FALLBACK_ROOT = join(ROOT, ".tmp-tests");

/**
 * 本进程建过的临时目录。
 *
 * ⚠️ 必须在进程退出时统一清理：用例里逐个 `removeTempDir` 很容易漏
 * （这轮就漏出 41 个残留目录）。测试是**每个文件一个进程**，
 * 所以在 `process.on("exit")` 里一次性扫掉最省心，也不依赖用例自觉。
 */
const created = new Set();

process.on("exit", () => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // 进程正在退出，清理失败不该改变退出码
    }
  }
});

/**
 * 找一个**确实可写**的临时根目录。
 *
 * @returns {string}
 */
function writableRoot() {
  const candidates = [tmpdir(), FALLBACK_ROOT];
  const errors = [];
  for (const base of candidates) {
    try {
      mkdirSync(base, { recursive: true });
      // 真正验证一次：只 mkdir 不够，加固环境可能允许目录存在但不许在里面创建
      const probe = mkdtempSync(join(base, "probe-"));
      rmSync(probe, { recursive: true, force: true });
      return base;
    } catch (err) {
      errors.push(`${base}: ${err?.code ?? err?.message ?? err}`);
    }
  }
  throw new Error(`找不到可写的临时目录（试过 ${candidates.length} 处）—— ${errors.join("；")}`);
}

/**
 * 建一个临时目录。
 *
 * @param {string} [prefix] 目录名前缀（便于认出是哪个用例留下的）
 * @returns {string} 绝对路径
 */
export function makeTempDir(prefix = "whale-tmp-") {
  const dir = mkdtempSync(join(writableRoot(), prefix));
  created.add(dir);
  return dir;
}

/**
 * 删掉一个临时目录（幂等，删不掉也不让用例失败）。
 *
 * @param {string} dir
 */
export function removeTempDir(dir) {
  if (typeof dir !== "string" || dir === "") return;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理失败不该把用例判红：临时目录残留由系统/下次清理兜底
  }
}

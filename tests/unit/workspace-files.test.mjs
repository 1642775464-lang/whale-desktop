/**
 * 工作区文件列表的纯逻辑
 *
 * 职责：钉住条目归一化、目录前缀规范化、**路径安全边界**。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得单独测：路径处理是最容易出**静默错误**的地方 ——
 * 拼错前缀只是「列出来是空的」，而 `safeRelativePath` 放行一个 `..`
 * 就等于把小窗变成「能开工作区外任意文件」的入口。这两类都不能靠肉眼。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  baseName,
  childDir,
  normalizeDirPrefix,
  normalizeEntries,
  parentDir,
  safeRelativePath,
} from "../../whale-bridge/lib/workspace-files.mjs";

test("normalizeEntries：路径 / 名字 / 类型齐备", () => {
  const out = normalizeEntries([
    { path: "whale-window/renderer/app.js", kind: "file" },
    { path: "docs", kind: "directory" },
  ]);
  assert.deepEqual(out, [
    { path: "docs", name: "docs", kind: "directory" },
    { path: "whale-window/renderer/app.js", name: "app.js", kind: "file" },
  ]);
});

test("normalizeEntries：**目录排在文件前面**，同组按名字", () => {
  /*
   * 不依赖宿主的返回顺序：文件管理器里目录在前是用户预期，
   * 而宿主给的是搜索排序（不稳定）。
   */
  const out = normalizeEntries([
    { path: "z.txt", kind: "file" },
    { path: "b-dir", kind: "directory" },
    { path: "a.txt", kind: "file" },
    { path: "a-dir", kind: "directory" },
  ]);
  assert.deepEqual(out.map((e) => e.path), ["a-dir", "b-dir", "a.txt", "z.txt"]);
});

test("normalizeEntries：缺 path 的整条丢掉（点不了）", () => {
  const out = normalizeEntries([
    { kind: "file" },
    { path: "" },
    { path: "  " },
    { path: "ok.txt", kind: "file" },
  ]);
  assert.deepEqual(out.map((e) => e.path), ["ok.txt"]);
});

test("normalizeEntries：kind 不是 directory 就按文件处理", () => {
  /*
   * 保守当文件：当目录会让用户点进去得到一个空列表，更容易误导。
   */
  const out = normalizeEntries([{ path: "x", kind: "文件" }, { path: "y" }]);
  assert.deepEqual(out.map((e) => e.kind), ["file", "file"]);
});

test("normalizeEntries：非数组 / 畸形项不崩", () => {
  assert.deepEqual(normalizeEntries(null), []);
  assert.deepEqual(normalizeEntries(undefined), []);
  assert.deepEqual(normalizeEntries([null, 42, "x"]), []);
});

test("baseName：取末段，容忍结尾斜杠", () => {
  assert.equal(baseName("whale-window/renderer/app.js"), "app.js");
  assert.equal(baseName("docs/"), "docs");
  assert.equal(baseName("docs"), "docs");
});

test("normalizeDirPrefix：统一成「无前导斜杠、有结尾斜杠」", () => {
  /*
   * 宿主按「目录前缀」匹配（实测 `whale-window/` 才列得出子项），
   * 所以拼 query 前必须统一形式，否则列出来是空的（静默空）。
   */
  assert.equal(normalizeDirPrefix(""), "");
  assert.equal(normalizeDirPrefix("whale-window"), "whale-window/");
  assert.equal(normalizeDirPrefix("whale-window/"), "whale-window/");
  assert.equal(normalizeDirPrefix("/whale-window"), "whale-window/");
  assert.equal(normalizeDirPrefix("\\whale-window"), "whale-window/");
  assert.equal(normalizeDirPrefix("  "), "");
});

test("safeRelativePath：放行工作区内的相对路径", () => {
  assert.deepEqual(safeRelativePath("whale-window/renderer/app.js"), {
    ok: true, path: "whale-window/renderer/app.js",
  });
  // 反斜杠统一成正斜杠（宿主候选里就是正斜杠）
  assert.deepEqual(safeRelativePath("whale-window\\app.js"), {
    ok: true, path: "whale-window/app.js",
  });
  // 中间的 `.` 段去掉
  assert.deepEqual(safeRelativePath("./docs/x"), { ok: true, path: "docs/x" });
});

test("safeRelativePath：**拒绝绝对路径**（否则能开任意文件）", () => {
  for (const p of ["C:\\Windows\\System32\\cmd.exe", "c:/windows", "\\\\server\\share", "/etc/passwd", "\\Windows"]) {
    const out = safeRelativePath(p);
    assert.equal(out.ok, false, `绝对路径必须拒绝：${p}`);
  }
});

test("safeRelativePath：**拒绝 .. 段**（否则能爬出工作区）", () => {
  for (const p of ["../secret", "docs/../../etc/passwd", "..", "a/..", "..\\..\\x"]) {
    assert.equal(safeRelativePath(p).ok, false, `越界路径必须拒绝：${p}`);
  }
});

test("safeRelativePath：空 / 非字符串明确拒绝，不静默成空串", () => {
  assert.equal(safeRelativePath("").ok, false);
  assert.equal(safeRelativePath("   ").ok, false);
  assert.equal(safeRelativePath(null).ok, false);
  assert.equal(safeRelativePath(undefined).ok, false);
  assert.equal(safeRelativePath(42).ok, false);
  assert.equal(safeRelativePath(".").ok, false, "只剩 . 段等于空路径");
});

test("childDir：由当前目录 + 名字拼出下钻前缀", () => {
  assert.equal(childDir("", "docs"), "docs/");
  assert.equal(childDir("whale-window/", "renderer"), "whale-window/renderer/");
  assert.equal(childDir("whale-window", "/renderer"), "whale-window/renderer/");
});

test("parentDir：上一级；已在根时仍给根", () => {
  assert.equal(parentDir(""), "");
  assert.equal(parentDir("docs"), "");
  assert.equal(parentDir("docs/"), "");
  assert.equal(parentDir("a/b/"), "a/");
  assert.equal(parentDir("a/b/c/"), "a/b/");
});

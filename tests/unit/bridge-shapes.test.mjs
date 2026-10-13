/**
 * 桥响应的形状归一化
 *
 * 职责：钉住「少剥一层 / 字段名写错」这类**静默错误**。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：这类错误的共同表现是「界面空着但不报错」——
 * 真窗口能看出「空」，但看不出是「桥返回空」还是「我们取错了字段」。
 * 真踩过：侧边栏显示「没有可见的会话」，而桥其实返回了 55 条。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function load() {
  const sandbox = { window: {}, console: { warn: () => {} }, Object, Array, String };
  createContext(sandbox);
  runInContext(
    readFileSync(join(ROOT, "whale-window", "renderer", "bridge-shapes.js"), "utf8"),
    sandbox,
    { filename: "bridge-shapes.js" },
  );
  return sandbox.window.WhaleBridgeShapes;
}

/*
 * ⚠️ 沙箱（node:vm）里的数组与测试进程的数组**跨 realm**，
 * `deepEqual` 会因为「结构相同但不同引用」失败。统一用 JSON 比较。
 */
const same = (actual, expected, msg) =>
  assert.equal(JSON.stringify(actual), JSON.stringify(expected), msg);

test("normalizeSessionList：取 sessions 与 archivedKnown", () => {
  const { normalizeSessionList } = load();
  const out = normalizeSessionList({ sessions: [{ sessionId: "a" }], archivedKnown: true });
  same(out.sessions, [{ sessionId: "a" }]);
  assert.equal(out.archivedKnown, true);
});

test("normalizeSessionList：归档判据没拿到就是 false（不该按它隐藏）", () => {
  const { normalizeSessionList } = load();
  assert.equal(normalizeSessionList({ sessions: [] }).archivedKnown, false);
  assert.equal(normalizeSessionList({ sessions: [], archivedKnown: "yes" }).archivedKnown, false);
});

test("normalizeSessionList：缺字段给空数组，不崩", () => {
  const { normalizeSessionList } = load();
  same(normalizeSessionList({}).sessions, []);
  same(normalizeSessionList(null).sessions, []);
  same(normalizeSessionList(undefined).sessions, []);
});

test("normalizeWorkspaceFiles：取 dir / entries / reason", () => {
  const { normalizeWorkspaceFiles } = load();
  const out = normalizeWorkspaceFiles(
    { dir: "docs/", entries: [{ path: "docs/a.md" }], reason: null },
    "fallback/",
  );
  assert.equal(out.dir, "docs/");
  same(out.entries, [{ path: "docs/a.md" }]);
  assert.equal(out.reason, null);
});

test("normalizeWorkspaceFiles：桥没给 dir 时用请求里那个", () => {
  const { normalizeWorkspaceFiles } = load();
  assert.equal(normalizeWorkspaceFiles({}, "docs/").dir, "docs/");
  assert.equal(normalizeWorkspaceFiles({}, "").dir, "");
});

test("normalizeWorkspaceFiles：reason 要保留（不能当成空目录）", () => {
  /*
   * ⚠️ 宿主那条路「需要活 agent」时给空清单 + reason。
   * 丢掉 reason 就会被显示成「这个目录是空的」—— 两者含义完全不同。
   */
  const { normalizeWorkspaceFiles } = load();
  const out = normalizeWorkspaceFiles({ entries: [], reason: "没有活跃 agent" });
  assert.equal(out.reason, "没有活跃 agent");
});

test("normalizeSkills：取 skills 数组", () => {
  const { normalizeSkills } = load();
  same(normalizeSkills({ skills: [{ name: "x" }] }).skills, [{ name: "x" }]);
  same(normalizeSkills({}).skills, []);
});

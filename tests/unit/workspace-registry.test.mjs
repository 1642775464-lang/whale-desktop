/**
 * 工作区注册表读取
 *
 * 职责：钉住「工作区归属是**登记制**」这件事 —— 以及读不到时的保守行为。
 * 所属层：测试（tests/unit）
 *
 * ## 为什么值得单独测
 *
 * 用户报过：
 *
 * > 数目根本不对，宿主侧数量没有那么多，你自己看你多出来的都是一堆空壳
 *
 * 根因是我按「会话的 cwd 等于某目录」反推归属，而宿主是**登记制**：
 * 注册表里每个工作区有一份显式 `sessionIds`。实测对照：
 * 「悬浮窗」工作区注册表里只有 **3 条**，按 cwd 反推能匹配出 **8 条**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { makeTempDir } from "../helpers/temp-dir.mjs";
import { join } from "node:path";

import { readWorkspaceRegistry, registryPath } from "../../whale-bridge/lib/workspace-registry.mjs";

/** 造一个临时注册表文件。 */
function writeRegistry(data) {
  const dir = makeTempDir("whale-ws-");
  const file = join(dir, "workspace.json");
  writeFileSync(file, JSON.stringify(data), "utf8");
  return file;
}

test("读工作区：id / 标题 / 路径 / 登记成员", () => {
  const file = writeRegistry({
    global: {
      defaultWorkspaceId: "ws-default",
      archivedSessionIds: ["s-arch"],
      pinnedSessionIds: ["s-pin"],
    },
    tables: {
      workspaces: {
        "ws-a": { path: "D:\\proj", title: "项目", sessionIds: ["s1", "s2"] },
        "ws-default": { path: "C:\\Users\\me\\default-workspace", title: "default-workspace", sessionIds: ["s3"] },
      },
    },
  });

  const reg = readWorkspaceRegistry(file);
  assert.equal(reg.ok, true);
  assert.equal(reg.workspaces.length, 2);
  const a = reg.workspaces.find((w) => w.id === "ws-a");
  assert.deepEqual(a.sessionIds, ["s1", "s2"], "成员是登记的那份，不按 cwd 反推");
  assert.equal(a.title, "项目");
  assert.equal(a.isDefault, false);
  assert.equal(reg.workspaces.find((w) => w.id === "ws-default").isDefault, true);
  assert.deepEqual(reg.archivedIds, ["s-arch"]);
  assert.deepEqual(reg.pinnedIds, ["s-pin"]);
});

test("没有 title 时用路径最后一段（与界面显示口径一致）", () => {
  const file = writeRegistry({
    global: {},
    tables: { workspaces: { w: { path: "D:\\a\\悬浮窗", sessionIds: [] } } },
  });
  assert.equal(readWorkspaceRegistry(file).workspaces[0].title, "悬浮窗");
});

test("文件不存在 / 坏 JSON → ok:false 且全空（界面据此不隐藏）", () => {
  /*
   * ⚠️ 读不到时**不能**假装「没有工作区也没有归档」——
   * 那会让界面按「已确认」去裁剪与隐藏，而实际是「根本不知道」。
   * 所以要用 ok:false 区分开。
   */
  assert.deepEqual(readWorkspaceRegistry(".tmp-tests/不存在的注册表.json"), {
    ok: false, workspaces: [], archivedIds: [], pinnedIds: [],
  });

  const bad = makeTempDir("whale-ws-bad-");
  const badFile = join(bad, "workspace.json");
  writeFileSync(badFile, "{ 这不是 json", "utf8");
  assert.equal(readWorkspaceRegistry(badFile).ok, false);
});

test("脏数据被过滤：非字符串 id / 缺字段不崩", () => {
  const file = writeRegistry({
    global: { archivedSessionIds: ["ok", null, 42, "", "also"] },
    tables: {
      workspaces: {
        w1: { path: "D:\\p", sessionIds: ["a", null, 7, ""] },
        w2: null,                       // 畸形行整条跳过
        w3: { sessionIds: "坏了" },     // 不是数组 → 空成员
      },
    },
  });
  const reg = readWorkspaceRegistry(file);
  assert.deepEqual(reg.archivedIds, ["ok", "also"]);
  assert.deepEqual(reg.workspaces.find((w) => w.id === "w1").sessionIds, ["a"]);
  assert.equal(reg.workspaces.find((w) => w.id === "w2"), undefined);
  assert.deepEqual(reg.workspaces.find((w) => w.id === "w3").sessionIds, []);
  assert.equal(reg.workspaces.find((w) => w.id === "w3").path, null);
});

test("registryPath：尊重 DSH_HOME，否则用 ~/.dsh", () => {
  assert.equal(
    registryPath({ DSH_HOME: "C:\\custom" }),
    join("C:\\custom", "storages", "workspace.json"),
  );
  assert.match(registryPath({}), /storages[\\/]workspace\.json$/);
});

/**
 * 会话清单的降级数据源（注册表 + 投影缓存）
 *
 * 职责：钉住「`session/list` 整体失败时，持久层清单兜底」这件事。
 * 所属层：测试（tests/unit）
 *
 * ## 为什么需要它
 *
 * 实测宿主可能因**一条**会话的 header 冲突（SESSION_QUERY_SOURCE_CONFLICT）
 * 让整个 `session/list` 502，而单会话的 resume/activate 一切正常。
 * 那时侧边栏不能降级成折叠器里那一两条 —— 要用注册表 + projcache 拼完整清单。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { makeTempDir } from "../helpers/temp-dir.mjs";
import { join } from "node:path";

import {
  fallbackSessionCatalog,
  projcacheDir,
  readProjection,
} from "../../whale-bridge/lib/fallback-catalog.mjs";

function setup({ registry, projections }) {
  const dir = makeTempDir("whale-fb-");
  const regFile = join(dir, "workspace.json");
  writeFileSync(regFile, JSON.stringify(registry), "utf8");
  // projcache 是**扁平目录**：sessions/<sessionId>.json（实测布局）
  const cacheDir = join(dir, "sessions");
  mkdirSync(cacheDir, { recursive: true });
  for (const [id, proj] of Object.entries(projections)) {
    writeFileSync(join(cacheDir, `${id}.json`), JSON.stringify(proj), "utf8");
  }
  return { registryFile: regFile, cacheDir };
}

test("降级清单：注册表给归属/归档，projcache 给标题与时间", () => {
  const { registryFile, cacheDir } = setup({
    registry: {
      global: { archivedSessionIds: ["s-arch"] },
      tables: {
        workspaces: {
          "ws-a": { path: "D:\\proj", title: "项目", sessionIds: ["s-1", "s-2"] },
        },
      },
    },
    projections: {
      "s-1": {
        record: {
          identity: { cwd: "D:\\proj" },
          rows: {
            title: { val: "会话甲" },
            sessionListMetadata: { val: { blank: false, lastPromptAt: 200 } },
          },
        },
      },
      "s-2": {
        record: {
          identity: { cwd: "D:\\proj" },
          rows: {
            title: { val: null },
            sessionListMetadata: { val: { blank: true, lastPromptAt: 100 } },
          },
        },
      },
    },
  });

  const out = fallbackSessionCatalog({ registryFile, cacheDir });
  assert.equal(out.ok, true);
  assert.equal(out.sessions.length, 2);
  const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId["s-1"].title, "会话甲");
  assert.equal(byId["s-1"].workspaceTitle, "项目");
  assert.equal(byId["s-1"].workspaceId, "ws-a");
  assert.equal(byId["s-1"].updatedAt, 200);
  assert.equal(byId["s-1"].blank, false);
  assert.equal(byId["s-1"].archived, false);
  assert.equal(byId["s-1"].running, false, "持久层快照，实时状态未知");
  assert.equal(byId["s-1"].agentAvailable, false);
  assert.equal(byId["s-2"].blank, true, "空壳标记来自 projcache");
  assert.equal(byId["s-2"].archived, false);
});

test("降级清单：归档标记来自注册表", () => {
  const { registryFile, cacheDir } = setup({
    registry: {
      global: { archivedSessionIds: ["s-arch"] },
      tables: {
        workspaces: {
          w: { path: "D:\\p", title: "P", sessionIds: ["s-arch", "s-keep"] },
        },
      },
    },
    projections: {
      "s-arch": { record: { rows: { title: { val: null } } } },
      "s-keep": { record: { rows: { title: { val: "留着" } } } },
    },
  });

  const out = fallbackSessionCatalog({ registryFile, cacheDir });
  const byId = Object.fromEntries(out.sessions.map((s) => [s.sessionId, s]));
  assert.equal(byId["s-arch"].archived, true);
  assert.equal(byId["s-keep"].archived, false);
  assert.equal(out.archivedKnown, true);
});

test("降级清单：projcache 缺失的会话也给一行（title 为 null，不整条丢）", () => {
  const { registryFile, cacheDir } = setup({
    registry: {
      global: {},
      tables: { workspaces: { w: { path: "D:\\p", title: "P", sessionIds: ["no-cache"] } } },
    },
    projections: {},
  });
  const out = fallbackSessionCatalog({ registryFile, cacheDir });
  assert.equal(out.sessions.length, 1);
  assert.equal(out.sessions[0].title, null, "没标题也给一行，不把会话藏掉");
  assert.equal(out.sessions[0].workspaceTitle, "P");
});

test("降级清单：按最近活动倒序（null 排最后）", () => {
  const { registryFile, cacheDir } = setup({
    registry: {
      global: {},
      tables: {
        workspaces: {
          w: { path: "D:\\p", title: "P", sessionIds: ["old", "new", "none"] },
        },
      },
    },
    projections: {
      old: { record: { rows: { sessionListMetadata: { val: { lastPromptAt: 100 } } } } },
      new: { record: { rows: { sessionListMetadata: { val: { lastPromptAt: 900 } } } } },
      none: { record: { rows: {} } },
    },
  });
  const out = fallbackSessionCatalog({ registryFile, cacheDir });
  assert.deepEqual(out.sessions.map((s) => s.sessionId), ["new", "old", "none"]);
});

test("降级清单：**不设 degraded**（清单完整，不是「不完整」）", () => {
  const { registryFile, cacheDir } = setup({
    registry: { global: {}, tables: { workspaces: { w: { path: "D:\\p", title: "P", sessionIds: [] } } } },
    projections: {},
  });
  const out = fallbackSessionCatalog({ registryFile, cacheDir });
  assert.equal(out.degraded, undefined, "完整清单不该触发「不完整」提示");
  assert.equal(out.fallback, true, "fallback 标记只供调试/测试用");
});

test("降级清单：注册表读不到 → ok:false，不编造清单", () => {
  const out = fallbackSessionCatalog({ registryFile: ".tmp-tests/不存在的注册表.json" });
  assert.equal(out.ok, false);
  assert.equal(out.code, "registry-unavailable");
});

test("projcacheDir：尊重 DSH_HOME", () => {
  assert.match(
    projcacheDir({ DSH_HOME: "C:\\custom" }),
    /storages[\\/]session_projcache[\\/]sessions$/,
  );
});

test("readProjection：读不到给 null；坏 JSON 也给 null", () => {
  const dir = makeTempDir("whale-fb-proj-");
  assert.equal(readProjection(dir, "nope"), null);
  writeFileSync(join(dir, "bad.json"), "{ 坏了", "utf8");
  assert.equal(readProjection(dir, "bad"), null);
});

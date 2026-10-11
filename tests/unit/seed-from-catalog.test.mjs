/**
 * 注册表清单种子（seedFromCatalog）
 *
 * 职责：钉住「ensureSeeded 找不到时用注册表清单兜底种上」的行为。
 * 所属层：测试（tests/unit）
 *
 * 为什么单独成文件：seed-cold-session.test.mjs 顶到 500 行上限（强制 14），
 * 而 seedFromCatalog 是**另一条路径**（注册表清单兜底，不是「最近一次」种子），
 * 失败原因不同，拆开让红了的用例指对方向。
 *
 * ## 为什么需要它（用户报的「列表点会话无法切换」）
 *
 * 根因链：
 *   ensureSeeded 走 sessionController.list（"All live sessions"），
 *   实测**活会话也可能不在那份清单里**（e21d009d 是活会话、getSession
 *   找得到，但 list 不含它）→ 折叠器没有它 → hud 清单缺它 →
 *   小窗 decideFollow 拒绝跟随 → 指针动了界面不动。
 *
 * 注册表清单（fallbackSessionCatalog）以注册表为准，**一定包含**
 * 登记在册的会话，所以用它兜底最稳。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createColdSeed } from "../../whale-bridge/lib/seed.mjs";
import { createFoldSet } from "../../whale-bridge/lib/fold.mjs";

test("seedFromCatalog：ensureSeeded 找不到时用注册表清单种上", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: {
      recentSessions: async () => [],           // ensureSeeded 走这条路 → 找不到
      sessionEvents: async () => [],
    },
    catalogOf: () => ({
      ok: true,
      sessions: [
        {
          sessionId: "s-cold",
          title: "冷会话标题",
          workspace: "D:\\proj",
          updatedAt: 123,
          running: false,
        },
      ],
    }),
  });

  const ok = await seed.seedFromCatalog("s-cold");
  assert.equal(ok, true, "注册表清单里有就该种上");
  assert.ok(foldSet.sessions.has("s-cold"), "折叠器里要有这个会话");
  const fold = foldSet.sessions.get("s-cold");
  assert.equal(fold.title, "冷会话标题", "标题从注册表清单带上");
  assert.equal(fold.workspace, "D:\\proj");
  assert.equal(fold.running, false, "冷会话 running 归位");
});

test("seedFromCatalog：已经在折叠器里的会话直接 true，不再读清单", async () => {
  const foldSet = createFoldSet();
  let catalogReads = 0;
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: { recentSessions: async () => [], sessionEvents: async () => [] },
    catalogOf: () => { catalogReads += 1; return { ok: true, sessions: [] }; },
  });
  // 先直接塞一个 fold（模拟事件流已喂过）
  foldSet.sessions.set("s-hot", { sessionId: "s-hot", title: null, tail: [] });
  assert.equal(await seed.seedFromCatalog("s-hot"), true);
  assert.equal(catalogReads, 0, "已有就不该读清单");
});

test("seedFromCatalog：注册表清单里也没有 → false，不建空 fold", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: { recentSessions: async () => [], sessionEvents: async () => [] },
    catalogOf: () => ({ ok: true, sessions: [] }),
  });
  assert.equal(await seed.seedFromCatalog("不存在"), false);
  assert.equal(foldSet.sessions.size, 0);
});

test("seedFromCatalog：catalogOf 抛错也要降级 false，不冒异常", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: { recentSessions: async () => [], sessionEvents: async () => [] },
    catalogOf: () => { throw new Error("注册表读不到"); },
  });
  assert.equal(await seed.seedFromCatalog("s"), false);
  assert.equal(foldSet.sessions.size, 0);
});

test("seedFromCatalog：catalogOf 给 ok:false 同样降级 false", async () => {
  const foldSet = createFoldSet();
  const seed = createColdSeed({
    foldSet,
    log: () => {},
    host: { recentSessions: async () => [], sessionEvents: async () => [] },
    catalogOf: () => ({ ok: false }),
  });
  assert.equal(await seed.seedFromCatalog("s"), false);
});

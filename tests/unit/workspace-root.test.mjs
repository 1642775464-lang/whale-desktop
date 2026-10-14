/**
 * 工作区根解析
 *
 * 职责：钉住「读文件的工作区根与会话清单同源」这条 —— 它修的是
 *       用户报的「能进文件列表但打不开文件（no-workspace）」。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测：这类 bug 的表现是**两条通路不一致** ——
 * 列目录走 `getAgent` + `fileReferences`（一直好），读文件走会话字段
 * （宿主没给就是空）。只测「读文件函数本身」发现不了，
 * 必须测**根的来源顺序**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveWorkspaceRoot } from "../../whale-bridge/lib/workspace-root.mjs";

const neverCatalog = () => ({ ok: false, code: "registry-unavailable" });

test("宿主直接给了 cwd 就用它（最直接，不必再问清单）", async () => {
  let askedList = false;
  const host = {
    listSessionsViaTypert: async () => { askedList = true; return { ok: true, sessions: [] }; },
  };
  const root = await resolveWorkspaceRoot({
    host,
    sessionId: "s1",
    session: { cwd: "D:/proj" },
    catalogOf: neverCatalog,
  });
  assert.equal(root, "D:/proj");
  assert.equal(askedList, false, "有直接来源就不该再去问清单");
});

test("**宿主没给工作区字段时，回退到会话清单**（这正是用户报的那个 bug）", async () => {
  /*
   * 实测宿主 `getSession()` 的 cwd / workspace 都是空的 ——
   * 原实现据此直接报 no-workspace，于是「列表能进、文件打不开」。
   * 修法就是回退到会话清单（界面上已证明可用的来源）。
   */
  const host = {
    listSessionsViaTypert: async () => ({
      ok: true,
      sessions: [
        { sessionId: "other", workspace: "D:/other" },
        { sessionId: "s1", workspacePath: "D:/proj", workspaceTitle: "悬浮窗" },
      ],
    }),
  };
  const root = await resolveWorkspaceRoot({
    host,
    sessionId: "s1",
    session: {},
    catalogOf: neverCatalog,
  });
  assert.equal(root, "D:/proj");
});

test("清单里 workspace 优于 workspacePath（前者是该会话的工作目录）", async () => {
  const host = {
    listSessionsViaTypert: async () => ({
      ok: true,
      sessions: [{ sessionId: "s1", workspace: "D:/proj/sub", workspacePath: "D:/proj" }],
    }),
  };
  const root = await resolveWorkspaceRoot({ host, sessionId: "s1", session: {}, catalogOf: neverCatalog });
  assert.equal(root, "D:/proj/sub");
});

test("清单也拿不到时，回退到降级清单", async () => {
  const host = { listSessionsViaTypert: async () => ({ ok: false, code: "boom" }) };
  const root = await resolveWorkspaceRoot({
    host,
    sessionId: "s1",
    session: {},
    catalogOf: () => ({ ok: true, sessions: [{ sessionId: "s1", workspace: "D:/fallback" }] }),
  });
  assert.equal(root, "D:/fallback");
});

test("清单读取**抛异常**时不打挂整个请求，继续往下降级", async () => {
  const host = { listSessionsViaTypert: async () => { throw new Error("网络炸了"); } };
  const root = await resolveWorkspaceRoot({
    host,
    sessionId: "s1",
    session: {},
    catalogOf: () => ({ ok: true, sessions: [{ sessionId: "s1", workspace: "D:/still-here" }] }),
  });
  assert.equal(root, "D:/still-here");
});

test("全都拿不到时返回空串 —— **不猜一个默认目录**", async () => {
  /*
   * 编一个默认目录会让用户读到别的项目的文件，比明确报错糟得多。
   */
  const host = { listSessionsViaTypert: async () => ({ ok: true, sessions: [] }) };
  const root = await resolveWorkspaceRoot({ host, sessionId: "s1", session: {}, catalogOf: neverCatalog });
  assert.equal(root, "");
});

test("空字符串与 null 都当「没有」（不能把 '' 当有效根）", async () => {
  const host = { listSessionsViaTypert: async () => ({ ok: true, sessions: [{ sessionId: "s1", workspace: "D:/ok" }] }) };
  const root = await resolveWorkspaceRoot({
    host,
    sessionId: "s1",
    session: { cwd: "", workspace: null },
    catalogOf: neverCatalog,
  });
  assert.equal(root, "D:/ok", "空串/null 要跳过，继续找下一个来源");
});

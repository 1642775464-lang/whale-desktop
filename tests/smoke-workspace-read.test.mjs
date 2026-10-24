/**
 * 端到端：工作区文件**列得出也打得开**
 *
 * 职责：钉住用户报的那组现象 —— 「能进文件列表，但点开文件报 no-workspace」。
 * 所属层：测试（smoke）
 *
 * ## 为什么必须端到端测这一条
 *
 * 这个 bug 的本质是**两条通路拿工作区根的方式不一致**：
 *   · 列目录走 `getAgent` + `fileReferences` —— 不碰会话的工作区字段，一直是好的；
 *   · 读文件原先是 `session.cwd ?? session.workspace` —— 宿主这两个字段为空，
 *     于是永远报 `no-workspace`。
 *
 * ⚠️ 夹具的 `sessions.get()` 恰好只返回 `{ id }`（**没有** cwd / workspace），
 * 与实测遇到的宿主形态一致 —— 也就是说这个夹具**天然就是这个 bug 的触发条件**，
 * 不需要额外改造。工作区只出现在 `sessionController.list` 里。
 *
 * ## 用例覆盖
 *
 *   1. 列得出 + **打得开**（同一会话，走同一条根）；
 *   2. 越界路径被拒（安全边界不能被这次修复放松）；
 *   3. 文件不存在报 404（不假装成功）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { makeTempDir } from "./helpers/temp-dir.mjs";
import { join } from "node:path";

import { apply, dispose } from "../whale-bridge/host.js";
import { createFakeCtx, createHttpTools } from "./helpers/slice3-fixtures.mjs";

/* 端口 19400：19380~19399 已被其它 smoke 占用（有测试专门查重复监听）。 */
const PORT = 19386;
const http = createHttpTools(PORT);

/** 造一个真实存在的工作区目录，里面放真文件。 */
function makeWorkspace() {
  const root = makeTempDir("whale-ws-");
  mkdirSync(join(root, "docs"), { recursive: true });
  writeFileSync(join(root, "docs", "规范.md"), "# 标题\n\n正文内容\n", "utf8");
  return root;
}

/**
 * 造一份「降级清单」的落盘数据，并把 `DSH_HOME` 指过去。
 *
 * ## 为什么要绕这一下
 *
 * 用户那个 bug 的触发条件是**宿主 `getSession()` 不给工作区字段** ——
 * 夹具的 `sessions.get()` 本来就只返回 `{ id }`，天然满足。但这样跑不通：
 * `resolveWorkspaceRoot` 的第二来源 `listSessionsViaTypert` 在测试进程里走的是
 * **真实宿主通道**（实测返回真实会话清单，找不到夹具编的 `s-ws`），
 * 于是只能落到**第三来源：降级清单**。
 *
 * 降级清单由注册表（`<DSH_HOME>/storages/workspace.json`）+ 投影缓存
 * （`.../session_projcache/sessions/<id>.json`）拼出来，两者都尊重 `DSH_HOME` ——
 * 所以把 `DSH_HOME` 指向临时目录、写入这份数据，就能**确定性地**让它命中。
 *
 * 这样本用例才真的覆盖「宿主不给 → 回退清单」这条修复路径
 * （否则只测到「宿主给了」那条，注入回旧实现也照样绿 —— 已踩过）。
 *
 * @param {string} root 工作区绝对路径
 * @returns {string} 临时的 DSH_HOME
 */
function seedFallbackCatalog(root) {
  const home = makeTempDir("whale-home-");
  mkdirSync(join(home, "storages", "session_projcache", "sessions"), { recursive: true });

  // 注册表：工作区 + 它显式登记的会话 id（成员关系只认这里）
  writeFileSync(
    join(home, "storages", "workspace.json"),
    JSON.stringify({
      global: { defaultWorkspaceId: "ws-test" },
      tables: {
        workspaces: {
          "ws-test": { path: root, title: "测试工作区", sessionIds: ["s-ws"] },
        },
      },
    }),
    "utf8",
  );

  // 投影缓存：这条会话的工作目录（降级清单里的 workspace 就取它）
  writeFileSync(
    join(home, "storages", "session_projcache", "sessions", "s-ws.json"),
    JSON.stringify({
      record: {
        identity: { cwd: root },
        rows: { title: { val: "工作区用例" } },
      },
    }),
    "utf8",
  );

  return home;
}

/**
 * 造宿主：`sessions.get()` **只给 id，不给工作区字段**（实测形态、也是 bug 触发条件）。
 *
 * @param {string} root 工作区绝对路径
 * @param {Array<object>} entries 让 fileReferences 返回的候选
 */
function ctxWith(root, entries = [{ path: "docs/规范.md", kind: "file" }]) {
  const ctx = createFakeCtx({
    liveSessionId: "s-ws",
    services: {
      fileReferences: { list: async () => entries },
      sessionController: {
        list: async () => ({
          items: [
            {
              sessionId: "s-ws",
              updatedAt: 100,
              cwd: root,
              running: false,
              projections: { values: { title: "工作区用例" } },
            },
          ],
        }),
        inspect: async () => ({
          meta: { id: "s-ws" },
          inheritedEventCount: 0,
          events: [{ seq: 1, type: "session", data: {}, time: 1 }],
        }),
      },
    },
  });
  // 夹具的 sessions.get 固定只给 { id } —— **这正是 bug 的触发条件**，
  // 保持原样，让工作区只能从降级清单取到
  // 列目录那条路需要**活 agent**（宿主用它做作用域与鉴权）
  ctx.__setAgent("s-ws", { id: "s-ws", status: "idle" });
  return ctx;
}

test("工作区文件：列得出、打得开，且越界与缺失都如实报错", async (t) => {
  /*
   * ⚠️ 一个桥、一条用例：同一个进程里反复 `apply` 同一端口会相互干扰
   * （实测第二条会 ECONNRESET）。这几件事本来就属于同一条链路，
   * 合起来断言也更省时。
   */
  const root = makeWorkspace();
  const ctx = ctxWith(root);
  // 把 DSH_HOME 指到临时目录：让「降级清单」这条来源能确定性地命中
  const prevHome = process.env.DSH_HOME;
  process.env.DSH_HOME = seedFallbackCatalog(root);
  t.after(() => {
    if (prevHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prevHome;
  });
  await apply(ctx, { port: PORT });
  t.after(async () => { await dispose(); });

  const sid = "s-ws";

  // ① 列目录：能列出（这条一直是好的）
  const list = await http.getJson(`/whale/workspace/files?sessionId=${sid}&dir=docs`);
  assert.equal(list.status, 200, `列目录应成功：${JSON.stringify(list.json)}`);
  const names = (list.json.entries ?? []).map((e) => e.name);
  assert.ok(names.includes("规范.md"), `应列出 docs/规范.md，实际：${JSON.stringify(names)}`);

  // ② 读文件：**必须也能成功** —— 这就是用户报「打不开」的那一步
  const read = await http.getJson(
    `/whale/workspace/read?sessionId=${sid}&path=${encodeURIComponent("docs/规范.md")}`,
  );
  assert.equal(
    read.status, 200,
    `读文件应成功，实际 ${read.status} ${JSON.stringify(read.json)}`
    + "（若报 no-workspace，说明工作区根没走会话清单）",
  );
  assert.match(String(read.json.text ?? ""), /正文内容/, "应返回文件真实内容");

  // ③ 越界路径：安全边界不能因为这次修复而放松
  const bad = await http.getJson(
    `/whale/workspace/read?sessionId=${sid}&path=${encodeURIComponent("../outside.txt")}`,
  );
  assert.ok(bad.status === 400 || bad.status === 404, `越界路径应被拒，实际 ${bad.status}`);

  // ④ 不存在的文件：如实报 404，不假装成功
  const miss = await http.getJson(
    `/whale/workspace/read?sessionId=${sid}&path=${encodeURIComponent("nope.md")}`,
  );
  assert.equal(miss.status, 404, `应报 404，实际 ${miss.status} ${JSON.stringify(miss.json)}`);

  // ⑤ 缺 sessionId：报 400（不静默给空内容）
  const noSid = await http.getJson(`/whale/workspace/read?path=${encodeURIComponent("docs/规范.md")}`);
  assert.equal(noSid.status, 400, `缺 sessionId 应报 400，实际 ${noSid.status}`);
});

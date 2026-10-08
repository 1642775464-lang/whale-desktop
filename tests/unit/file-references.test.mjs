/**
 * 文件引用候选（切片 7 第四批）
 *
 * 职责：钉住「小窗 ＋ 浮层的『文件』项能搜到工作区文件」这条链路。
 * 所属层：测试（tests/unit）
 *
 * 用户报：「小窗的对话框的＋号交互内容和主窗口的没有对齐」。
 * 主窗口的＋号菜单里有一项「文件」，是 `@` 触发的**工作区文件引用**
 * （插入 `@路径`，不是上传）。小窗原先只有拖拽上传，没有这一项。
 *
 * 契约（逐字段核过宿主已发布代码）：
 *   fileReferences.list(agent, query, signal) → FileReferenceCandidate[]
 *   FileReferenceCandidate { path: string, kind: "file" | "directory" }
 *   插入形式：`@` + path（主窗口也是这个语义）
 *
 * ⚠️ 这块最容易踩的坑：**服务名与形状不能靠猜**。
 * 本项目的教训（commands.execute 的第 3、4 参）就是照目录签名写、
 * 与真实实现不一致，表现为「跑了但没数据、也不报错」。
 * 所以这里的假服务完全按宿主真实形状来造。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHostAccess } from "../../whale-bridge/lib/host-ctx.mjs";

/** 造一个带 ctx.get 的假宿主 ctx。 */
function gettableCtx(services, injected = []) {
  const declared = new Set(injected);
  return {
    on: () => () => {},
    get: (name) => (Object.hasOwn(services, name) ? services[name] : undefined),
    ...Object.fromEntries(Object.entries(services).filter(([n]) => declared.has(n))),
  };
}

/** 一个只有 fileReferences 的假宿主。 */
function ctxWithFileReferences(listImpl) {
  return gettableCtx({ fileReferences: { list: listImpl } });
}

test("fileReferences 是可选服务（没提供时给空数组，不抛）", async () => {
  const host = createHostAccess(gettableCtx({}));
  assert.deepEqual(await host.fileReferences("x"), []);
});

test("fileReferences 走宿主的 fileReferences.list(agent, query, signal)", async () => {
  let seen = null;
  const agent = { id: "a1" };
  const host = createHostAccess(ctxWithFileReferences((a, query, signal) => {
    seen = { a, query, signal };
    return Promise.resolve([{ path: "src/a.ts", kind: "file" }]);
  }));

  const out = await host.fileReferences("conf", agent);

  assert.equal(seen.a, agent, "第一参是 agent（宿主要它做鉴权与作用域）");
  assert.equal(seen.query, "conf", "第二参是查询串");
  assert.ok(seen.signal instanceof AbortSignal, "第三参必须是 AbortSignal（宿主会 throwIfAborted）");
  assert.deepEqual(out, [{ path: "src/a.ts", kind: "file" }]);
});

test("拿不到 agent 时不问宿主（宿主那条路需要活 agent）", async () => {
  let called = 0;
  const host = createHostAccess(ctxWithFileReferences(() => {
    called += 1;
    return Promise.resolve([]);
  }));

  const out = await host.fileReferences("x");
  assert.equal(called, 0, "没有 agent 就不该空敲一次宿主");
  assert.deepEqual(out, []);
});

test("结果原样透传：不改名、不补全（避免两套形状）", async () => {
  // 宿主给什么就交什么——桥自己再造一份字段，将来宿主改名就对不上。
  const raw = [
    { path: "docs/PRD.md", kind: "file" },
    { path: "docs/", kind: "directory" },
  ];
  const host = createHostAccess(ctxWithFileReferences(() => Promise.resolve(raw)));
  const out = await host.fileReferences("docs", { id: "a" });

  assert.equal(out[0], raw[0], "必须是宿主给的那个对象本身");
  assert.equal(out[1].kind, "directory", "目录也要保留（主窗口同样列出目录）");
});

test("宿主抛错时给空数组，不冒到 HTTP 层", async () => {
  const host = createHostAccess(ctxWithFileReferences(() => Promise.reject(new Error("搜索失败"))));
  assert.deepEqual(await host.fileReferences("x", { id: "a" }), []);
});

test("非数组返回当成空（宿主版本差异不该让桥抛错）", async () => {
  const host = createHostAccess(ctxWithFileReferences(() => Promise.resolve("不是数组")));
  assert.deepEqual(await host.fileReferences("x", { id: "a" }), []);
});

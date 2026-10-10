/**
 * 宿主元数据读取：按名探测服务、已归档会话判据
 *
 * 职责：钉住「只回答在不在 / 不读内容」的探测纪律，以及归档 id 的读取。
 * 所属层：测试（tests/unit）
 *
 * 为什么从 host-ctx.test.mjs 拆出来：那个文件顶到 500 行上限
 * （开发规范 强制 14）。这一组与「会话访问 / 模型切换」不是一类职责 ——
 * 它们读的是宿主元数据，不改任何东西，所以单独成文件。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createHostAccess } from "../../whale-bridge/lib/host-ctx.mjs";
import { createGettableCtx } from "../helpers/host-ctx-double.mjs";

// ── 按名探测服务（/whale/probe?services=）────────────────

test("serviceVisible：如实区分「有这个服务」与「没有」", () => {
  /*
   * 为什么需要这个能力：用户要的侧边栏里，「任务看板 / 技能中心 / 频道」
   * 的内容来自 DSH 的插件 —— 桥能不能取到它们的数据，只能**实测**回答。
   * 没有按名探测时，每验一个服务名都要改代码再重启宿主。
   */
  const host = createHostAccess(createGettableCtx({
    taskBoard: { list: () => [] },
    skills: { list: () => [] },
  }));

  const out = host.serviceVisible(["taskBoard", "skills", "imConnect", "channelHub"]);
  assert.equal(out.taskBoard, true, "任务看板服务在");
  assert.equal(out.skills, true, "技能服务在");
  assert.equal(out.imConnect, false, "频道没有这个服务名");
  assert.equal(out.channelHub, false, "不在的报 false，不猜");
});

test("serviceVisible：非法服务名一律报 false，不去读属性", () => {
  /*
   * 探测接口只接受常规标识符。否则它可以被当成「任意属性读取器」用
   * （比如传 `__proto__` / 带点的路径），把一个只读诊断变成越权入口。
   *
   * ⚠️ 这条测试真抓到了一个缺陷：输出对象原先用 `{}`，给
   * `out["__proto__"]` 赋值会去**改原型**而不是建属性 —— 结论丢掉，
   * 而且那正是原型污染入口。修法见 host-catalog 的 `Object.create(null)`。
   */
  const host = createHostAccess(createGettableCtx({ taskBoard: {} }));
  const out = host.serviceVisible(["__proto__", "a.b", "a b", "", "taskBoard"]);
  assert.equal(out["__proto__"], false, "拒绝原型链名字");
  assert.equal(out["a.b"], false, "拒绝带点的名字");
  assert.equal(out["a b"], false, "拒绝带空格的名字");
  assert.equal(out.taskBoard, true, "正常名字照常探测");
  assert.equal(Object.getPrototypeOf(out), null, "输出对象无原型，杜绝污染");
});

test("serviceVisible：传非数组 / 空数组不崩，给空结果", () => {
  const host = createHostAccess(createGettableCtx({ taskBoard: {} }));
  for (const bad of [undefined, null, [], "taskBoard"]) {
    const out = host.serviceVisible(bad);
    assert.deepEqual(Object.keys(out), [], `${String(bad)} 应给空结果`);
  }
});

test("serviceVisible：探测是只读的，不调用服务方法", () => {
  /*
   * 探测只回答「在不在」。若它顺手调了服务的方法，一个诊断动作就会
   * 产生副作用（比如真去列了任务、真去连了频道）。
   */
  let touched = 0;
  const spy = { list: () => { touched += 1; return []; } };
  const host = createHostAccess(createGettableCtx({ taskBoard: spy }));

  assert.equal(host.serviceVisible(["taskBoard"]).taskBoard, true);
  assert.equal(touched, 0, "只查存在性，不得调用服务方法");
});

// ── 已归档会话（侧边栏不列它们）────────────────────────

test("archivedSessionIds：读 workspaceRegistry 的归档 id 清单", () => {
  /*
   * 用户报过「你把已归档的会话也读进去了」。
   *
   * `session/list` 的 SessionSummary **不含归档状态**，权威来源是
   * `ctx.workspaceRegistry.archivedSessionIds` ——
   * 见 dsh-api-session-controller 的 archived-session-gate.js：
   * 它就是用 `archived.includes(header.id)` 判定归档的。
   */
  const host = createHostAccess(createGettableCtx({
    workspaceRegistry: { archivedSessionIds: ["a", "b"] },
  }));
  assert.deepEqual(host.archivedSessionIds(), { ok: true, ids: ["a", "b"] });
});

test("archivedSessionIds：服务不在时 ok=false 且给空清单（界面据此不隐藏）", () => {
  /*
   * ⚠️ 取不到时**不能**假装「没有归档会话」—— 那等于告诉界面
   * 「已确认没有归档的」，而实际是「根本不知道」。界面只在
   * archivedKnown=true 时才隐藏，所以这里必须用 ok:false 区分开。
   */
  const host = createHostAccess(createGettableCtx({}));
  assert.deepEqual(host.archivedSessionIds(), { ok: false, ids: [] });
});

test("archivedSessionIds：字段不是数组时也如实报 ok=false", () => {
  const host = createHostAccess(createGettableCtx({
    workspaceRegistry: { archivedSessionIds: "坏了" },
  }));
  assert.deepEqual(host.archivedSessionIds(), { ok: false, ids: [] });
});

test("archivedSessionIds：过滤掉非字符串项，不把脏数据当 id", () => {
  const host = createHostAccess(createGettableCtx({
    workspaceRegistry: { archivedSessionIds: ["a", null, 42, "", "b"] },
  }));
  assert.deepEqual(host.archivedSessionIds(), { ok: true, ids: ["a", "b"] });
});

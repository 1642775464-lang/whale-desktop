/**
 * 侧边对话的「归档」入口
 *
 * 职责：钉住归档这条链路的**渲染层**行为 —— 归档当前会话、成功后另起一条、
 *       失败如实报原因。
 * 所属层：测试（tests/unit）
 *
 * 为什么单独成文件：这几个用例与「面板导航 / 文件预览」不是同一职责，
 * 原先挤在 side-panels.test.mjs 里把那个文件顶过了 500 行上限（强制 14）。
 *
 * 桥端的分档行为（400/404/409/503）由 tests/smoke-session-archive.test.mjs 覆盖。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RENDERER = join(ROOT, "whale-window", "renderer");

/** 一个什么都不做的桩。 */
const nothing = async () => ({ ok: true, entries: [], messages: [] });

/** 一个不关心的假元素。 */
function fakeEl() {
  const listeners = {};
  return {
    textContent: "",
    innerHTML: "",
    value: "",
    hidden: false,
    disabled: false,
    className: "",
    title: "",
    children: [],
    appendChild(c) { this.children.push(c); },
    addEventListener(name, fn) { listeners[name] = fn; },
    click() { if (listeners.click) listeners.click(); },
    focus() {},
    setAttribute() {},
    getAttribute() { return null; },
    contains() { return false; },
  };
}

/** 侧窗 dom 桩（与真实 HTML 的 id 对齐）。 */
function mkDom() {
  const ids = [
    "sHome", "sbTitle", "sClose", "sBrowser", "sFiles", "sChat",
    "sbBack", "sbUrl", "sbGo", "sbWeb", "sfBack", "sfCrumb", "sfCount", "sfBody",
    "scBack", "scTitle", "scState", "scInherit", "scStream", "scInput", "scSend", "scArchive",
  ];
  const dom = {};
  for (const id of ids) dom[id] = fakeEl();
  return dom;
}

/** 在沙箱里加载侧窗面板（顺序与 side.html 一致）。 */
function loadPanels() {
  const sandbox = {
    window: {},
    console: { warn: () => {}, log: () => {} },
    Object, Array, String, Promise, Number, Boolean, JSON, Error,
    RegExp, Set, Map, Date, URLSearchParams,
    // 对话面板会起轮询：缺这两个会在进入对话时炸
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
  };
  sandbox.window.document = {
    createElement: () => fakeEl(),
    querySelector: () => null,
  };
  sandbox.window.console = sandbox.console;
  // ⚠️ 面板代码走的是 `global.xxx`（= window.xxx），所以定时器要挂在 window 上
  sandbox.window.setInterval = () => 1;
  sandbox.window.clearInterval = () => {};
  sandbox.window.setTimeout = () => 1;
  sandbox.window.clearTimeout = () => {};
  sandbox.window.URLSearchParams = URLSearchParams;
  createContext(sandbox);
  for (const f of ["file-preview.cjs", "side-files.js", "side-panels.js"]) {
    const p = f.endsWith(".cjs") ? join(ROOT, "whale-window", "lib", f) : join(RENDERER, f);
    runInContext(readFileSync(p, "utf8"), sandbox, { filename: f });
  }
  return {
    WhaleSidePanels: sandbox.window.WhaleSidePanels,
    WhaleFilePreview: sandbox.window.WhaleFilePreview,
    WhaleSideFiles: sandbox.window.WhaleSideFiles,
  };
}
test("侧边对话：点「归档」→ 归档当前会话，并**另起一条新对话**", async () => {
  /*
   * 用户要求：「侧边对话里能归档会话，给它一个归档入口」。
   *
   * ⚠️ 归档后必须另起新对话：这条已归档，继续在里面说话会把它重新唤醒，
   * 用户看到「归档了还能聊」会以为没生效。
   */
  const { WhaleSidePanels: { createSidePanels }, WhaleFilePreview: preview } = loadPanels();
  const dom = mkDom();
  const archived = [];
  let created = 0;
  const panels = createSidePanels({
    dom,
    preview,
    client: {
      createSession: async () => { created += 1; return { ok: true, sessionId: `s-${created}` }; },
      panel: async () => ({ ok: true, messages: [], running: false }),
      sessionList: async () => ({ ok: true, sessions: [] }),
      archiveSession: async (id) => { archived.push(id); return { ok: true }; },
      workspaceFiles: nothing, openWorkspacePath: nothing, readWorkspaceFile: nothing, send: nothing,
    },
    onHome: () => {},
  });

  await panels.enter("chat");
  await new Promise((r) => setImmediate(r));
  assert.equal(created, 1, "进对话先建一条");

  dom.scArchive.click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(archived, ["s-1"], "归档的应是当前这条对话");
  assert.equal(created, 2, "归档后要另起一条新的");
});

test("侧边对话：归档失败要**如实显示原因**，不静默", async () => {
  const { WhaleSidePanels: { createSidePanels }, WhaleFilePreview: preview } = loadPanels();
  const dom = mkDom();
  const notes = [];
  const panels = createSidePanels({
    dom,
    preview,
    client: {
      createSession: async () => ({ ok: true, sessionId: "s-1" }),
      panel: async () => ({ ok: true, messages: [], running: false }),
      sessionList: async () => ({ ok: true, sessions: [] }),
      archiveSession: async () => ({ ok: false, code: "session-active" }),
      workspaceFiles: nothing, openWorkspacePath: nothing, readWorkspaceFile: nothing, send: nothing,
    },
    onHome: () => {},
    onNotify: (m) => notes.push(m),
  });

  await panels.enter("chat");
  await new Promise((r) => setImmediate(r));

  dom.scArchive.click();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));

  assert.match(dom.scState.textContent, /session-active/, "失败原因要显示出来");
  assert.equal(notes.length, 1, "也要有一条通知，不能只写在小角落");
});


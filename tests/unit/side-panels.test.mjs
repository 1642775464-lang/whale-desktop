/**
 * 侧窗页面逻辑
 *
 * 职责：钉住地址补全规则与「三个按钮只显示对应面板」的切换。
 * 所属层：测试（tests/unit）
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 造一个够用的假 DOM。 */
function fakeEl() {
  const children = [];
  const listeners = {};
  const el = {
    hidden: false,
    textContent: "",
    title: "",
    value: "",
    disabled: false,
    className: "",
    children,
    listeners,
    appendChild(c) { children.push(c); },
    addEventListener(ev, fn) { listeners[ev] = fn; },
    setAttribute(k, v) { this[k] = v; },
    scrollTop: 0,
    scrollHeight: 0,
    click() { if (listeners.click) listeners.click(); },
  };
  Object.defineProperty(el, "innerHTML", {
    get() { return ""; },
    set(v) { if (v === "") children.length = 0; },
  });
  return el;
}

function loadPanels() {
  const sandbox = {
    window: {},
    console: { warn: () => {} },
    Object, Array, String, Promise, Number, URLSearchParams,
  };
  sandbox.window.document = {
    createElement: () => fakeEl(),
    getElementById: () => fakeEl(),
  };
  sandbox.window.setInterval = () => 1;
  sandbox.window.clearInterval = () => {};
  sandbox.window.console = sandbox.console;
  createContext(sandbox);
  runInContext(
    readFileSync(join(ROOT, "whale-window", "renderer", "side-panels.js"), "utf8"),
    sandbox,
    { filename: "side-panels.js" },
  );
  return sandbox.window.WhaleSidePanels;
}

const nothing = async () => ({ ok: true, entries: [], messages: [] });

/** 一个什么都不做的客户端桩（只为让面板构造成功）。 */
const inertClient = {
  workspaceFiles: nothing,
  panel: nothing,
  openWorkspacePath: nothing,
  send: nothing,
  createSession: nothing,
};

function mkDom() {
  const ids = [
    "sHome", "sbTitle", "sClose", "sBrowser", "sFiles", "sChat",
    "sbBack", "sbUrl", "sbGo", "sbWeb", "sfBack", "sfCrumb", "sfCount", "sfList",
    "scBack", "scTitle", "scState", "scStream", "scInput", "scSend",
  ];
  const dom = {};
  for (const id of ids) dom[id] = fakeEl();
  return dom;
}

test("normalizeUrl：缺协议时按 https 补", () => {
  const { normalizeUrl } = loadPanels();
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("  example.com/a  "), "https://example.com/a");
});

test("normalizeUrl：已有协议原样保留", () => {
  const { normalizeUrl } = loadPanels();
  assert.equal(normalizeUrl("http://a.com"), "http://a.com");
  assert.equal(normalizeUrl("https://a.com/x"), "https://a.com/x");
});

test("normalizeUrl：about/data/file 这类也放行（不带 //）", () => {
  const { normalizeUrl } = loadPanels();
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.equal(normalizeUrl("file:///C:/x.html"), "file:///C:/x.html");
});

test("normalizeUrl：空输入给空串（调用方据此提示，而不是打开某个默认站点）", () => {
  const { normalizeUrl } = loadPanels();
  assert.equal(normalizeUrl(""), "");
  assert.equal(normalizeUrl("   "), "");
  assert.equal(normalizeUrl(null), "");
});

test("浏览器：点「打开」把地址设到 webview 的 src", async () => {
  const { createSidePanels } = loadPanels();
  const dom = mkDom();
  dom.sbUrl.value = "example.com";
  createSidePanels({
    dom,
    client: inertClient,
    onHome: () => {},
  });
  dom.sbGo.click();
  assert.equal(dom.sbWeb.src, "https://example.com", "要补协议后交给 webview");
});

test("浏览器：空地址不打开，只提示", () => {
  const { createSidePanels } = loadPanels();
  const dom = mkDom();
  dom.sbUrl.value = "";
  const notes = [];
  createSidePanels({
    dom,
    client: inertClient,
    onHome: () => {},
    onNotify: (m) => notes.push(m),
  });
  dom.sbGo.click();
  assert.equal(dom.sbWeb.src, undefined, "不该给 webview 设地址");
  assert.equal(notes.length, 1);
});

test("文件：进入时列工作区根，失败要显示原因", async () => {
  const { createSidePanels } = loadPanels();
  const dom = mkDom();
  const seen = [];
  const panels = createSidePanels({
    dom,
    client: {
      workspaceFiles: async (dir) => { seen.push(dir); return { ok: false, code: "not-found" }; },
      panel: nothing, openWorkspacePath: nothing, send: nothing, createSession: nothing,
    },
    onHome: () => {},
  });
  await panels.enter("files");
  assert.deepEqual(seen, [""], "先列根目录");
  const text = dom.sfList.children.map((c) => c.textContent).join(" ");
  assert.match(text, /not-found/, "要显示失败原因");
});

test("侧边对话：进入时**新建一个真会话**，再拉它的面板", async () => {
  const { createSidePanels } = loadPanels();
  const dom = mkDom();
  let created = 0;
  let polledFor = null;
  const panels = createSidePanels({
    dom,
    client: {
      createSession: async () => { created += 1; return { ok: true, sessionId: "s-new" }; },
      panel: async (id) => { polledFor = id; return { ok: true, messages: [], running: false }; },
      workspaceFiles: nothing, openWorkspacePath: nothing, send: nothing,
    },
    onHome: () => {},
  });
  await panels.enter("chat");
  assert.equal(created, 1, "要真建一个会话");
  assert.equal(polledFor, "s-new", "建完要拉这个会话的面板");
});

test("侧边对话：已有会话时再进入不重复新建", async () => {
  const { createSidePanels } = loadPanels();
  const dom = mkDom();
  let created = 0;
  const panels = createSidePanels({
    dom,
    client: {
      createSession: async () => { created += 1; return { ok: true, sessionId: "s-1" }; },
      panel: async () => ({ ok: true, messages: [], running: false }),
      workspaceFiles: nothing, openWorkspacePath: nothing, send: nothing,
    },
    onHome: () => {},
  });
  await panels.enter("chat");
  panels.leave("chat");
  await panels.enter("chat");
  assert.equal(created, 1, "连点不该建出两个会话");
});

test("侧边对话：新建失败要显示原因，不静默空白", async () => {
  const { createSidePanels } = loadPanels();
  const dom = mkDom();
  const notes = [];
  const panels = createSidePanels({
    dom,
    client: {
      createSession: async () => ({ ok: false, code: "session-create-failed" }),
      panel: nothing, workspaceFiles: nothing, openWorkspacePath: nothing, send: nothing,
    },
    onHome: () => {},
    onNotify: (m) => notes.push(m),
  });
  await panels.enter("chat");
  const text = dom.scStream.children.map((c) => c.textContent).join(" ");
  assert.match(text, /session-create-failed/);
  assert.equal(notes.length, 1);
});

test("侧边对话：发消息空文本不发；有文本才发", async () => {
  const { createSidePanels } = loadPanels();
  const dom = mkDom();
  const sent = [];
  const panels = createSidePanels({
    dom,
    client: {
      createSession: async () => ({ ok: true, sessionId: "s-1" }),
      send: async (t) => { sent.push(t); return { ok: true }; },
      panel: async () => ({ ok: true, messages: [], running: false }),
      workspaceFiles: nothing, openWorkspacePath: nothing,
    },
    onHome: () => {},
  });
  await panels.enter("chat");

  dom.scInput.value = "   ";
  await new Promise((r) => setImmediate(r));
  dom.scSend.click();
  await new Promise((r) => setImmediate(r));
  assert.equal(sent.length, 0, "空文本不该发");

  dom.scInput.value = "你好";
  dom.scSend.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(sent, ["你好"]);
});

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
    focus() {},
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
    Object, Array, String, Promise, Number, URLSearchParams, RegExp, Set, Map,
  };
  sandbox.window.document = {
    createElement: () => fakeEl(),
    getElementById: () => fakeEl(),
  };
  sandbox.window.setInterval = () => 1;
  sandbox.window.clearInterval = () => {};
  sandbox.window.console = sandbox.console;
  createContext(sandbox);

  /*
   * 加载顺序与 side.html 一致：分类规则 → 文件面板 → 面板装配。
   * `file-preview.cjs` 是双端导出（见该文件末尾），所以在沙箱里也会挂到 window 上。
   */
  for (const rel of [
    ["whale-window", "lib", "file-preview.cjs"],
    ["whale-window", "renderer", "side-files.js"],
    ["whale-window", "renderer", "side-panels.js"],
  ]) {
    const file = join(ROOT, ...rel);
    runInContext(readFileSync(file, "utf8"), sandbox, { filename: rel[rel.length - 1] });
  }
  return {
    WhaleSidePanels: sandbox.window.WhaleSidePanels,
    WhaleFilePreview: sandbox.window.WhaleFilePreview,
    WhaleSideFiles: sandbox.window.WhaleSideFiles,
  };
}

const nothing = async () => ({ ok: true, entries: [], messages: [] });

/** 一个什么都不做的客户端桩（只为让面板构造成功）。 */
const inertClient = {
  workspaceFiles: nothing,
  panel: nothing,
  openWorkspacePath: nothing,
  readWorkspaceFile: nothing,
  send: nothing,
  createSession: nothing,
  sessionList: async () => ({ ok: true, sessions: [] }),
};

function mkDom() {
  const ids = [
    "sHome", "sbTitle", "sClose", "sBrowser", "sFiles", "sChat",
    "sbBack", "sbUrl", "sbGo", "sbWeb", "sfBack", "sfCrumb", "sfCount", "sfBody",
    "scBack", "scTitle", "scState", "scInherit", "scStream", "scInput", "scSend",
  ];
  const dom = {};
  for (const id of ids) dom[id] = fakeEl();
  return dom;
}

test("normalizeUrl：缺协议时按 https 补", () => {
  const { WhaleSidePanels: { normalizeUrl } } = loadPanels();
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("  example.com/a  "), "https://example.com/a");
});

test("normalizeUrl：已有协议原样保留", () => {
  const { WhaleSidePanels: { normalizeUrl } } = loadPanels();
  assert.equal(normalizeUrl("http://a.com"), "http://a.com");
  assert.equal(normalizeUrl("https://a.com/x"), "https://a.com/x");
});

test("normalizeUrl：about/data/file 这类也放行（不带 //）", () => {
  const { WhaleSidePanels: { normalizeUrl } } = loadPanels();
  assert.equal(normalizeUrl("about:blank"), "about:blank");
  assert.equal(normalizeUrl("file:///C:/x.html"), "file:///C:/x.html");
});

test("normalizeUrl：空输入给空串（调用方据此提示，而不是打开某个默认站点）", () => {
  const { WhaleSidePanels: { normalizeUrl } } = loadPanels();
  assert.equal(normalizeUrl(""), "");
  assert.equal(normalizeUrl("   "), "");
  assert.equal(normalizeUrl(null), "");
});

test("浏览器：点「打开」把地址设到 webview 的 src", async () => {
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
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
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
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
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
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
  const text = dom.sfBody.children.map((c) => c.textContent).join(" ");
  assert.match(text, /not-found/, "要显示失败原因");
});

test("侧边对话：进入时**新建一个真会话**，再拉它的面板", async () => {
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
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
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
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

test("浏览器：首页默认百度（webview 的 src 与地址栏一致）", async () => {
  /*
   * 用户要求「侧边栏浏览器首页默认百度」。
   *
   * ⚠️ 这个地址**同时**写在两处：`side.html` 的 webview `src`（决定
   * 「点开就有内容」）与本模块的 HOME_URL（把地址栏补上）。两处必须一致，
   * 否则用户会看到「地址栏空着、内容却是百度」这种别扭状态。
   */
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
  const dom = mkDom();
  const panels = createSidePanels({ dom, client: inertClient, onHome: () => {} });

  await panels.enter("browser");
  assert.match(dom.sbUrl.value, /baidu\.com/, "地址栏要补上默认首页");

  // HTML 里的 src 也要是同一个地址
  const html = readFileSync(join(ROOT, "whale-window", "renderer", "side.html"), "utf8");
  const src = /id="sbWeb"\s+src="([^"]+)"/.exec(html);
  assert.ok(src !== null, "side.html 里 webview 应带 src");
  assert.match(src[1], /baidu\.com/, "webview 的默认首页也要是百度");
});

test("浏览器：地址栏已有内容时不覆盖（用户输过的留着）", async () => {
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
  const dom = mkDom();
  dom.sbUrl.value = "https://example.com";
  const panels = createSidePanels({ dom, client: inertClient, onHome: () => {} });
  await panels.enter("browser");
  assert.equal(dom.sbUrl.value, "https://example.com", "不该把用户输的地址顶掉");
});

test("继承下拉：**归档会话不能出现**（用户报「很多已归档的不存在的会话」）", async () => {
  /*
   * 实测桥的清单 15 条里 **9 条是 `archived: true`** —— 它们已经没有可继承的
   * 上下文，列出来只会让用户挑到死会话。
   *
   * ⚠️ 这条也顺带钉住「`archived` 字段真的从桥传到了渲染层」：
   * 早先 `side-bridge.js` 的 sessionList **根本没带这个字段**，
   * 于是过滤条件永远拿不到 true、形同虚设。
   */
  const { WhaleSidePanels: { createSidePanels }, WhaleFilePreview: preview } = loadPanels();
  const dom = mkDom();
  const panels = createSidePanels({
    dom,
    preview,
    currentSessionId: () => "s-live",
    client: {
      createSession: async () => ({ ok: true, sessionId: "s-new" }),
      panel: async () => ({ ok: true, messages: [], running: false }),
      sessionList: async () => ({
        ok: true,
        sessions: [
          { sessionId: "s-live", title: "在用的", workspaceTitle: "ws", archived: false },
          { sessionId: "s-arch1", title: "已归档甲", workspaceTitle: "ws", archived: true },
          { sessionId: "s-arch2", title: "已归档乙", workspaceTitle: "ws", archived: true },
          { sessionId: "s-other", title: "另一个", workspaceTitle: "ws2", archived: false },
        ],
      }),
      workspaceFiles: nothing, openWorkspacePath: nothing, readWorkspaceFile: nothing, send: nothing,
    },
    onHome: () => {},
  });

  await panels.enter("chat");
  await new Promise((r) => setImmediate(r));

  const values = dom.scInherit.children.map((c) => c.value);
  assert.deepEqual(values, ["s-live", "s-other"], `归档的必须被滤掉，实际：${JSON.stringify(values)}`);
});

test("继承下拉：当前会话恰好是归档时仍保留（它是默认项兜底）", async () => {
  const { WhaleSidePanels: { createSidePanels }, WhaleFilePreview: preview } = loadPanels();
  const dom = mkDom();
  const panels = createSidePanels({
    dom,
    preview,
    currentSessionId: () => "s-arch",
    client: {
      createSession: async () => ({ ok: true, sessionId: "s-new" }),
      panel: async () => ({ ok: true, messages: [], running: false }),
      sessionList: async () => ({
        ok: true,
        sessions: [{ sessionId: "s-arch", title: "当前（已归档）", workspaceTitle: "ws", archived: true }],
      }),
      workspaceFiles: nothing, openWorkspacePath: nothing, readWorkspaceFile: nothing, send: nothing,
    },
    onHome: () => {},
  });

  await panels.enter("chat");
  await new Promise((r) => setImmediate(r));

  const values = dom.scInherit.children.map((c) => c.value);
  assert.ok(values.includes("s-arch"), "当前会话即便归档也要留着当默认项");
});

test("文件区：桥说 bad-request 时给**人话**，不是甩一个 code", async () => {
  /*
   * 用户报「文件区域读不到当前工作区」时，界面显示的是
   * 「读不到这个目录：bad-request」—— 那串 code 对用户毫无意义，
   * 也让人判断不出是「会话没选上」还是「桥挂了」。
   */
  const {
    WhaleSidePanels: { createSidePanels },
    WhaleFilePreview: preview,
    WhaleSideFiles: { explainCode },
  } = loadPanels();
  const dom = mkDom();
  const panels = createSidePanels({
    dom,
    preview,
    client: {
      workspaceFiles: async () => ({ ok: false, code: "bad-request" }),
      panel: nothing, openWorkspacePath: nothing, readWorkspaceFile: nothing,
      send: nothing, createSession: nothing, sessionList: async () => ({ ok: true, sessions: [] }),
    },
    onHome: () => {},
  });
  await panels.enter("files");
  const text = dom.sfBody.children.map((c) => c.textContent).join(" ");
  assert.match(text, /还没拿到当前会话/, "要说清楚是什么情况");
  assert.match(text, /bad-request/, "code 保留，便于排查");
  assert.ok(explainCode("bad-request").length > "bad-request".length, "不能只回一个 code");
});

test("文件区：点「返回」必须回到侧边栏首页", async () => {
  /*
   * ⚠️ 用户报「侧边栏文件区，点返回回不到侧边栏首页」——
   * 根因是拆出文件面板时**漏传了 `onHome` 依赖**：
   * `side-files.js` 里调 `deps.onHome(...)` 时它是 undefined，直接抛错、
   * 什么都不发生（而且启动时不报错，只在点下去那一刻才暴露）。
   *
   * 这条测试专门钉住「依赖真的传到位、点下去真的会回调」——
   * 光测「函数存在」拦不住这类漏传。
   */
  const { WhaleSidePanels: { createSidePanels }, WhaleFilePreview: preview } = loadPanels();
  const dom = mkDom();
  const homes = [];
  const panels = createSidePanels({
    dom,
    preview,
    client: {
      workspaceFiles: async (dir) => ({
        ok: true,
        dir,
        entries: [{ path: "docs", name: "docs", kind: "directory" }],
      }),
      panel: nothing, openWorkspacePath: nothing, readWorkspaceFile: nothing,
      send: nothing, createSession: nothing, sessionList: async () => ({ ok: true, sessions: [] }),
    },
    onHome: (name) => homes.push(name),
  });

  await panels.enter("files");
  // 在**列表层**（没点进任何文件）点返回 → 应回首页
  dom.sfBack.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(homes, ["files"], "点返回要回调 onHome，否则用户看到的是一动不动");
});

test("文件区：看文件时点返回先回列表，再点才回首页（一层层退）", async () => {
  const { WhaleSidePanels: { createSidePanels }, WhaleFilePreview: preview } = loadPanels();
  const dom = mkDom();
  const homes = [];
  const panels = createSidePanels({
    dom,
    // 分类函数也要注入：漏传它的表现是「一点列表就抛 previewModeOf」
    preview,
    client: {
      workspaceFiles: async (dir) => ({
        ok: true,
        dir,
        entries: [{ path: "a.md", name: "a.md", kind: "file" }],
      }),
      readWorkspaceFile: async () => ({ ok: true, text: "# hi", size: 4 }),
      panel: nothing, openWorkspacePath: nothing,
      send: nothing, createSession: nothing, sessionList: async () => ({ ok: true, sessions: [] }),
    },
    onHome: (name) => homes.push(name),
  });

  await panels.enter("files");
  // 点进文件（预览）
  dom.sfBody.children[0].click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(homes, [], "看文件时不该直接回首页");

  dom.sfBack.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(homes, [], "第一下返回：回列表（还没到首页）");

  dom.sfBack.click();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(homes, ["files"], "第二下返回：回首页");
});

test("侧边对话：新建失败要显示原因，不静默空白", async () => {
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
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
  const { WhaleSidePanels: { createSidePanels } } = loadPanels();
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

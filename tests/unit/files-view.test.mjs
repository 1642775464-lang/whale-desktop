/**
 * 工作区文件列表页面
 *
 * 职责：钉住「点目录下钻 / 点文件调用打开 / 面包屑 / 读不到要说明原因」。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得测（而不是只靠真窗口）：下钻的路径拼接与「读不到 vs 空目录」
 * 的区分都是纯逻辑，错一处的表现都是「界面空着」——真窗口一眼看不出
 * 是「目录真的空」还是「路径拼错了」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 造一个够用的假 DOM（files-view 只用到这几个方法）。 */
function fakeEl() {
  const children = [];
  const el = {
    hidden: true,
    textContent: "",
    title: "",
    className: "",
    children,
    listeners: {},
    appendChild(c) { children.push(c); },
    addEventListener(ev, fn) { this.listeners[ev] = fn; },
    /** 直接触发注册的点击处理器（模拟用户点击这一行）。 */
    click() { if (this.listeners.click) this.listeners.click(); },
  };
  /*
   * ⚠️ `innerHTML = ""` 必须真的清空子节点。
   * 不实现它的话「先清空再重建」的元素会累积 —— 面包屑会越渲染越长，
   * 而那看起来像产品 bug（我这轮就被自己的替身骗过一次）。
   */
  Object.defineProperty(el, "innerHTML", {
    get() { return ""; },
    set(v) { if (v === "") children.length = 0; },
  });
  return el;
}

function load() {
  const sandbox = {
    window: {},
    console: { warn: () => {} },
    Object, Array, String, Promise, encodeURIComponent,
  };
  sandbox.window.document = {
    createElement: () => fakeEl(),
  };
  // files-view 用的是 `global.console.warn`（global 即 sandbox.window）
  sandbox.window.console = sandbox.console;
  createContext(sandbox);
  runInContext(
    readFileSync(join(ROOT, "whale-window", "renderer", "files-view.js"), "utf8"),
    sandbox,
    { filename: "files-view.js" },
  );
  return sandbox.window.WhaleFilesView;
}

function setup(fetchFiles, openPath, onNotify) {
  const { createFilesView } = load();
  const dom = {
    view: fakeEl(),
    fvBack: fakeEl(),
    fvCrumb: fakeEl(),
    fvCount: fakeEl(),
    fvList: fakeEl(),
  };
  let back = 0;
  const view = createFilesView({
    dom,
    fetchFiles,
    openPath: openPath ?? (async () => ({ ok: true })),
    onBack: () => { back += 1; },
    onNotify,
  });
  return { backCalls: () => back, dom, view };
}

const ROOT_ENTRIES = [
  { path: "docs", name: "docs", kind: "directory" },
  { path: "package.json", name: "package.json", kind: "file" },
];

test("show：从工作区根开始，列出来并渲染", async () => {
  const seen = [];
  const { dom, view } = setup(async (dir) => {
    seen.push(dir);
    return { ok: true, dir, entries: ROOT_ENTRIES };
  });

  await view.show();
  assert.deepEqual(seen, [""], "进入页面先列根目录");
  assert.equal(dom.view.hidden, false);
  assert.equal(dom.fvCount.textContent, "2");
});

test("点目录：下钻到该目录（路径带结尾斜杠）", async () => {
  /*
   * ⚠️ 目录前缀必须带结尾斜杠 —— 宿主的匹配口径是按前缀，
   * 少了斜杠会列出同级同前缀的条目（或空），而这是**静默**的。
   */
  const seen = [];
  const { dom, view } = setup(async (dir) => {
    seen.push(dir);
    if (dir === "") return { ok: true, dir: "", entries: ROOT_ENTRIES };
    return { ok: true, dir, entries: [{ path: "docs/a.md", name: "a.md", kind: "file" }] };
  });

  await view.show();
  // 第一行就是目录 docs
  dom.fvList.children[0].click();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(seen, ["", "docs/"], "下钻要传带斜杠的目录前缀");
});

test("点文件：调用 openPath（用系统默认程序打开）", async () => {
  const opened = [];
  const { dom, view } = setup(
    async () => ({ ok: true, dir: "", entries: ROOT_ENTRIES }),
    async (path) => { opened.push(path); return { ok: true }; },
  );

  await view.show();
  // 目录在前，所以第二行是文件 package.json
  dom.fvList.children[1].click();
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(opened, ["package.json"], "点文件要请求打开它");
});

test("打开失败：如实提示，不静默", async () => {
  const notes = [];
  const { dom, view } = setup(
    async () => ({ ok: true, dir: "", entries: ROOT_ENTRIES }),
    async () => ({ ok: false, code: "session-not-ready" }),
    (m) => notes.push(m),
  );

  await view.show();
  dom.fvList.children[1].click();
  await new Promise((r) => setImmediate(r));

  assert.equal(notes.length, 1, "失败必须有提示");
  assert.match(notes[0], /session-not-ready/);
});

test("读不到目录：显示原因，不显示「这个目录是空的」", async () => {
  /*
   * ⚠️ 「读不到」与「目录是空的」含义完全不同 —— 混成一个会让用户
   * 以为工作区里真的什么都没有。
   */
  const notes = [];
  const { dom, view } = setup(async () => ({ ok: false, code: "session-not-found" }), null, (m) => notes.push(m));

  await view.show();
  const text = dom.fvList.children.map((c) => c.textContent).join(" ");
  assert.match(text, /session-not-found/, "要显示失败原因");
  assert.doesNotMatch(text, /这个目录是空的/, "不能冒充空目录");
  assert.equal(notes.length, 1);
});

test("宿主说「没有活 agent」：显示它给的原因，不当成空目录", async () => {
  const { dom, view } = setup(async () => ({
    ok: true,
    dir: "",
    entries: [],
    reason: "该会话当前没有活跃 agent，读不到工作区文件",
  }));

  await view.show();
  const text = dom.fvList.children.map((c) => c.textContent).join(" ");
  assert.match(text, /没有活跃 agent/, "如实转述宿主给的原因");
  assert.doesNotMatch(text, /这个目录是空的/);
});

test("真的空目录：才显示「这个目录是空的」", async () => {
  const { dom, view } = setup(async () => ({ ok: true, dir: "", entries: [] }));
  await view.show();
  const text = dom.fvList.children.map((c) => c.textContent).join(" ");
  assert.match(text, /这个目录是空的/);
});

test("面包屑：根 + 各级，可点段回上级", async () => {
  const seen = [];
  const { dom, view } = setup(async (dir) => {
    seen.push(dir);
    if (dir === "") return { ok: true, dir: "", entries: ROOT_ENTRIES };
    if (dir === "docs/") {
      return { ok: true, dir, entries: [{ path: "docs/sub", name: "sub", kind: "directory" }] };
    }
    return { ok: true, dir, entries: [] };
  });

  await view.show();
  await view.gotoDir("docs/sub/");

  // 面包屑应为：工作区 / docs / sub
  const segs = dom.fvCrumb.children.filter((c) => c.className.includes("fv-crumb-seg"));
  assert.deepEqual(segs.map((c) => c.textContent), ["工作区", "docs", "sub"]);
  // 点「工作区」回到根
  dom.fvCrumb.children.filter((c) => c.className.includes("fv-crumb-seg"))[0].click();
  await new Promise((r) => setImmediate(r));
  assert.equal(seen[seen.length - 1], "", "点面包屑根要回根目录");
});

test("返回按钮：隐藏页面并回调", async () => {
  const { backCalls, dom, view } = setup(async () => ({ ok: true, dir: "", entries: [] }));
  await view.show();
  dom.fvBack.click();
  assert.equal(backCalls(), 1);
  assert.equal(view.isVisible(), false);
  assert.equal(dom.view.hidden, true);
});

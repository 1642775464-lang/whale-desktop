/**
 * 小窗 ＋ 浮层必须和主窗口对齐（切片 7 第四批）
 *
 * 职责：钉住「＋ 浮层 = 文件(@引用) + 上传 + 指令(宿主真命令表)」这个结构。
 * 所属层：测试（tests/unit）
 *
 * 用户报：「小窗的对话框的＋号交互内容和主窗口的没有对齐」。
 * 主窗口的＋号是一份**分组菜单**：文件 / 目标 / 计划 / 反馈 /（指令组）
 * 压缩 / 权限 / 模型 / 下载日志 / 旁问 / mnemon。
 * 而小窗原先只有一个拖拽上传区，差了一大截。
 *
 * 两条硬要求（用户明确裁定）：
 *   1. ＋ 浮层必须包含宿主指令列表
 *   2. 「文件」也要做，按 A：搜索 → 选中后在输入框插入 `@路径` **待发送**
 *      （与主窗口 @ 语义一致，也不会误发消息）
 *
 * 指令列表走 `/whale/commands` 的**真命令表**——不硬编码任何一条，
 * 宿主加了命令会自动出现（这是本项目「以宿主为准」的一贯要求）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RENDERER = join(ROOT, "whale-window", "renderer");

/** 最小元素替身（含能真正触发的事件监听）。 */
function el() {
  const handlers = new Map();
  const node = {
    textContent: "", className: "", hidden: false, value: "", style: {},
    children: [], dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {}, removeAttribute() {}, appendChild(c) { this.children.push(c); },
    querySelectorAll: () => [], remove() {}, focus() {},
    /**
     * 记录监听器而不是丢掉。
     *
     * ⚠️ 早先这里是个空函数，于是测试里怎么点都不会触发产品挂的 handler，
     * 表现为「候选/指令一个都没渲染」，而断言只会说「要列出候选文件」——
     * 完全指不出是替身没接事件。替身的能力必须覆盖产品真实用到的那部分。
     */
    addEventListener(type, fn) {
      if (!handlers.has(type)) handlers.set(type, []);
      handlers.get(type).push(fn);
    },
    /** 测试用：触发一次点击。 */
    click() {
      for (const fn of handlers.get("click") ?? []) fn({ preventDefault() {}, target: node });
    },
  };
  return node;
}

/** 造一份够用的假 DOM。 */
function fakeDom() {
  const dom = {};
  for (const id of ["overlay", "ovTitle", "ovBody", "ovClose", "uplList", "input"]) {
    dom[id] = el();
  }
  dom.__document = { createElement: () => el(), createTextNode: () => el() };
  return dom;
}

/** 在沙箱里加载 overlays.js。 */
function loadOverlays(deps) {
  const dom = fakeDom();
  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.Array = Array; w.Object = Object; w.String = String; w.Number = Number;
  w.JSON = JSON; w.Promise = Promise; w.Math = Math;
  w.console = sandbox.console;
  w.document = dom.__document;
  createContext(sandbox);
  // ＋ 菜单已按业务域拆成独立模块（overlays.js 装不下它了）
  runInContext(readFileSync(join(RENDERER, "add-menu.js"), "utf8"), sandbox, {
    filename: "add-menu.js",
  });

  const client = {
    listCommands: async () => [
      { name: "btw", description: "根据当前上下文回答，不执行工具", hint: "旁问内容" },
      { name: "compact", description: "Compact older conversation history", hint: "" },
      { name: "export", description: "Download this Session log as a ZIP archive", hint: "" },
      { name: "feedback", description: "Record feedback about this session", hint: "<text>" },
      { name: "goal", description: "Set or view the goal", hint: "" },
      { name: "mnemon", description: "查看、召回或管理 Mnemon 外置记忆", hint: "" },
      { name: "permission", description: "Switch the permission preset", hint: "<preset>" },
      { name: "plan", description: "Enter or leave plan mode", hint: "" },
    ],
    fileReferences: async () => [
      { path: "src/app.js", kind: "file" },
      { path: "docs/", kind: "directory" },
    ],
  };

  // 行的渲染由 overlays 提供（同一套两栏行，视觉才一致）；测试里用等价替身
  function makeRow(label, desc, value, opts) {
    const node = el();
    node.className = "ov-row";
    const name = el();
    name.textContent = label;
    node.appendChild(name);
    if (desc) { const d = el(); d.className = "v"; d.textContent = desc; node.appendChild(d); }
    if (opts && typeof opts.onClick === "function") node.addEventListener("click", opts.onClick);
    return node;
  }
  function makeNote(text) {
    const node = el();
    node.className = "ov-empty";
    node.textContent = text;
    return node;
  }

  let openName = "add";
  const api = sandbox.window.WhaleAddMenu.createAddMenu({
    dom,
    clientOf: () => client,
    currentOf: () => openName,
    insertIntoInput: deps?.onInsertText ?? (() => {}),
    onFiles: deps?.onFiles ?? (() => {}),
    onPickFiles: deps?.onPickFiles ?? (() => {}),
    close: () => { openName = null; },
    row: makeRow,
    note: makeNote,
  });
  return { dom, api, client };
}

/** 读出浮层里所有的行（按 .ov-row 类名）。 */
function rowsOf(dom) {
  const walk = (node, out = []) => {
    for (const child of node.children ?? []) {
      if (child.className === "ov-row" || String(child.className).startsWith("ov-row")) {
        out.push(child);
      }
      walk(child, out);
    }
    return out;
  };
  return walk(dom.ovBody);
}

/** 所有行的可见文字。 */
function textsOf(dom) {
  return rowsOf(dom).map((r) => (r.children ?? []).map((c) => c.textContent).join(" "));
}

test("＋ 浮层要列出宿主的指令（走真命令表，不硬编码）", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  const text = textsOf(dom).join(" | ");
  for (const name of ["btw", "compact", "export", "feedback", "goal", "mnemon", "permission", "plan"]) {
    assert.ok(text.includes(name), `指令 ${name} 必须出现在＋浮层里（实际：${text}）`);
  }
});

test("＋ 浮层要有「文件」项（主窗口菜单里的 @ 引用）", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  const text = textsOf(dom).join(" | ");
  assert.ok(text.includes("文件"), `＋浮层要有「文件」这一项（实际：${text}）`);
});

test("点「文件」进入搜索：列出候选，且**插入 @路径 而不是发送**", async () => {
  let inserted = null;
  const { dom, api } = loadOverlays({ onInsertText: (t) => { inserted = t; } });
  await api.renderAdd();

  // 找到「文件」那一行并点击
  const fileRow = rowsOf(dom).find((r) => (r.children ?? []).some((c) => c.textContent === "文件"));
  assert.ok(fileRow !== undefined, "要能找到「文件」这一行");
  fileRow.click();
  await new Promise((r) => setTimeout(r, 30)); // 等 renderFileSearch 拉完候选

  // 选中第一条候选
  const candidateRow = rowsOf(dom).find((r) => (r.children ?? []).some((c) => c.textContent === "src/app.js"));
  assert.ok(candidateRow !== undefined, "要列出候选文件");
  candidateRow.click();

  assert.equal(inserted, "@src/app.js", "选中后插入 @路径（待发送），不是直接发送");
});

test("上传入口仍在（拖拽区不能因为加了菜单就丢掉）", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();
  const hasDrop = (dom.ovBody.children ?? []).some((c) => c.className === "upl-drop");
  assert.ok(hasDrop, "拖拽上传区必须保留");
});

test("指令点一下是**插进输入框**而不是立即执行（与主窗口一致）", async () => {
  let inserted = null;
  const { dom, api } = loadOverlays({ onInsertText: (t) => { inserted = t; } });
  await api.renderAdd();

  const row = rowsOf(dom).find((r) => (r.children ?? []).some((c) => c.textContent === "compact"));
  assert.ok(row !== undefined, "要能找到 compact 这一行");
  row.click();

  assert.equal(inserted, "/compact", "点指令应把 /命令 插进输入框，由用户补参数再发送");
});

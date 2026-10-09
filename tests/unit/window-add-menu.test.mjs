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

/** 在沙箱里加载 add-menu.js（及其依赖 menu-icons.js）。 */
function loadOverlays(deps) {
  const dom = fakeDom();
  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.Array = Array; w.Object = Object; w.String = String; w.Number = Number;
  w.JSON = JSON; w.Promise = Promise; w.Math = Math;
  w.console = sandbox.console;
  w.document = dom.__document;
  createContext(sandbox);
  /**
   * 脚本清单必须与真实 index.html 一致。
   *
   * ⚠️ 环境坑：拆文件后沙箱漏加载某个脚本，会让被测模块「功能静默少一半」，
   * 而报错只会说「某项没渲染」，指不出是沙箱没加载。
   * add-menu.js 依赖 menu-icons.js（图标与分组表都在那里），
   * 真实页面在它之前加载，这里就必须同样先加载。
   */
  runInContext(readFileSync(join(RENDERER, "menu-icons.js"), "utf8"), sandbox, {
    filename: "menu-icons.js",
  });
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

  // 行的渲染由 overlays 提供（同一套两栏行，视觉才一致）；测试里用等价替身。
  // 替身必须覆盖产品真实用到的能力，包括 `opts.icon`（图标走 innerHTML）——
  // 否则「图标没渲染」这类回归在测试里根本看不见。
  function makeRow(label, desc, value, opts) {
    const node = el();
    node.className = "ov-row";
    if (opts && typeof opts.icon === "string" && opts.icon !== "") {
      node.className = "ov-row has-ico";
      const ico = el();
      ico.className = "ico";
      ico.innerHTML = opts.icon;
      node.appendChild(ico);
    }
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

  // ⚠️ 内置命令（goal/plan/feedback/compact/permission/export）显示的是
  // 主窗口的**中文标题**，不是命令名 —— 所以按标题找。
  // 未列进主窗口分组的宿主命令（btw / mnemon）保留命令名。
  const text = textsOf(dom).join(" | ");
  for (const label of ["目标", "计划", "反馈", "压缩", "权限", "下载日志"]) {
    assert.ok(text.includes(label), `指令「${label}」必须出现在＋浮层里（实际：${text}）`);
  }
  for (const name of ["btw", "mnemon"]) {
    assert.ok(text.includes(name), `宿主命令 ${name} 必须出现在＋浮层里（实际：${text}）`);
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

  // 「压缩」是 compact 的主窗口中文标题
  const row = rowsOf(dom).find((r) => labelOf(r) === "压缩");
  assert.ok(row !== undefined, "要能找到「压缩」这一行");
  row.click();

  assert.equal(inserted, "/compact", "点指令应把 /命令 插进输入框，由用户补参数再发送");
});

// ─────────────────────────────────────────────────────────────
// 用户报：「小窗输入框里目标/计划这两个还是缺失的，而且也没有图标」
// ─────────────────────────────────────────────────────────────

/** 浮层里所有的分组标题文字。 */
function groupsOf(dom) {
  return (dom.ovBody.children ?? [])
    .filter((c) => c.className === "ov-group")
    .map((c) => c.textContent);
}

/** 某一行的标签（第一栏 span 的文字，跳过图标容器）。 */
function labelOf(row) {
  const spans = (row.children ?? []).filter((c) => c.className !== "ico");
  return spans.length > 0 ? spans[0].textContent : "";
}

test("＋菜单分「添加」「指令」两组，行序与主窗口一致", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  assert.deepEqual(groupsOf(dom), ["添加", "指令"], "分组标题必须是 添加 / 指令");

  const labels = rowsOf(dom).map(labelOf);
  // 「添加」组的四行必须在「指令」组之前
  const iGoal = labels.indexOf("目标");
  const iPlan = labels.indexOf("计划");
  const iCompact = labels.indexOf("压缩");
  assert.ok(iGoal !== -1, `缺「目标」行（实际：${labels.join(" / ")}）`);
  assert.ok(iPlan !== -1, `缺「计划」行（实际：${labels.join(" / ")}）`);
  assert.ok(iGoal < iCompact, "「目标」必须在「指令」组之前");
  assert.ok(iPlan < iCompact, "「计划」必须在「指令」组之前");
});

test("「目标」「计划」「反馈」显示的是主窗口的中文标题与中文说明", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  const rows = rowsOf(dom);
  const find = (label) => rows.find((r) => labelOf(r) === label);

  const goal = find("目标");
  assert.ok(goal !== undefined, "缺「目标」行");
  assert.ok(
    (goal.children ?? []).some((c) => c.textContent === "设置或查看长期任务目标"),
    "「目标」的说明要显示主窗口的中文说明",
  );

  const plan = find("计划");
  assert.ok(plan !== undefined, "缺「计划」行");
  assert.ok(
    (plan.children ?? []).some((c) => c.textContent === "进入或退出计划模式"),
    "「计划」的说明要显示主窗口的中文说明",
  );

  const feedback = find("反馈");
  assert.ok(feedback !== undefined, "缺「反馈」行");
  assert.ok(
    (feedback.children ?? []).some((c) => c.textContent === "发送关于当前会话的反馈"),
    "「反馈」的说明要显示主窗口的中文说明",
  );
});

test("菜单行真的带上了图标（不是只有文字）", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  const rows = rowsOf(dom);
  const find = (label) => rows.find((r) => labelOf(r) === label);

  for (const label of ["文件", "目标", "计划", "反馈", "压缩", "权限", "下载日志"]) {
    const r = find(label);
    assert.ok(r !== undefined, `缺「${label}」行`);
    const ico = (r.children ?? []).find((c) => c.className === "ico");
    assert.ok(ico !== undefined, `「${label}」行没有图标容器`);
    assert.match(String(ico.innerHTML), /^<svg\b/, `「${label}」的图标不是 svg`);
    assert.match(String(ico.innerHTML), /viewBox="0 0 16 16"/, `「${label}」的 viewBox 不对`);
  }
});

test("「模型」行也带图标与主窗口文案（它不在宿主命令表里，但仍要齐）", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  const row = rowsOf(dom).find((r) => labelOf(r) === "模型");
  assert.ok(row !== undefined, "缺「模型」行");

  const ico = (row.children ?? []).find((c) => c.className === "ico");
  assert.ok(ico !== undefined, "「模型」行没有图标");
  assert.match(String(ico.innerHTML), /stroke-miterlimit="10"/, "「模型」的图标不该丢属性");

  const desc = (row.children ?? []).find((c) => c.className === "v");
  assert.equal(desc?.textContent, "选择本会话使用的模型", "「模型」的说明要显示主窗口文案");
});

test("宿主新增的命令会自动落在「指令」组末尾（不硬编码）", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  const labels = rowsOf(dom).map(labelOf);
  // btw / mnemon 不在主窗口那两个分组里，必须仍然出现（收在指令组末尾）
  assert.ok(labels.includes("btw"), `宿主命令 btw 必须出现（实际：${labels.join(" / ")}）`);
  assert.ok(labels.includes("mnemon"), `宿主命令 mnemon 必须出现（实际：${labels.join(" / ")}）`);
  const iCompact = labels.indexOf("压缩");
  assert.ok(labels.indexOf("btw") > iCompact, "未列出的命令要排在「指令」组末尾");
});

test("点「目标」也是插进输入框待发送（不是立即进计划模式）", async () => {
  let inserted = null;
  const { dom, api } = loadOverlays({ onInsertText: (t) => { inserted = t; } });
  await api.renderAdd();

  const rows = rowsOf(dom);
  const goal = rows.find((r) => labelOf(r) === "目标");
  assert.ok(goal !== undefined, "缺「目标」行");
  goal.click();

  assert.equal(inserted, "/goal", "点「目标」应把 /goal 插进输入框，等用户补目标再发");
});

test("内置命令的说明不拼 hint（与主窗口文案逐字一致）", async () => {
  const { dom, api } = loadOverlays();
  await api.renderAdd();

  const rows = rowsOf(dom);
  const descOf = (label) => {
    const r = rows.find((x) => labelOf(x) === label);
    const v = (r?.children ?? []).find((c) => c.className === "v");
    return v?.textContent ?? "";
  };

  // 宿主给的 hint 是 <text> / <preset>，主窗口不显示它们
  assert.equal(descOf("反馈"), "发送关于当前会话的反馈", "「反馈」的说明不该带（<text>）");
  assert.equal(
    descOf("权限"),
    "切换权限预设（沙箱模式与审批策略）",
    "「权限」的说明不该带（<preset>）",
  );

  // 未列进主窗口分组的宿主命令仍要带 hint —— 那是用户唯一能知道要填什么的来源
  assert.match(descOf("btw"), /（旁问内容）/, "btw 这类没有中文说明的命令要保留 hint");
});

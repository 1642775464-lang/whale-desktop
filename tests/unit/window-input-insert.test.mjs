/**
 * 往输入框插入文本的行为测试
 *
 * 职责：钉住「插入后必须让监听者知道内容变了」这件事。
 * 所属层：测试（tests/unit）
 *
 * 用户报：「/后的指令点击没有用，并不会出现在输入框内」。
 *
 * 排查结论（真窗口探针取证）：文字其实**进去了**，但程序化赋值不会触发
 * `input` 事件，而斜杠命令面板靠 `input` 事件同步候选 —— 于是点了 ＋菜单里的
 * 「压缩」，输入框有了 `/compact` 却什么都不弹，手感就是「点了没用」。
 * 手动打 `/` 时面板会弹，两条路的行为不一致。
 *
 * 为什么之前 665 条测试拦不住：这条逻辑内联在 app.js 的装配函数里，
 * 而旧断言只检查「insertIntoInput 被调用、收到 /compact」——
 * **从没断言事件是否发出**。替身层断言不出装配层的漏派发。
 * 所以这条逻辑抽成 input-insert.js，并由本文件按**事件**而非调用来验证。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const RENDERER = join(ROOT, "whale-window", "renderer");

/**
 * 造一个会**真的派发事件**的输入框替身。
 *
 * ⚠️ 替身的能力必须覆盖产品真实用到的那部分：如果 `dispatchEvent` 是空函数，
 * 「有没有派发」就永远测不出来，而这正是本条要守的东西。
 * 占位提示走 attributes，也要真存真取。
 */
function makeInput(initial = "", placeholder = "问点什么…") {
  const listeners = new Map();
  const attrs = new Map([["placeholder", placeholder]]);
  return {
    value: initial,
    focused: false,
    dispatched: [],
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatchEvent(ev) {
      this.dispatched.push(ev.type);
      for (const fn of listeners.get(ev.type) ?? []) fn(ev);
      return true;
    },
    setAttribute(name, v) { attrs.set(name, v); },
    getAttribute(name) { return attrs.has(name) ? attrs.get(name) : null; },
    focus() { this.focused = true; },
  };
}

/** 在沙箱里加载 input-insert.js。 */
function load() {
  const sandbox = { window: {}, console: { warn: () => {}, log: () => {} } };
  const w = sandbox.window;
  w.Event = class Event {
    constructor(type, opts) { this.type = type; this.bubbles = Boolean(opts?.bubbles); }
  };
  w.console = sandbox.console;
  createContext(sandbox);
  runInContext(readFileSync(join(RENDERER, "input-insert.js"), "utf8"), sandbox, {
    filename: "input-insert.js",
  });
  return sandbox.window.WhaleInputInsert;
}

test("插入后文字真的落到输入框里", () => {
  const { insertIntoInput } = load();
  const input = makeInput("");
  const out = insertIntoInput(input, "/compact");
  assert.equal(input.value, "/compact", "输入框里必须有 /compact");
  assert.equal(out, "/compact", "返回值应是插入后的值");
});

test("插入必须派发 input 事件（斜杠面板靠它同步，漏了就是「点了没用」）", () => {
  const { insertIntoInput } = load();
  const input = makeInput("");
  insertIntoInput(input, "/compact");
  assert.deepEqual(
    input.dispatched,
    ["input"],
    "程序化赋值不会自己触发事件，必须补发 input —— 漏了斜杠面板就不弹",
  );
});

test("阴性对照：监听者必须真的被叫到（不是只记录了事件类型）", () => {
  const { insertIntoInput } = load();
  const input = makeInput("");
  let seen = null;
  input.addEventListener("input", () => { seen = input.value; });
  insertIntoInput(input, "/goal");
  assert.equal(seen, "/goal", "监听 input 的部件应当看到新值");
  assert.equal(input.focused, true, "插入后应把焦点给输入框");
});

test("已有内容且不以空白结尾时补一个空格，两者不粘连", () => {
  const { insertIntoInput } = load();
  const input = makeInput("你好");
  insertIntoInput(input, "/compact");
  assert.equal(input.value, "你好 /compact");

  const spaced = makeInput("你好 ");
  insertIntoInput(spaced, "/compact");
  assert.equal(spaced.value, "你好 /compact", "已以空白结尾时不再补空格");
});

test("空串与非字符串不改变输入框，也不派发事件", () => {
  const { insertIntoInput } = load();
  const input = makeInput("abc");
  insertIntoInput(input, "");
  insertIntoInput(input, null);
  insertIntoInput(input, undefined);
  assert.equal(input.value, "abc");
  assert.deepEqual(input.dispatched, [], "没插入就不该惊动监听者");
});

test("输入框缺失时安全返回，不抛错", () => {
  const { insertIntoInput } = load();
  assert.equal(insertIntoInput(null, "/x"), "");
  assert.equal(insertIntoInput(undefined, "/x"), "");
});

// ─────────────────────────────────────────────────────────────
// 参数引导（点「计划」之后要告诉用户接着写什么）
// ─────────────────────────────────────────────────────────────

test("记住输入框原本的占位提示（引导结束后要还原成它）", () => {
  const { rememberPlaceholder } = load();
  const input = makeInput("", "问点什么…");
  assert.equal(rememberPlaceholder(input), "问点什么…");
  assert.equal(rememberPlaceholder(null), "", "输入框缺失时给空串，不抛错");
});

test("有参数声明的命令：把宿主的说明显示成占位提示", () => {
  const { showArgHint } = load();
  // 真实调用顺序：先插入（输入框里就有了 /btw ），再给引导
  const input = makeInput("/btw ");
  showArgHint(input, "旁问内容", "/btw ", "问点什么…");
  assert.equal(input.getAttribute("placeholder"), "接着写：旁问内容");
});

test("没有参数声明的命令：还原默认提示（引导不许黏着）", () => {
  const { showArgHint } = load();
  const input = makeInput("/压缩 ");
  showArgHint(input, "", "/压缩 ", "问点什么…");
  assert.equal(input.getAttribute("placeholder"), "问点什么…");
});

test("用户已经补了参数就不再引导（内容超出刚插入的命令）", () => {
  const { showArgHint } = load();
  const input = makeInput("/btw 这段是用户已经写的旁问");
  showArgHint(input, "旁问内容", "/btw ", "问点什么…");
  assert.equal(
    input.getAttribute("placeholder"),
    "问点什么…",
    "用户已经在写了，不该再提示他该写什么",
  );
});

test("阴性对照：引导必须靠「刚插入的文本」判断，不能只看输入框非空", () => {
  // 这是一段真实死代码的防线：showArgHint 在插入**之后**被调用，
  // 此时输入框必然非空。若实现里判断「输入框非空 → 不引导」，条件恒为真，
  // 引导永远不显示，而测试如果只喂空输入框就会全绿。
  const { showArgHint } = load();
  const input = makeInput("/btw ");
  showArgHint(input, "旁问内容", "/btw ", "问点什么…");
  assert.equal(
    input.getAttribute("placeholder"),
    "接着写：旁问内容",
    "输入框非空（刚插入的命令）时仍然要给出引导",
  );
});

// ─────────────────────────────────────────────────────────────
// 接线：app.js 必须走这个模块，不能自己再写一份
// ─────────────────────────────────────────────────────────────

test("app.js 的 insertIntoInput 走 input-insert.js（不许自己再写一份）", () => {
  const appJs = readFileSync(join(RENDERER, "app.js"), "utf8");
  assert.match(
    appJs,
    /WhaleInputInsert\.insertIntoInput\(dom\.input/,
    "app.js 必须委托给 input-insert.js；自己内联一份就会再次漏发事件",
  );
  // 内联重写的特征：直接给 value 赋值后再自己派发
  assert.doesNotMatch(
    appJs,
    /dom\.input\.value\s*=\s*cur\s*===/,
    "app.js 里不该再有内联的插入实现",
  );
  // 参数引导同理：内联一份会再次踩「条件恒为真」的死代码
  assert.match(
    appJs,
    /WhaleInputInsert\.showArgHint\(dom\.input/,
    "参数引导也必须委托给 input-insert.js",
  );
});

test("index.html 在 app.js 之前加载 input-insert.js", () => {
  const html = readFileSync(join(RENDERER, "index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "");
  const iInsert = html.indexOf("input-insert.js");
  const iApp = html.indexOf("app.js");
  assert.ok(iInsert !== -1, "index.html 没有加载 input-insert.js");
  assert.ok(iInsert < iApp, "input-insert.js 必须在 app.js 之前加载（后者要用它）");
});

test("palette 确实监听输入框的 input 事件（这条链路两端都要在）", () => {
  const appJs = readFileSync(join(RENDERER, "app.js"), "utf8");
  assert.match(
    appJs,
    /dom\.input\.addEventListener\("input"/,
    "app.js 必须把输入框的 input 事件接到 palette.sync()；否则派发也没人听",
  );
});

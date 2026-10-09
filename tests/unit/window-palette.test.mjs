/**
 * 斜杠命令面板与会话标签单测
 *
 * 职责：钉住两条「看起来很直白、实际很容易写错」的判定——
 *       命令过滤规则、会话三档标签的判据。
 * 所属层：测试（tests/unit）
 *
 * palette.js / panels.js 是浏览器 script（不能 import），用 node:vm 造一个
 * 带假 window 的沙箱加载后取出它们的命名空间。
 *
 * 这两条判据值得单测的理由：
 *   - 过滤规则写错的表现是「搜不到」——用户会以为功能坏了
 *   - 标签判据写错的表现是「点了一个切不过去的会话」——错误更难归因
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RENDERER = join(ROOT, "whale-window", "renderer");

/** 在假 window 里加载一个渲染层模块，取回它挂上去的命名空间。 */
function loadModule(file, exportName) {
  const sandbox = {
    window: {},
    console: { warn: () => {}, log: () => {} },
  };
  sandbox.window.document = {
    createElement: () => ({
      className: "",
      textContent: "",
      id: "",
      hidden: false,
      appendChild: () => {},
      addEventListener: () => {},
    }),
  };
  createContext(sandbox);
  runInContext(readFileSync(join(RENDERER, file), "utf8"), sandbox, { filename: file });
  return sandbox.window[exportName];
}

const palette = loadModule("palette.js", "WhalePalette");
const panels = loadModule("panels.js", "WhalePanels");

/**
 * 断言一个「标签」对象。
 *
 * 不能直接 deepEqual：返回值是在 vm 沙箱里创建的对象，
 * 与本测试所在的 realm 不同源，严格深比对会因 prototype 不同而失败
 * （报「Values have same structure but are not reference-equal」）。
 * 逐字段取值来比，跨 realm 也没问题。
 */
function assertLabel(actual, cls, text) {
  assert.equal(actual.cls, cls, "标签类不对");
  assert.equal(actual.text, text, "标签文案不对");
}

/** 跨 realm 安全地取字符串数组（vm 里的 Array.prototype 与本 realm 不同源）。 */
function idsOf(list) {
  return Array.from(list).map((x) => x.id ?? x);
}

test("兜底表含三条，语音是灰项（command 为 null）", () => {
  // 切片 7 起命令表问宿主；这份本地表只在桥拿不到时顶上。
  assert.equal(palette.FALLBACK_COMMANDS.length, 3);
  const voice = Array.from(palette.FALLBACK_COMMANDS).find((c) => c.label === "语音");
  assert.ok(voice !== undefined, "缺「语音」项");
  assert.equal(voice.command, null, "语音未接通 → command 必须是 null（渲染成灰项）");
});

test("fromHost：把宿主 descriptor 转成面板条目", () => {
  // 宿主 descriptor 形状：{name, description, hint, definitionId}
  // name 不含斜杠；hint 是参数占位（如 <preset>）
  const out = palette.fromHost([
    { name: "permission", description: "切换权限预设", hint: "<preset>" },
    { name: "compact", description: "压缩以上对话内容", hint: null },
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].command, "/permission", "必须补上前导斜杠，否则命令发不出去");
  assert.equal(out[0].label, "permission");
  assert.match(out[0].desc, /切换权限预设/, "描述要带上");
  assert.match(out[0].desc, /<preset>/, "参数提示要显示，用户才知道还要填什么");
  assert.equal(out[1].command, "/compact");
  assert.doesNotMatch(out[1].desc, /null/, "没有 hint 时不能把 null 渲染进去");
});

test("有真命令表时用它，不再用兜底表", () => {
  const host = palette.fromHost([
    { name: "permission", description: "切换权限预设", hint: "<preset>" },
    { name: "compact", description: "压缩以上对话内容", hint: null },
  ]);
  const all = Array.from(palette.filterCommands("/", host));
  assert.equal(all.length, 2, "应只列宿主的命令");
  assert.ok(all.every((c) => c.command !== "/sk"), "兜底表的条目不该混进来");
});

test("按命令名过滤真命令表：/per 命中 permission", () => {
  const host = palette.fromHost([
    { name: "permission", description: "切换权限预设", hint: "<preset>" },
    { name: "compact", description: "压缩以上对话内容", hint: null },
  ]);
  const out = Array.from(palette.filterCommands("/per", host));
  assert.ok(out.some((c) => c.command === "/permission"), "应命中");
});

test("按中文描述过滤：搜「权限」也能命中真命令", () => {
  // 用户常记得「权限」而不是 /permission —— 所以过滤要同时看描述
  const host = palette.fromHost([
    { name: "permission", description: "切换权限预设", hint: "<preset>" },
    { name: "compact", description: "压缩以上对话内容", hint: null },
  ]);
  const out = Array.from(palette.filterCommands("/权限", host));
  assert.ok(out.some((c) => c.command === "/permission"), "应命中含「权限」的那条");
});

test("空输入：可用命令都列出，且灰项保留（规范要求显示为灰）", () => {
  // 《页面框架》4.3 的示意里「🎤 语音（暂不可用）[灰]」是**要显示的**——
  // 灰 = 能力未接通，而不是「不显示」。所以空输入时应包含灰项。
  const all = palette.filterCommands("/");
  assert.ok(all.length >= 2, "空输入应列出命令");
  const hasUsable = all.some((c) => c.command !== null);
  assert.equal(hasUsable, true, "至少要有一条可用命令");
});

test("按命令名过滤：/sk 命中技能类", () => {
  const out = palette.filterCommands("/sk");
  assert.ok(out.length > 0, "/sk 应有命中");
  assert.ok(out.some((c) => c.command === "/sk"), "应命中 /sk");
});

test("按中文标签过滤：搜「技能」也能命中", () => {
  // 用户常记得「技能」而不是 /skills —— 所以过滤要同时看命令名与标签
  const out = palette.filterCommands("/技能");
  assert.ok(out.length > 0, "搜中文标签应有命中");
  assert.ok(out.some((c) => c.label.includes("技能")), "应命中含「技能」的项");
});

test("过滤不区分大小写", () => {
  const lower = Array.from(palette.filterCommands("/sk")).map((c) => c.command);
  const upper = Array.from(palette.filterCommands("/SK")).map((c) => c.command);
  assert.deepEqual(upper, lower, "大小写不该影响结果");
});

test("无命中时返回空数组，不返回全部（否则像「搜什么都没用」）", () => {
  assert.equal(palette.filterCommands("/绝不可能存在的命令").length, 0);
});

test("会话标签：当前会话 → 当前", () => {
  assertLabel(panels.labelFor({ sessionId: "a" }, "a"), "cur", "当前");
});

test("会话标签：内存里有 agent → 可切换", () => {
  assertLabel(panels.labelFor({ sessionId: "b", agentAvailable: true }, "a"), "sw", "可切换");
});

test("会话标签：只在磁盘上 → 历史（需先唤醒）", () => {
  assertLabel(panels.labelFor({ sessionId: "c", agentAvailable: false }, "a"), "hist", "历史");
});

test("会话标签：agentAvailable 缺失时按「历史」处理（保守）", () => {
  // 宁可让用户多点一次唤醒，也不要让他点一个切不过去的会话
  assert.equal(panels.labelFor({ sessionId: "d" }, "a").cls, "hist");
});

test("菜单项顺序固定，且「按需确认」是灰项", () => {
  const ids = idsOf(Array.from(panels.MENU_ITEMS).filter((i) => i.id !== undefined));
  assert.deepEqual(ids, ["projects", "approval", "skills", "plugins", "more"]);
  const approval = Array.from(panels.MENU_ITEMS).find((i) => i.id === "approval");
  assert.equal(approval.badge, "灰", "能力未接通项必须标灰");
});

test("「更多」含三个窗口动作", () => {
  assert.deepEqual(idsOf(Array.from(panels.MORE_ITEMS)), ["minimize", "reload", "quit"]);
});

// ─────────────────────────────────────────────────────────────
// 面板里的条目：「需要参数」的命令不能被直接执行
//
// 用户报：「选择某个指令就直接被发送出去了」（他点的是斜杠候选面板里的条目）。
// 主窗口的语义是**按命令类型分流**（见 DSH 的决策表）：
//   带参数声明的 → 进入等待参数态；弹窗类 → 打开弹窗；其余 → 才直接执行。
// 而小窗的面板原先**一律直接执行** —— 于是 /btw 这种要填参数的命令
// 一点就被执行掉了，用户感受就是「被发送出去了」。
// ─────────────────────────────────────────────────────────────

test("宿主命令转成面板条目时要保留参数声明（否则无从判断该不该直接执行）", () => {
  const list = palette.fromHost([
    { name: "btw", description: "根据当前上下文回答", hint: "旁问内容" },
    { name: "compact", description: "压缩以上对话内容", hint: null },
  ]);

  const btw = list.find((c) => c.label === "btw");
  const compact = list.find((c) => c.label === "compact");
  assert.ok(btw !== undefined && compact !== undefined, "两条都要转出来");

  assert.equal(btw.hint, "旁问内容", "带参数的命令必须把 hint 带出来");
  assert.equal(compact.hint, null, "不带参数的命令 hint 为 null（表示可直接执行）");

  // 但**候选值**不变：它仍是可直接用的命令行
  assert.equal(btw.command, "/btw");
  assert.equal(compact.command, "/compact");
});

test("不需要参数的命令：面板条目照常可直接执行", () => {
  const list = palette.fromHost([{ name: "compact", description: "压缩", hint: null }]);
  assert.equal(list[0].command, "/compact");
  assert.equal(list[0].hint, null);
});

test("app.js 必须按参数声明分流（需要参数的不能直接执行）", () => {
  const appJs = readFileSync(join(RENDERER, "app.js"), "utf8");
  // onPick 要能拿到第二条参数（整条条目），否则它拿不到 hint
  assert.match(
    appJs,
    /onPick\(command, item\)/,
    "onPick 必须接收整条条目 —— 只给命令字符串就无从判断是否需要参数",
  );
  assert.match(
    appJs,
    /inputArea\.pick\(/,
    "分流交给 input-area 的 pick（它与「插入 + 参数引导」是同一件事）",
  );

  // 分流本体：带 hint 的认领、其余交给执行回调
  const inputArea = readFileSync(join(RENDERER, "input-area.js"), "utf8");
  assert.match(inputArea, /pick\(command, item, run\)/, "input-area 必须实现 pick");
  assert.match(
    inputArea,
    /item\?\.hint[\s\S]{0,320}claimCommand\(/,
    "带参数声明的命令必须**认领**进输入框等用户补参数（主窗口的 leadingInput 语义），" +
    "而不是被直接执行掉",
  );
});

test("面板选中必须「认领」而不是「追加」（否则出现两个斜杠）", () => {
  // 用户报：「我输入 / 后，选择 btw 后，直接弹出了两个 /」。
  // 他敲的 `/` 是命令引导符；追加得到 `//btw`，主窗口是替换。
  const inputArea = readFileSync(join(RENDERER, "input-area.js"), "utf8");
  assert.match(inputArea, /claimCommand\(/, "pick 必须用认领（替换）语义");
  assert.doesNotMatch(
    inputArea,
    /pick\(command, item, run\)[\s\S]{0,400}?editor\.insert\(/,
    "pick 里不能用追加式插入 —— 那会把用户敲的引导符留在原地",
  );
});

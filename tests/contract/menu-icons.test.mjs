/**
 * ＋ 菜单图标契约测试
 *
 * 职责：把「小窗的菜单图标 = DSH 主窗口的同一套图标」钉死，并守住
 *       分组顺序与本地化标题。所属层：测试（tests/contract）
 *
 * 为什么值得单独一层：用户裁定「照 DSH 主窗口那套图标像素级复刻」。
 * 这类承诺坏了**界面上不报错**，只是图标悄悄变成别的一版图形——
 * 「看起来在跑」，只有机械比对才能拦住：
 *   - DSH 升级换代换了图标组件 → 小窗画的还是上一版的图；
 *   - 有人手改 menu-icons.js 微调一条 path → 与主窗口不再一致；
 *   - 分组顺序被改动 → ＋菜单的行序与主窗口就对不上了。
 *
 * 数据源依赖：本测试会去读本机 DSH 安装目录。装目录不在时**跳过比对**
 * （而不是红），因为换了机器/未装 DSH 不该让整仓测试挂掉；
 * 但「跳过」会打印一行说明，不会静默。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN = join(ROOT, "whale-window");

const readWin = (rel) => readFileSync(join(WIN, rel), "utf8");

const iconsPath = join(WIN, "renderer", "menu-icons.js");
const iconsSrc = readWin(join("renderer", "menu-icons.js"));

/**
 * 动态 import 工具模块。
 *
 * ⚠️ Windows 上**不能**直接把绝对路径交给 import()：会报
 * `ERR_UNSUPPORTED_ESM_URL_SCHEME ... Received protocol 'd:'`。
 * 必须经 pathToFileURL 转成 file:// URL（工作区路径含中文，顺带避免编码问题）。
 */
const importTool = () => import(pathToFileURL(join(ROOT, "tools", "whale-menu-icons.mjs")).href);

/**
 * 把沙箱里造出来的值搬回宿主 realm。
 *
 * ⚠️ 真实踩过：node:vm 的沙箱有**自己的 Array/Object 原型**，
 * 所以 `assert.deepStrictEqual(沙箱数组, 宿主数组)` 会失败——
 * 而报错里 actual 与 expected **打印出来一模一样**，极具迷惑性
 * （看着像断言写错了，其实是原型不同）。
 * 用 JSON 往返克隆到宿主 realm 再比。
 */
const toHost = (value) => JSON.parse(JSON.stringify(value));

/** 在 node:vm 沙箱里跑一遍 menu-icons.js，取它真实暴露的对象。 */
async function loadIcons() {
  const vm = await import("node:vm");
  const sandbox = { window: {} };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  vm.runInContext(iconsSrc, sandbox);
  return sandbox.window.WhaleMenuIcons;
}

// ─────────────────────────────────────────────────────────────
// 一、与 DSH 源逐字一致（漂移即红）
// ─────────────────────────────────────────────────────────────

test("menu-icons.js 与 DSH 安装包的图标数据逐字一致", async (t) => {
  const tool = await importTool();

  if (!existsSync(tool.PRIMITIVES_FILE)) {
    t.diagnostic(`跳过：本机没有 DSH 图标数据源（${tool.PRIMITIVES_FILE}）`);
    return;
  }

  const want = tool.expectedSource();
  const have = readFileSync(iconsPath, "utf8");
  assert.equal(
    have,
    want,
    "menu-icons.js 与 DSH 的图标数据不一致，请运行 node tools/whale-menu-icons.mjs",
  );
});

test("阴性对照：图标数据改一个字节就必须被比对抓住", async (t) => {
  const tool = await importTool();
  if (!existsSync(tool.PRIMITIVES_FILE)) {
    t.diagnostic("跳过：本机没有 DSH 图标数据源");
    return;
  }

  const want = tool.expectedSource();
  // 把目标图标里一个坐标数字改掉（8 → 7），模拟「有人手改了一条 path」
  const tampered = want.replace("M14.5001 8C14.5", "M14.5001 7C14.5");
  assert.notEqual(tampered, want, "阴性对照自身失效：没改到任何字节");

  assert.notEqual(
    tampered,
    want,
    "改了一个字节后仍被判为一致 —— 比对形同虚设",
  );
  assert.equal(readFileSync(iconsPath, "utf8"), want, "磁盘上的文件应与源一致");
  assert.notEqual(readFileSync(iconsPath, "utf8"), tampered, "被篡改的版本不该等于磁盘内容");
});

// ─────────────────────────────────────────────────────────────
// 二、分组顺序与标题（与主窗口菜单一致）
// ─────────────────────────────────────────────────────────────

test("＋菜单分「添加」与「指令」两组，行序与主窗口一致", async () => {
  const icons = await loadIcons();
  assert.deepEqual(
    toHost(icons.SECTIONS.map((s) => [s.name, s.label])),
    [["add", "添加"], ["commands", "指令"]],
    "分组名与标题必须与主窗口一致（添加 / 指令）",
  );
  assert.deepEqual(
    toHost(icons.SECTIONS[0].rows),
    ["file", "goal", "plan", "feedback"],
    "「添加」组的行序必须是 文件→目标→计划→反馈（主窗口 SECTION_ROWS.add）",
  );
  assert.deepEqual(
    toHost(icons.SECTIONS[1].rows),
    ["compact", "permission", "model", "export"],
    "「指令」组的行序必须是 压缩→权限→模型→下载日志（主窗口 SECTION_ROWS.commands）",
  );
});

test("本地化标题与说明来自主窗口的中文字典", async () => {
  const icons = await loadIcons();
  // 用户报「小窗缺目标/计划」——这两条的标题必须是中文，不是宿主的英文描述
  assert.equal(icons.LABELS.goal, "目标");
  assert.equal(icons.LABELS.plan, "计划");
  assert.equal(icons.LABELS.feedback, "反馈");
  assert.equal(icons.LABELS.file, "文件");
  assert.equal(icons.LABELS.compact, "压缩");
  assert.equal(icons.LABELS.permission, "权限");
  assert.equal(icons.LABELS.model, "模型");
  assert.equal(icons.LABELS.export, "下载日志");

  assert.equal(icons.DESCRIPTIONS.goal, "设置或查看长期任务目标");
  assert.equal(icons.DESCRIPTIONS.plan, "进入或退出计划模式");
  assert.equal(icons.DESCRIPTIONS.feedback, "发送关于当前会话的反馈");
  assert.equal(icons.DESCRIPTIONS.file, "引用工作区文件");
  assert.equal(icons.DESCRIPTIONS.model, "选择本会话使用的模型");
});

test("文案必须与主窗口各包的 zh 字典逐字一致（不是我们编的）", async (t) => {
  const tool = await importTool();

  let checked = 0;
  for (const source of tool.LABEL_SOURCES) {
    if (!existsSync(source.file)) {
      t.diagnostic(`跳过：本机没有 ${source.file}`);
      continue;
    }
    const src = readFileSync(source.file, "utf8");
    for (const [key, want] of Object.entries(source.checks)) {
      assert.equal(
        tool.readZhEntry(src, key),
        want,
        `${key} 与主窗口字典不一致（源：${source.file}）`,
      );
      checked += 1;
    }
  }
  assert.ok(checked > 0, "一条文案都没校验到 —— 校验源全都不存在？");
});

// ─────────────────────────────────────────────────────────────
// 三、图标本体：7 行都要有，且是内联 currentColor
// ─────────────────────────────────────────────────────────────

/** 主窗口菜单里带图标的全部行（与 MENU_ROWS 一致）。 */
const ICON_KEYS = ["file", "goal", "plan", "feedback", "compact", "permission", "model", "export"];

test("8 个菜单行都有图标，且是内联 SVG（不是空串、不是外链）", async () => {
  const icons = await loadIcons();
  for (const key of ICON_KEYS) {
    const svg = icons.iconOf(key);
    assert.ok(svg.length > 0, `${key} 缺图标`);
    assert.match(svg, /^<svg\b/, `${key} 的图标不是内联 svg`);
    assert.match(svg, /viewBox="0 0 16 16"/, `${key} 的 viewBox 必须与 DSH 一致`);
    // 不能外链：CSP 是 default-src 'none'，外链图标会被静默拦掉
    assert.doesNotMatch(svg, /<img|href=|src=/, `${key} 的图标不许外链（CSP 会拦）`);
  }
});

test("图标配色继承 currentColor（换主题才不会失配）", async () => {
  const icons = await loadIcons();
  for (const key of ICON_KEYS) {
    const svg = icons.iconOf(key);
    // 每条 path 要么 stroke 要么 fill，都必须走 currentColor
    assert.match(svg, /(stroke|fill)="currentColor"/, `${key} 的图标没有 currentColor`);
    assert.doesNotMatch(svg, /#[0-9a-fA-F]{3,6}\b/, `${key} 的图标不许写死颜色`);
  }
});

test("逐条 path 的绘制方式与 DSH 一致（stroke/fill 混用的行不能拉平）", async () => {
  const icons = await loadIcons();

  // 计划：前两条描边 + 后三条填充 —— 一律当 stroke 会让清单框走样
  const plan = icons.iconOf("plan");
  const planPaths = plan.match(/<path[^>]*>/g) ?? [];
  assert.equal(planPaths.length, 5, "计划的图标应解析出 5 条 path");
  assert.equal(
    planPaths.filter((p) => p.includes('fill="currentColor"')).length,
    3,
    "计划有 3 条 path 是填充（清单框与笔）",
  );

  // 权限：盾牌那条带 stroke-linejoin
  assert.match(icons.iconOf("permission"), /stroke-linejoin="round"/, "权限的盾牌缺 stroke-linejoin");

  // 压缩：圆环那条带透明度
  assert.match(icons.iconOf("compact"), /opacity="0\.35"/, "压缩的圆环缺 opacity");

  // 模型：数据库图标的齿轮那条带 stroke-miterlimit。
  // 这条属性最容易在「通用化提取」时丢掉 —— 丢了不报错，只是那一笔画得不对。
  assert.match(
    icons.iconOf("model"),
    /stroke-miterlimit="10"/,
    "模型的齿轮缺 stroke-miterlimit",
  );
  // 模型的两条 path 一条填充一条描边，不能拉平
  const modelPaths = icons.iconOf("model").match(/<path[^>]*>/g) ?? [];
  assert.equal(modelPaths.length, 2, "模型的图标应解析出 2 条 path");
  assert.equal(
    modelPaths.filter((p) => p.includes('fill="currentColor"')).length,
    1,
    "模型有 1 条 path 是填充（数据库主体）",
  );
});

test("取不到的键返回空串而不是抛错（图标是装饰，不该让菜单打不开）", async () => {
  const icons = await loadIcons();
  assert.equal(icons.iconOf("不存在的东西"), "");
});

// ─────────────────────────────────────────────────────────────
// 四、接线：菜单真的用上了图标
// ─────────────────────────────────────────────────────────────

test("add-menu.js 渲染时用了图标与分组表", () => {
  const addMenu = readWin(join("renderer", "add-menu.js"));
  assert.match(addMenu, /WhaleMenuIcons/, "add-menu.js 没有引用图标模块");
  assert.match(addMenu, /iconOf|ICONS/, "add-menu.js 没有取图标");
});

test("index.html 在 add-menu.js 之前加载 menu-icons.js", () => {
  const html = readWin(join("renderer", "index.html")).replace(/<!--[\s\S]*?-->/g, "");
  const iIcons = html.indexOf("menu-icons.js");
  const iAdd = html.indexOf("add-menu.js");
  assert.ok(iIcons !== -1, "index.html 没有加载 menu-icons.js");
  assert.ok(iAdd !== -1, "index.html 没有加载 add-menu.js");
  assert.ok(iIcons < iAdd, "menu-icons.js 必须在 add-menu.js 之前加载（后者要用它）");
});

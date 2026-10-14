/**
 * 小窗渲染层契约测试
 *
 * 职责：把「渲染层的对外承诺」钉死——DOM 结构、CSP、关键数值、
 *       preload 与主进程通道的一一对应、`--shadow-pad` 与主进程常量一致。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得单独一层：这些承诺**坏了都不报错**，只是行为悄悄变差——
 *   - CSP 少写 'self' → app.js 被静默拦截，窗口里只剩字面文本；
 *   - `--shadow-pad` 与 SHADOW_PAD 不一致 → 阴影被硬切成直边；
 *   - preload 多暴露一个通道而主进程没注册 → 调用是永远挂起的 Promise；
 *   - 图钉横帽写成 `<rect>` → 被全局 `rect{fill:none}` 清成空心。
 * 全都是「看起来在跑」的故障，只有机械比对才能拦住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WIN = join(ROOT, "whale-window");

const read = (rel) => readFileSync(join(WIN, rel), "utf8");

/** 去掉 HTML 注释：注释里出现的选择器会被正则当成真实元素（最危险的假通过）。 */
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

const rawHtml = read(join("renderer", "index.html"));
const html = stripComments(rawHtml);
const css = read(join("renderer", "skin.css"));
const appJs = read(join("renderer", "app.js"));
const clientJs = read(join("renderer", "bridge-client.js"));
const preloadText = read("preload.cjs");

/**
 * 渲染层全部脚本的合并文本。
 *
 * 断言「界面里存在某文案/某分支」时应扫**整个渲染层**，而不是只扫 app.js：
 * 批次 C 把纯渲染拆到 render.js 之后，只扫 app.js 的断言会全部误报
 * （那是布局变化，不是契约变化）。按职责拆文件是要求，不是违约。
 */
const rendererAll = [
  "app.js", "render.js", "palette.js", "panels.js", "bridge-client.js",
  "bridge-capabilities.js", "follow.js", "stream.js", "menu-icons.js",
  "add-menu.js", "rich-input.js", "input-area.js",
]
  .map((f) => read(join("renderer", f)))
  .join("\n");

const hasId = (id) => new RegExp(`id="${id}"`).test(html);

test("顶栏元素齐全（F2）", () => {
  /*
   * 「元素齐全」的清单就是规格：删了按钮不改清单会立刻红，那正是它该起的作用。
   * 变更史：六元素（含 btnGear）→ 删 btnGear 成五元素 →
   * 用户要求加三个新图标（左右侧边栏、文件夹）成八元素。
   *
   * ⚠️ 新增的这三个**当前没有交互**（用户明确说「下一步再明确具体的交互内容」）。
   * 它们先作为占位存在，等交互定了再接绑定。
   */
  // ⚠️ `btnFolder` 已按用户要求移除（文件列表改到侧边栏里默认展示）
  for (const id of ["btnMin", "btnPin", "btnSideLeft", "btnSideRight", "tbTitle"]) {
    assert.ok(hasId(id), `缺元素 #${id}`);
  }
  assert.match(html, /class="brand-dot"/, "工作区色块必须存在");
  assert.doesNotMatch(html, /id="btnGear"/, "侧边工作台按钮已按用户要求移除");
});

test("顶栏布局顺序：左组按钮 → 色块 → 标题 → 右组按钮", () => {
  /*
   * 用户明确的布局要求：
   *   「顶栏中间区域为会话标题区域，左侧依次是最小化、置顶、
   *     还要加一个打开左侧边栏的图标。右侧改为两个图标，
   *     一个是文件夹图标，一个是打开右侧边栏图标」
   *
   * 顺序是这次需求的核心，所以按 **DOM 出现顺序**钉住，而不是只查「存在」。
   * 只查存在的话，把侧边栏图标插到标题右边也照样绿 —— 那就不符合要求了。
   */
  const topbar = /<header class="topbar"[^>]*>([\s\S]*?)<\/header>/.exec(html);
  assert.ok(topbar !== null, "找不到顶栏");

  /*
   * 提取「标记点」：既取 id，也取那个没有 id 的色块（它是 class）。
   * ⚠️ 只写 `id="..."` 的正则匹配不到 `.brand-dot`（它只有 class）——
   * 第一版就这么错了，断言会以为色块不在序列里。
   */
  const ids = [...topbar[1].matchAll(/id="([^"]+)"|class="(brand-dot)"/g)]
    .map((m) => m[1] ?? m[2]);
  assert.deepEqual(
    ids,
    ["btnMin", "btnPin", "btnSideLeft", "brand-dot", "tbTitle", "btnSideRight"],
    "顶栏顺序：最小化 → 置顶 → 左侧边栏 → 色块 → 标题 → 右侧边栏 → 更多",
  );

  // 标题必须夹在左右两组按钮之间 —— 「中间区域为会话标题」靠这个成立
  const iTitle = ids.indexOf("tbTitle");
  assert.ok(iTitle > ids.indexOf("btnSideLeft"), "标题要在左侧组之后");
  assert.ok(iTitle < ids.indexOf("btnSideRight"), "标题要在右侧组之前");
});

test("app.js 绑定的每个按钮都必须真的存在于 HTML", () => {
  // 真实踩过：重写 app.js 时 dom 表漏了 btnAdd/btnUsage/btnModel 三个引用，
  // 结果 `dom.btnModel.addEventListener` 在 undefined 上调用 →
  // 脚本顶层抛 TypeError → **后面所有绑定一行都不执行** →
  // 界面全哑、显示「未连接」，而桥完全正常。极难归因。
  //
  // 修法不是补引用了事：这里把「app.js 里 dom.* 引用的每个 id」
  // 与「HTML 里实际存在的 id」做机械比对，漏一个就红。
  const domRefs = new Set();
  for (const m of appJs.matchAll(/\$\("([A-Za-z][\w]*)"\)/g)) domRefs.add(m[1]);
  // app.js 里的动态引用（OVERLAY_BUTTONS 用字符串键）单独列出
  for (const m of appJs.matchAll(/\["(btn\w+)",\s*"/g)) domRefs.add(m[1]);

  const missing = [...domRefs].filter((id) => !hasId(id) && !["win", "bar"].includes(id));
  assert.deepEqual(
    missing,
    [],
    `这些元素在 app.js 里被引用但 HTML 里不存在（undefined 上调 addEventListener ` +
      `会让整个脚本崩掉）：\n${missing.map((x) => `#${x}`).join("\n")}`,
  );

  // 委托给 OVERLAY_BUTTONS 的三个按钮也要单独锁（那条正则只覆盖一种写法）
  for (const id of ["btnAdd", "btnUsage", "btnModel", "inputOverlay", "ovClose", "uplList"]) {
    assert.ok(hasId(id), `切片 7 的 #${id} 必须在 HTML 里`);
  }
});

test("F2：三个占位按钮不得加回", () => {
  // 2026-10-04 用户裁定删掉「语音通话 / 麦克风 / 屏幕共享」
  const banned = ["btnCall", "btnMic", "btnShare", "语音通话", "屏幕共享"];
  for (const b of banned) {
    assert.ok(!html.includes(b), `顶栏不该出现「${b}」——已被用户裁定删除`);
  }
});

test("图钉横帽必须用 <path> 画（陷阱 5）", () => {
  // 全局 .ico svg rect{fill:none} 会把 <rect> 清成空心
  const pinBlock = /id="btnPin"[\s\S]*?<\/button>/.exec(html)?.[0] ?? "";
  assert.ok(pinBlock.length > 0, "找不到图钉按钮");
  assert.match(pinBlock, /<path d="M4\.6 3\.2h6\.8v1\.7H4\.6z"/, "横帽必须是闭合 path");
  assert.ok(!/<rect/.test(pinBlock), "图钉里不得出现 <rect>");
});

test("内容区顶部的会话标题行已按用户要求移除", () => {
  /*
   * 用户截图红框圈住「标题 + 同源会话角标 + 副标题」那一区，
   * 说「这部分这个框不需要」—— 整个区块移除。
   * 顶栏标题 tbTitle 保留（红框没圈它）。
   */
  assert.ok(hasId("tbTitle"), "顶栏标题保留");
  assert.ok(!hasId("shTitle"), "会话标题行已移除");
  assert.ok(!hasId("shSub"), "副标题行已移除");
  assert.doesNotMatch(html, /同源会话/, "「同源会话」角标随区块移除");
});

test("输入区按钮组齐全（F6）", () => {
  /*
   * 原含 `btnVoice`（语音输入，标注「暂未实现」、点了没反应）。
   * 用户要求去掉，这里跟着改。
   */
  for (const id of ["btnAdd", "btnPerm", "btnUsage", "btnMore", "btnModel", "btnSend"]) {
    assert.ok(hasId(id), `缺按钮 #${id}`);
  }
  assert.doesNotMatch(html, /id="btnVoice"/, "语音按钮已按用户要求移除");
});

test("灰色项不得有 hover 反馈（规范 2：不假装能用）", () => {
  /*
   * ⚠️ 原先只断言 `.cbtn.grey` —— 那是语音按钮（唯一的 `.cbtn.grey` 使用者），
   * 而语音按钮已按用户要求移除。守一个**已经没人用**的类，等于守死代码。
   *
   * 现在断言**页面上真正在用的**两类灰项：
   *   · `.mi.grey`     —— 菜单里不可用的项（panels.js / palette.js）
   *   · `.ov-row.grey` —— 浮层里读取失败的来源行（overlays.js）
   * 断言钉在真正生效的那一环，产品换用别的类名时会立刻红。
   */
  for (const sel of ["mi", "ov-row"]) {
    assert.match(
      css,
      new RegExp(`\\.${sel}\\.grey\\s*\\{[^}]*cursor:\\s*not-allowed`, "s"),
      `.${sel}.grey 应给 not-allowed 光标`,
    );
    assert.match(
      css,
      new RegExp(`\\.${sel}\\.grey:hover\\s*\\{[^}]*background:\\s*transparent`, "s"),
      `.${sel}.grey 的 hover 不该有背景变化（不假装能用）`,
    );
  }
});

test("发送键的 aria 约定（B7 判据按此读 DOM）", () => {
  assert.match(css, /\.send\.stop\s*\{[^}]*background:\s*var\(--bad\)/s, "运行中必须是红方块");
  assert.match(rendererAll, /aria-label.*中断|"中断"/, "运行中 aria-label 必须是「中断」");
  assert.match(rendererAll, /"发送"/, "空闲 aria-label 必须是「发送」");
});

test("用量圆环周长与公式一致（2πr = 50.27）", () => {
  assert.match(html, /stroke-dasharray="50\.3"/, "周长 50.3");
  assert.match(rendererAll, /50\.3 \* \(1 - pct \/ 100\)/, "offset = 周长 × (1 − 百分比/100)");
  assert.match(css, /\.usage-ring svg\s*\{[^}]*rotate\(-90deg\)/s, "从 12 点方向顺时针增长");
});

test("权限三档文案与主窗口逐字一致（F6/B9）", () => {
  for (const text of ["仅可查看", "工作区内修改", "完全权限"]) {
    assert.ok(rendererAll.includes(text), `缺文案「${text}」`);
  }
});

test("角色文案：用户「你」，助手「DSH」", () => {
  assert.ok(rendererAll.includes('"你"'), "用户角色文案应为「你」");
  assert.ok(rendererAll.includes('"DSH"'), "助手角色文案应为「DSH」");
});

test("消息按桥给的 kind 分流，不得读 role（读错字段不报错，只是全部渲染成助手）", () => {
  // 桥的面板投影给的是 {kind:"user"|"assistant"|"tool", text, seq}。
  // 曾经渲染层按 m.role 读，于是每条消息都渲染成「DSH」、
  // 用户的发言完全看不出来——而且**不报任何错**。
  assert.ok(!/m\.role/.test(rendererAll), "不得读 m.role；桥给的是 kind");
  assert.match(rendererAll, /m\.kind/, "必须按 kind 分流");
  for (const kind of ["user", "assistant", "tool"]) {
    assert.ok(rendererAll.includes(`"${kind}"`), `必须处理 kind="${kind}"`);
  }
});

test("面板字段形状与桥的投影一致（字段名对不上是静默故障）", () => {
  // 直接拿桥的投影函数产出的形状做对照，而不是照文档抄
  const { messagesOf, todosOf, runningToolOf } = require(join(ROOT, "whale-bridge", "lib", "panel-data.mjs"));
  const fold = {
    tail: [
      { kind: "user", text: "你好", seq: 1 },
      { kind: "assistant", text: "在的", seq: 2 },
      { kind: "tool", name: "bash", state: "running", seq: 3 },
      { kind: "todo", todos: [{ content: "做A", status: "pending" }] },
    ],
  };
  const messages = messagesOf(fold);
  assert.deepEqual(messages[0], { kind: "user", text: "你好", seq: 1 });
  assert.equal(messages[2].kind, "tool");
  assert.equal(messages[2].name, "bash");
  assert.deepEqual(todosOf(fold), [{ content: "做A", status: "pending" }]);
  // 渲染层必须认识这三个 kind
  for (const m of messages) {
    assert.ok(rendererAll.includes(`"${m.kind}"`), `渲染层不认识 kind="${m.kind}"`);
  }
  // 状态条要靠 runningToolOf 的产出说工具名
  assert.equal(runningToolOf(fold), "bash");
  assert.match(clientJs, /toolName/, "客户端必须读 toolName，否则状态条只会说「正在运行」");
});

test("任务坞的三种状态与桥的 todo 口径一致", () => {
  // 桥给的是宿主的 status，色点映射必须覆盖 completed / in_progress / 其余
  assert.match(rendererAll, /"completed"/, "已完成的色点");
  assert.match(rendererAll, /"in_progress"/, "进行中的色点");
  assert.match(css, /\.pd\.done/, "绿点样式");
  assert.match(css, /\.pd\.doing/, "橙点样式");
  assert.match(css, /\.pd\.todo/, "灰空心样式");
});

test("回合运行态取两个来源的或（只看 agentRunning 会永远不亮）", () => {
  // 桥拿不到 agent 时 agentRunning 恒为 false，而折叠器能报出 running
  assert.match(
    clientJs,
    /json\.running === true \|\| json\.agentRunning === true/,
    "必须两者取或，否则状态条与中断键在真实场景里永远不亮",
  );
});

test("CSP 必须放行 'self'，否则 app.js / skin.css 被静默拦截（陷阱 4）", () => {
  const csp = /content="([^"]*default-src[^"]*)"/.exec(rawHtml)?.[1];
  assert.ok(csp !== undefined, "index.html 必须有 CSP");
  assert.match(csp, /script-src[^;]*'self'/, "script-src 必须含 'self'");
  assert.match(csp, /style-src[^;]*'self'/, "style-src 必须含 'self'");
  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1/, "只放行回环连接");
  assert.ok(!/connect-src[^;]*https?:\/\/\*/.test(csp), "connect-src 不得通配主机");
});

test("崩溃兜底页的脚本必须外链（CSP 会拦内联）", () => {
  const crashed = read(join("renderer", "crashed.html"));
  const csp = /content="([^"]*default-src[^"]*)"/.exec(crashed)?.[1] ?? "";
  assert.match(csp, /script-src[^;]*'self'/, "兜底页同样要放行 'self'");
  assert.match(crashed, /<script src="crashed\.js">/, "必须外链脚本，内联会被拦");
  assert.ok(existsSync(join(WIN, "renderer", "crashed.js")), "crashed.js 必须存在");
});

test("脚本加载顺序：各模块先定义、app.js 最后装配", () => {
  /*
   * ⚠️ 这个清单就是规格：新增或删除模块都要改这里，
   * 否则会立刻红 —— 那正是它该起的作用（顺序错了会在启动时抛
   * ReferenceError，现象是「窗口在、什么都没接上」，极难归因）。
   */
  const tags = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    tags,
    ["bridge-capabilities.js", "bridge-shapes.js", "bridge-workspace.js", "bridge-client.js", "follow.js", "stream.js", "menu-icons.js", "add-menu.js", "rich-input.js", "input-area.js", "render.js", "palette.js", "panels.js", "sidebar.js", "skills-view.js", "account-panel.js", "sidebar-mount.js", "overlays.js", "dom-table.js", "app.js"],
    "顺序错了会在启动时抛 ReferenceError（现象是「窗口在、什么都没接上」）",
  );
  // app.js 必须最后：它是装配层，要用到前面每个模块的命名空间
  assert.equal(tags[tags.length - 1], "app.js", "app.js 必须在最后加载");

  // sidebar.js 要用 panels.js 的 labelFor（会话三档标签只有一处实现）
  assert.ok(
    tags.indexOf("panels.js") < tags.indexOf("sidebar.js"),
    "panels.js 必须在 sidebar.js 之前加载",
  );
  // skills-view.js 是主区页面，由 app.js 装配；它不依赖 overlays，但要在 app 之前
  assert.ok(
    tags.indexOf("skills-view.js") < tags.indexOf("app.js"),
    "skills-view.js 必须在 app.js 之前加载",
  );

  // menu-icons.js 必须排在 add-menu.js 之前：后者要用前者的图标与分组表，
  // 顺序反了的现象是「＋菜单没有图标、且少了目标/计划两行」（不会报错）
  assert.ok(
    tags.indexOf("menu-icons.js") < tags.indexOf("add-menu.js"),
    "menu-icons.js 必须在 add-menu.js 之前加载",
  );
});

test("--shadow-pad 必须等于主进程的 SHADOW_PAD（否则阴影被硬切）", () => {
  const geometry = require(join(WIN, "lib", "geometry.cjs"));
  const cssPad = /--shadow-pad:\s*(\d+)px/.exec(css)?.[1];
  assert.ok(cssPad !== undefined, "skin.css 必须有 --shadow-pad");
  assert.equal(
    Number(cssPad),
    geometry.SHADOW_PAD,
    "两处不一致时：留小 → 阴影被硬切一条直边；留大 → 窗外多一圈无用途空边",
  );
});

test("内容尺寸与主进程常量一致（460×678）", () => {
  const geometry = require(join(WIN, "lib", "geometry.cjs"));
  assert.equal(geometry.CONTENT_WIDTH, 460);
  assert.equal(geometry.CONTENT_HEIGHT, 678);
  assert.match(css, /--content-w:\s*460px/);
  assert.match(css, /--content-h:\s*678px/);
  assert.match(css, /\.win\s*\{[^}]*border-radius:\s*18px/s, "圆角 18px");
});

test("preload 暴露的通道与主进程注册的通道一一对应", () => {
  const ipc = require(join(WIN, "lib", "ipc.cjs"));
  const found = [...preloadText.matchAll(/"whale:[a-z-]+"/g)].map((m) => m[0].slice(1, -1));
  const preloadChannels = [...new Set(found)].sort();
  const registered = Object.values(ipc.CHANNEL).sort();
  assert.deepEqual(
    preloadChannels,
    registered,
    "preload 与主进程的通道必须完全一致：多暴露一个就是永远挂起的 Promise",
  );
});

test("浮层键只能绑一次：btnPerm 不得单独再绑（绑两次会互相抵消）", () => {
  // 真实踩过：权限键在 OVERLAY_BUTTONS 循环里绑了一次（toggle + render），
  // 上一行又单独绑了一次（只 toggle）。点一下触发两个处理器：
  // 第一个打开浮层，第二个又切一次把它关掉，且 isOpen() 为假 → 不渲染
  // → 也从不发 /whale/presets 请求。
  // 净效果是「点了没反应」，而所有代码看起来都在。
  // 这类「同一元素绑两次」的静默失效只能靠机械检查拦。
  const bindCount = (id) => {
    const re = new RegExp(`dom\\.${id}\\.addEventListener\\(\\s*"click"`, "g");
    return (appJs.match(re) ?? []).length;
  };
  for (const id of ["btnPerm", "btnModel", "btnUsage", "btnAdd"]) {
    assert.equal(
      bindCount(id),
      0,
      `#${id} 不该有独立的 click 绑定——它由 OVERLAY_BUTTONS 循环统一接线；` +
        "额外再绑一次会让两次 toggle 互相抵消（浮层永远打不开）",
    );
    assert.ok(
      new RegExp(`\\["${id}",\\s*"`).test(appJs),
      `#${id} 必须在 OVERLAY_BUTTONS 表里（否则它没有绑定，点了没反应）`,
    );
  }
  assert.match(appJs, /OVERLAY_BUTTONS\.forEach\(/, "必须有 OVERLAY_BUTTONS 统一接线");
});

test("overlays.js 必须用取值函数拿 client，不能存成对象", () => {
  // 真实踩过：`const client = deps.getClient;` 把**取值函数本身**当客户端用了，
  // 于是 client.modelCatalog() / client.getState() 全线报
  // "client.xxx is not a function"——函数也是对象，所以报「不是函数」
  // 而不是「undefined」，看着像 client 缺方法，其实 client 本身就是那个函数。
  // 三个浮层因此全部点不动（这是用户报的「除了＋其他都没实现」的真因）。
  const overlaysJs = read(join("renderer", "overlays.js"));
  const lines = overlaysJs.split("\n");
  // 只看真正会执行的代码行（注释里为了讲清这个坑必然会提到错误写法）
  const codeLines = lines.filter((t) => {
    const s = t.trim();
    return !s.startsWith("*") && !s.startsWith("//") && !s.startsWith("/*");
  });
  const code = codeLines.join("\n");

  // 1) 不得出现把取值函数存成变量的写法
  assert.ok(
    !/const\s+client\s*=\s*deps\.getClient\s*;/.test(code),
    "不得把 deps.getClient 存成 client——它是取值函数，不是客户端",
  );

  // 2) 必须有一个取值访问器
  assert.match(code, /function\s+clientOf\s*\(\)\s*\{\s*return\s+deps\.getClient\(\)/,
    "必须定义 clientOf() 每次现取");

  // 3) 所有 client 调用都必须经由 clientOf()——漏一处就是那个浮层点不动
  const bare = [];
  let inBlockComment = false;
  lines.forEach((text, index) => {
    const trimmed = text.trim();
    if (inBlockComment) {
      if (trimmed.includes("*/")) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) inBlockComment = true;
      return;
    }
    if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
    if (/(?<!clientOf\(\)\.)\bclient\./.test(text)) bare.push(`${index + 1}: ${trimmed}`);
  });
  assert.deepEqual(bare, [], `这些地方直接用了 client 而不是 clientOf()：\n${bare.join("\n")}`);
});

test("preload 不暴露 ipcRenderer 本体，也不开放任意 channel", () => {
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preloadText), "不得直接暴露 ipcRenderer");
  assert.match(preloadText, /exposeInMainWorld\(\s*"whale"/, "必须暴露 window.whale");
  // 不得出现「传什么 channel 就转发什么」的万能入口
  assert.ok(!/invoke\(\s*channel\s*[,)]/.test(preloadText), "不得转发任意 channel");
});

test("窗口动作白名单权威定义在 ipc.cjs，且含 5 个动作", () => {
  const ipc = require(join(WIN, "lib", "ipc.cjs"));
  assert.deepEqual(
    [...ipc.WINDOW_ACTIONS],
    ["minimize", "hide", "close", "toggle-pin", "summon"],
    "summon 是切片 7 第三批加的：复用 ≠ 唤起，已存在的窗口要被拿到面前",
  );
});

test("渲染层不出现 @deepseek-ai/，也不出现第三方裸包", () => {
  for (const [name, text] of [["app.js", appJs], ["bridge-client.js", clientJs]]) {
    assert.ok(!/@deepseek-ai\//.test(text), `${name} 引了宿主包`);
    const specs = [...text.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(specs, [], `${name} 出现了模块引用（渲染层零构建）`);
  }
});

test("降级：桥断时显示空态文案，不伪造读数", () => {
  assert.ok(rendererAll.includes("桥未连接 · 重试中"), "空态文案必须取自规范 6.3");
  assert.ok(rendererAll.includes("还没有消息"), "消息流为空的文案必须取自规范 6.3");
  assert.ok(rendererAll.includes('"–"'), "拿不到数一律显示 –");
});

test("面板接口必须先拿到 sessionId（否则 400，窗口永远停在未连接）", () => {
  // /whale/panel 缺 sessionId 会 400；小窗启动时并不知道自己是哪个会话，
  // 必须先问 /whale/hud（无需参数）拿 activeSessionId。
  assert.match(clientJs, /fetchActiveSessionId/, "必须有「先问活跃会话」这一步");
  assert.match(clientJs, /activeSessionId/, "应读桥给的 activeSessionId");
  assert.match(clientJs, /refreshPanel/, "拿到 id 后再拉面板");
});

test("主进程文件都在", () => {
  for (const file of ["main.cjs", "preload.cjs", "run.ps1", "package.json", "lib/geometry.cjs", "lib/persist.cjs", "lib/recovery.cjs", "lib/window.cjs", "lib/ipc.cjs", "lib/log.cjs", "lib/boot.cjs"]) {
    assert.ok(existsSync(join(WIN, file)), `缺文件 whale-window/${file}`);
  }
});

test("package.json 无运行时依赖（强制 17）", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies, undefined, "运行时依赖必须为 0");
});

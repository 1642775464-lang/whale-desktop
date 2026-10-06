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
const rendererAll = ["app.js", "render.js", "palette.js", "panels.js", "bridge-client.js"]
  .map((f) => read(join("renderer", f)))
  .join("\n");

const hasId = (id) => new RegExp(`id="${id}"`).test(html);

test("顶栏六元素齐全（F2）", () => {
  for (const id of ["btnMin", "btnPin", "btnGear", "btnMenu", "tbTitle"]) {
    assert.ok(hasId(id), `缺元素 #${id}`);
  }
  assert.match(html, /class="brand-dot"/, "工作区色块必须存在");
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

test("会话标题行三元素齐全（F3），角标文案固定", () => {
  assert.ok(hasId("shTitle"), "缺会话标题");
  assert.ok(hasId("shSub"), "缺副标题行");
  assert.match(html, /class="sh-badge">同源会话</, "「同源会话」文案固定，不得改写");
});

test("输入区按钮组齐全（F6）", () => {
  for (const id of ["btnAdd", "btnPerm", "btnUsage", "btnMore", "btnModel", "btnVoice", "btnSend"]) {
    assert.ok(hasId(id), `缺按钮 #${id}`);
  }
});

test("灰色项不得有 hover 反馈（规范 2：不假装能用）", () => {
  assert.match(css, /\.cbtn\.grey:hover\s*\{[^}]*background:\s*#fff/s, "灰色按钮 hover 不该变色");
  assert.match(css, /\.cbtn\.grey\s*\{[^}]*cursor:\s*not-allowed/s, "灰色按钮应给 not-allowed 光标");
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
  const tags = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    tags,
    ["bridge-client.js", "render.js", "palette.js", "panels.js", "app.js"],
    "顺序错了会在启动时抛 ReferenceError（现象是「窗口在、什么都没接上」）",
  );
  // app.js 必须最后：它是装配层，要用到前面每个模块的命名空间
  assert.equal(tags[tags.length - 1], "app.js", "app.js 必须在最后加载");
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

test("preload 不暴露 ipcRenderer 本体，也不开放任意 channel", () => {
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preloadText), "不得直接暴露 ipcRenderer");
  assert.match(preloadText, /exposeInMainWorld\(\s*"whale"/, "必须暴露 window.whale");
  // 不得出现「传什么 channel 就转发什么」的万能入口
  assert.ok(!/invoke\(\s*channel\s*[,)]/.test(preloadText), "不得转发任意 channel");
});

test("窗口动作白名单权威定义在 ipc.cjs，且含 4 个动作", () => {
  const ipc = require(join(WIN, "lib", "ipc.cjs"));
  assert.deepEqual([...ipc.WINDOW_ACTIONS], ["minimize", "hide", "close", "toggle-pin"]);
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

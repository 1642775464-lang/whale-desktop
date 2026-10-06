/**
 * 悬浮条渲染层契约测试
 *
 * 职责：把「渲染层的对外承诺」钉死——DOM 结构、加载顺序、CSP、关键数值、
 *       preload 与主进程通道的一一对应、图标内联与源文件一致。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得单独一层：这些承诺**坏了都不报错**，只是行为悄悄变差——
 *   - CSP 少写 'self' → hud.js 被静默拦截，窗口里只剩字面文本；
 *   - faceB/faceF 顺序反了 → 滚筒偶尔闪出一个错误标题（16ms 窗口）；
 *   - preload 多暴露一个通道而主进程没注册 → 调用是永远挂起的 Promise；
 *   - CSS 数值与规范漂移 → 「差不多的界面」。
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
const HUD = join(ROOT, "whale-hud");

const read = (rel) => readFileSync(join(HUD, rel), "utf8");

/**
 * 去掉 HTML 注释后再做结构断言。
 *
 * 必须去：注释里出现 `<script src="hud.js">` 这类示例（本文件的 CSP 注释就有）
 * 会被正则当成真实标签；反过来，**被注释掉的元素也会被误判为存在**——
 * 那是最危险的假通过。所有对 HTML 的结构检查都走这份「无注释文本」。
 */
const stripComments = (text) => text.replace(/<!--[\s\S]*?-->/g, "");

const html = stripComments(read(join("renderer", "index.html")));
const rawHtml = read(join("renderer", "index.html"));
const css = read(join("renderer", "hud.css"));
const hv = read(join("renderer", "hud.js"));
const bc = read(join("renderer", "bridge-client.js"));

/** DOM id 必须存在。 */
function hasId(id) {
  return new RegExp(`id="${id}"`).test(html);
}

test("五元素 DOM 齐全（A4 的静态侧）", () => {
  for (const id of ["bar", "whaleBtn", "dot", "reel", "segSpeed", "segCtx", "collapseBtn"]) {
    assert.ok(hasId(id), `缺元素 #${id}`);
  }
});

test("可测性约定：class 与 id 与《前端设计规范》第八节一致", () => {
  assert.match(html, /class="whale"/, "鲸鱼图标必须是 class=\"whale\"");
  assert.match(html, /class="seg mono ctx"/, "上下文段必须是 class=\"seg mono ctx\"（悬停触发详情）");
  assert.ok(hasId("hudDetail"), "悬停详情浮层 id 必须是 hudDetail");
});

test("A7：faceB 必须排在 faceF 之前", () => {
  // DOM 顺序决定堆叠：front 必须更上层。写反了会闪出「下一个的下一个」
  const b = html.indexOf('id="faceB"');
  const f = html.indexOf('id="faceF"');
  assert.ok(b !== -1 && f !== -1, "两个面都要在");
  assert.ok(b < f, "faceB 必须在 faceF 之前，否则滚筒会闪假标题");
});

test("悬停详情五行齐全且顺序固定", () => {
  const ids = ["dCtx", "dOut", "dIn", "dCache", "dSteps"];
  let last = -1;
  for (const id of ids) {
    const at = html.indexOf(`id="${id}"`);
    assert.ok(at !== -1, `缺详情行 #${id}`);
    assert.ok(at > last, `详情行顺序错了：#${id}`);
    last = at;
  }
  for (const label of ["上下文占用", "累计输出", "累计输入", "累计缓存读", "步数 / 回合"]) {
    assert.ok(html.includes(label), `缺详情行文案「${label}」`);
  }
});

test("收起箭头朝左（用户点名改过，不得改回）", () => {
  assert.match(html, /points="15 18 9 12 15 6"/, "箭头必须朝左");
});

test("CSP 必须放行 'self'，否则 hud.js / hud.css 被静默拦截", () => {
  const cspMatch = /content="([^"]*default-src[^"]*)"/.exec(html);
  assert.ok(cspMatch !== null, "index.html 必须有 CSP");
  const csp = cspMatch[1];
  assert.match(csp, /script-src[^;]*'self'/, "script-src 必须含 'self'");
  assert.match(csp, /style-src[^;]*'self'/, "style-src 必须含 'self'");
  assert.match(csp, /connect-src[^;]*http:\/\/127\.0\.0\.1/, "只放行回环连接");
  assert.match(csp, /default-src\s+'none'/, "默认必须全禁，再逐项放行");
  // 注意：`http://127.0.0.1:*` 里的 `*` 是通配端口，属于合法写法。
  // 要拦的是**通配主机**（那等于对任何站点开放）。
  assert.ok(!/connect-src[^;]*https?:\/\/\*/.test(csp), "connect-src 不得通配主机");
  assert.ok(!/connect-src[^;]*\s\*/.test(csp), "connect-src 不得写成裸 *");
});

test("脚本加载顺序：各模块先定义、hud.js 最后装配", () => {
  // 只在 <script src> 里找：注释里也提到了文件名，拿全文 indexOf 会误判
  const tags = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    tags,
    ["bridge-client.js", "carousel.js", "drag.js", "hud.js"],
    "加载顺序错了会在启动时抛 ReferenceError",
  );
  // hud.js 必须最后：它是装配层，要用到前面每个模块的命名空间
  assert.equal(tags[tags.length - 1], "hud.js", "hud.js 必须在最后");
});

test("preload 暴露的通道与主进程注册的通道一一对应", () => {
  const ipc = require(join(HUD, "lib", "ipc.cjs"));
  const preloadText = readFileSync(join(HUD, "preload.cjs"), "utf8");

  // 从 preload 的 CHANNELS 字面量里抽出全部通道名
  const preloadChannels = [...preloadText.matchAll(/"hud:[a-z-]+"/g)].map((m) => m[0].slice(1, -1));
  const unique = [...new Set(preloadChannels)].sort();
  const registered = Object.values(ipc.CHANNELS).sort();

  assert.deepEqual(
    unique,
    registered,
    "preload 与主进程的通道必须完全一致：多暴露一个就是永远挂起的 Promise",
  );
});

test("preload 不暴露 ipcRenderer 本体", () => {
  const preloadText = readFileSync(join(HUD, "preload.cjs"), "utf8");
  assert.ok(!/exposeInMainWorld\([^)]*ipcRenderer\s*\)/.test(preloadText), "不得直接暴露 ipcRenderer");
  // 只允许通过具名方法转发；不允许暴露任意 channel 的万能入口
  assert.ok(!/exposeInMainWorld\(\s*["']whale["']/.test(preloadText), "本模块暴露名是 hud，不是 whale");
  assert.match(preloadText, /exposeInMainWorld\(\s*"hud"/, "必须暴露 window.hud");
});

test("F7 右键菜单三项齐全（托盘已移除，这是唯一关闭途径）", () => {
  const ipc = require(join(HUD, "lib", "ipc.cjs"));
  assert.deepEqual(
    ipc.MENU_ITEMS.map((i) => i.id),
    ["reload", "hide", "quit"],
  );
  const labels = ipc.MENU_ITEMS.map((i) => i.label);
  assert.deepEqual(labels, ["重新加载界面", "隐藏悬浮条", "退出悬浮条"]);
});

test("菜单项 id 写错会被抓到（负向验证）", () => {
  const ipc = require(join(HUD, "lib", "ipc.cjs"));
  const template = ipc.createMenuTemplate({ reload: () => {}, hide: () => {}, quit: () => {} });
  assert.equal(template.length, 3);
  for (const item of template) {
    assert.equal(typeof item.click, "function", `${item.id} 缺点击处理，点了会没反应`);
  }
});

test("关键 CSS 值与《前端设计规范》一致（不许「差不多」）", () => {
  const expectations = [
    [/border-radius:\s*26px/, "条圆角 26px（= 高 52 的一半，正胶囊）"],
    [/\.bar\s*\{[^}]*height:\s*52px/s, "条高 52px"],
    [/\.bar\s*\{[^}]*width:\s*560px/s, "条宽 560px"],
    [/\.whale\s*\{[^}]*width:\s*40px/s, "鲸鱼圆底 40×40"],
    [/\.dot\s*\{[^}]*width:\s*8px/s, "状态点 8px"],
    [/\.face\s*\{[^}]*font-size:\s*13\.5px/s, "标题字号 13.5px"],
    [/\.seg\.mono\s*\{[^}]*font-size:\s*15px/s, "速度数字 15px"],
    [/top:\s*88px/, "详情浮层 top:88px"],
    [/width:\s*270px/, "详情浮层宽 270px"],
  ];
  for (const [pattern, why] of expectations) {
    assert.match(css, pattern, `CSS 与规范不符：${why}`);
  }
});

test("阴影是三层的（缺一不可）", () => {
  const barRule = /\.bar\s*\{[^}]*\}/s.exec(css)?.[0] ?? "";
  const layers = (barRule.match(/rgba\(/g) ?? []).length;
  assert.ok(layers >= 3, `条的阴影层数不足（找到 ${layers} 层）`);
});

test("等宽数字段必须垂直居中（基线对齐要配满高行盒）", () => {
  // 用户报过「token 流速与上下文不是上下居中的」。
  // 根因：`.seg.mono` 用 align-items: baseline（为让 tok/s 落在数字基线上，
  // 这是刻意的），但内层 flex 行只撑出内容高（约 24.75px）且**贴着盒子顶部**，
  // 36px 盒子里少掉的那 5.6px 全跑到下面 —— 实测文字中心偏上 **6px**。
  //
  // 修法：数字自己的行盒撑满容器高度（line-height = 盒高），
  // 基线自然落回中心。
  //
  // 这条断言盯住两件事，缺一就会漂回去：
  const monoRule = /\.seg\.mono\s*\{[^}]*\}/s.exec(css)?.[0] ?? "";
  assert.ok(monoRule !== "", "找不到 .seg.mono 规则");
  assert.match(monoRule, /align-items:\s*baseline/, "基线对齐是刻意的排版意图，不能随手改成 center");
  assert.match(
    monoRule,
    /line-height:\s*36px/,
    "行盒必须撑满 36px 盒高，否则内容会贴顶、看起来偏上 6px",
  );

  // 单位（tok/s）要贴基线，所以它自己必须是紧行高——
  // 否则它的行盒会把整行撑出去，居中又被破坏
  const unitRule = /\.seg\.mono\s+\.unit\s*\{[^}]*\}/s.exec(css)?.[0] ?? "";
  assert.ok(unitRule !== "", "找不到 .seg.mono .unit 规则");
  assert.match(unitRule, /line-height:\s*1\b/, "单位必须紧行高，不参与撑行");
  assert.doesNotMatch(unitRule, /line-height:\s*36px/, "单位不该撑满盒高——那样会顶偏数字");
});

test("收起态自己声明 scaleX(0)，且 overflow 可见", () => {
  // 陷阱 1：靠动画的 forwards 停留态，摘掉动画类会连填充一起消失
  assert.match(css, /body\.collapsed\s+\.bar\s*\{[^}]*transform:\s*scaleX\(0\)/s, "终态必须由 .collapsed 自己声明");
  assert.match(css, /body\.collapsed\s*\{[^}]*overflow:\s*visible/s, "陷阱 2：收起态必须 overflow:visible");
});

test("图标挪到 body 下时按球的坐标定位（陷阱 3 的唯一解）", () => {
  assert.match(css, /body\s*>\s*\.whale\s*\{[^}]*left:\s*24px/s, "球内左边距 24px");
  assert.match(css, /body\s*>\s*\.whale\s*\{[^}]*top:\s*12px/s, "球内上边距 12px");
});

test("完成提醒是位移类动画（脉冲已被用户否决）", () => {
  assert.match(css, /@keyframes\s+hud-shake/, "震动必须有 keyframes");
  const shake = /@keyframes\s+hud-shake\s*\{[\s\S]*?\n\}/.exec(css)?.[0] ?? "";
  assert.match(shake, /margin-left/, "位移类：必须动位置");
  assert.ok(!/scale\(/.test(shake), "不得用缩放（那是脉冲的做法）");
});

test("渲染层不出现 @deepseek-ai/，也不出现第三方裸包", () => {
  for (const [name, text] of [["hud.js", hv], ["bridge-client.js", bc]]) {
    assert.ok(!/@deepseek-ai\//.test(text), `${name} 引了宿主包`);
    const specs = [...text.matchAll(/(?:from\s+|require\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    assert.deepEqual(specs, [], `${name} 出现了模块引用（渲染层零构建）`);
  }
});

test("降级：桥断时显示空态文案，不伪造读数", () => {
  assert.ok(hv.includes("桥未连接 · 重试中"), "空态文案必须取自规范 6.3");
  assert.ok(hv.includes('"–"'), "拿不到数一律显示 –");
});

test("鲸鱼图标内联结果与 favicon-whale.svg 一致", () => {
  const icon = require(join(ROOT, "tools", "whale-icon.mjs"));
  // 用原文比对：标记块本身在注释里，去注释会把整块挖空
  assert.equal(icon.currentBlock(rawHtml), icon.expectedBlock(), "图标漂移了，请跑 node tools/whale-icon.mjs");
});

test("图标内联块里的 path 数据非空（防止「鲸鱼不见了」）", () => {
  const block = /<!-- WHALE_ICON_START -->([\s\S]*?)<!-- WHALE_ICON_END -->/.exec(rawHtml);
  assert.ok(block !== null, "找不到图标标记块");
  const d = /<path d="([^"]+)"/.exec(block[1]);
  assert.ok(d !== null && d[1].length > 200, "path 数据缺失或过短");
});

test("鲸鱼点击是**切换**语义，不只是唤起（F2①）", () => {
  // PRD F2①：单击唤起小窗；**小窗已在跑时再点收起**。
  // 曾经函数名叫 toggle、实现却只调 openSmallWindow —— 表现是
  // 「点几次都只是重新唤起，永远关不掉」，用户报过一次。
  //
  // ⚠️ 这一条**不能只查「两个方法名都出现过」**。
  // 我第一次就是这么写的，随后做注入验证（把切换改回只唤起）时它照样全绿——
  // 因为注入只改了调用关系、方法名仍在文件里，那种断言是空壳。
  // 所以这里必须查到**真实的条件分支结构**。
  const toggle = /function toggleSmallWindow[\s\S]*?\n  \}/.exec(hv);
  assert.ok(toggle !== null, "找不到 toggleSmallWindow");
  const body = toggle[0];

  assert.match(body, /isSmallWindowRunning/, "必须先问真实运行态");
  // 必须有「据运行态二选一」的结构，两种写法都接受：
  //   三元：running ? closeSmallWindow() : openSmallWindow()
  //   分支：if (running) { ...close } else { ...open }
  const ternary = /running\s*\?\s*client\.closeSmallWindow\(\)/.test(body) &&
    /:\s*client\.openSmallWindow\(\)/.test(body);
  assert.ok(
    ternary || hasToggleBranch(body),
    "切换必须按运行态真的二选一：在跑调 closeSmallWindow、没跑调 openSmallWindow。"
      + "只让两个方法名出现是不够的（曾因此漏判）。",
  );
});

/**
 * 判断一段代码里是否有「据 running 真的二选一」的分支结构。
 *
 * 单独提出来是为了让主断言与负向验证**共用同一条规则**——
 * 规则若在两处各写一遍，改了一处忘了另一处时负向验证会失真。
 *
 * @param {string} body
 * @returns {boolean}
 */
function hasToggleBranch(body) {
  const ifElse = /if\s*\([^)]*running[^)]*\)\s*\{[\s\S]*?closeSmallWindow[\s\S]*?\}\s*else\s*\{[\s\S]*?openSmallWindow/;
  const ternary = /running\s*\?\s*client\.closeSmallWindow\(\)[\s\S]*?:\s*client\.openSmallWindow\(\)/;
  return ifElse.test(body) || ternary.test(body);
}

test("负向验证：只唤起不收起确实会被上一条规则抓到", () => {
  // 规则若是空壳（永远通过），上面那条断言毫无意义。
  // 这里直接喂一段「只唤起」的实现，确认它被判为不合格。
  const bad = `function toggleSmallWindow() {
    client.isSmallWindowRunning().then((running) => {
      const action = client.openSmallWindow(); void running; void client.closeSmallWindow;
      return action;
    });
  }`;
  const good = `function toggleSmallWindow() {
    client.isSmallWindowRunning().then((running) => {
      const action = running ? client.closeSmallWindow() : client.openSmallWindow();
      return action;
    });
  }`;
  assert.equal(hasToggleBranch(bad), false, "「只唤起」必须被判不合格");
  assert.equal(hasToggleBranch(good), true, "真正的切换应通过");
});

test("判定「在跑」要问桥，不靠本地猜（小窗可被用户自己关掉）", () => {
  assert.match(bc, /isSmallWindowRunning/, "桥客户端必须提供运行态查询");
  assert.match(hv, /isSmallWindowRunning/, "切换前必须查真实运行态");
  // 查询要读 target 字段（泛化后窗口表里同时有 hud 与 window）
  assert.match(bc, /w\.target === "window"/, "必须按 target 区分，否则会把悬浮条自己算成小窗");
});

test("外圈绿环 = 小窗在跑（F2①），且跟随现实", () => {
  assert.match(hv, /renderWhaleRing/, "必须有绿环渲染");
  assert.match(hv, /classList\.toggle\("on"/, "绿环用 .on 类");
  // 用户从小窗自己退出后绿环也得灭 —— 需要定时核对
  assert.match(hv, /RING_WATCH_MS/, "必须有定期核对，否则指示会停在错的态");
  assert.match(hv, /setInterval/, "核对要周期性跑，不能只在点击时更新");
});

test("收起失败要红闪（不静默）", () => {
  const toggle = /function toggleSmallWindow[\s\S]*?\n  \}/.exec(hv);
  assert.ok(toggle !== null);
  assert.match(toggle[0], /flashFail/, "失败必须红闪");
  assert.match(toggle[0], /console\.warn/, "失败必须留可查痕迹");
});

test("结构断言确实去掉了注释（负向验证）", () => {
  // 若注释没被去掉，「被注释掉的元素」会被误判为存在——最危险的假通过
  const sample = '<div id="real"></div><!-- <div id="ghost"></div> -->';
  const clean = stripComments(sample);
  assert.match(clean, /id="real"/);
  assert.ok(!/id="ghost"/.test(clean), "注释里的元素必须被排除");
  // 本文件的 HTML 注释里确实出现过 <script src="hud.js">，正好是这条规则的实战样例
  assert.ok(rawHtml.includes("<script src=\"hud.js\">"), "样例前提不成立，说明注释被改过了");
});

test("主进程文件都在（渲染层契约的前提）", () => {
  for (const file of ["main.cjs", "preload.cjs", "run.ps1", "package.json", "lib/geometry.cjs", "lib/state.cjs", "lib/window.cjs", "lib/ipc.cjs", "lib/log.cjs"]) {
    assert.ok(existsSync(join(HUD, file)), `缺文件 whale-hud/${file}`);
  }
});

test("package.json 无运行时依赖（强制 17）", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.dependencies, undefined, "运行时依赖必须为 0");
  assert.equal(pkg.devDependencies, undefined, "开发依赖统一在仓库根");
});

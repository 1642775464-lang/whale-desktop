/**
 * 页面内小鲸鱼按钮契约测试
 *
 * 职责：钉住按钮的对外契约——挂哪个槽、图标是否与源文件一致、
 *       单击是否真的请求桥拉起两个目标。
 * 所属层：测试（tests/contract）
 *
 * 为什么值得单独一条：按钮是**跨层**的（页面浮层 → HTTP → 桥 → 子进程），
 * 每一层都可能悄悄错开：
 *   - 槽位写错 → 按钮不出现，且不报错
 *   - 忘了 pointerEvents → 按钮看得见点不动
 *   - 只拉一个目标 → PRD F8 的「同时拉起」不成立
 * 这三条都在这里变成机械断言。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

const clientJs = read(join("whale-bridge", "lib", "client.js"));
const pkg = JSON.parse(read(join("whale-bridge", "package.json")));
const patch = read(join("whale-bridge", "cordis.patch.yml"));
const svg = read(join("whale-hud", "renderer", "favicon-whale.svg"));
const buttonReadme = read(join("whale-button", "README.md"));

test("客户端入口已在 package.json 声明（漏了按钮根本不加载）", () => {
  assert.equal(pkg.exports?.["./client"], "./lib/client.js", "必须导出 ./client");
  assert.equal(pkg.dsh?.client?.platform, "web", "客户端平台必须是 web");
  assert.equal(pkg.dsh?.client?.immediately, true, "必须立即加载（否则要点开某个面板才出现）");
  assert.ok(pkg.dsh?.bundle?.patch, "必须声明 bundle 补丁");
});

test("宿主入口没被破坏（同一个包两个半侧）", () => {
  assert.equal(pkg.main, "host.js", "宿主半侧入口仍是 host.js");
  assert.equal(pkg.exports?.["."], "./host.js");
  // 文件清单要同时包含两侧
  assert.ok(pkg.files.includes("host.js"), "files 必须含宿主入口");
  assert.ok(pkg.files.includes("lib"), "files 必须含 lib（客户端入口在 lib 下）");
});

test("bundle 补丁插入的 id 与包名一致", () => {
  assert.match(patch, /- id: whale-bridge/, "补丁必须插入 whale-bridge 这一行");
  assert.match(patch, /name: "whale-bridge"/, "name 必须与包名一致，否则解析不到");
});

test("按钮挂在 shell.overlay 槽（PRD F8 指定）", () => {
  assert.match(clientJs, /shell\.overlay/, "必须挂 shell.overlay");
  assert.match(clientJs, /ctx\.slots\.register\(/, "必须走 slots.register");
  assert.match(clientJs, /id: "whale-button"/, "槽位条目 id 固定为 whale-button");
});

test("模块注册 id 必须等于包名（否则模块表对不上）", () => {
  assert.match(
    clientJs,
    /__ModuleLoader__\.load\(\{\s*\n\s*id: "whale-bridge"/,
    "loader 的 id 必须等于包名 whale-bridge",
  );
});

test("pointerEvents: auto 必须写（这一层是 click-through，漏了按钮点不动）", () => {
  // 宿主原文：The layer itself is click-through — entries opt back into pointer events
  assert.match(
    clientJs,
    /pointerEvents:\s*"auto"/,
    "shell.overlay 是穿透层，条目必须自己开指针事件，否则看得见点不动且不报错",
  );
});

test("图标：按钮里的鲸鱼路径与源 svg 逐字符一致", () => {
  const svgPath = /d="([^"]{100,})"/.exec(svg)?.[1];
  const btnPath = /const WHALE_PATH_D\s*=\s*"([^"]{100,})"/.exec(clientJs)?.[1];
  assert.ok(svgPath !== undefined, "源 svg 里应有长 path");
  assert.ok(
    btnPath !== undefined,
    "按钮里应有已注入的 path；若是空串说明忘了跑 tools/whale-btn-icon.mjs",
  );
  assert.equal(btnPath, svgPath, "同一产品只许有一枚鲸鱼，形状必须一致");
});

test("viewBox 与源 svg 一致（否则鲸鱼会被裁切或缩得极小）", () => {
  const svgViewBox = /viewBox="([^"]+)"/.exec(svg)?.[1];
  assert.ok(svgViewBox !== undefined, "源 svg 应有 viewBox");
  assert.ok(
    clientJs.includes(`viewBox: "${svgViewBox}"`),
    `按钮的 viewBox 必须是 "${svgViewBox}"，与源文件一致`,
  );
});

test("尺寸 40×40 圆形（前端设计规范 §五）", () => {
  assert.match(clientJs, /const SIZE = 40;/, "尺寸常量应为 40");
  assert.match(clientJs, /borderRadius:\s*"50%"/, "必须是圆形");
});

test("单击同时请求拉起两个目标（PRD F8：同时拉起悬浮条与小窗）", () => {
  // 两个目标都要出现
  assert.match(clientJs, /askBridgeToOpen\("hud"\)/, "必须请求拉起悬浮条");
  assert.match(clientJs, /askBridgeToOpen\("window"\)/, "必须请求拉起小窗");
  // 且是并行的（串行会让用户感觉到先后）
  assert.match(clientJs, /Promise\.all\(/, "两个请求应并行发出，不要串行等待");
});

test("只走 HTTP，不 require 宿主包、不自己起进程（铁律 A-2）", () => {
  assert.match(clientJs, /fetch\(/, "必须用 fetch 走桥");
  assert.doesNotMatch(clientJs, /require\(["']node:/, "客户端半侧不得 require Node 内置模块");
  assert.doesNotMatch(clientJs, /child_process/, "不得自己 spawn 进程——拉起窗口是桥的职责");
  assert.doesNotMatch(clientJs, /@deepseek-ai\//, "不得 require 宿主包（铁律 A-1）");
});

test("请求体带 target 与 reason，且指向回环地址", () => {
  assert.match(clientJs, /127\.0\.0\.1:19387/, "桥地址必须是回环地址");
  assert.match(clientJs, /body: JSON\.stringify\(\{ target, reason: "button" \}\)/, "请求体形状固定");
});

test("失败不静默（点不动时用户会以为插件坏了）", () => {
  assert.match(clientJs, /console\.warn\(/, "拉起失败必须留下可查的痕迹");
});

test("whale-button/README 指向真实实现位置", () => {
  assert.match(buttonReadme, /whale-bridge\/lib\/client\.js/, "说明必须指向真实实现");
  assert.match(buttonReadme, /轻量架构草案/, "必须说明归属依据");
});

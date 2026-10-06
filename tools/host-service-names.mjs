/**
 * 宿主真实服务名勘察
 *
 * 职责：用宿主的 cordis 起一个最小 Context，列出**真实注册的服务名**，
 *       而不是从别人的 inject 清单里猜。
 * 所属层：工程工具（tools/）
 *
 * 为什么要做：我给桥声明的 inject 里有 `projections` 与 `models` 两个
 * 带猜测成分的名字。Cordis 的语义是「inject 里声明的服务未就绪就不 apply」——
 * 一个不存在的名字会让插件**永远不被启动**，且不报错。
 * 与其继续猜，不如把真实名单拉出来。
 *
 * 用法：node tools/host-service-names.mjs
 */

import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";

const APP = "C:/Program Files/DSH Desktop/resources/app";
const MODULES = path.join(APP, "node_modules", "@deepseek-ai");

const report = {};

// ── 方法一：扫宿主源码里所有 service 注册（ctx.provide / Service 定义）──
const names = new Set();
const patterns = [
  /\.provide\(\s*["']([a-zA-Z][\w]*)["']/g,
  /Service\.define\(\s*["']([a-zA-Z][\w]*)["']/g,
  /ctx\.set\(\s*["']([a-zA-Z][\w]*)["']/g,
];

/** 递归收集 .js 文件。 */
function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      walk(full, out, depth + 1);
    } else if (e.name.endsWith(".js")) {
      out.push(full);
    }
  }
  return out;
}

const files = walk(MODULES);
report.scannedFiles = files.length;

for (const f of files) {
  let text;
  try {
    text = fs.readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const re of patterns) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      names.add(m[1]);
    }
  }
}

report.providedNames = [...names].sort();

// ── 方法二：直接问 cordis 的 RegistryService 有哪些已注册名 ──
try {
  const cordis = await import(pathToFileURL(path.join(MODULES, "cordis", "lib", "index.js")).href);
  report.cordisLoaded = true;
  if (typeof cordis.Context === "function") {
    const ctx = new cordis.Context();
    // registry 上可能挂着已有服务
    const keys = Object.keys(ctx);
    report.contextKeys = keys.slice(0, 40);
    if (ctx.registry) {
      report.registryKeys = Object.keys(ctx.registry).slice(0, 60);
    }
  }
} catch (err) {
  report.cordisError = err.message;
}

// ── 我关心的几个名字到底存不存在 ──
const wanted = [
  "sessions",
  "agents",
  "commands",
  "sessionProjections",
  "projections",
  "attachments",
  "models",
];
report.wanted = Object.fromEntries(
  wanted.map((w) => [
    w,
    {
      inProvided: names.has(w),
      inRegistry: Array.isArray(report.registryKeys) ? report.registryKeys.includes(w) : null,
    },
  ]),
);

console.log(`SERVICE_NAMES ${  JSON.stringify(report, null, 2)}`);

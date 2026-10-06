/**
 * 装插件后的加载预演
 *
 * 职责：模拟宿主的解析方式——从 profile 的 node_modules 里 require 到
 *       whale-bridge，确认它真的能被加载、并且导出形状符合插件契约。
 * 所属层：工程工具（tools/）
 *
 * 为什么必须做：配置写对了不等于**包能解析到**。link: 依赖没链上、
 * 或包名与 insert 的 name 不一致时，宿主启动后插件加载会失败——
 * 而那是在重启之后才会发现的事。
 *
 * 用法：node tools/host-load-dryrun.mjs
 */

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const PROFILE = "C:/Users/Administrator/.dsh/profiles/desktop";
const report = {};

// ── 1) 解析路径：宿主会从 profile 的 node_modules 找 "whale-bridge" ──
const resolved = path.join(PROFILE, "node_modules", "whale-bridge");
report.resolvedPath = resolved;
report.exists = fs.existsSync(resolved);

if (report.exists) {
  const stat = fs.lstatSync(resolved);
  report.isSymlink = stat.isSymbolicLink();
  report.linkTarget = report.isSymlink ? fs.readlinkSync(resolved) : null;
}

// ── 2) 读它的 package.json，确认 main 指向真实文件 ──
const pkgFile = path.join(resolved, "package.json");
if (fs.existsSync(pkgFile)) {
  const pkg = JSON.parse(fs.readFileSync(pkgFile, "utf8"));
  report.packageName = pkg.name;
  report.packageMain = pkg.main;
  report.packageType = pkg.type;
  const mainFile = path.join(resolved, pkg.main ?? "index.js");
  report.mainExists = fs.existsSync(mainFile);
}

// ── 3) 真加载一次，核对插件契约 ──
try {
  const require2 = createRequire(pathToFileURL(path.join(PROFILE, "index.js")).href);
  let mod;
  try {
    // 宿主是 ESM 加载器；这里也走 import
    mod = await import(pathToFileURL(path.join(resolved, "host.js")).href);
  } catch (err) {
    report.importError = err.message;
  }
  if (mod !== undefined) {
    report.exports = {
      name: mod.name,
      applyType: typeof mod.apply,
      disposeType: typeof mod.dispose,
    };
    // 契约：插件必须有 name（字符串）与 apply（函数）
    report.contractOk = typeof mod.name === "string" && typeof mod.apply === "function";
  }
  void require2;
} catch (err) {
  report.loadError = err.message;
}

// ── 4) 配置里 insert 的 name 必须与包名一致 ──
const yamlText = fs.readFileSync(path.join(PROFILE, "cordis.patch.yml"), "utf8");
const m = /- insert:\s*\r?\n\s*- id: whale-bridge\s*\r?\n\s*name:\s*"([^"]+)"/.exec(yamlText);
report.insertName = m === null ? null : m[1];
report.nameMatchesPackage = report.insertName === report.packageName;

report.verdict =
  report.exists === true &&
  report.mainExists === true &&
  report.contractOk === true &&
  report.nameMatchesPackage === true
    ? "pass"
    : "fail";

console.log(`LOAD_DRYRUN ${  JSON.stringify(report, null, 2)}`);
process.exit(report.verdict === "pass" ? 0 : 1);

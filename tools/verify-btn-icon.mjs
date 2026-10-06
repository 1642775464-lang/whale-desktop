/**
 * 独立核对：按钮里的鲸鱼路径与源 svg 是否逐字符一致
 *
 * 职责：不复用工具自己的比对逻辑，独立读两个文件比一次。
 * 所属层：工程工具（tools/）
 *
 * 为什么要独立核：工具的 --check 用的是它自己的抽取函数。
 * 万一抽取函数两边都错（比如正则同时匹配到别的东西），
 * 自校验会一致地通过而错得一致。所以这里另写一遍抽取。
 *
 * 用法：node tools/verify-btn-icon.mjs
 */

import { readFileSync } from "node:fs";

const svgText = readFileSync("whale-hud/renderer/favicon-whale.svg", "utf8");
const clientText = readFileSync("whale-bridge/lib/client.js", "utf8");

// 独立抽取（与工具里的正则写法不同，故意换一种）
const svgMatch = /d="([^"]{100,})"/.exec(svgText);
const clientMatch = /const WHALE_PATH_D\s*=\s*"([^"]{100,})"/.exec(clientText);

const report = {
  svgFound: svgMatch !== null,
  clientFound: clientMatch !== null,
};

if (report.svgFound && report.clientFound) {
  const a = svgMatch[1];
  const b = clientMatch[1];
  report.svgLen = a.length;
  report.clientLen = b.length;
  report.identical = a === b;
  // 报告首个差异位置，便于定位
  if (!report.identical) {
    let i = 0;
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i += 1;
    report.firstDiffAt = i;
    report.svgSnippet = a.slice(Math.max(0, i - 20), i + 20);
    report.clientSnippet = b.slice(Math.max(0, i - 20), i + 20);
  }
} else {
  report.svgIsPlaceholder = /const WHALE_PATH_D\s*=\s*""/.test(clientText);
}

report.verdict = report.identical === true ? "pass" : "fail";
console.log(`VERIFY_BTN_ICON ${  JSON.stringify(report, null, 2)}`);
process.exit(report.verdict === "pass" ? 0 : 1);

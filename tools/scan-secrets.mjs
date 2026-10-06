/**
 * 闸门 4 · 密钥扫描
 *
 * 职责：扫描仓库中被 git 跟踪的文件，检出疑似凭证。
 * 所属层：工程工具（tools/）
 *
 * 退出码：0 = 通过；1 = 发现问题
 *
 * 用法：node tools/scan-secrets.mjs
 */

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

/**
 * 每个模式：名称、正则、是否只看赋值形态。
 * 正则一律带 g 标志以便逐行多次匹配。
 */
const PATTERNS = [
  { name: "私钥块", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "AWS Access Key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: "GitHub Token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { name: "OpenAI 风格密钥", re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: "Slack Token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { name: "Google API Key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: "JWT", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { name: "带密码的连接串", re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s:@/]{6,}@/gi },
  {
    name: "硬编码赋值",
    re: /\b(api[_-]?key|apikey|secret|passwd|password|token|credential)\b\s*[:=]\s*["'`]([^"'`\s]{12,})["'`]/gi,
  },
];

/** 二进制或体积过大的文件跳过。 */
const SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp",
  ".zip", ".gz", ".zst", ".7z", ".rar", ".exe", ".dll", ".node",
  ".woff", ".woff2", ".ttf", ".otf", ".mp4", ".mp3", ".pdf",
]);

const MAX_BYTES = 2 * 1024 * 1024;

/** 占位值不算凭证。 */
const PLACEHOLDER = /^(your|xxx+|todo|placeholder|changeme|example|test|dummy|fake|\*+|-+|\.\.\.)$/i;

function trackedFiles() {
  try {
    const out = execFileSync("git", ["ls-files", "-z"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split("\0").filter(Boolean);
  } catch (err) {
    console.error("无法执行 git ls-files，请确认当前目录是 git 仓库。");
    console.error(String(err.message ?? err));
    process.exit(2);
  }
}

function scanFile(path) {
  const hits = [];

  const ext = extname(path).toLowerCase();
  if (SKIP_EXT.has(ext)) return hits;

  let stat;
  try {
    stat = statSync(path);
  } catch {
    return hits;
  }
  if (stat.size > MAX_BYTES) return hits;

  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return hits;
  }

  // 逐行扫描，便于报出行号。
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过明显的注释示例行
    for (const { name, re } of PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line)) !== null) {
        const captured = m[2] ?? m[1] ?? m[0];
        if (PLACEHOLDER.test(String(captured).trim())) continue;
        hits.push({ name, line: i + 1, text: line.trim().slice(0, 120) });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
    }
  }
  return hits;
}

let total = 0;
for (const path of trackedFiles()) {
  const hits = scanFile(path);
  if (hits.length === 0) continue;
  for (const h of hits) {
    total++;
    console.error(`[密钥] ${path}:${h.line}  ${h.name}`);
    console.error(`        ${h.text}`);
  }
}

if (total > 0) {
  console.error(`\n闸门 4 失败：发现 ${total} 处疑似凭证。`);
  console.error("凭证绝不进仓库。请移入环境变量，并检查是否已进入历史提交。");
  process.exit(1);
}

console.log("闸门 4 通过：未发现凭证。");

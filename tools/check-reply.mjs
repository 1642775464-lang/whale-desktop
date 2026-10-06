/**
 * 正文守门器
 *
 * 职责：检查「准备发给用户的回复正文」是否混入了内部摘要类内容
 *       （<analysis> / <summary> / 复盘 / 进度罗列等），命中即拦下。
 * 所属层：工程工具（tools/）
 *
 * 为什么要有这个工具：这是一条**硬性交付纪律**，反复被违反过三次。
 * 靠"记得"是不可靠的——所以改成机械化检查：把正文交给它，
 * 它只回答「能不能发」。这样纪律不再依赖自觉。
 *
 * 用法：
 *   node tools/check-reply.mjs --file <正文文件>
 *   echo "正文" | node tools/check-reply.mjs -
 *   node tools/check-reply.mjs --selftest     自检：验证规则真的能拦
 *
 * 退出码：0 = 可以发；1 = 命中了禁止内容
 */

import { readFileSync } from "node:fs";

/**
 * 禁止形态清单。
 *
 * 每条都是**具体的、可机械识别的**特征，不是模糊的"不要写总结"。
 * 之所以列这么细：笼统的规则执行时会自我宽容，具体的特征无法辩解。
 */
const RULES = [
  {
    id: "analysis-tag",
    label: "分析块标记",
    // 与 XML/HTML 标签同理，但只针对内部备忘用的那几个标记
    pattern: /<\/?(analysis|summary|thinking|scratchpad|internal)\b[^>]*>/i,
    hint: "内部备忘块标记不得出现在回复正文里",
  },
  {
    id: "summary-heading",
    label: "摘要/复盘小标题",
    // 行首形如 "Summary"、"摘要："、"## 复盘"、"Summary: 我改了三个文件"
    // 注意必须用 [ \t]* 而不是 \s*：\s 会吃掉换行，导致整块文本被当成一行
    pattern: /^[ \t]*(#{1,6}[ \t]*)?(\d+\.[ \t]*)?((summary|analysis)\b|摘要|复盘|回顾|内部备忘)[^\S\r\n]*[:：]?/im,
    hint: "「摘要 / 复盘 / Summary」类小标题属于内部内容",
  },
  {
    id: "numbered-request-block",
    label: "分条需求复述块",
    // 形如 "1. **Primary Request and Intent:**" —— 这是压缩备忘的典型开头。
    // 多段拼是为了绕开 max-len：一条正则拆成若干段，语义不变
    pattern: new RegExp(
      "^\\s*\\d+\\.\\s*\\*\\*(primary request|key technical concepts|files and code sections"
        + "|errors and fixes|problem solving|all user messages|pending tasks"
        + "|current work|optional next step)",
      "im",
    ),
    hint: "这是上下文备忘的固定分节，绝不是给用户看的内容",
  },
  {
    id: "todo-recital",
    label: "内部工作流水复述",
    // 「我读了X、我改了Y、接下来做Z」式的清单
    pattern: /^\s*[-*]\s*(我(已)?(读|看)了|我(已)?(改|写)了|接下来(我)?(要|将)?(做|改|写))/m,
    hint: "逐条复述自己读了什么改了什么，属于内部流水",
  },
];

/**
 * 检查一段正文。
 *
 * @param {string} text 准备发送的回复正文
 * @returns {{ok: boolean, hits: Array<{id: string, label: string, hint: string, line: number, excerpt: string}>}}
 */
export function checkReply(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const hits = [];

  for (const rule of RULES) {
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      // 单行规则用 test；跨行规则（rare）用整体匹配定位行号
      if (rule.pattern.test(line)) {
        hits.push({
          id: rule.id,
          label: rule.label,
          hint: rule.hint,
          line: i + 1,
          excerpt: line.trim().slice(0, 60),
        });
      }
    }
  }

  return { ok: hits.length === 0, hits };
}

/**
 * 自检：用正反样例证明规则不是空壳。
 *
 * 为什么要自检：一条永远返回"通过"的规则比没有规则更危险——
 * 它会让人以为纪律被执行了。正样例必须被拦，反样例必须放行。
 *
 * @returns {{pass: boolean, detail: string[]}}
 */
export function selfTest() {
  const badSamples = [
    "<analysis>\n用户要求实现切片 3\n</analysis>",
    "Summary: 我改了三个文件",
    "## 复盘\n这轮做了什么",
    "- 我读了 host.js\n- 我改了 server.mjs",
    "1. **Primary Request and Intent:** 用户要求从零实施",
    "3. **Files and Code Sections:**\n- whale-bridge/host.js",
  ];

  const goodSamples = [
    "切片 3 冒烟测试四处失败已定位，全部是测试自身写错，产品代码没问题。",
    "六道闸门全过，225 个测试全绿，已提交。",
    "**结论**：SSE 双端点已通，事件 1 秒内到达。",
    "要不要我继续？",
    "// 下面这段是代码注释，说的是 summary 字段的取值",
  ];

  const detail = [];
  let pass = true;

  for (const s of badSamples) {
    const r = checkReply(s);
    if (r.ok) {
      pass = false;
      detail.push(`✖ 漏放（应拦未拦）：${JSON.stringify(s.slice(0, 40))}`);
    } else {
      detail.push(`✔ 拦住 [${r.hits[0].id}]：${JSON.stringify(s.slice(0, 40))}`);
    }
  }

  for (const s of goodSamples) {
    const r = checkReply(s);
    if (!r.ok) {
      pass = false;
      detail.push(`✖ 误伤（应放却拦）[${r.hits[0].id}]：${JSON.stringify(s.slice(0, 40))}`);
    } else {
      detail.push(`✔ 放行：${JSON.stringify(s.slice(0, 40))}`);
    }
  }

  return { pass, detail };
}

/** 读取输入：文件或 stdin。 */
function readInput(args) {
  const idx = args.indexOf("--file");
  if (idx >= 0) {
    const p = args[idx + 1];
    if (p === undefined) throw new Error("--file 需要一个路径");
    return readFileSync(p, "utf8");
  }
  if (args.includes("-")) {
    return readFileSync(0, "utf8");
  }
  throw new Error("用法：node tools/check-reply.mjs --file <路径> | - | --selftest");
}

// 直接执行时（被 import 时不跑）
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("check-reply.mjs")) {
  const args = process.argv.slice(2);

  if (args.includes("--selftest")) {
    const r = selfTest();
    for (const line of r.detail) console.log(line);
    console.log(r.pass ? "\n自检通过：规则确实能拦、也确实不误伤。" : "\n自检失败：规则有问题。");
    process.exit(r.pass ? 0 : 1);
  }

  let text;
  try {
    text = readInput(args);
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  const result = checkReply(text);
  if (result.ok) {
    console.log("正文检查通过，可以发送。");
    process.exit(0);
  }

  console.error("正文检查未通过——检测到内部摘要类内容，禁止发送：\n");
  for (const h of result.hits) {
    console.error(`  [${h.id}] ${h.label}  第 ${h.line} 行`);
    console.error(`    ${h.hint}`);
    console.error(`    命中：${h.excerpt}`);
  }
  process.exit(1);
}

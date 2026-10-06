/**
 * 预提交钩子
 *
 * 职责：git commit 前执行六道闸门，不过则阻止提交。
 * 所属层：工程工具（tools/）
 *
 * 安装方式（不依赖 husky）：
 *   git config core.hooksPath .githooks
 *
 * 说明：闸门 4/5/6 是底线闸门，任一不过即拒绝提交（开发规范 强制 23）。
 */

import { spawnSync } from "node:child_process";

const res = spawnSync(process.execPath, ["tools/gate.mjs", "--commit"], {
  encoding: "utf8",
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (res.status !== 0) {
  console.error("");
  console.error("预提交钩子：闸门未全过，提交已被阻止。");
  console.error("如需临时跳过（不推荐）：git commit --no-verify");
  process.exit(1);
}

process.exit(0);

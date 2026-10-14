/**
 * 小窗与侧窗的**外观一致性**契约
 *
 * 职责：钉住两侧**必须一致**的那些数值（顶栏高度、输入框字号行高）
 *       与**必须一致的行为**（滚动条隐藏但保留滚动）。
 * 所属层：测试（tests/contract）
 *
 * ## 为什么单独成文件
 *
 * 这些断言的共同点是「**跨两个 CSS 文件**」：`skin.css`（主窗）与
 * `side-skin.css`（侧窗）。侧窗贴在主窗右边、两块看起来是一条面板，
 * 任何一处改了另一处没改，就会在交界处露馅 —— 而这类不一致
 * **只有真窗口渲染才看得见**，纯读 CSS 文本发现不了。
 *
 * 原先它们挤在 `window-renderer.test.mjs` 里把那个文件顶过了
 * 500 行上限（强制 14），按「跨窗口一致性」这一职责拆出来。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RENDERER = join(ROOT, "whale-window", "renderer");

const mainSkin = readFileSync(join(RENDERER, "skin.css"), "utf8");
const sideSkin = readFileSync(join(RENDERER, "side-skin.css"), "utf8");

test("侧窗顶栏高度与小窗一致（两块连成一条面板，差一截就是台阶）", () => {
  /*
   * 用户报「侧边栏和小窗的顶栏高度需要对齐」。
   *
   * 侧窗贴在小窗右边、两块看起来是**一条面板** —— 顶栏高度只要不一样，
   * 交界处就会出现明显的台阶。这两个数字分在两个 CSS 文件里
   * （改一处忘另一处是最容易发生的事），所以用测试钉死。
   */
  const mainTop = /\.topbar\s*\{[^}]*?height:\s*(\d+)px/.exec(mainSkin);
  const sideTop = /\.sbar\s*\{[^}]*?height:\s*(\d+)px/.exec(sideSkin);
  assert.ok(mainTop !== null, "找不到小窗顶栏高度");
  assert.ok(sideTop !== null, "找不到侧窗顶栏高度");
  assert.equal(
    sideTop[1], mainTop[1],
    `侧窗顶栏 ${sideTop[1]}px 与小窗 ${mainTop[1]}px 不一致 —— 会露出台阶`,
  );
});

test("两个窗口都隐藏滚动条但保留滚动（用户要「无感」）", () => {
  /*
   * 用户要求：「所有的涉及上下滑动查看的，都不需要滚动条，做成无感的，
   * 鼠标滚轮滚动就行」。
   *
   * ⚠️ 两条规则都要有：只写 `::-webkit-scrollbar { width: 0 }` 时，
   * 新版 Chromium 里滚动条**仍然占位**（约 15px），内容区会无端窄一截 ——
   * 那正是用户此前看到「浏览器比例不对」的来源之一。
   *
   * 也**不能**用 `overflow: hidden` 代替：那会连滚动都没了，
   * 与「滚轮滚动就行」正好相反。
   */
  for (const file of ["skin.css", "side-skin.css"]) {
    const css = readFileSync(join(RENDERER, file), "utf8");
    assert.match(css, /::-webkit-scrollbar\s*\{[^}]*width:\s*0/, `${file} 缺「压成 0 宽」`);
    assert.match(css, /scrollbar-width:\s*none/, `${file} 缺 scrollbar-width: none（会仍占位）`);
  }
});

test("侧窗输入框字号与行高对齐小窗（用户要求高度一致）", () => {
  /*
   * 用户报「侧边对话区对话输入框的高度大小需要和小窗的一致」。
   * 高度由字号 × 行高 + 内边距决定，关键是把**字号与行高**对齐；
   * 这两个值分在两个 CSS 里，用测试钉住。
   */
  const mainRi = /\.ri\s*\{[^}]*?font-size:\s*([\d.]+)px[^}]*?line-height:\s*([\d.]+)/.exec(mainSkin);
  const sideInput = /\.sc-input\s*\{[^}]*?font-size:\s*([\d.]+)px[^}]*?line-height:\s*([\d.]+)/.exec(sideSkin);
  assert.ok(mainRi !== null, "找不到主窗输入框的字号/行高");
  assert.ok(sideInput !== null, "找不到侧窗输入框的字号/行高");
  assert.equal(sideInput[1], mainRi[1], "字号要一致");
  assert.equal(sideInput[2], mainRi[2], "行高要一致");
});

test("侧窗输入框要撑到与主窗同量级的高度（只对齐字号不够）", () => {
  /*
   * ⚠️ 补一条：光对齐字号与行高，单行 `<input>` 只有 ~35px，
   * 而主窗那个输入框视觉上约 44px（外面还包着一层），并排看仍会觉得
   * 「侧边这个小一号」。所以还要撑 padding —— 这里钉住它确实撑了。
   */
  const sideInput = /\.sc-input\s*\{[^}]*?padding:\s*(\d+)px/.exec(sideSkin);
  assert.ok(sideInput !== null, "找不到侧窗输入框的 padding");
  assert.ok(
    Number(sideInput[1]) >= 10,
    `侧窗输入框上下 padding 只有 ${sideInput[1]}px，会显得比主窗小一号`,
  );
});

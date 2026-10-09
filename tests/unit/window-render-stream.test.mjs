/**
 * 小窗消息流显示什么（行为级）
 *
 * 职责：钉住「小窗只显示对话内容，不显示工具调用过程」。
 * 所属层：测试（tests/unit）
 *
 * 用户要求：「小窗里不需要展示你的工具调用过程，不需要展示你的思考过程」。
 *
 * 小窗是一个盯进度的小窗口，不是调试面板 —— 用户要看到的是
 * 「我问了什么 / 助手答了什么」，工具的调用与结果属于**过程**，
 * 放在这里只会把对话挤走。
 *
 * 为什么必须是行为级：这类「不该显示什么」的要求，只有真的把渲染器跑起来、
 * 真的喂一条工具消息进去、再看消息流里有没有多出一行，才算验证过。
 * 正则扫源码只能证明「文件里出现过某个字符串」。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { makeRenderer, baseState, streamLines } from "../helpers/window-render-double.mjs";

test("工具调用不出现在消息流里", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    messages: [
      { kind: "user", text: "帮我看下这个文件", seq: 1 },
      { kind: "tool", name: "read_file", text: "", seq: 2 },
      { kind: "assistant", text: "看完了，没问题", seq: 3 },
    ],
  });

  const lines = streamLines(dom);
  const texts = lines.map((l) => l.text).join(" | ");
  assert.ok(texts.includes("帮我看下这个文件"), `用户的话要显示（实际：${texts}）`);
  assert.ok(texts.includes("看完了，没问题"), `助手的回答要显示（实际：${texts}）`);
  assert.ok(
    !texts.includes("read_file"),
    `工具名不该出现在小窗里（实际：${texts}）`,
  );
  assert.ok(
    !texts.includes("tool"),
    `「tool」这个字样也不该出现（实际：${texts}）`,
  );
  /*
   * ⚠️ 还要断言**行数**。
   *
   * 注入验证发现的缺口：只断言「文字里不含工具名」时，如果过滤被去掉，
   * 工具消息会走进普通渲染分支、画出一行空白的「DSH」——
   * 那段文字里没有工具名，于是旧断言照样通过。
   * 行数才能拦住「多画了东西」这件事。
   */
  assert.equal(
    lines.length,
    2,
    `3 条消息里有 1 条是工具调用，应当只渲染 2 行（实际：${JSON.stringify(lines)}）`,
  );
});

test("只有工具调用、没有对话时，消息流里也不该多出一行", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    messages: [{ kind: "tool", name: "bash", text: "", seq: 1 }],
  });
  assert.equal(
    streamLines(dom).length,
    0,
    "全是过程消息时应当什么都不显示（而不是留下一行工具名）",
  );
});

test("不再有工具行的样式类（样式与渲染要一起退场）", () => {
  // 渲染层不再产出 .tool-line 之后，样式留着就是死代码；
  // 更要紧的是：留着它会让下一个人以为「这里本来就该显示工具」。
  const { dom, renderer } = makeRenderer();
  renderer.all({
    ...baseState,
    messages: [
      { kind: "tool", name: "grep", text: "", seq: 1 },
      { kind: "assistant", text: "结果如下", seq: 2 },
    ],
  });
  const lines = streamLines(dom);
  assert.ok(
    lines.every((l) => !String(l.cls).includes("tool-line")),
    `不该再有工具行（实际：${JSON.stringify(lines)}）`,
  );
});

test("状态条不报具体工具名，只说「正在运行」", () => {
  // 报工具名等于把过程暴露出来。用户只需要知道「它还在忙」。
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, running: true, toolName: "read_file" });
  assert.equal(dom.status.hidden, false, "运行中要显示状态条");
  assert.equal(
    dom.statusText.textContent,
    "正在运行",
    "不该把工具名写进状态条",
  );
  assert.ok(
    !dom.statusText.textContent.includes("read_file"),
    "状态条里不该出现工具名",
  );
});

test("运行中但拿不到工具名时，状态条照样显示", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, running: true, toolName: null });
  assert.equal(dom.status.hidden, false);
  assert.equal(dom.statusText.textContent, "正在运行");
});

test("没在运行时状态条收起", () => {
  const { dom, renderer } = makeRenderer();
  renderer.all({ ...baseState, running: false });
  assert.equal(dom.status.hidden, true);
});

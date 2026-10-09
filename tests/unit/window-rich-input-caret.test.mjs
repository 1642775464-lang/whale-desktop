/**
 * 命令认领与光标保持的行为测试
 *
 * 职责：钉住两件与**光标**有关的用户可见行为 ——
 *       从候选面板认领命令、以及连续输入时不能把光标甩回开头。
 * 所属层：测试（tests/unit）
 *
 * 这两件事放一起，是因为它们指向同一个底层机制（重绘与选区）：
 *   · 认领命令要**替换**草稿开头的引导符（不是追加），并保住光标；
 *   · 光标被甩回开头，根因也是重绘——`paint()` 清空重建会摧毁选区。
 *
 * 从 window-rich-input.test.mjs 拆出来是因为文件顶到了 500 行上限
 * （开发规范 强制 14）。替身共用 tests/helpers/rich-input-double.mjs，
 * 不各带一份 —— 否则两份替身必然漂移，同一份产品代码在两处得出不同结论。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { load, tokenText } from "../helpers/rich-input-double.mjs";

// ─────────────────────────────────────────────────────────────
// 一、认领命令（把已敲的「/前缀」替换成完整命令）
//
// 用户报：「我输入 / 后，选择 btw 后，直接弹出了两个 /，而且鼠标光标位置也不对」
//
// 根因：选中面板条目时用的是**追加**，而草稿里那个 `/` 是用户敲的**命令引导符**。
// 追加的结果就是 `//btw`。主窗口的语义是**替换**草稿里那个 token
// （DSH 的 leadingClaim 注释：the composer keeps the claimed token in the draft）。
// ─────────────────────────────────────────────────────────────

test("认领命令：草稿是「/」时要替换成完整命令，不能追加", () => {
  const { editor } = load();
  editor.setText("/");
  const out = editor.claimCommand("/btw ");
  assert.equal(out, "/btw ", "必须替换掉用户敲的那个斜杠");
  assert.equal(editor.getText(), "/btw ", "界面上不能出现两个斜杠");
});

test("认领命令：草稿是已敲的过滤词时要整段替换", () => {
  const { editor } = load();
  editor.setText("/bt");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "/btw ", "用户敲的 /bt 应由完整命令取代");
});

test("认领命令：草稿为空时直接放进完整命令", () => {
  const { editor } = load();
  editor.setText("");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "/btw ");
});

test("认领命令：普通文字不被动（只认领以 / 开头的情况）", () => {
  const { editor } = load();
  editor.setText("你好");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "你好 /btw ", "不是命令引导符时按普通插入处理");
});

test("认领命令：已经写了的参数要保留（不能被替换吃掉）", () => {
  const { editor } = load();
  editor.setText("/目标 我说点什么");
  editor.claimCommand("/目标 ");
  assert.equal(editor.getText(), "/目标 我说点什么", "参数部分不该因为认领而丢失");
});

test("认领命令后光标必须落在末尾（用户接着打字，不该跳回开头）", () => {
  const { editor } = load();
  editor.setText("/");
  editor.claimCommand("/btw ");
  assert.equal(editor.getText(), "/btw ");
  assert.ok(editor.caretAtEnd(), "认领之后光标要落在末尾");
});

test("认领之后命令那段会被染色（它与插入是同一条视觉路径）", () => {
  const { editor, el } = load();
  editor.setText("/");
  editor.claimCommand("/btw ");
  assert.equal(tokenText(el), "/btw");
});

// ─────────────────────────────────────────────────────────────
// 二、连续输入时不能重建 DOM、不能把光标甩回开头
//
// 用户报：「第一个字符可以正常输入，接着光标就直接跳到最前面」
// （截图里输入框是 `kxxxxxxx/btw x` —— 后面敲的字全插到了开头）
//
// 根因：`paint()` 每次输入都**清空子节点再重建**。重建会摧毁选区，
// 浏览器随后把光标放到重建后的默认位置（开头）。
//
// 这是「按文本重建」这个设计的直接代价 —— 当时论证它能避免状态不一致，
// 但没考虑它会打断正在进行的输入。
// ─────────────────────────────────────────────────────────────

test("连续普通输入时不许重建节点（否则光标会被甩回开头）", () => {
  const { editor, el } = load();
  editor.setText("k");
  const firstNode = el.children[0];
  el.type("kx");
  assert.equal(
    el.children[0],
    firstNode,
    "内容里没有命令时不需要动 DOM —— 重建会把光标甩回开头",
  );
  assert.equal(editor.getText(), "kx");
});

test("从普通文字变成命令时才重建（该上色的时候仍要上色）", () => {
  const { editor, el } = load();
  editor.setText("/");
  assert.equal(tokenText(el), "", "还没构成完整命令");
  el.type("/btw ");
  assert.equal(tokenText(el), "/btw", "构成命令后必须上色");
});

test("着色状态没变时不重建（命令已上色，继续打字不该动它）", () => {
  const { editor, el } = load();
  editor.setText("/btw x");
  const tokenNode = el.children[0];
  assert.equal(tokenText(el), "/btw");
  el.type("/btw xy");
  assert.equal(el.children[0], tokenNode, "命令段没变，不该重建");
  assert.equal(editor.getText(), "/btw xy");
});

test("确实需要重建时，光标要按原来的偏移量回到原位（不能跳开头）", () => {
  // 用户可能把普通文字改成命令 —— 这时必须重建。
  // 重建之后要按**原偏移量**恢复光标，而不是一律甩到末尾或开头。
  const { editor, el } = load();
  el.type("ab");
  el.setCaretOffset(2);        // 光标在第 2 个字符之后
  el.type("/btw ");            // 变成命令 → 必然重建
  assert.equal(
    el.caretOffsetApplied,
    2,
    "重建后光标应回到原来的偏移量 2（不是 0=开头，也不是 6=末尾）",
  );
  assert.equal(editor.getText(), "/btw ");
});

test("光标在中间时编辑内容，光标不该被动（不重建就不碰光标）", () => {
  const { editor, el } = load();
  el.type("abcd");
  /*
   * 记一个基线：编辑器在装配时会画一次（那一次必然动 DOM、也就会安置光标）。
   * 下面比的是**增量** —— 不建基线就会把装配那次算进来，得到假红。
   */
  const setsAfterInit = el.editorSetCount;

  el.setCaretOffset(2);           // 光标在中间
  el.type("ab/cd");               // 内容变了，仍不是命令 → 就地改文本节点
  assert.equal(editor.getText(), "ab/cd");
  assert.equal(
    el.editorSetCount,
    setsAfterInit,
    "不需要重建时编辑器**不该再安置光标** —— 用户的光标在哪就是哪",
  );

  el.setCaretOffset(2);
  el.type("/goal x");             // 仍是单文本节点 → 就地改，不重建
  assert.equal(editor.getText(), "/goal x");
  assert.equal(el.editorSetCount, setsAfterInit, "依然不该动光标");
});

test("命令段被改掉时必然重建，光标仍按原偏移量恢复", () => {
  /*
   * ⚠️ 这条是**负数注入逼出来的**：把「重建后恢复光标」那句删掉时，
   * 上面那些测试**一条都没红** —— 因为它们的替身路径根本不触发重建。
   * 一条没有测试守着的行为，等于没有。
   *
   * 这里构造真正必然重建的情形：现有内容是 `[span('/btw'), ' x']`，
   * 而新内容不以 `/btw` 开头 —— 替身（与浏览器）都会整体重排，
   * 于是走到重建分支。
   */
  const { editor, el } = load();
  editor.setText("/btw x");
  assert.equal(tokenText(el), "/btw", "先确认已上色");
  el.setCaretOffset(3);           // 光标停在第 3 个字符之后
  el.type("k/btw x");             // 不再以命令开头 → 必然重建
  assert.equal(
    el.caretOffsetApplied,
    3,
    "重建后光标必须按原偏移量恢复 —— 删掉这一步用户就会看到光标跳回开头",
  );
  assert.equal(editor.getText(), "k/btw x");
  assert.equal(tokenText(el), "", "不再以命令开头，颜色也该退掉");
});

test("阴性对照：把「结构没变就不动 DOM」去掉，上面那条必须红", () => {
  // 这条守的是「防线真的在起作用」：如果实现退化成无条件重建，
  // `el.children[0]` 的引用就会变 —— 用同一份断言再走一遍，
  // 确保它确实能观察到重建（而不是因为替身不敏感而永远为真）。
  const { editor, el } = load();
  editor.setText("/btw x");
  const tokenNode = el.children[0];
  // 手动制造一次真实重建（模拟退化的实现）
  editor.setText("/btw x");
  assert.notEqual(
    el.children[0],
    tokenNode,
    "真正重建时节点引用必须变化 —— 否则说明断言观察不到重建，是假防线",
  );
});

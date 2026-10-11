/**
 * 侧边栏底部：账号信息 + 充值余额
 *
 * 职责：钉住「余额拿不到显示 —（不是 0）」与「资料/余额各自独立」这两条。
 * 所属层：测试（tests/unit）
 *
 * 为什么值得单独测：`—` 与 `0` 在界面上含义完全不同 —— 把「读不到」
 * 显示成「0 元」会让用户以为余额真的没了。这类「把不知道显示成某个值」
 * 的问题只能靠断言挡住。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 加载 account-panel.js 并拿到导出。 */
function load() {
  const sandbox = { window: {}, console: { warn: () => {} }, Object, Array, String };
  createContext(sandbox);
  runInContext(
    readFileSync(join(ROOT, "whale-window", "renderer", "account-panel.js"), "utf8"),
    sandbox,
    { filename: "account-panel.js" },
  );
  return sandbox.window.WhaleAccountPanel;
}

/** 造一组假 DOM 元素。 */
function fakeDom() {
  const mk = () => ({ textContent: "", title: "" });
  return { avatar: mk(), name: mk(), sub: mk(), balance: mk() };
}

test("formatBalance：带币种符号", () => {
  const { formatBalance } = load();
  assert.equal(formatBalance({ currency: "CNY", balance: "9.55" }), "¥9.55");
  assert.equal(formatBalance({ currency: "USD", balance: "1.20" }), "$1.20");
});

test("formatBalance：拿不到给「—」，**不是 0**", () => {
  /*
   * ⚠️ 这条是核心：0 与「不知道」在界面上含义完全不同。
   * 显示 0 会让用户以为余额真的没了。
   */
  const { formatBalance } = load();
  assert.equal(formatBalance(null), "—");
  assert.equal(formatBalance(undefined), "—");
  assert.equal(formatBalance({ currency: "CNY", balance: null }), "—");
  assert.equal(formatBalance({ currency: "CNY", balance: "" }), "—");
});

test("formatBalance：未知币种只给数字，不编符号", () => {
  const { formatBalance } = load();
  assert.equal(formatBalance({ currency: "JPY", balance: "100" }), "100");
});

test("渲染：资料与余额都在时正常显示", () => {
  const { createAccountPanel } = load();
  const dom = fakeDom();
  const panel = createAccountPanel({ dom, fetchAccount: async () => ({}) });
  panel.render({
    ok: true,
    profile: { name: "张三", contact: "a@b.com" },
    balance: { wallets: [{ currency: "CNY", balance: "9.55" }] },
  });
  assert.equal(dom.name.textContent, "张三");
  assert.equal(dom.sub.textContent, "a@b.com");
  assert.equal(dom.balance.textContent, "¥9.55");
});

test("渲染：资料失败但余额成功 —— 余额仍要显示（各自独立）", () => {
  const { createAccountPanel } = load();
  const dom = fakeDom();
  const panel = createAccountPanel({ dom, fetchAccount: async () => ({}) });
  panel.render({
    ok: true,
    profile: null,
    profileCode: "account/not-ready",
    balance: { wallets: [{ currency: "CNY", balance: "3.00" }] },
  });
  assert.equal(dom.balance.textContent, "¥3.00", "一块失败不该拖垮另一块");
  assert.match(dom.sub.textContent, /account\/not-ready/, "失败原因要如实显示");
});

test("渲染：余额失败但资料成功 —— 余额显示「—」并带原因", () => {
  const { createAccountPanel } = load();
  const dom = fakeDom();
  const panel = createAccountPanel({ dom, fetchAccount: async () => ({}) });
  panel.render({
    ok: true,
    profile: { name: "李四", contact: null },
    balance: null,
    balanceCode: "typert/unavailable",
  });
  assert.equal(dom.name.textContent, "李四");
  assert.equal(dom.balance.textContent, "—", "读不到不是 0");
  assert.equal(dom.balance.title, "typert/unavailable");
});

test("渲染：整体失败时两块都降级，不崩", () => {
  const { createAccountPanel } = load();
  const dom = fakeDom();
  const panel = createAccountPanel({ dom, fetchAccount: async () => ({}) });
  panel.render({ ok: false, code: "network" });
  assert.equal(dom.name.textContent, "未登录");
  assert.equal(dom.balance.textContent, "—");
});

test("refresh：fetch 抛错被吞，降级为失败态", async () => {
  const { createAccountPanel } = load();
  const dom = fakeDom();
  const panel = createAccountPanel({
    dom,
    fetchAccount: async () => { throw new Error("桥挂了"); },
  });
  await panel.refresh();
  assert.equal(dom.balance.textContent, "—");
});

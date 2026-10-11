/*
 * 侧边栏底部：账号信息 + 充值余额
 *
 * 职责：拉 `/whale/account`（桥走 Typert 的 account/getProfile + getBalance），
 *       把姓名/联系方式/头像与余额渲染到底部那一小块。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独成文件：它是**一块独立的信息区**（与「会话清单」「技能中心」
 * 各自的改动原因不同），塞进 sidebar.js 会让那个文件的职责从「导航」
 * 扩到「账号展示」—— 两者的数据源、失败模式、刷新时机都不一样。
 *
 * 三条纪律：
 *   1. **拿不到就说拿不到**。余额读不到显示「—」，不显示 0
 *      （0 与「不知道」含义完全不同，界面上混成一个会误导）。
 *   2. **资料与余额各自独立**。宿主一个方法失败不该让另一块也空白。
 *   3. **失败原因如实显示**，不静默变成默认值。
 *
 * 本文件是浏览器 script（不能 import），对外只暴露 window.WhaleAccountPanel。
 */

(function attachAccountPanel(global) {
  "use strict";

  /** 币种符号（宿主给的是 `CNY` / `USD` 这类代码）。 */
  const CURRENCY_SIGN = { CNY: "¥", USD: "$" };

  /**
   * 把宿主给的余额行格式化成显示串。
   *
   * @param {{currency: string|null, balance: string|null}|null} wallet
   * @returns {string} 拿不到给「—」（不是 0）
   */
  function formatBalance(wallet) {
    if (wallet === null || wallet === undefined) return "—";
    const raw = wallet.balance;
    if (typeof raw !== "string" || raw === "") return "—";
    const sign = CURRENCY_SIGN[wallet.currency] ?? "";
    // 宿主给的是字符串（保留它自己的精度），只补币种符号
    return `${sign}${raw}`;
  }

  /**
   * 建账号面板控制器。
   *
   * @param {object} deps
   * @param {object} deps.dom {avatar, name, sub, balance}
   * @param {() => Promise<object>} deps.fetchAccount 拉账号数据
   * @returns {object} 控制器
   */
  function createAccountPanel(deps) {
    const dom = deps.dom;

    /** 渲染一次（含失败态）。 */
    function render(out) {
      const data = out !== null && out !== undefined && out.ok === true ? out : null;

      // ── 账号资料 ──
      if (data !== null && data.profile !== null && data.profile !== undefined) {
        const name = data.profile.name;
        dom.name.textContent = typeof name === "string" && name !== "" ? name : "已登录 DeepSeek";
        const contact = data.profile.contact;
        dom.sub.textContent = typeof contact === "string" && contact !== ""
          ? contact
          : "账号资料暂不可用";
      } else {
        dom.name.textContent = "未登录";
        dom.sub.textContent = data !== null && data.profileCode
          ? `账号资料暂不可用（${data.profileCode}）`
          : "账号资料暂不可用";
      }

      // ── 余额 ──
      if (data !== null && data.balance !== null && data.balance !== undefined) {
        const first = Array.isArray(data.balance.wallets) ? data.balance.wallets[0] : null;
        dom.balance.textContent = formatBalance(first ?? null);
      } else {
        // 读不到显示「—」：与「余额是 0」必须区分开
        dom.balance.textContent = "—";
        if (data !== null && data.balanceCode) dom.balance.title = data.balanceCode;
      }
    }

    /** 拉一次并渲染。 */
    function refresh() {
      return Promise.resolve(deps.fetchAccount()).then(function (out) {
        render(out);
        return out;
      }).catch(function (err) {
        render({ ok: false, code: err && err.message ? err.message : "network" });
      });
    }

    return { refresh, render };
  }

  global.WhaleAccountPanel = { createAccountPanel, formatBalance };
})(typeof window !== "undefined" ? window : globalThis);

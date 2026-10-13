/**
 * 账号能力的 Typert 调用
 *
 * 职责：读账号状态、资料与充值余额（侧边栏底部模块用）。
 * 所属层：桥（whale-bridge/lib）
 *
 * 为什么从 typert-bridge.mjs 拆出来：那个文件已到 500 行上限（强制 14），
 * 而账号是**独立的一个数据域**（失败模式是「三块各自失败」），
 * 与「技能目录 / 会话清单」不是一类改动原因。
 *
 * 调用形状由工厂注入的 `invokeRemote` 负责（唯一事实源仍在 typert-bridge），
 * 这里只关心**返回怎么归一化**。
 *
 * ## 契约（照 `dsh-api-account-controller` 的 typert.host.js 声明）
 *
 *   account/getState    args:{client:{version,locale,timezoneOffsetSeconds}}
 *     → {status:"signed-out"|"credential-stored", links:{usageUrl, topUpUrl},
 *        attempt:{...}|null}
 *   account/getProfile  同上 args
 *     → {status:"ready", value:{id, name, contact, avatarUrl?}} | {status:"failed"}
 *       **宿主无凭证时直接返回 `null`**（不是 failed）—— 见
 *       dsh-deepseek-account-platform 的 `getProfile`：
 *       `if (stored === null) return null;`
 *   account/getBalance  同上 args
 *     → {status:"ready", value:[{currency:"CNY"|"USD", balance}],
 *        bonusWallets:[{currency, balance}]} | {status:"failed"}
 *
 * ⚠️ `client` 参数是**必填**（客户端元数据），不给会被严格 codec 拒掉。
 *
 * ⚠️ **为什么要读 getState**：`getProfile` 的 `null` 有歧义 ——
 * 「没登录」与「读取被中断」都是 null。而 getState 明确给
 * `signed-out` / `credential-stored`，界面据此才能说准是「未登录」
 * 还是「资料暂不可用」（两者对用户含义不同）。
 */

/**
 * 帐号接口要的客户端元数据里的 `version`。
 *
 * 宿主只把它当 `z.string()` 收下（不校验语义），给桥自己的标识即可 ——
 * 但**必须给**：`client` 是严格 codec 的必填参数，缺字段整条调用会被拒。
 */
const ACCOUNT_CLIENT_VERSION = "whale-desktop";

/**
 * 建账号调用能力。
 *
 * @param {object} deps
 * @param {(req: {namespace: string, method: string, args?: object}) => Promise<object>} deps.invokeRemote
 * @returns {{accountInfo: () => Promise<object>}}
 */
export function createAccountCalls({ invokeRemote }) {
  /**
   * 读账号状态、资料与充值余额。
   *
   * 三个方法各自独立取值，**一个失败不影响另一个**。
   *
   * @returns {Promise<{ok:boolean, signedIn?:boolean|null, profile?:object|null,
   *                    balance?:object|null, profileCode?:string,
   *                    balanceCode?:string, stateCode?:string}>}
   */
  async function accountInfo() {
    const client = {
      version: ACCOUNT_CLIENT_VERSION,
      locale: "zh-CN",
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    };

    const call = (method) => invokeRemote({ namespace: "account", method, args: { client } });

    const [stateOut, profileOut, balanceOut] = await Promise.all([
      call("getState"),
      call("getProfile"),
      call("getBalance"),
    ]);

    /*
     * getState：`{status, links, attempt}` —— **没有** ready/failed 包装。
     * `status` 直接就是登录状态。
     */
    let signedIn = null;
    let stateCode = null;
    if (stateOut.ok === true && stateOut.value !== null && typeof stateOut.value === "object") {
      const st = stateOut.value.status;
      if (st === "credential-stored") signedIn = true;
      else if (st === "signed-out") signedIn = false;
      else stateCode = "account/state-unknown";
    } else {
      stateCode = stateOut.ok === true ? "account/state-unknown" : (stateOut.code ?? "typert/failed");
    }

    /** 把宿主给的 `{status, value}` 收成 `{ok, value}`（status 非 ready 即失败）。 */
    const unwrap = (out) => {
      if (out.ok !== true) return { ok: false, code: out.code ?? "typert/failed" };
      const v = out.value;
      if (v === null || typeof v !== "object" || v.status !== "ready") {
        return { ok: false, code: "account/not-ready" };
      }
      return { ok: true, value: v.value ?? null };
    };

    const profile = unwrap(profileOut);
    const balance = unwrap(balanceOut);

    return {
      ok: true,
      /*
       * 登录状态：`true` 已登录 / `false` 未登录 / `null` 不知道。
       * 界面靠它区分「未登录」与「资料暂不可用」—— 这两句对用户含义不同。
       */
      signedIn,
      stateCode,
      profile: profile.ok
        ? {
          name: typeof profile.value?.name === "string" ? profile.value.name : null,
          contact: typeof profile.value?.contact === "string" ? profile.value.contact : null,
          avatarUrl: typeof profile.value?.avatarUrl === "string" ? profile.value.avatarUrl : null,
        }
        : null,
      profileCode: profile.ok ? null : profile.code,
      balance: balance.ok
        ? {
          // 主钱包：取第一项；宿主给的是数组（多币种）
          wallets: Array.isArray(balance.value)
            ? balance.value.map((w) => ({
              currency: typeof w?.currency === "string" ? w.currency : null,
              balance: typeof w?.balance === "string" ? w.balance : null,
            }))
            : [],
          bonusWallets: Array.isArray(balanceOut.value?.bonusWallets)
            ? balanceOut.value.bonusWallets.map((w) => ({
              currency: typeof w?.currency === "string" ? w.currency : null,
              balance: typeof w?.balance === "string" ? w.balance : null,
            }))
            : [],
        }
        : null,
      balanceCode: balance.ok ? null : balance.code,
    };
  }

  return { accountInfo };
}

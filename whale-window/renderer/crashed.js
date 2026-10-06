/*
 * 崩溃兜底页交互
 *
 * 职责：兜底页上的两个按钮——「再试一次」与「隐藏窗口」。
 * 所属层：小窗（whale-window/renderer）
 *
 * 为什么单独一个文件而不是内联在 crashed.html：
 * CSP 是 `default-src 'none'`，只写 `script-src 'self'` 时**内联脚本会被
 * 静默拦截**（陷阱 4）——兜底页正好是最不能出这种问题的地方：
 * 它已经是最后一层，按钮再点不动就真的没救。
 */

(function main(global) {
  "use strict";

  const btnRetry = global.document.getElementById("btnRetry");
  const btnHide = global.document.getElementById("btnHide");
  const btnQuit = global.document.getElementById("btnQuit");

  /**
   * 「再试一次」。
   *
   * 重新加载界面。主进程的重载计数只能由「加载成功」清零，
   * 所以若这次仍然崩，计数会继续累加——不会出现无限重载。
   */
  btnRetry.addEventListener("click", function () {
    btnRetry.disabled = true;
    btnRetry.textContent = "正在重试…";
    global.location.reload();
  });

  btnHide.addEventListener("click", function () {
    global.whale.windowAction("hide");
  });

  btnQuit.addEventListener("click", function () {
    global.whale.windowAction("close");
  });

  if (global.whale && typeof global.whale.log === "function") {
    global.whale.log("兜底页已加载，等待用户选择");
  }
})(window);

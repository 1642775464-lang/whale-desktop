/**
 * 定位「agent/inbox/spliced 事件 data 不可序列化」的真因
 *
 * 职责：用宿主自己的 isJsonValue 检查桥构造出的用户消息，逐项定位
 *       到底是哪个字段导致 snapshotJsonValue 返回 undefined。
 * 所属层：工程工具（tools/）
 *
 * 背景：装进真实宿主后 POST /whale/send 返回
 *   {"code":"send-failed","message":'session event "agent/inbox/spliced" carries non-JSON-serializable data'}
 * 宿主在 session.append 里做 snapshotJsonValue(data)，返回 undefined 就抛。
 *
 * 用法：node tools/diagnose-send-serialization.mjs
 */

import { pathToFileURL } from "node:url";

const UTIL = "C:/Program Files/DSH Desktop/resources/app/node_modules/@deepseek-ai/dsh-util-values/lib/index.js";
const util = await import(pathToFileURL(UTIL).href);

const report = { hasIsJsonValue: typeof util.isJsonValue === "function", hasSnapshot: typeof util.snapshotJsonValue === "function" };

/** 检查一个值是否能无损 JSON 序列化。 */
function check(label, value) {
  const out = { label };
  try {
    const snap = util.snapshotJsonValue(value);
    out.serializable = snap !== undefined;
    if (snap === undefined) {
      // 用 isJsonValue 复核
      try {
        out.confirm = util.isJsonValue(value) === true;
      } catch (err) {
        out.confirmError = err.message;
      }
      // 试着 JSON.stringify 看会不会抛
      try {
        JSON.stringify(value);
        out.stringifyThrows = false;
      } catch (err) {
        out.stringifyThrows = true;
        out.stringifyError = err.message;
      }
      // 逐键扫描，定位是哪个字段的问题
      if (value !== null && typeof value === "object") {
        out.badKeys = [];
        for (const [k, v] of Object.entries(value)) {
          try {
            if (util.snapshotJsonValue(v) === undefined) out.badKeys.push(k);
          } catch {
            out.badKeys.push(`${k}(throw)`);
          }
        }
      }
      if (Array.isArray(value)) {
        out.badIndexes = [];
        value.forEach((v, i) => {
          try {
            if (util.snapshotJsonValue(v) === undefined) out.badIndexes.push(i);
          } catch {
            out.badIndexes.push(`${i}(throw)`);
          }
        });
      }
    }
  } catch (err) {
    out.error = err.message;
  }
  return out;
}

// 复现桥的 send 路径构造出的消息
const { createUserMessage } = await import(pathToFileURL("D:/DEEPSEEK/悬浮窗/whale-bridge/lib/host-actions.mjs").href);

// 情形 A：content 为普通数组（桥自行构造的形状）
const msgA = createUserMessage([{ type: "text", text: "测试" }], { kind: "whale-hud", mode: "send" });
report.msgA = check("桥自造 content + source=whale-hud", msgA);

// 情形 B：不带 source
const msgB = createUserMessage([{ type: "text", text: "测试" }]);
report.msgB = check("不带 source", msgB);

// 情形 C：source 带 mode: null
const msgC = createUserMessage([{ type: "text", text: "测试" }], { kind: "whale-hud", mode: null });
report.msgC = check("source.mode = null", msgC);

// 情形 D：宿主默认 source（对照）
const msgD = createUserMessage([{ type: "text", text: "测试" }], { kind: "user" });
report.msgD = check("source = { kind: 'user' }（对照）", msgD);

// 逐个字段单独测
report.fields = {
  contentArray: check("content 数组本身", [{ type: "text", text: "测试" }]),
  sourceWithMode: check("source = {kind, mode}", { kind: "whale-hud", mode: "send" }),
  sourceKindOnly: check("source = {kind}", { kind: "whale-hud" }),
  uuid: check("id (uuid 字符串)", "b3f2e1a0-0000-4000-8000-000000000000"),
  role: check("role", "user"),
  frozenObj: check("Object.freeze 的普通对象", Object.freeze({ a: 1 })),
};

console.log(`SERIALIZE_DIAG ${  JSON.stringify(report, null, 2)}`);

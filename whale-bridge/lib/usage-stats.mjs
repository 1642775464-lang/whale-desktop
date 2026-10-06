/**
 * token 口径统计内核
 *
 * 职责：四桶求和、上下文占用计算、输出速度窗口。
 * 所属层：桥（whale-bridge/lib）
 *
 * 口径来源（D1 方案 C，见 docs/桥-PRD.md F4 与 docs/边界与NFR说明书.md）：
 *   上下文占用 = pressureFrom(usage)
 *              = inputTokens + (cacheReadTokens ?? 0) + (cacheWriteTokens ?? 0)
 *   分母取 request/context.data.contextWindow。
 *
 * 实测约束（K-10，不得违反）：
 *   落盘 usage 对象只有 4 个字段——inputTokens / outputTokens / totalTokens / cacheReadTokens，
 *   **没有 cacheWriteTokens**。故该项恒按 0 兜底，**绝不虚构**。
 *   且 totalTokens 含缓存读，**不能**当上下文占用用。
 *
 * 本模块是纯函数：不读文件、不碰网络、不看时钟（时间由调用方传入）。
 */

/** 速度窗口：8 秒（F5）。 */
export const SPEED_WINDOW_MS = 8000;

/** 空统计（四桶全 0，未收到任何 usage 时的初值）。 */
export function emptyTotals() {
  return {
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
  };
}

/**
 * pressureFrom：上下文占用口径。
 *
 * @param {object | null | undefined} usage 宿主给的 usage 对象
 * @returns {number | null} 占用 token 数；usage 无效时返回 null（不返回 0，0 是合法占用）
 */
export function pressureFrom(usage) {
  if (usage === null || typeof usage !== "object") return null;
  const input = numberOrNull(usage.inputTokens);
  if (input === null) return null;
  return input + (numberOrNull(usage.cacheReadTokens) ?? 0) + (numberOrNull(usage.cacheWriteTokens) ?? 0);
}

/**
 * 把一条 usage 累加进四桶。
 *
 * 注意：返回**新对象**，不修改入参（纯函数）。
 *
 * @param {object} totals 现有四桶
 * @param {object | null | undefined} usage 一条 usage
 * @returns {object} 新的四桶
 */
export function addUsage(totals, usage) {
  const base = {
    totalInput: numberOrNull(totals?.totalInput) ?? 0,
    totalOutput: numberOrNull(totals?.totalOutput) ?? 0,
    totalCacheRead: numberOrNull(totals?.totalCacheRead) ?? 0,
    totalCacheWrite: numberOrNull(totals?.totalCacheWrite) ?? 0,
  };
  if (usage === null || typeof usage !== "object") return base;

  return {
    totalInput: base.totalInput + (numberOrNull(usage.inputTokens) ?? 0),
    totalOutput: base.totalOutput + (numberOrNull(usage.outputTokens) ?? 0),
    totalCacheRead: base.totalCacheRead + (numberOrNull(usage.cacheReadTokens) ?? 0),
    // K-10：落盘无此字段，恒按 0 累加，不虚构
    totalCacheWrite: base.totalCacheWrite + (numberOrNull(usage.cacheWriteTokens) ?? 0),
  };
}

/**
 * 从事件数组里提取全部 usage，按序累加四桶。
 *
 * @param {Array<object>} events 事件数组（每条形如 {type, data}）
 * @returns {object} 四桶
 */
export function sumUsage(events) {
  let totals = emptyTotals();
  if (!Array.isArray(events)) return totals;
  for (const event of events) {
    if (event?.type !== "assistant/message") continue;
    totals = addUsage(totals, event.data?.usage);
  }
  return totals;
}

/**
 * 取最后一条 usage（用于上下文占用）。
 *
 * @param {Array<object>} events 事件数组
 * @returns {number | null} pressureFrom 结果；无 usage 时 null
 */
export function latestPressure(events) {
  if (!Array.isArray(events)) return null;
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "assistant/message") continue;
    const p = pressureFrom(event.data?.usage);
    if (p !== null) return p;
  }
  return null;
}

/**
 * 取上下文窗口大小（来自 request/context 事件）。
 *
 * @param {Array<object>} events 事件数组
 * @returns {number | null} 窗口 token 数；无该事件时 null
 */
export function contextWindowOf(events) {
  if (!Array.isArray(events)) return null;
  // 实测全会话只有 1 条 request/context，取最后一条即可
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i];
    if (event?.type !== "request/context") continue;
    return numberOrNull(event.data?.contextWindow);
  }
  return null;
}

/**
 * 向窗口里加一个采样并算出速度。
 *
 * 采样过期（早于 now - SPEED_WINDOW_MS）即丢弃。窗口内无样本时速度为 0
 * （累计数字不动——「宁可静止不假装能动」）。
 *
 * @param {Array<{at: number, outputTokens: number}>} samples 现有采样
 * @param {{ at: number, outputTokens: number }} sample 新采样
 * @param {number} now 当前时刻（epoch ms）
 * @returns {{ samples: Array<{at: number, outputTokens: number}>, tokPerSec: number }}
 */
export function pushSample(samples, sample, now) {
  const list = Array.isArray(samples) ? samples : [];
  const cutoff = now - SPEED_WINDOW_MS;
  const kept = list.filter((s) => numberOrNull(s?.at) !== null && s.at > cutoff);
  if (numberOrNull(sample?.at) !== null) {
    kept.push({ at: sample.at, outputTokens: numberOrNull(sample.outputTokens) ?? 0 });
  }

  const sum = kept.reduce((acc, s) => acc + (numberOrNull(s.outputTokens) ?? 0), 0);
  const span = kept.length === 0 ? 0 : Math.max(1, now - kept[0].at);
  const tokPerSec = span === 0 ? 0 : round2((sum * 1000) / span);

  return { samples: kept, tokPerSec };
}

/**
 * 只看不写：按当前时刻算出采样窗口内的速度（不修改采样）。
 *
 * @param {Array<{at: number, outputTokens: number}>} samples 采样
 * @param {number} now 当前时刻（epoch ms）
 * @returns {{ samples: Array<object>, tokPerSec: number }} 清理后的采样与速度
 */
export function speedAt(samples, now) {
  const list = Array.isArray(samples) ? samples : [];
  const cutoff = now - SPEED_WINDOW_MS;
  const kept = list.filter((s) => numberOrNull(s?.at) !== null && s.at > cutoff);
  const sum = kept.reduce((acc, s) => acc + (numberOrNull(s.outputTokens) ?? 0), 0);
  const span = kept.length === 0 ? 0 : Math.max(1, now - kept[0].at);
  return { samples: kept, tokPerSec: span === 0 ? 0 : round2((sum * 1000) / span) };
}

/**
 * 上下文占用百分比。取不到占用或窗口时返回 null（界面显示 `–`）。
 *
 * @param {number | null} used
 * @param {number | null} window
 * @returns {number | null}
 */
export function usagePercent(used, window_) {
  if (used === null || window_ === null) return null;
  if (!Number.isFinite(used) || !Number.isFinite(window_) || window_ <= 0) return null;
  return round2((used / window_) * 100);
}

/** 取有限数字；否则 null（区分「0」与「没有值」）。 */
function numberOrNull(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 保留两位小数。 */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * 工作区文件列表的纯逻辑
 *
 * 职责：把宿主给的候选路径归一化成界面要的条目，并校验「点进去」的路径。
 * 所属层：桥（whale-bridge/lib）
 *
 * ## 数据源说明
 *
 * 宿主 `fileReferences.list(agent, query)` 是**搜索**接口，但实测有个关键性质：
 *
 *   · `query = ""`            → 列出工作区**顶层**条目（20 条：13 目录 7 文件）
 *   · `query = "whale-window/"` → 列出该目录下的条目（8 条）
 *
 * 也就是说「传目录前缀」等价于「列这个目录」—— 主窗口的 `@` 补全也是这么用的。
 * 所以**逐层点进去**不需要新的宿主能力，复用这条即可。
 *
 * 返回的每一项是 `FileReferenceCandidate { path, kind }`，
 * `kind` 为 `"file"` / `"directory"`，能直接区分。
 *
 * ## 为什么拆成纯函数
 *
 * 归一化与路径校验都是**纯计算**，可以脱离宿主单测；而它们恰恰是最容易出
 * 静默错误的地方（路径拼错、把文件当目录列、相对路径跑到工作区外）。
 */

/** 条目的稳定排序权重：目录在前，然后按名字。 */
const KIND_ORDER = { directory: 0, file: 1 };

/**
 * 把宿主给的候选归一化成界面条目。
 *
 * **只做归一化，不编造**：缺 `path` 的整条丢掉（点不了）；
 * `kind` 不是已知值时保守当文件（当目录会点进去得到空列表，更容易误导）。
 *
 * @param {Array<object>} candidates 宿主候选
 * @returns {Array<{path: string, name: string, kind: "file"|"directory"}>}
 */
export function normalizeEntries(candidates) {
  const out = [];
  for (const item of Array.isArray(candidates) ? candidates : []) {
    if (item === null || typeof item !== "object") continue;
    const path = typeof item.path === "string" ? item.path.trim() : "";
    if (path === "") continue;
    const kind = item.kind === "directory" ? "directory" : "file";
    out.push({ path, name: baseName(path), kind });
  }
  // 目录在前、同组按名字（界面稳定，不依赖宿主返回顺序）
  out.sort((l, r) => {
    const k = (KIND_ORDER[l.kind] ?? 1) - (KIND_ORDER[r.kind] ?? 1);
    if (k !== 0) return k;
    return l.name.localeCompare(r.name, "zh");
  });
  return out;
}

/**
 * 取路径末段作为显示名。
 *
 * @param {string} path 相对路径（如 `whale-window/renderer/app.js`）
 * @returns {string}
 */
export function baseName(path) {
  const parts = String(path).split("/").filter((s) => s !== "");
  return parts.length > 0 ? parts[parts.length - 1] : String(path);
}

/**
 * 规范化用户给的目录前缀（拼进 query 用）。
 *
 * 统一成「无开头斜杠、有结尾斜杠」的形式：`whale-window` 与 `/whale-window`
 * 都要变成 `whale-window/`，否则拼出来的 query 对不上宿主的口径。
 *
 * @param {string} dir 目录前缀（空串表示工作区根）
 * @returns {string}
 */
export function normalizeDirPrefix(dir) {
  const raw = typeof dir === "string" ? dir.trim() : "";
  // 去掉开头的斜杠与反斜杠（宿主用相对路径，无前导分隔符）
  const trimmed = raw.replace(/^[/\\]+/, "");
  if (trimmed === "") return "";
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

/**
 * 判断一个相对路径是否**可以交给宿主打开**。
 *
 * ⚠️ 这是安全边界：渲染层传来的路径是**不受信任**的（网页内容可以伪造调用）。
 * 只放行「工作区内的相对路径」：
 *   · 拒绝绝对路径（`C:\...`、`/etc/...`）—— 否则等于让小窗能开任意文件；
 *   · 拒绝 `..` 段 —— 否则可以爬出工作区；
 *   · 拒绝盘符与 UNC 前缀。
 *
 * @param {string} path 待校验路径
 * @returns {{ok: true, path: string} | {ok: false, reason: string}}
 */
export function safeRelativePath(path) {
  if (typeof path !== "string") return { ok: false, reason: "path-not-string" };
  const raw = path.trim();
  if (raw === "") return { ok: false, reason: "path-empty" };
  // 绝对路径（含盘符、UNC、以分隔符开头）
  if (/^[a-zA-Z]:/.test(raw)) return { ok: false, reason: "path-absolute" };
  if (raw.startsWith("/") || raw.startsWith("\\")) return { ok: false, reason: "path-absolute" };
  if (raw.startsWith("//")) return { ok: false, reason: "path-unc" };
  // 统一分隔符后逐段检查：任何 `..` 段都不允许
  const segments = raw.split(/[/\\]+/).filter((s) => s !== "" && s !== ".");
  if (segments.some((s) => s === "..")) return { ok: false, reason: "path-escapes" };
  if (segments.length === 0) return { ok: false, reason: "path-empty" };
  // 交给宿主时统一用正斜杠（宿主候选里就是正斜杠）
  return { ok: true, path: segments.join("/") };
}

/**
 * 把「工作区相对路径」拼成绝对路径，并确认它**没有跑出工作区**。
 *
 * ⚠️ 这是读文件内容的最后一道闸。`safeRelativePath` 已经挡掉了 `..` 与绝对路径，
 * 但**符号链接**能绕过纯字符串检查（`link` 这一段里没有 `..`，它却指向别处），
 * 所以这里用 `realpath` 再核一次前缀 —— 字符串检查与真实路径检查缺一不可。
 *
 * @param {string} root 工作区绝对路径
 * @param {string} rel 已过 `safeRelativePath` 的相对路径
 * @param {(p: string) => string} realpath 真实路径解析（注入以便单测）
 * @param {string} [sep] 路径分隔符（默认 `/`）
 * @returns {{ok: true, abs: string} | {ok: false, reason: string}}
 */
export function resolveInsideRoot(root, rel, realpath, sep = "/") {
  if (typeof root !== "string" || root === "") return { ok: false, reason: "root-missing" };
  const base = root.replace(/[/\\]+$/, "");
  const abs = `${base}${sep}${String(rel).split("/").join(sep)}`;
  let realAbs;
  let realBase;
  try {
    realAbs = realpath(abs);
    realBase = realpath(base);
  } catch {
    // 不存在或被权限拒绝：交给调用方按「读不到」处理，不在这里猜原因
    return { ok: false, reason: "not-found" };
  }
  const a = String(realAbs).replace(/\\/g, "/").replace(/\/+$/, "");
  const b = String(realBase).replace(/\\/g, "/").replace(/\/+$/, "");
  if (a === b) return { ok: false, reason: "path-is-directory" };
  if (!a.startsWith(`${b}/`)) return { ok: false, reason: "path-escapes" };
  return { ok: true, abs };
}

/**
 * 由当前目录 + 条目名拼出下钻后的目录前缀。
 *
 * @param {string} dir 当前目录前缀
 * @param {string} name 条目名（目录名）
 * @returns {string} 新的目录前缀
 */
export function childDir(dir, name) {
  return `${normalizeDirPrefix(dir)}${String(name).replace(/^[/\\]+/, "")}/`;
}

/**
 * 由当前目录前缀推出上一级（已在根时仍给根）。
 *
 * @param {string} dir 当前目录前缀
 * @returns {string}
 */
export function parentDir(dir) {
  const norm = normalizeDirPrefix(dir);
  if (norm === "") return "";
  const parts = norm.split("/").filter((s) => s !== "");
  parts.pop();
  return parts.length === 0 ? "" : `${parts.join("/")}/`;
}

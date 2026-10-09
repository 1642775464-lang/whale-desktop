/**
 * 菜单规格：主窗口＋号菜单「长什么样」的知识
 *
 * 职责：声明菜单行的图标组件名、分组顺序、本地化文案，以及这些文案的
 *       校验源（哪个包的哪个字典键）。所属层：工程工具（tools/）
 *
 * 为什么从 whale-menu-icons.mjs 拆出来（开发规范 强制 14，普通模块 500 行）：
 *   那个文件里其实混着两类知识——
 *     · **规格**：菜单有哪些行、每行用哪个图标组件、文案是什么（本文件）；
 *     · **机制**：怎么从 DSH 包里把 path 数据抠出来、怎么生成模块。
 *   两者变化的理由不同：DSH 加一条菜单行只动规格，改打包格式只动机制。
 *   混在一起时，改一条文案要先读完 500 行提取代码。
 *
 * 这些常量**不是我们编的**，是从 DSH 安装包读出来抄录的；
 * `tests/contract/menu-icons.test.mjs` 会拿 LABEL_SOURCES 回去逐字核对。
 */

import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * DSH 安装目录。
 *
 * 与检出位置（C:\Program Files\DSH Desktop\resources\app）是**同一个地方**，
 * 但这里不写死盘符：允许用环境变量覆盖，方便换机器或做阴性对照。
 */
export const DSH_APP_DIR =
  process.env.DSH_APP_DIR ?? "C:\\Program Files\\DSH Desktop\\resources\\app";

/** 图标 path 数据所在包（主窗口图标的权威来源）。 */
export const PRIMITIVES_FILE = path.join(
  DSH_APP_DIR,
  "node_modules",
  "@deepseek-ai",
  "dsh-client-ui-primitives",
  "lib",
  "index.js",
);

/** 主窗口菜单行 → 图标组件的绑定表所在包。 */
export const COMMANDS_FILE = path.join(
  DSH_APP_DIR,
  "node_modules",
  "@deepseek-ai",
  "dsh-client-ui-commands",
  "lib",
  "client.js",
);

/**
 * 「模型」那一行的绑定点在**另一个包**。
 *
 * 主窗口的「模型」不是宿主命令，图标由模型选择包自己注册
 * （`name: "model"` + `IconDataOutlineRegular`），所以它的校验源不同。
 */
export const MODEL_FILE = path.join(
  DSH_APP_DIR,
  "node_modules",
  "@deepseek-ai",
  "dsh-client-ui-model-selection",
  "lib",
  "client.js",
);

/** 生成目标。 */
export const OUT_FILE = path.join(ROOT, "whale-window", "renderer", "menu-icons.js");

/**
 * 菜单行定义。
 *
 * `artwork` 是 primitives 包里 Artwork 函数的**标识符**。计划的图标是别名
 * （`IconPlanOutlineArtwork` 直接转发到 `IconListPenOutlineArtwork`），
 * 所以这里填最终画图的那个。
 *
 * `regular` 是要复刻的组件名（主窗口用的是 Regular 档，strokeWidth 1）。
 * 工具会去 commands 包的 `HOST_FACES` 里核对「命令名 → 组件名」没漂移。
 */
export const MENU_ROWS = Object.freeze([
  { key: "file", host: null, artwork: "IconPaperclipOutlineArtwork", regular: "IconPaperclipOutlineRegular", size: 16 },
  { key: "goal", host: "goal", artwork: "IconGoalOutlineArtwork", regular: "IconGoalOutlineRegular", size: 16 },
  { key: "plan", host: "plan", artwork: "IconListPenOutlineArtwork", regular: "IconPlanOutlineRegular", size: 14 },
  { key: "feedback", host: "feedback", artwork: "IconPaperPlaneOutlineArtwork", regular: "IconPaperPlaneOutlineRegular", size: 14 },
  { key: "compact", host: "compact", artwork: "IconCompactOutlineArtwork", regular: "IconCompactOutlineRegular", size: 16 },
  { key: "permission", host: "permission", artwork: "FullAccessArtwork", regular: "PermissionIconFullAccessRegular", size: 16 },
  // 「模型」的绑定点在模型选择包（不是宿主命令表），见 MODEL_FILE
  { key: "model", host: null, artwork: "IconDataOutlineArtwork", regular: "IconDataOutlineRegular", size: 16 },
  { key: "export", host: "export", artwork: "IconDownloadOutlineArtwork", regular: "IconDownloadOutlineRegular", size: 16 },
]);

/** 主窗口菜单的分组（与 commands 包的 SECTION_ROWS 一致）。 */
export const MENU_SECTIONS = Object.freeze({
  add: Object.freeze(["file", "goal", "plan", "feedback"]),
  commands: Object.freeze(["compact", "permission", "model", "export"]),
});

/** 主窗口菜单的本地化标题（与主窗口各包的 zh 字典一致）。 */
export const MENU_LABELS = Object.freeze({
  file: "文件",
  goal: "目标",
  plan: "计划",
  feedback: "反馈",
  compact: "压缩",
  permission: "权限",
  model: "模型",
  export: "下载日志",
});

/** 主窗口菜单的本地化说明（与主窗口各包的 zh 字典一致）。 */
export const MENU_DESCRIPTIONS = Object.freeze({
  file: "引用工作区文件",
  goal: "设置或查看长期任务目标",
  plan: "进入或退出计划模式",
  feedback: "发送关于当前会话的反馈",
  compact: "压缩以上对话内容",
  permission: "切换权限预设（沙箱模式与审批策略）",
  model: "选择本会话使用的模型",
  export: "将当前会话内容导出为 ZIP",
});

/**
 * 内置命令的**本地化命令写法**（zh 字典里的 `token.*`）。
 *
 * ⚠️ 与标题是**两回事**，不要混：
 *   · 标题（`label.*`）：菜单行左边显示什么 —— export 是「下载日志」；
 *   · 写法（`token.*`）：**插进输入框的文本** —— export 是「导出」。
 *
 * 主窗口在菜单里点一条带参数的命令时，插进草稿的是**本地化写法**，
 * 提交时才由 `TOKEN_ALIASES` 解析回真实命令名（`plan`）。用户接着写参数，
 * 中英文写法都能被认出来。
 */
export const MENU_TOKENS = Object.freeze({
  goal: "目标",
  plan: "计划",
  feedback: "反馈",
  compact: "压缩",
  permission: "权限",
  export: "导出",
});

/**
 * 本地化文案的校验源：包 → 字典键 → 期望值。
 *
 * 这些文案**必须来自主窗口自己的字典**，不能由我们编。DSH 改了措辞时，
 * 契约测试会在这里红，而不是小窗悄悄显示着上一版的文案。
 */
export const LABEL_SOURCES = Object.freeze([
  {
    file: COMMANDS_FILE,
    checks: {
      "label.goal": "目标",
      "label.plan": "计划",
      "label.feedback": "反馈",
      "label.compact": "压缩",
      "label.permission": "权限",
      "label.export": "下载日志",
      "description.goal": "设置或查看长期任务目标",
      "description.plan": "进入或退出计划模式",
      "description.feedback": "发送关于当前会话的反馈",
      // 插进输入框的写法（与标题不同名，单独核对）
      "token.goal": "目标",
      "token.plan": "计划",
      "token.feedback": "反馈",
      "token.compact": "压缩",
      "token.permission": "权限",
      "token.export": "导出",
    },
  },
  {
    file: MODEL_FILE,
    checks: {
      "command.label": "模型",
      "command.description": "选择本会话使用的模型",
    },
  },
]);

/**
 * 读一个包的 zh 字典里某个键的值。
 *
 * 只做极简解析（`"键": "值"`），够用且不引入依赖；
 * 拿不到返回 undefined，由调用方决定是报错还是跳过。
 *
 * @param {string} src
 * @param {string} key
 * @returns {string|undefined}
 */
export function readZhEntry(src, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hit = new RegExp(`"${escaped}"\\s*:\\s*"([^"]*)"`).exec(src);
  return hit === null ? undefined : hit[1];
}

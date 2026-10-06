# 步骤 9 · Git 与质量闸门

## 仓库

首次提交 65b5bdb，42 个文件入库。分支 main + develop。

## 六道闸门

| # | 名称 | 命令 | 结果 |
|---|---|---|---|
| 1 | 语法检查 | node --check | 通过 |
| 2 | Lint | eslint . | 通过 |
| 3 | 单测覆盖率 | node --test | 待实施 |
| 4 | 密钥扫描 | scan-secrets | 通过 |
| 5 | 依赖扫描 | scan-deps | 通过 |
| 6 | 规范扫描 | scan-rules | 通过 |

统一入口 tools/gate.mjs，执行记录写 gate-log.ndjson。

## 构建闸门改语法检查

零构建方案没有编译步骤。闸门 1 替代它，已在开发规范强制 26 写明。

## 不依赖 husky

用 core.hooksPath 指向 .githooks。零依赖。

## 排除入库

_inbox 977KB 原输入包与既有源码、_probe 25KB 探查脚本、runtime 运行时二进制、node_modules。

## 负向测试

密钥扫描拦下 sk- 开头的假密钥；规范扫描拦下 520 行文件、utils.mjs 垃圾桶名、渲染层引宿主包。

## 一个坑

往 gate.mjs 里写「eslint 没装就跳过」的兜底，结果把真实的 lint 失败也吞成了跳过。已改成显式检查工具是否存在。

## 关键数字

- 首次提交 42 个文件
- 强制项 35 条
- 运行时第三方依赖 0
- .gitignore 排除 4 类目录

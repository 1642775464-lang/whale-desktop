# 切片 1 完成：桥骨架端到端可用

## 一句话结论

桥的 HTTP 服务已在 `127.0.0.1:19387` 起得来，4 条只读路由全部返回预期结果，六道闸门全过、35 个单测全绿；本片未装插件进真实宿主，装插件留到验收环节。

## 本片交付了什么

```kv cols=2
路由数: 22 条已登记（唯一事实源 routes.mjs）
已实现: 4 条只读路由
源文件: 7 个新增（host.js + lib/ 六个模块）
测试: 3 份，35 个用例全绿
闸门: 6 道全过
运行时依赖: 0 个
```

## 四条路由的真实验证结果

用假宿主 ctx 起真实服务、发真实 HTTP 请求，实测响应如下：

```kv cols=2
GET /whale: 200，返回 22 条路由表，4 条 implemented=true
GET /whale/probe: 200，宿主服务探测 sessions/agents/commands 可用
GET /whale/capability: 200，send/command/abort/resume 四项均 available
GET /whale/panel: 200，messages/todos 空数组，permission/model 为 null
```

降级路径也一并验证：

```kv cols=2
GET /whale/panel 缺参数: 400，code=bad-request
GET /whale/panel 未知会话: 404，code=session-not-found
GET /whale/nope: 404，code=not-found
```

## 一个值得记下的坑

冒烟演示脚本第一版跑出全部路由 404，但单测 35 个全绿、同代码换端口就正常。逐层排查注册表、路径解析、模块实例、端口绑定之后定位到：

> `tests/smoke-demo.mjs` 第 12 行 `import { registerSliceOneRoutes }` 了，却从未调用。处理器表为空，服务照常起得来、照常监听端口，于是每个请求都规规矩矩地回 404。

单测没暴露它，是因为每个单测各自独立调了注册函数。教训是：演示脚本不走与被测代码同一条初始化路径时，它验证的其实是另一套东西；真实入口是 `host.js` 的 `apply()`，注册发生在它内部。

## 降级口径

```kv cols=2
取不到数据: 字段给 null，不编造数字
缺参数: 回 400 并说明缺哪个参数
未知会话: 回 404 并带上会话 id
服务缺失: 不抛错，只在 probe 里标 false
```

## 下一步

切片 2 接宿主事件订阅。补三个纯函数模块：折叠器、token 统计、逐帧 zstd 解码。再把架构铁律 A-1 做成可机械化检查的测试。

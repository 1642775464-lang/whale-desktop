/**
 * 宿主 ctx 的测试替身
 *
 * 职责：给 host-ctx 相关的单测提供两种假 ctx —— 带 Cordis inject 守卫的、
 *       以及带 `get` 方法的。所属层：测试（tests/helpers）
 *
 * 为什么抽出来：`host-ctx.test.mjs` 顶到 500 行上限（强制 14），
 * 按职责把「探测服务 / 归档判据」拆到另一个文件；两个文件都需要这两个
 * 替身，所以落在 helpers 里共用，而不是各自复制一份（复制必然漂移）。
 */

/**
 * 造一个模拟 Cordis 服务容器的 ctx。
 *
 * 关键行为与 @deepseek-ai/cordis 的 Proxy handler 一致：
 *   - 已注册且已声明的服务 → 返回实例
 *   - 已注册但**未声明 inject** → 抛 `cannot get property "X" without inject`
 *   - 未注册 → 抛普通 Error（不可用）
 *
 * ⚠️ 注意它守的是 **`ctx.X` 属性访问**。`ctx.get(name)` 是另一条路
 * （不经过 inject 守卫），用下面的 `createGettableCtx`。
 *
 * @param {object} services 已注册的服务
 * @param {string[]} injected 插件声明的 inject 列表
 * @returns {object}
 */
export function createGuardedCtx(services, injected) {
  const declared = new Set(injected);
  return new Proxy(
    { on: () => () => {} },
    {
      get(target, prop) {
        if (typeof prop !== "string") return Reflect.get(target, prop);
        if (Reflect.has(target, prop)) return Reflect.get(target, prop);

        if (Object.hasOwn(services, prop)) {
          if (!declared.has(prop)) {
            throw new Error(`cannot get property "${prop}" without inject`);
          }
          return services[prop];
        }
        throw new Error(`service "${prop}" not found`);
      },
    },
  );
}

/**
 * 造一个带 `get` 的 ctx（可选服务走这条）。
 *
 * `ctx.get(name)` **不经过 inject 守卫** —— 桥的可选服务全都用它，
 * 所以测这些能力（probe / 归档判据 / 模型目录）要用这个替身。
 *
 * @param {object} services 已注册的服务
 * @param {string[]} [injected] 已声明 inject 的名字（属性访问要放行）
 * @returns {object}
 */
export function createGettableCtx(services, injected = []) {
  const declared = new Set(injected);
  return {
    on: () => () => {},
    get: (name) => (Object.hasOwn(services, name) ? services[name] : undefined),
    ...Object.fromEntries(
      Object.entries(services).filter(([name]) => declared.has(name)),
    ),
  };
}

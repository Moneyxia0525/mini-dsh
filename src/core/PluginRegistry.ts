import type { MiniContext, MiniPlugin } from "../types";

export interface PluginRegistryOptions {
  /** 注入到每个插件的共享运行时上下文 */
  ctx: MiniContext;
  /** 生命周期日志（默认 console，可注入静默实现用于测试） */
  logger?: Pick<Console, "log" | "error">;
}

/**
 * PluginRegistry：插件装配与生命周期管理。
 *
 * 职责：
 * 1. 校验插件名唯一
 * 2. 依据 dependsOn 做拓扑排序
 * 3. 依次执行 setup（插件在此通过 ctx.provide 注册服务）
 * 4. 卸载时逆序执行 dispose
 *
 * 内核不含任何业务逻辑，只做「装配、依赖校验、生命周期」三件事。
 */
export class PluginRegistry {
  private plugins: MiniPlugin[] = [];
  private setupDone = new Set<string>();
  private ctx: MiniContext;
  private logger: Pick<Console, "log" | "error">;

  constructor(options: PluginRegistryOptions) {
    this.ctx = options.ctx;
    this.logger = options.logger ?? console;
  }

  register(plugin: MiniPlugin): this {
    if (this.plugins.some((p) => p.name === plugin.name)) {
      throw new Error(`[PluginRegistry] 插件名重复: "${plugin.name}"`);
    }
    this.plugins.push(plugin);
    return this;
  }

  registerAll(plugins: MiniPlugin[]): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  get size(): number {
    return this.plugins.length;
  }

  /** 拓扑排序（Kahn），依赖缺失直接报错 */
  private topoSort(): MiniPlugin[] {
    const byName = new Map(this.plugins.map((p) => [p.name, p]));
    const indegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const p of this.plugins) {
      indegree.set(p.name, 0);
    }
    for (const p of this.plugins) {
      for (const dep of p.dependsOn ?? []) {
        if (!byName.has(dep)) {
          throw new Error(
            `[PluginRegistry] 插件 "${p.name}" 声明的依赖 "${dep}" 不存在，请确认该服务由哪个插件提供`,
          );
        }
        indegree.set(p.name, (indegree.get(p.name) ?? 0) + 1);
        const list = dependents.get(dep) ?? [];
        list.push(p.name);
        dependents.set(dep, list);
      }
    }

    const queue = [...this.plugins.filter((p) => (indegree.get(p.name) ?? 0) === 0)];
    const order: MiniPlugin[] = [];
    while (queue.length) {
      const cur = queue.shift()!;
      order.push(cur);
      for (const next of dependents.get(cur.name) ?? []) {
        const d = (indegree.get(next) ?? 0) - 1;
        indegree.set(next, d);
        if (d === 0) queue.push(byName.get(next)!);
      }
    }
    if (order.length !== this.plugins.length) {
      throw new Error(`[PluginRegistry] 检测到插件循环依赖: ${[...indegree.entries()].filter(([, v]) => v > 0).map(([k]) => k).join(", ")}`);
    }
    return order;
  }

  /** 依次 setup 所有插件，返回一个用于 dispose 的句柄 */
  async setupAll(): Promise<() => Promise<void>> {
    const order = this.topoSort();
    try {
      for (const plugin of order) {
        this.logger.log(`[PluginRegistry] setup: ${plugin.name}`);
        await plugin.setup(this.ctx);
        this.setupDone.add(plugin.name);
      }
    } catch (err) {
      this.logger.error("[PluginRegistry] setup 失败，开始回滚已完成的插件");
      for (const plugin of [...order].reverse()) {
        if (!this.setupDone.has(plugin.name)) continue;
        try {
          await plugin.dispose?.();
        } finally {
          this.setupDone.delete(plugin.name);
        }
      }
      throw err;
    }
    return async () => {
      for (const plugin of [...order].reverse()) {
        if (!this.setupDone.has(plugin.name)) continue;
        this.logger.log(`[PluginRegistry] dispose: ${plugin.name}`);
        await plugin.dispose?.();
        this.setupDone.delete(plugin.name);
      }
    };
  }
}

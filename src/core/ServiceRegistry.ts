/**
 * ServiceRegistry：服务注册与依赖注入。
 *
 * 只负责「谁提供了什么能力、依赖谁」——key -> instance 的映射。
 * 不感知插件生命周期，保证内核最小化。
 */
export class ServiceRegistry {
  private services = new Map<string, unknown>();

  register<T>(key: string, service: T): void {
    if (this.services.has(key)) {
      throw new Error(`[ServiceRegistry] service "${key}" 已注册，重复注册通常意味着装配顺序错误`);
    }
    this.services.set(key, service);
  }

  replace<T>(key: string, service: T): void {
    if (!this.services.has(key)) {
      throw new Error(`[ServiceRegistry] service "${key}" 尚未注册，无法替换`);
    }
    this.services.set(key, service);
  }

  /** 注入服务，缺失即抛错（fail-fast，装配期即暴露依赖缺失） */
  get<T>(key: string): T {
    const service = this.services.get(key);
    if (service === undefined) {
      throw new Error(`[ServiceRegistry] 未找到服务 "${key}"，请检查插件依赖声明（dependsOn）与装配顺序`);
    }
    return service as T;
  }

  tryGet<T>(key: string): T | undefined {
    return this.services.get(key) as T | undefined;
  }

  has(key: string): boolean {
    return this.services.has(key);
  }

  keys(): string[] {
    return [...this.services.keys()];
  }
}

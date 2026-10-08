import type { RunnerConfig } from "../runner/config.js";
import { TransportRegistry } from "../transports/registry.js";
import { DirectTransportFactory } from "../transports/direct.js";
import { HttpProxyTransportFactory } from "../transports/http-proxy.js";
import { Socks5TransportFactory } from "../transports/socks5.js";
import type { BrowserHost } from "../browser/types.js";
import type { ProxyConfigState } from "../runtime/proxy-config-contract.js";

/**
 * 任务级执行快照:任务开始时取得,生命周期内固定不变。
 * 旧任务读旧快照,新任务读新快照,不存在混合版本读取。
 */
export interface ExecutionSnapshot {
  readonly version: number;
  readonly deployments: RunnerConfig["providers"];
  readonly transports: TransportRegistry;
  readonly browser: BrowserHost;
}

/**
 * 从权威配置状态构建不可变执行快照。
 *
 * - 全新构建 TransportRegistry,不修改任何旧实例;
 * - deployment 对象与其 transport 深度冻结;
 * - 浏览器宿主共享,仅换绑当前 Registry(见 ChromeProfileHost.forTransports)。
 */
export function buildExecutionSnapshot(
  state: ProxyConfigState,
  baseConfig: RunnerConfig,
  sharedBrowser: BrowserHost & { forTransports?: (transports: TransportRegistry) => BrowserHost },
): ExecutionSnapshot {
  const transports = new TransportRegistry();
  // 快照 Registry 是独立实例,必须自带工厂;与 createRunnerRuntime 保持同一组实现。
  transports.registerFactory(new DirectTransportFactory());
  transports.registerFactory(new HttpProxyTransportFactory());
  transports.registerFactory(new Socks5TransportFactory());
  for (const [id, transport] of Object.entries(state.transports)) {
    if (transport.type === "direct") {
      transports.build(id, { type: "direct" });
    } else {
      transports.build(id, { type: transport.type, url: transport.url });
    }
  }

  const deployments = Object.fromEntries(
    Object.entries(baseConfig.providers).map(([id, deployment]) => {
      const binding = state.bindings[id];
      // null 绑定是显式状态:必须剔除 YAML deployment 自带的 transport,而不是保留。
      const { transport: _yamlTransport, ...rest } = deployment as typeof deployment & {
        transport?: { primary: string; fallback: string[] };
      };
      const effective = binding
        ? { ...rest, transport: Object.freeze({ ...binding, fallback: [...binding.fallback] }) }
        : rest;
      return [id, Object.freeze(effective)] as const;
    }),
  );

  const browser = sharedBrowser.forTransports
    ? sharedBrowser.forTransports(transports)
    : sharedBrowser;

  return {
    version: state.version,
    deployments,
    transports,
    browser,
  };
}

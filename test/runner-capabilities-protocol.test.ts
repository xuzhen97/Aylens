import { describe, expect, it } from "vitest";
import { CAPABILITIES_SCHEMA_IS_EXHAUSTIVE, runnerToGatewaySchema } from "../src/runtime/protocol.js";
import type { RuntimeCapabilities } from "../src/runtime/types.js";

/**
 * 能力上报的协议往返测试。
 *
 * 存在的理由：`capabilitiesSchema` 是 z.object，默认**剥除未知键**。
 * 漏声明一个字段不会有任何编译或测试信号，只会让 Gateway 静默收不到它——
 * `credentialConfig` 就这样丢过一次，界面恒报“该 Runner 不支持凭据管理”。
 *
 * 这里给每个字段都设一个**不同于缺省值**的取值（false / [] / {} 都是缺省，故一律用 true / 非空），
 * 再逐字段比对：任何漏声明的字段都会在这里被点名。
 */
const fullCapabilities: RuntimeCapabilities = {
  providerTypes: ["tavily"],
  providerIds: ["tavily"],
  authProviderIds: ["x"],
  providerOperations: { tavily: ["search", "extract", "usage"] },
  browsers: ["chrome"],
  profiles: ["browser-main"],
  profileDetails: [{
    id: "browser-main",
    browser: "chrome",
    mode: "cdp",
    activeLeases: 0,
    maxConcurrency: 1,
    interactive: true,
    transport: "proxy-main",
  }],
  providerStates: { x: { status: "authenticated", checkedAt: 1 } },
  proxyConfig: true,
  credentialConfig: true,
  http: true,
  browserAutomation: true,
};

function parseRegister(capabilities: RuntimeCapabilities) {
  const parsed = runnerToGatewaySchema.parse({
    type: "REGISTER",
    messageId: "m1",
    protocolVersion: "1",
    runnerId: "runner-1",
    hostname: "host",
    os: "linux",
    version: "1.0.0",
    labels: {},
    capabilities,
    capacity: { maxJobs: 4, activeJobs: 0 },
    timestamp: 1,
  });
  if (parsed.type !== "REGISTER") throw new Error(`expected REGISTER, got ${parsed.type}`);
  return parsed;
}

function parseHeartbeat(capabilities: RuntimeCapabilities) {
  const parsed = runnerToGatewaySchema.parse({
    type: "HEARTBEAT",
    messageId: "m2",
    runnerId: "runner-1",
    capabilities,
    capacity: { maxJobs: 4, activeJobs: 1 },
    timestamp: 2,
  });
  if (parsed.type !== "HEARTBEAT") throw new Error(`expected HEARTBEAT, got ${parsed.type}`);
  return parsed;
}

describe("runner capability protocol", () => {
  it("declares every RuntimeCapabilities field in the protocol schema", () => {
    // 编译期守卫的测试期镜像：漏字段时上面那个类型断言先拦住，这里再给运行时信号。
    expect(CAPABILITIES_SCHEMA_IS_EXHAUSTIVE).toBe(true);
  });

  it("preserves every capability field through the real REGISTER schema", () => {
    const { capabilities } = parseRegister(fullCapabilities);

    for (const [key, value] of Object.entries(fullCapabilities)) {
      expect(
        (capabilities as Record<string, unknown>)[key],
        `capabilities.${key} 在协议 schema 中被丢弃`,
      ).toEqual(value);
    }
    expect(capabilities).toEqual(fullCapabilities);
  });

  it("preserves every capability field through the real HEARTBEAT schema", () => {
    expect(parseHeartbeat(fullCapabilities).capabilities).toEqual(fullCapabilities);
  });

  it("defaults the management capabilities to false for older runners", () => {
    // 旧 Runner 只会上报这些字段。
    const legacy = parseRegister({
      providerTypes: [],
      providerIds: [],
      browsers: [],
      profiles: [],
      http: true,
      browserAutomation: false,
    } as RuntimeCapabilities).capabilities;

    // 未上报 → 缺省 false → Gateway 明确拒绝对其做配置管理，
    // 而不是乐观假设它支持。
    expect(legacy.credentialConfig).toBe(false);
    expect(legacy.proxyConfig).toBe(false);
    expect(legacy.providerOperations).toBeUndefined();
  });
});

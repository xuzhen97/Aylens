import { describe, expect, it } from "vitest";
import { gatewayToRunnerSchema } from "../src/runtime/protocol.js";
import { configReplySchema } from "../src/runtime/runner-config-channel.js";
import type { ConfigResource } from "../src/runtime/runner-config-channel.js";

/**
 * 配置协议的往返守卫。
 *
 * 这里封的是一整族已经反复出事的缺陷：**「类型/契约改了，zod schema 没跟上」**。
 * z.object 会剥除或拒绝不认识的形状，而丢弃往往是静默的——
 * 最坏的一次是 `CONFIG_REQUEST.write` 只声明了 proxyWriteSchema：
 * Runner 收下凭据写入时 safeParse 失败直接 return，发送方干等 10 秒超时，
 * 表现为浏览器里“读取配置能用、保存必失败”。
 *
 * 因此每个**资源类型**都必须在这里同时覆盖两个方向（请求 + 回执），
 * 新增资源忘了加 schema 就会红。
 */
const CREDENTIAL_WRITE = {
  operationId: "op-1",
  expectedVersion: 0,
  mutation: { kind: "put-pool", id: "tavily-main", service: "tavily", name: "Tavily", enabled: true },
};

const CREDENTIAL_SAFE_VIEW = {
  version: 0,
  pools: [],
  credentials: [],
  providers: [{ id: "tavily", poolId: null }],
};

const PROXY_WRITE = {
  operationId: "op-2",
  expectedVersion: 0,
  mutation: { kind: "put", id: "proxy-new", type: "http-proxy", address: "http://127.0.0.1:8899", credentials: { action: "clear" } },
};

const PROXY_SAFE_VIEW = {
  version: 0,
  proxies: [{ id: "direct", type: "direct", hasCredentials: false, providerRefs: [], profileRefs: [] }],
  providers: [],
  browserRestartRequired: [],
};

/** 与 `ConfigResource` 一一对应；漏一个资源类型会让下面的循环少跑一组。 */
const RESOURCES: Array<{ resource: ConfigResource; write: unknown; safeView: unknown }> = [
  { resource: "proxy", write: PROXY_WRITE, safeView: PROXY_SAFE_VIEW },
  { resource: "credentials", write: CREDENTIAL_WRITE, safeView: CREDENTIAL_SAFE_VIEW },
];

describe("runner config protocol round-trip", () => {
  it("covers every ConfigResource declared by the channel", () => {
    // 这个是防“新增资源忘了加到本表”的：资源名是字面量联合，
    // 用类型断言保证本表覆盖全部取值。
    const covered: Record<ConfigResource, true> = { proxy: true, credentials: true };
    expect(RESOURCES.map((entry) => entry.resource).sort()).toEqual(Object.keys(covered).sort());
  });

  for (const { resource, write, safeView } of RESOURCES) {
    it(`accepts a ${resource} write in Gateway→Runner CONFIG_REQUEST`, () => {
      const parsed = gatewayToRunnerSchema.safeParse({
        type: "CONFIG_REQUEST",
        messageId: "m1",
        requestId: "r1",
        runnerId: "runner-1",
        resource,
        kind: "write",
        write,
        operationId: "op-1",
        expectedVersion: 0,
        timestamp: 1,
      });

      expect(parsed.success, `CONFIG_REQUEST 拒绝了 ${resource} 写入：${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    });

    it(`accepts a ${resource} read request without a write payload`, () => {
      const parsed = gatewayToRunnerSchema.safeParse({
        type: "CONFIG_REQUEST",
        messageId: "m2",
        requestId: "r2",
        runnerId: "runner-1",
        resource,
        kind: "read",
        timestamp: 1,
      });

      expect(parsed.success).toBe(true);
    });

    it(`accepts a ${resource} result in Runner→Gateway CONFIG_RESULT`, () => {
      const parsed = configReplySchema.safeParse({
        type: "CONFIG_RESULT",
        messageId: "m3",
        requestId: "r3",
        runnerId: "runner-1",
        resource,
        result: safeView,
        timestamp: 1,
      });

      expect(parsed.success, `CONFIG_RESULT 拒绝了 ${resource} 脱敏视图：${JSON.stringify(parsed.error?.issues)}`).toBe(true);
    });
  }

  it("still accepts a legacy config request without the resource field", () => {
    const parsed = gatewayToRunnerSchema.safeParse({
      type: "CONFIG_REQUEST",
      messageId: "m4",
      requestId: "r4",
      runnerId: "runner-1",
      kind: "read",
      timestamp: 1,
    });

    // 旧 Gateway 不发 resource → 缺省按 proxy 解释，不能因此拒收。
    expect(parsed.success).toBe(true);
  });
});

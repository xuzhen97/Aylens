import { z } from "zod";
import { providerAuthStateSchema } from "../contracts/validation.js";
import { configReplySchema } from "./runner-config-channel.js";
import { proxyWriteSchema } from "./proxy-config-contract.js";
import { credentialWriteSchema } from "./credential-config-contract.js";
import type { RuntimeCapabilities } from "./types.js";

export const RUNNER_PROTOCOL_VERSION = "1";

const browserProfileStateSchema = z.object({
  id: z.string(),
  browser: z.string(),
  mode: z.enum(["launch", "cdp"]),
  activeLeases: z.number().int().nonnegative(),
  maxConcurrency: z.number().int().positive(),
  interactive: z.boolean(),
  transport: z.string().min(1),
});

/** 用量报告：精度区分官方统计 / 响应报告 / 本地估算 / 未知，未知不化成 0。 */
const providerUsageReportSchema = z.object({
  service: z.string(),
  fetchedAt: z.number(),
  accuracy: z.enum(["official", "response", "estimated", "unknown"]),
  supported: z.boolean(),
  entries: z.array(z.object({
    scope: z.enum(["credential", "account"]),
    used: z.number().optional(),
    limit: z.number().nullable().optional(),
    // 单位不跨服务商可比（credits / requests / USD），因此不归一化。
    unit: z.string(),
  })),
});

const capabilitiesSchema = z.object({
  providerTypes: z.array(z.string()),
  providerIds: z.array(z.string()),
  authProviderIds: z.array(z.string()).default([]),
  // 每个 Provider 的实际操作能力。旧 Runner 不上报 → 缺省 undefined，
  // Gateway 对 search/auth 照旧派发、对新能力 extract 明确拒绝。
  providerOperations: z.record(z.string(), z.array(z.enum(["search", "extract", "usage"]))).optional(),
  browsers: z.array(z.string()),
  profiles: z.array(z.string()),
  // 兼容旧 Runner:调度仍使用 profiles;详细状态是增量可观测字段。
  profileDetails: z.array(browserProfileStateSchema).default([]),
  providerStates: z.record(z.string(), providerAuthStateSchema).default({}),
  // 兼容旧 Runner:新 Runner 才支持代理配置通道。
  proxyConfig: z.boolean().default(false),
  // API 凭据池的管理能力。与 proxyConfig 独立：旧 Runner 缺省 false。
  credentialConfig: z.boolean().default(false),
  http: z.boolean(),
  browserAutomation: z.boolean(),
});

/**
 * 编译期守卫：capabilitiesSchema 必须声明 RuntimeCapabilities 的每一个字段。
 *
 * z.object 默认**剥除未知键**，所以漏声明一个字段不会报错，只会在运行时静默丢失
 * —— `credentialConfig` 就这样丢过一次，表现为界面恒报“该 Runner 不支持凭据管理”。
 * 这个断言把“漏字段”从运行时静默故障变成编译错误，并直接指出缺哪个。
 */
type CapabilitySchemaKeys = keyof z.infer<typeof capabilitiesSchema>;
type MissingCapabilityKeys = Exclude<keyof RuntimeCapabilities, CapabilitySchemaKeys>;
/** 缺字段时把字段名当成类型，而不是笼统的 never —— 报错直接点名缺哪个。 */
type ExhaustivenessOf<T> = [T] extends [never] ? true : T;
export const CAPABILITIES_SCHEMA_IS_EXHAUSTIVE: ExhaustivenessOf<MissingCapabilityKeys> = true;

const capacitySchema = z.object({
  maxJobs: z.number().int().positive(),
  activeJobs: z.number().int().nonnegative(),
});

export const runnerToGatewaySchema = z.discriminatedUnion("type", [
  configReplySchema,
  z.object({
    type: z.literal("REGISTER"),
    messageId: z.string(),
    protocolVersion: z.string(),
    runnerId: z.string(),
    hostname: z.string(),
    os: z.enum(["windows", "linux", "darwin"]),
    version: z.string(),
    labels: z.record(z.string(), z.string()),
    capabilities: capabilitiesSchema,
    capacity: capacitySchema,
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("HEARTBEAT"),
    messageId: z.string(),
    runnerId: z.string(),
    capabilities: capabilitiesSchema,
    capacity: capacitySchema,
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("JOB_ACCEPTED"),
    messageId: z.string(),
    runnerId: z.string(),
    jobId: z.string(),
    executionId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("JOB_STARTED"),
    messageId: z.string(),
    runnerId: z.string(),
    jobId: z.string(),
    executionId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("JOB_RESULT"),
    messageId: z.string(),
    runnerId: z.string(),
    jobId: z.string(),
    executionId: z.string(),
    output: z.union([
      z.object({ items: z.array(z.unknown()) }),
      providerAuthStateSchema,
      // 用量报告：与搜索结果、登录态并列的第三种执行输出。
      providerUsageReportSchema,
    ]),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("JOB_ERROR"),
    messageId: z.string(),
    runnerId: z.string(),
    jobId: z.string(),
    executionId: z.string(),
    error: z.object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    }),
    timestamp: z.number(),
  }),
]);

export const gatewayToRunnerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("REGISTERED"),
    messageId: z.string(),
    protocolVersion: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("EXECUTE"),
    messageId: z.string(),
    jobId: z.string(),
    executionId: z.string(),
    providerId: z.string(),
    providerType: z.string(),
    operation: z.enum(["search", "extract", "usage", "auth_check", "auth_login"]),
    input: z.unknown(),
    requestId: z.string(),
    traceId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("CONFIG_REQUEST"),
    messageId: z.string(),
    requestId: z.string(),
    runnerId: z.string(),
    // 旧 Gateway 不发该字段 → 按 proxy 解析，既有代理通道不受影响。
    resource: z.enum(["proxy", "credentials"]).optional(),
    kind: z.enum(["read", "write"]),
    // 两种资源的写形状都必须收：只声明 proxyWriteSchema 时，
    // Runner 会因 safeParse 失败而**静默丢弃**凭据写入，
    // 发送方干等 10 秒超时（表现为 CONFIG_RESULT_UNKNOWN / 503）。
    write: z.union([proxyWriteSchema, credentialWriteSchema]).optional(),
    operationId: z.string().optional(),
    expectedVersion: z.number().int().nonnegative().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("CANCEL"),
    messageId: z.string(),
    jobId: z.string(),
    executionId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal("PING"),
    messageId: z.string(),
    timestamp: z.number(),
  }),
]);

export type RunnerToGatewayMessage = z.infer<typeof runnerToGatewaySchema>;
export type GatewayToRunnerMessage = z.infer<typeof gatewayToRunnerSchema>;

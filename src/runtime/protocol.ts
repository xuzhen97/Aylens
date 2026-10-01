import { z } from "zod";
import { providerAuthStateSchema } from "../contracts/validation.js";

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

const capabilitiesSchema = z.object({
  providerTypes: z.array(z.string()),
  providerIds: z.array(z.string()),
  authProviderIds: z.array(z.string()).default([]),
  browsers: z.array(z.string()),
  profiles: z.array(z.string()),
  // 兼容旧 Runner：调度仍使用 profiles；详细状态是增量可观测字段。
  profileDetails: z.array(browserProfileStateSchema).default([]),
  providerStates: z.record(z.string(), providerAuthStateSchema).default({}),
  http: z.boolean(),
  browserAutomation: z.boolean(),
});

const capacitySchema = z.object({
  maxJobs: z.number().int().positive(),
  activeJobs: z.number().int().nonnegative(),
});

export const runnerToGatewaySchema = z.discriminatedUnion("type", [
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
    operation: z.enum(["search", "auth_check", "auth_login"]),
    input: z.unknown(),
    requestId: z.string(),
    traceId: z.string(),
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

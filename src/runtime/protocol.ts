import { z } from "zod";

export const RUNNER_PROTOCOL_VERSION = "1";

const capabilitiesSchema = z.object({
  providerTypes: z.array(z.string()),
  browsers: z.array(z.string()),
  profiles: z.array(z.string()),
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
    output: z.object({ items: z.array(z.unknown()) }),
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
    providerConfig: z.unknown(),
    operation: z.literal("search"),
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

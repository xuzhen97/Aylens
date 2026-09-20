import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { interpolateEnv } from "../config/loader.js";
import { browserProfileSchema, transportSchema } from "../config/schema.js";

export const runnerConfigSchema = z.object({
  runner: z.object({
    id: z.string().min(1),
    gatewayUrl: z.string().url(),
    token: z.string().min(1),
    heartbeatMs: z.number().int().positive().default(10_000),
    maxJobs: z.number().int().positive().default(1),
    labels: z.record(z.string(), z.string()).default({}),
  }),
  plugins: z.object({
    baseDir: z.string().min(1).default("."),
    modules: z.array(z.string().min(1)).default([]),
  }).default({ baseDir: ".", modules: [] }),
  capabilities: z.object({
    browsers: z.array(z.string()).default([]),
    http: z.boolean().default(true),
    browserAutomation: z.boolean().default(false),
  }),
  transports: z.record(z.string(), transportSchema).default({
    direct: { type: "direct" },
  }),
  browserProfiles: z.record(z.string(), browserProfileSchema).default({}),
}).superRefine((config, ctx) => {
  for (const [profileId, profile] of Object.entries(config.browserProfiles)) {
    if (profile.mode === "cdp" && !profile.cdpEndpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["browserProfiles", profileId, "cdpEndpoint"],
        message: "cdpEndpoint is required when mode=cdp",
      });
    }

    if (profile.transport && !(profile.transport in config.transports)) {
      ctx.addIssue({
        code: "custom",
        path: ["browserProfiles", profileId, "transport"],
        message: `Unknown Runner-local transport: ${profile.transport}`,
      });
    }
  }
});

export type RunnerConfig = z.infer<typeof runnerConfigSchema>;

export async function loadRunnerConfig(
  path = process.env.AYLENS_RUNNER_CONFIG ?? "./config/runner.yaml",
): Promise<RunnerConfig> {
  const raw = await readFile(resolve(path), "utf8");
  return runnerConfigSchema.parse(YAML.parse(interpolateEnv(raw)));
}

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import YAML from "yaml";
import { z } from "zod";
import { interpolateEnv } from "../config/loader.js";
import { browserProfileSchema, providerDeploymentSchema, transportSchema } from "../config/schema.js";
import { openSqlite } from "../storage/sqlite.js";
import { runnerDbPath } from "../storage/paths.js";
import { runnerMigrations } from "../storage/runner-migrations.js";
import { ProxyConfigStore } from "./proxy-config-store.js";
import { ProxyConfigService } from "./proxy-config-service.js";
import { CredentialStore } from "./credentials/store.js";
import { CredentialConfigService } from "./credentials/service.js";

export const runnerConfigSchema = z.object({
  runner: z.object({
    id: z.string().min(1),
    gatewayUrl: z.string().url(),
    token: z.string().min(1),
    heartbeatMs: z.number().int().positive().default(10_000),
    maxJobs: z.number().int().positive().default(10),
    labels: z.record(z.string(), z.string()).default({}),
  }),
  plugins: z.object({
    baseDir: z.string().min(1).default("."),
    modules: z.array(z.string().min(1)).default([]),
  }).default({ baseDir: ".", modules: [] }),
  browser: z.object({
    defaultProfile: z.string().min(1).optional(),
  }).default({}),
  providers: z.record(z.string(), providerDeploymentSchema).default({}),
  transports: z.record(z.string(), transportSchema).default({
    direct: { type: "direct" },
  }),
  browserProfiles: z.record(z.string(), browserProfileSchema).default({}),
}).superRefine((config, ctx) => {
  if (config.browser.defaultProfile && !(config.browser.defaultProfile in config.browserProfiles)) {
    ctx.addIssue({
      code: "custom",
      path: ["browser", "defaultProfile"],
      message: `Unknown Runner-local default browser profile: ${config.browser.defaultProfile}`,
    });
  }

  for (const [profileId, profile] of Object.entries(config.browserProfiles)) {
    if (profile.mode === "cdp" && !profile.cdpEndpoint) {
      ctx.addIssue({
        code: "custom",
        path: ["browserProfiles", profileId, "cdpEndpoint"],
        message: "cdpEndpoint is required when mode=cdp",
      });
    }

    if (profile.mode === "cdp" && profile.autoStart && profile.cdpEndpoint) {
      let endpoint: URL;
      try {
        endpoint = new URL(profile.cdpEndpoint);
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["browserProfiles", profileId, "cdpEndpoint"],
          message: "cdpEndpoint is not a valid URL",
        });
        continue;
      }
      const isLoopback = endpoint.hostname === "127.0.0.1" || endpoint.hostname === "localhost" || endpoint.hostname === "::1";
      if (endpoint.protocol !== "http:" || !isLoopback) {
        ctx.addIssue({
          code: "custom",
          path: ["browserProfiles", profileId, "cdpEndpoint"],
          message: "autoStart requires a local http:// CDP endpoint",
        });
      }
    }

    if (profile.mode === "cdp" && profile.maxConcurrency !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["browserProfiles", profileId, "maxConcurrency"],
        message: "mode=cdp requires maxConcurrency=1 so Playwright can attach/detach per job safely",
      });
    }

    if (profile.mode === "launch" && profile.autoStart) {
      ctx.addIssue({
        code: "custom",
        path: ["browserProfiles", profileId, "autoStart"],
        message: "autoStart is only supported when mode=cdp",
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

  for (const [providerId, deployment] of Object.entries(config.providers)) {
    if (deployment.browser && !(deployment.browser.profile in config.browserProfiles)) {
      ctx.addIssue({
        code: "custom",
        path: ["providers", providerId, "browser", "profile"],
        message: `Unknown Runner-local browser profile: ${deployment.browser.profile}`,
      });
    }

    if (deployment.transport) {
      for (const transportId of [deployment.transport.primary, ...deployment.transport.fallback]) {
        if (!(transportId in config.transports)) {
          ctx.addIssue({
            code: "custom",
            path: ["providers", providerId, "transport"],
            message: `Unknown Runner-local transport: ${transportId}`,
          });
        }
      }
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

export interface RunnerStartup {
  config: RunnerConfig;
  store: ProxyConfigStore;
  service: ProxyConfigService;
  /** API 凭据池：与代理共用同一个 Runner 数据库，但表与所有权完全独立。 */
  credentialStore: CredentialStore;
  credentialService: CredentialConfigService;
  database: DatabaseSync;
  databasePath: string;
  close(): void;
}

export interface RunnerStartupOptions {
  /** 测试注入:优先于按 runner ID 推导的文件库。 */
  database?: DatabaseSync;
  /** 重启场景:复用既有数据库文件。 */
  databasePath?: string;
}

/**
 * Runner 启动装载:先解析未迁移启动字段(runner 身份与 DB 路径),
 * 再按初始化状态选择一次性导入或权威读取。
 *
 * - 首次启动:完整校验 YAML(含插值)后导入代理与绑定。
 * - 已初始化:剔除 YAML 中已迁移字段(transports/providers.transport)后再插值,
 *   失效的旧代理环境变量或旧绑定不会阻断启动;代理与绑定以数据库为唯一来源。
 */
export async function loadRunnerStartup(
  path = process.env.AYLENS_RUNNER_CONFIG ?? "./config/runner.yaml",
  options: RunnerStartupOptions = {},
): Promise<RunnerStartup> {
  const rawText = await readFile(resolve(path), "utf8");
  const raw = YAML.parse(rawText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new Error("Runner config is empty or invalid");
  }

  const runnerIdentity = z.object({
    id: z.string().min(1),
  }).parse((raw.runner as Record<string, unknown> | undefined) ?? {});

  const databasePath = options.databasePath
    ?? runnerDbPath(runnerIdentity.id, process.env, process.cwd());

  const database = options.database ?? openSqlite(databasePath, runnerMigrations);
  const store = new ProxyConfigStore(database);
  const initialized = store.read().initialized;
  try {
    return await buildRunnerStartup(database, raw, initialized, databasePath);
  } catch (error) {
    // 校验或组装失败必须释放句柄,否则 Windows 上文件被锁。
    if (!options.database) {
      try {
        database.close();
      } catch { /* already closed */ }
    }
    throw error;
  }
}

function buildRunnerStartup(
  database: DatabaseSync,
  raw: Record<string, unknown>,
  initialized: boolean,
  databasePath: string,
): RunnerStartup {
  const store = new ProxyConfigStore(database);
  const state = store.read();

  let effectiveRaw: Record<string, unknown> = raw;
  if (initialized) {
    // 数据库是唯一来源:代理段直接用库内值替换 YAML(而不是删除),否则 YAML 里
    // browserProfiles.*.transport 之类的引用会指向已被迁移走的代理而在 schema 校验处报
    // “Unknown Runner-local transport”;provider 绑定稍后由 state.bindings 覆盖,这里先剔除。
    const remaining: Record<string, unknown> = { ...raw };
    // SAFETY: state.transports 由同一 transportSchema 导入/写入,结构一致;
    // 绕开 Record 推断仅为复用 schema 校验。
    remaining.transports = state.transports as unknown as Record<string, unknown>;
    const providers = { ...((remaining.providers as Record<string, Record<string, unknown>> | undefined) ?? {}) };
    for (const value of Object.values(providers)) delete value.transport;
    if (Object.keys(providers).length > 0) remaining.providers = providers;

    effectiveRaw = YAML.parse(interpolateEnv(YAML.stringify(remaining))) as Record<string, unknown>;
  }

  const config = runnerConfigSchema.parse(effectiveRaw);
  store.initialize(config);
  // initialize 是幂等的:首次启动在此导入 YAML,已初始化时为空操作,state 仍为权威值。
  const initializedState = initialized ? state : store.read();
  // 数据库代理与绑定组装回有效运行配置;YAML Profile transport 必须引用数据库中存在的代理。
  // SAFETY: state.bindings 与 state.transports 由同一 transportSchema 导入/写入,结构一致;
  // 绕开 Record 推断仅为复用 schema 校验。
  const deployments = Object.fromEntries(
    Object.entries(config.providers).map(([id, deployment]) => {
      const binding = initializedState.bindings[id];
      if (!binding) return [id, deployment] as const;
      return [id, { ...deployment, transport: binding } as typeof deployment] as const;
    }),
  );
  const assembled = runnerConfigSchema.parse({
    ...config,
    // SAFETY: initializedState.transports 由同一 transportSchema 导入/写入,结构一致;
    // 绕开 Record 推断仅为复用 schema 校验。
    transports: initializedState.transports as unknown as RunnerConfig["transports"],
    providers: deployments,
  });

  const service = new ProxyConfigService(store, assembled);
  // 凭据服务与代理共用同一个 db：迁移已包含凭据表（runner-migrations v2）。
  // providerTypes 用于校验 bind 的服务归属，取自已组装的最终部署配置。
  const credentialStore = new CredentialStore(database);
  const providerTypes = Object.fromEntries(
    Object.entries(assembled.providers).map(([id, deployment]) => [id, deployment.type]),
  );
  const credentialService = new CredentialConfigService(credentialStore, providerTypes);
  let closed = false;
  return {
    config: assembled,
    store,
    service,
    credentialStore,
    credentialService,
    database,
    databasePath,
    close: () => {
      if (closed) return;
      closed = true;
      database.close();
    },
  };
}

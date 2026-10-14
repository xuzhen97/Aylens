import { AylensBridgeError, type BridgeConfig } from "../../bridge-core/src/client.js";

/**
 * patch 行 `config:` 段能提供的字段（全部可选）。
 *
 * 注意这些值来自 YAML，类型不总是理想：`allowAuthLogin` 允许字符串，是因为
 * `allowAuthLogin: "true"`（带引号）在 YAML 里是字符串而不是布尔。
 */
export interface PluginConfigInput {
	baseUrl?: string;
	/** 从哪个环境变量读 API Key，缺省 `AYLENS_API_KEY`。 */
	apiKeyEnv?: string;
	requestTimeoutMs?: number;
	allowAuthLogin?: boolean | string;
}

const DEFAULT_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_API_KEY_ENV = "AYLENS_API_KEY";

/** 与 VCP 侧口径一致：只有显式真值才算开。 */
const TRUTHY = ["1", "true", "yes", "on"];

function coerceBoolean(value: unknown): boolean {
	if (value === true) return true;
	if (typeof value !== "string") return false;
	return TRUTHY.includes(value.trim().toLowerCase());
}

function stringOrUndefined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 解析插件配置。优先级：patch 行的 `config` 段 → 环境变量 → 内置默认值。
 *
 * 凭据只走环境变量（桌面版由宿主的 `loadLayeredEnv` 加载 `$DSH_HOME/.env`，
 * 已实证与 CLI 同源）。**不读任何密钥文件**——`cordis.patch.yml` 会被
 * `dsh-config-manager` 重写，也会随配置同步链路离开本机。
 *
 * 刻意**不在这里抛错**：缺 API Key 时若激活期就炸，宿主会让整个插件层失效、
 * 4 个工具集体消失，比单次调用失败难诊断得多。缺 Key 的报错留给每次工具调用
 * （见 `assertConfigured`）。
 */
export function resolveConfig(raw: PluginConfigInput = {}): BridgeConfig {
	// 非字符串/非正数的配置一律视为「没给」，回落到下一优先级，而不是把脏值带进去。
	const configuredBaseUrl = stringOrUndefined(raw.baseUrl);
	const baseUrl = (configuredBaseUrl ?? stringOrUndefined(process.env.AYLENS_BASE_URL) ?? DEFAULT_BASE_URL).replace(
		/\/+$/,
		"",
	);

	const apiKeyEnv = stringOrUndefined(raw.apiKeyEnv) ?? DEFAULT_API_KEY_ENV;
	const apiKey = process.env[apiKeyEnv] ?? process.env[DEFAULT_API_KEY_ENV] ?? "";

	const timeout = raw.requestTimeoutMs;
	const requestTimeoutMs =
		typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;

	return { baseUrl, apiKey, requestTimeoutMs, allowAuthLogin: coerceBoolean(raw.allowAuthLogin) };
}

/** 每次工具调用前检查配置完整性；缺 Key 时给出可操作的指引。 */
export function assertConfigured(config: BridgeConfig): void {
	if (config.apiKey) return;
	throw new AylensBridgeError(
		"CONFIG_ERROR",
		"缺少 Aylens API Key：请在 $DSH_HOME/.env 里设置 AYLENS_API_KEY（或在启动宿主的环境里导出同名变量）。",
	);
}

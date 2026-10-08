import fs from "node:fs";
import path from "node:path";
import type { PluginConfig } from "./types.js";

/**
 * 解析 config.env（KEY=VALUE，支持 # 注释与单双引号包裹）。
 */
export function parseEnvFile(content: string): Record<string, string> {
	const result: Record<string, string> = {};
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIndex = trimmed.indexOf("=");
		if (eqIndex === -1) continue;
		const key = trimmed.slice(0, eqIndex).trim();
		let value = trimmed.slice(eqIndex + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (key) result[key] = value;
	}
	return result;
}

export class ConfigError extends Error {
	readonly code = "CONFIG_ERROR";
}

function readConfigFile(dir: string): Record<string, string> {
	const envPath = path.join(dir, "config.env");
	if (!fs.existsSync(envPath)) return {};
	try {
		return parseEnvFile(fs.readFileSync(envPath, "utf-8"));
	} catch (err) {
		process.stderr.write(`[AylensBridge] Failed to read config.env: ${String(err)}\n`);
		return {};
	}
}

/**
 * 加载插件配置。
 *
 * 优先级：config.env（cwd，即 VCPToolBox 传入的 plugin.basePath）
 *        → 环境变量（VCPToolBox 会把 config.env 解析结果注入子进程 env）
 *        → 内置默认值。
 *
 * 之所以做环境变量兜底：PluginStore 覆盖重装会把整个插件目录搬到 .backup，
 * config.env 不在分发包内，必然丢失。有兜底才不至于每次都重灌凭据。
 */
export function loadConfig(searchDir?: string): PluginConfig {
	const dir = searchDir ?? process.cwd();
	const fileEnv = readConfigFile(dir);

	const baseUrl = (
		fileEnv.AYLENS_BASE_URL ??
		process.env.AYLENS_BASE_URL ??
		"http://127.0.0.1:3000"
	).replace(/\/+$/, "");

	const apiKey = fileEnv.AYLENS_API_KEY ?? process.env.AYLENS_API_KEY ?? "";

	const rawTimeout =
		fileEnv.REQUEST_TIMEOUT_MS ?? process.env.REQUEST_TIMEOUT_MS ?? "120000";
	const parsedTimeout = Number.parseInt(rawTimeout, 10);
	const requestTimeoutMs =
		Number.isFinite(parsedTimeout) && parsedTimeout > 0 ? parsedTimeout : 120_000;

	if (!apiKey) {
		throw new ConfigError(
			"缺少 AYLENS_API_KEY：请在插件目录的 config.env 中配置，或设置同名环境变量。",
		);
	}

	let parsed: URL;
	try {
		parsed = new URL(baseUrl);
	} catch {
		throw new ConfigError(`AYLENS_BASE_URL 不是合法 URL：${baseUrl}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new ConfigError(`AYLENS_BASE_URL 仅支持 http/https，当前：${parsed.protocol}`);
	}

	const rawAllowAuthLogin =
		fileEnv.AYLENS_ALLOW_AUTH_LOGIN ?? process.env.AYLENS_ALLOW_AUTH_LOGIN ?? "false";
	const allowAuthLogin = ["1", "true", "yes", "on"].includes(rawAllowAuthLogin.trim().toLowerCase());

	return { baseUrl, apiKey, requestTimeoutMs, allowAuthLogin };
}

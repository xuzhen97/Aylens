import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../src/config.js";

afterEach(() => {
	delete process.env.AYLENS_BASE_URL;
	delete process.env.AYLENS_API_KEY;
	delete process.env.MY_KEY;
});

describe("resolveConfig", () => {
	it("默认 baseUrl 是 127.0.0.1:3000，且去掉结尾斜杠", () => {
		process.env.AYLENS_API_KEY = "k";
		expect(resolveConfig({ baseUrl: "http://127.0.0.1:3000///" }).baseUrl).toBe("http://127.0.0.1:3000");
	});

	it("config 段优先于环境变量", () => {
		process.env.AYLENS_BASE_URL = "http://from-env:3000";
		process.env.AYLENS_API_KEY = "env-key";
		const config = resolveConfig({ baseUrl: "http://from-patch:3000" });
		expect(config.baseUrl).toBe("http://from-patch:3000");
	});

	it("环境变量在 config 段缺失时生效", () => {
		process.env.AYLENS_BASE_URL = "http://from-env:3000";
		process.env.AYLENS_API_KEY = "env-key";
		const config = resolveConfig({});
		expect(config.baseUrl).toBe("http://from-env:3000");
		expect(config.apiKey).toBe("env-key");
	});

	it("apiKey 从 apiKeyEnv 指定的环境变量读，缺省读 AYLENS_API_KEY", () => {
		process.env.MY_KEY = "abc";
		process.env.AYLENS_API_KEY = "fallback";
		expect(resolveConfig({ apiKeyEnv: "MY_KEY" }).apiKey).toBe("abc");
		expect(resolveConfig({}).apiKey).toBe("fallback");
	});

	it("apiKeyEnv 指定但该变量不存在时回退到 AYLENS_API_KEY", () => {
		process.env.AYLENS_API_KEY = "fallback";
		expect(resolveConfig({ apiKeyEnv: "MY_KEY" }).apiKey).toBe("fallback");
	});

	it("allowAuthLogin 默认 false，只有显式 true 才开启", () => {
		expect(resolveConfig({}).allowAuthLogin).toBe(false);
		expect(resolveConfig({ allowAuthLogin: true }).allowAuthLogin).toBe(true);
	});

	it("allowAuthLogin 容忍 YAML 里的字符串真值（与 VCP 侧口径一致）", () => {
		// YAML 里写成 allowAuthLogin: "true" 拿到的是字符串，不该静默变成 false。
		for (const truthy of ["true", "TRUE", "yes", "on", "1", " true "]) {
			expect(resolveConfig({ allowAuthLogin: truthy }).allowAuthLogin, truthy).toBe(true);
		}
		for (const falsy of ["false", "no", "off", "0", "", "随便"]) {
			expect(resolveConfig({ allowAuthLogin: falsy }).allowAuthLogin, falsy).toBe(false);
		}
	});

	it("config 段给了脏类型时回落到下一优先级，而不是把脏值带进去", () => {
		process.env.AYLENS_BASE_URL = "http://from-env:3000";
		// @ts-expect-error 故意传错类型，模拟 YAML 写成了数字/对象
		expect(resolveConfig({ baseUrl: 123 }).baseUrl).toBe("http://from-env:3000");
		// @ts-expect-error 同上
		expect(resolveConfig({ requestTimeoutMs: "5000" }).requestTimeoutMs).toBe(120_000);
		// @ts-expect-error 同上
		expect(resolveConfig({ apiKeyEnv: 42 }).apiKey).toBe(process.env.AYLENS_API_KEY ?? "");
	});

	it("requestTimeoutMs 非法时回落到 120000", () => {
		expect(resolveConfig({ requestTimeoutMs: 0 }).requestTimeoutMs).toBe(120_000);
		expect(resolveConfig({ requestTimeoutMs: -1 }).requestTimeoutMs).toBe(120_000);
		expect(resolveConfig({ requestTimeoutMs: Number.NaN }).requestTimeoutMs).toBe(120_000);
		expect(resolveConfig({ requestTimeoutMs: 5_000 }).requestTimeoutMs).toBe(5_000);
	});

	it("解析期不因缺 API Key 抛错（否则整个插件层会失效、4 个工具集体消失）", () => {
		expect(() => resolveConfig({ baseUrl: "http://127.0.0.1:3000" })).not.toThrow();
		expect(resolveConfig({}).apiKey).toBe("");
	});
});

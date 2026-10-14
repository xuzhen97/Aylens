import type { JsonValue } from "@deepseek-ai/dsh-tools";

/**
 * 把契约对象收敛成「无损 JSON 记录」。
 *
 * 为什么需要这一处显式的缝：工具主体必须返回 `output.schema` 声明的规范 JSON 值，
 * 而 schema 推断出的类型是 `Record<string, JsonValue>`。`bridge-core` 的契约接口为了贴合
 * Gateway 的真实响应，可选字段写成 `?: T | undefined`——这在类型上不满足 `JsonValue`，
 * 但**运行时并不存在 `undefined`**：这些对象直接来自对网关响应的 `JSON.parse`。
 *
 * 所以这里只做一次有据可依的收敛，而不是在每个工具里零散地写 `as never`。
 */
export function canonical(value: object): Record<string, JsonValue> {
	return value as unknown as Record<string, JsonValue>;
}

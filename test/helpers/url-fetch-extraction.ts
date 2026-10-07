import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStaticDocument } from "../../src/providers/url-fetch/extract.js";

/**
 * url-fetch 的静态 DOM 方案固定为 linkedom，而不是 jsdom。
 *
 * 依据：jsdom 在模块加载期执行 `require.resolve("./xhr-sync-worker.js")`，该文件无法随
 * `.aylens-provider` 单文件 ESM 包自包含（详见临时 Plan 中 Task 1 的偏差记录）。
 * linkedom 可在源码目录之外、无 node_modules 可见的条件下独立运行。
 *
 * 注意：linkedom 不是完整 DOM 实现。Readability 依赖的 DOM 行为必须由 fixture 测试覆盖，
 * 不能把“能打包”当作“提取正确”。
 */

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "url-fetch");

export function readFixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), "utf8");
}

/** 复用生产实现，避免测试与被测对象出现两套解析行为。 */
export function createDocument(html: string): Document {
  return parseStaticDocument(html);
}

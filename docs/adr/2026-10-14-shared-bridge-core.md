# 插件桥接层共享执行核心

- Status: Accepted
- Date: 2026-10-14

## Context

`vcp-toolbox-plugin-bridge` 为 VCPToolBox 侧桥接层明确写下了「不采用共享代码包」。当时那一对是 MCP tool adapter（进程内实现，直接使用 `GatewayContext`）与 VCP 插件（远程 HTTP 客户端）——两者执行体不同，可共享的确实只有契约；引入第三方共享包还会让根包的 `tsc` 依赖另一个包的构建产物，而本仓库没有 TypeScript project references。

现在出现的是**新的一对**：`packages/vcp-plugin` 与 `packages/dsh-plugin`（见 `dsh-native-tool-plugin-bridge`）。两者都是 Gateway REST 客户端，**执行体同构**：同一条取数逻辑、同一套错误码映射、同一份契约镜像、同一套渲染与截断预算。

若不共享，同一处逻辑要维护两份。本项目已经有过一次被验证的失败模式：检索渠道实现完成、路由也配好了，模型侧却因为描述与清单没同步而完全不知道它的存在。双份实现会把这类漂移从"一处改三处"放大成"两套各自改三处"，而漂移的表现是静默的——渠道存在，但永远不会被调用。

## Decision

新增 workspace 包 `packages/bridge-core`（`@aylens/bridge-core`），零运行时依赖，承载两个插件桥接层共享的执行核心：

- `client.ts` —— REST 客户端：`fetch` + 超时 + 错误码映射。
- `contracts.ts` —— Search / Extract / Provider / Runtime 的契约镜像。
- `operations.ts` —— 九条操作的纯函数：校验入参 → 调 Gateway → 返回结构化结果。
- `render.ts` —— 结构化结果 → Markdown。
- `capabilities.ts` —— 渠道能力事实的**唯一真源**：结构化常量（渠道 id、`query` 语义、批量上限、是否自带正文）以及一段渠道语义文案。

**铁律：`operations.ts` 只返回结构化值，绝不返回文本。** 取数与排版必须切开——VCP 侧要一段 Markdown 文本，DSH 侧要"规范值 + 各自的呈现"，这是两侧能共用同一份核心的唯一前提。

**铁律：渠道事实只写一遍。** 工具/命令描述是模型能看到的"能力可见性"的唯一载体，而两个宿主的描述必须各自携带协议样板——VCP 有 `command` 字段纪律与 TOOL_REQUEST 字段说明，DSH 有 JSON Schema 参数。可共享的是**渠道事实**（`url-fetch` 填 URL、`x-search` 填检索式、`tavily` / `exa` / `anysearch` 填自然语言、各家批量上限、API 渠道自带正文因此不必再 Extract），不可共享的是协议样板。若两侧各手写一份事实，漂移的表现是静默的：渠道实现了，但某个宿主的模型永远不知道它存在。因此 `capabilities.ts` 承载事实，两个宿主各自组装描述，契约测试断言两侧的组装结果都包含这份事实。

**采用源码级共享，不引入跨包构建产物依赖。** 消费方以 `tsc --noEmit` 做类型检查（`packages/vcp-plugin/tsconfig.json` 因此去掉 `rootDir` / `outDir`），实际打包由 esbuild 完成并把核心内联进各自的产物。根 `tsconfig.json` 的 `include` 只覆盖 `src/**`、`test/**`、`scripts/**`，不涉及 `packages/**`，因此根 `tsc` 完全不受影响。这样既拿到了单一真源，又避开了 project references 与构建顺序耦合。

契约镜像仍**刻意不从 `src/contracts/*.ts` import**：两个宿主的产物都必须自洽、可脱离源码树分发，不能被 Aylens 内部源码路径绑住。

**本决策的适用范围。** 它只覆盖"插件 ↔ 插件"这一对。`vcp-toolbox-plugin-bridge` 的「不采用共享代码包」对 MCP adapter 与插件那一对**继续有效**——那里可共享的确实只有契约。

## Consequences

- 版本的"多处同步"从三处扩到四层：核心一改，两个插件的产物都要重建、两侧版本号都要升。根 `plugins.json` 的版本是 PluginStore 判断更新的依据，漏了它商店永远不会提示更新。
- 抽取会动到已发布且测试完备的 AylensBridge：`plugins/aylens/index.cjs` 与 `plugin-manifest.json` 必须重建，`packages/vcp-plugin/package.json`、`plugins/aylens/plugin-manifest.json` 与根 `plugins.json` 三处版本号同步升到 0.3.0。
- `packages/vcp-plugin` 的构建脚本中 `tsc` 步骤改为 `--noEmit`；它的 `tsconfig.json` 不再产出编译结果，打包完全交给 esbuild。
- 契约测试的断言面扩大：不仅要校验「已构建产物与 MCP adapter 一致」，还要校验**两个宿主的描述都点名了每个可用渠道及其实质性限制**。
- 核心层的测试可以脱离两个宿主独立运行，这本身降低了"渠道实现正确但没被暴露"的检出成本。

## Alternatives considered

- **两份独立实现**：零回归风险，改动不外溢。但同一逻辑两份维护，漂移面翻倍，而漂移在本项目的表现形式是静默的能力缺失，不采用。
- **让 `dsh-plugin` 直接 import `vcp-plugin/src/*`**：最省事，但违背 vcp-plugin「产物必须自洽、不假定外部源码路径」的自定约束，还会把一个宿主的传输层语义泄漏给另一个宿主，不采用。
- **让核心同时承载 MCP adapter 的进程内实现**：能让三面真正统一，但 MCP adapter 用 `GatewayContext` 进程内执行、插件走远程 HTTP，执行体不同；强行统一会把 HTTP 语义塞进 MCP 工具，不采用。
- **给核心配独立构建步（产出 `dist` + `.d.ts` 供消费方引用）**：能让 `rootDir` 保持原样，但引入包间构建顺序耦合——正是 `vcp-toolbox-plugin-bridge` 顾虑的那一条，而源码级共享可以完全绕开，不采用。

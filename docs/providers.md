# Provider 与 Plugin

## Provider 的职责

Provider 只描述“如何访问某个渠道”。

它不应该负责：

- 机器选择
- Runtime 调度
- 全局重试策略
- Proxy 生命周期
- Browser Profile 调度
- Audit
- Cache

Provider 通过 Runtime 注入的服务使用网络和浏览器能力。

## ProviderFactory

Provider 实现通过 Factory 注册。

概念接口：

```ts
export interface ProviderFactory {
  readonly type: string;
  create(
    id: string,
    config: ProviderDeploymentConfig,
    context: ProviderFactoryContext
  ): SearchProvider;
}
```

Gateway Provider instance 和 Provider type 是不同概念：

```text
generic-browser     -> Provider instance
generic-browser     -> Provider implementation type
windows-generic-01  -> Runtime
browser-main       -> Browser Profile
```

同一种 Provider type 可以创建多个 Provider instance。

### Provider ID、Type 与 Implementation

Provider ID 是 Gateway/Runner 对齐的逻辑实例，Provider Type 是调度和协议能力，Implementation 才是具体代码。不同 Runner 可以为同一个 Provider ID/Type 加载不同实现，只要实现遵守相同 Provider 契约。

官方实现源码统一放在 `src/providers/<implementation>/`。正式构建时，内置实现会进入 Runner Bundle，不进入 Gateway Bundle；同一源码也可以构建成独立的 `.aylens-provider` 文件。Runner 用 `builtin:<implementation>` 加载内置实现，外部实现优先使用 `.aylens-provider` 分发，也继续兼容本地 ESM 路径或 npm package。无论来源如何，最终都必须导出同一个 Provider Plugin 契约。

## Runner Provider Plugin

Runner 不在 Gateway 中硬编码渠道。内置 Provider 随 Runner Bundle 发布；外部 Provider 推荐打成单个 `.aylens-provider` 文件，由同一套 Plugin Loader 加载：

```yaml
plugins:
  baseDir: "."
  modules:
    - "builtin:generic-browser"
    - "./providers/my-provider.aylens-provider"
    - "./external/my-provider/index.mjs"
    - "@my-company/aylens-provider-example"
```

Plugin 示例：

```js
export default {
  name: "example-plugin",
  version: "1.0.0",

  factories: [
    {
      type: "example-browser-provider",

      create(id, config, services) {
        return {
          id,

          async search(context, request) {
            // services.transports
            // services.browser
            // services.defaultBrowserProfile
            // config.options
            // const profileId = config.browser?.profile ?? services.defaultBrowserProfile

            return {
              items: [],
            };
          },
        };
      },
    },
  ],
};
```

Runner 会验证 Plugin metadata 并注册 Factory。

`.aylens-provider` 是 ZIP 容器，至少包含 `provider.json` 和已经 bundle 的 `index.mjs`。因此一个 Provider 可以作为单文件通过 GitHub Release、内网文件服务器或直接拷贝分发，不要求发布 npm。Runner 会校验 manifest，把 bundle 解到内容寻址缓存后动态加载。相对路径以 `plugins.baseDir` 为基准；原始 ESM 与 npm package 继续作为兼容加载方式。

只有实际加载成功的 Provider type 才会出现在 Runner capability 中。如果 Plugin import 失败或 descriptor 非法，Runner 会在注册 Gateway 前启动失败。

Plugin 属于可信本地代码。配置一个 module 等于允许它访问 Runner 进程和 Runtime-local 服务。

## generic-browser

仓库包含：

```text
src/providers/generic-browser/index.ts
```

它是 Aylens 官方内置 Provider。`pnpm build` 后它会包含在 `release/runner/aylens-runner.mjs` 中，同时生成 `release/providers/generic-browser.aylens-provider` 作为独立分发包；Gateway Bundle 中不包含这份 Provider 执行逻辑。Runner 通过 `builtin:generic-browser` 选择内置版本。

执行路径：

```text
POST /v1/search
  -> SearchService
  -> ExecutionDispatcher
  -> Remote Runner
  -> generic-browser Plugin
  -> BrowserHost.withProfile(...)
  -> persistent Chrome
  -> page.goto(...)
  -> title + body.innerText()
  -> SearchDocument
  -> Gateway
```

只接受：

```text
http://
https://
```

带嵌入式用户名密码的 URL 会被拒绝。

Gateway Provider Definition：

```yaml
providers:
  generic-browser:
    type: generic-browser
    enabled: true

    runtime:
      selector:
        os: windows
        providerType: generic-browser
        browser: chrome
        profile: browser-main

```

Runner Provider Deployment：

```yaml
browser:
  defaultProfile: browser-main

providers:
  generic-browser:
    type: generic-browser
    options:
      waitUntil: domcontentloaded
      timeoutMs: 30000
      extractionTimeoutMs: 10000
      postLoadDelayMs: 0
      maxTextChars: 50000
      snippetChars: 500
      textSelector: body
      keepPageOpen: false
```

`generic-browser` 会优先使用显式 `provider.browser.profile`，未配置时使用 Runner 注入的 `services.defaultBrowserProfile`。其他 Browser Provider 若要共享同一浏览器工作区，也应实现相同 fallback。

Gateway 只用 Definition 做路由和调度；Runner 根据相同的 Provider ID 找到本地 Deployment，并使用本地执行配置创建 Provider。

结果会归一化成统一 SearchDocument。

## 人工登录态

登录型网站可在 Runner Provider Deployment 中临时设置：

```yaml
providers:
  generic-browser:
    type: generic-browser
    options:
      keepPageOpen: true
```

然后：

1. 请求登录页；
2. Runner 打开可见 persistent Chrome；
3. 手工登录；
4. 再请求 authenticated page；
5. 同一 BrowserContext 复用 Cookie / Local Storage；
6. 登录稳定后把 keepPageOpen 改回 false，避免 tab 累积。

登录状态留在 Runner 本地。

## 添加真实 Provider

通常只需要：

1. 实现 SearchProvider；
2. 暴露 ProviderFactory；
3. 官方实现放入 `src/providers/<implementation>/` 并注册为 builtin；需要独立分发的 Provider 构建成 `.aylens-provider`，也可继续使用 ESM/npm 兼容形式；
4. 使用注入的 Transport / BrowserHost；
5. 在 Gateway YAML 中增加 Provider instance；
6. 加到 route，或在请求里显式指定 source。

正常情况下不应该修改：

```text
SearchService
ExecutionDispatcher
RuntimeRegistry
Runner protocol
Gateway REST API
```

这些边界构成当前 Provider 扩展方式。完整架构见 [architecture.md](./architecture.md)。

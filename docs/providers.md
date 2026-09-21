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
export interface ProviderFactory<TConfig = unknown> {
  readonly type: string;
  create(
    id: string,
    config: TConfig,
    services: ProviderContext
  ): SearchProvider;
}
```

Gateway Provider instance 和 Provider type 是不同概念：

```text
generic-browser     -> Provider instance
generic-browser     -> Provider implementation type
windows-generic-01  -> Runtime
generic-login       -> Browser Profile
```

未来同一种 Provider type 可以创建多个 Provider instance。

## Runner Provider Plugin

Runner 不硬编码渠道。它从配置加载本地 ESM module：

```yaml
plugins:
  baseDir: "."
  modules:
    - "./plugins/my-provider/index.mjs"
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
            // config.options
            // config.browser?.profile

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

只有实际加载成功的 Provider type 才会出现在 Runner capability 中。如果 Plugin import 失败或 descriptor 非法，Runner 会在注册 Gateway 前启动失败。

Plugin 属于可信本地代码。配置一个 module 等于允许它访问 Runner 进程和 Runtime-local 服务。

## generic-browser

仓库包含：

```text
plugins/generic-browser/index.mjs
```

它不是搜索引擎，而是一个验证 Provider：把 SearchRequest.query 当 URL，通过真实浏览器读取页面。

执行路径：

```text
POST /v1/search
  -> SearchService
  -> ExecutionDispatcher
  -> Windows Runner
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

示例配置：

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
        profile: generic-login

    browser:
      profile: generic-login

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

结果会归一化成统一 SearchDocument。

## 人工登录态

登录型网站可临时把：

```yaml
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
3. 打包成 Runner Plugin，或注册到 Gateway Local Runtime；
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

只有真正引入新的系统能力时，才需要扩展这些边界。

完整设计见 [../ARCHITECTURE.md](../ARCHITECTURE.md)。

# 配置说明

## 配置入口

Gateway：

```text
config/aylens.yaml
```

Runner：

```text
config/runner.yaml
```

默认配置（`config/aylens.yaml` / `config/runner.yaml`）已接入 generic-browser，
开箱即用。可通过环境变量覆盖配置文件位置：

```text
AYLENS_CONFIG
AYLENS_RUNNER_CONFIG
```

配置支持环境变量插值：

```text
${VAR}
${VAR:-fallback}
```

## Gateway 最小结构

```yaml
version: 1

auth:
  apiKey: "${AYLENS_API_KEY:-dev-key}"
  runnerTokens:
    dev-runner: "${AYLENS_RUNNER_TOKEN:-dev-runner-token}"

providers:
  generic-browser:
    type: generic-browser

routes:
  default:
    providers:
      - generic-browser
```

Gateway 侧不再有 `transports` 与 `browserProfiles` 段：Gateway 不做抓取，因此不持有 Transport 或 Browser Profile。Provider 的 `transport`、`browser` 与 `options` 只存在于 Runner Provider Deployment。

`server` 与 `runtimeRegistry` 都有默认值。Provider 的 `runtime` placement 也可以省略；此时 Gateway 会按 Provider ID 与 Type，从实际部署该 Provider 的在线 Runner 中选择。

## Runner 最小结构

```yaml
runner:
  id: dev-runner
  gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect"
  token: "${AYLENS_RUNNER_TOKEN:-dev-runner-token}"
plugins:
  modules:
    - "builtin:generic-browser"
    # 外部扩展推荐：- "./providers/example.aylens-provider"

browser:
  # 浏览器类 Provider 未显式指定 profile 时统一使用这里。
  defaultProfile: browser-main

providers:
  generic-browser:
    type: generic-browser

browserProfiles:
  browser-main:
    userDataDir: "./.profiles/browser-main"
    headless: true
```

Runner 不再要求手工填写 `capabilities`。Provider Type 来自实际加载成功的 Plugin，Provider ID 来自本机 Deployment，Browser/Profile 能力来自实际 Browser Profile。Direct Transport、Plugin `baseDir`、心跳和并发数都有默认值。

`browser.defaultProfile` 是 Runner 级共享浏览器工作区。多个浏览器 Provider 可以省略各自的 `browser.profile`，统一复用同一个持久化 Profile；需要隔离账号或代理时，再在单个 Provider 上显式指定 `browser.profile` 覆盖默认值。

## Runtime 选择

Provider 定义与执行机器是两个概念。默认情况下无需配置 `runtime`，Gateway 会自动要求目标 Runner 实际部署同一个 Provider ID，并匹配 Provider Type。只有需要固定机器或增加 placement 约束时，才配置 `runtime.nodeId` 或 `runtime.selector`。

示例：

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

这里表达的是：

- Provider instance：generic-browser
- Provider type：generic-browser
- Runtime OS：Windows
- Runtime 已加载对应 Provider Plugin
- Runtime 已部署 generic-browser 这个 Provider ID
- Runtime 提供 Chrome
- Runtime 拥有 browser-main Profile

Provider 的执行配置属于 Runner，例如：

```yaml
providers:
  generic-browser:
    type: generic-browser
    browser:
      profile: browser-main
    options:
      timeoutMs: 30000
```

Gateway 不需要知道远程机器上的 Chrome 路径、Provider Options、Cookie 或代理配置。

## Transport（Runner 配置）

Direct：

```yaml
transports:
  direct:
    type: direct
```

HTTP/HTTPS Proxy：

```yaml
transports:
  proxy-us:
    type: http-proxy
    url: "${PROXY_US_URL}"
```

支持：

```text
http://
https://
```

SOCKS5：

```yaml
transports:
  proxy-cn:
    type: socks5
    url: "${PROXY_CN_URL}"
```

支持：

```text
socks5://
socks5h://
```

代理凭据应留在 Runtime 本地环境变量，不通过 Gateway 下发。

## Browser Profile（Runner 配置）

Persistent Chrome：

```yaml
browserProfiles:
  browser-main:
    browser: chrome
    mode: launch
    persistent: true
    userDataDir: "D:\\Aylens\\profiles\\browser-main"
    channel: chrome
    headless: false
    interactive: true
    maxConcurrency: 1
    args: []
```

CDP：

```yaml
browserProfiles:
  chrome-external:
    browser: chrome
    mode: cdp
    cdpEndpoint: "http://127.0.0.1:9222"
    maxConcurrency: 1
    interactive: true
```

如果 Profile 指定 Transport：

```yaml
browserProfiles:
  account-main:
    browser: chrome
    mode: launch
    userDataDir: "D:\\Aylens\\profiles\\account-main"
    transport: proxy-cn
```

BrowserHost 会把 Runtime-local Transport 映射为浏览器代理配置。

不要让多台机器同时写同一个 Chrome User Data 目录。

## 敏感信息边界

以下内容应保持 Runtime-local：

- Runner Token
- Proxy URL 中的凭据
- Chrome userDataDir
- Chrome Cookie / Local Storage
- CDP 本地访问细节
- Provider 私密凭据

Gateway 侧优先保存逻辑名称和选择条件，而不是本地秘密。

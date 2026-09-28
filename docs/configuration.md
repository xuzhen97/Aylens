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

## Gateway 基本结构

```yaml
version: 1

server:
  host: 127.0.0.1
  port: 3000
  runnerPath: /v1/runners/connect

auth:
  apiKey: "${AYLENS_API_KEY:-dev-key}"
  runnerTokens:
    dev-runner: "${AYLENS_RUNNER_TOKEN:-dev-runner-token}"

runtimeRegistry:
  heartbeatTimeoutMs: 30000
  offlineAfterMs: 60000
  jobTimeoutMs: 30000

providers: {}

routes:
  default:
    providers: []
```

Gateway 侧不再有 `transports` 与 `browserProfiles` 段：Gateway 不做抓取，因此不持有 Transport 或 Browser Profile。
Provider 的 `transport`、`browser` 与 `options` 只存在于 Runner Provider Deployment，不由 Gateway 保存或随任务下发。

## Runner 基本结构

```yaml
runner:
  id: dev-runner
  gatewayUrl: "ws://127.0.0.1:3000/v1/runners/connect"
  token: "${AYLENS_RUNNER_TOKEN:-dev-runner-token}"
  heartbeatMs: 10000
  maxJobs: 1

plugins:
  baseDir: "."
  modules:
    - "builtin:generic-browser"

capabilities:
  browsers: []
  http: true
  browserAutomation: false

transports:
  direct:
    type: direct

browserProfiles: {}
```

Provider capability 不应手工伪造。Runner 会根据实际成功加载的 Provider Plugin 上报 providerTypes，并根据本机 Provider Deployment 上报 providerIds。

## Runtime 选择

Provider 定义与执行机器是两个概念。

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
        profile: generic-login

```

这里表达的是：

- Provider instance：generic-browser
- Provider type：generic-browser
- Runtime OS：Windows
- Runtime 已加载对应 Provider Plugin
- Runtime 已部署 generic-browser 这个 Provider ID
- Runtime 提供 Chrome
- Runtime 拥有 generic-login Profile

Provider 的执行配置属于 Runner，例如：

```yaml
providers:
  generic-browser:
    type: generic-browser
    browser:
      profile: generic-login
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
  generic-login:
    browser: chrome
    mode: launch
    persistent: true
    userDataDir: "D:\\Aylens\\profiles\\generic-login"
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

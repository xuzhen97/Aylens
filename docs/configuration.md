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
    - "builtin:x-search"
    # 外部扩展推荐：- "./providers/example.aylens-provider"

browser:
  # 浏览器类 Provider 未显式指定 profile 时统一使用这里。
  defaultProfile: browser-main

providers:
  generic-browser:
    type: generic-browser
  x:
    type: x-search

browserProfiles:
  browser-main:
    mode: cdp
    userDataDir: "./.profiles/browser-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: true
    interactive: true
```

Runner 不再要求手工填写 `capabilities`。Provider Type 来自实际加载成功的 Plugin，Provider ID 来自本机 Deployment，Browser/Profile 能力来自实际 Browser Profile。Direct Transport、Plugin `baseDir`、心跳和并发数都有默认值。

`browser.defaultProfile` 是 Runner 级共享浏览器工作区。Runner 会把它作为 `services.defaultBrowserProfile` 注入 ProviderFactory；`generic-browser` 和 `x-search` 都在未配置 `provider.browser.profile` 时使用该默认值。其他 Browser Provider 也应采用 `config.browser?.profile ?? services.defaultBrowserProfile` 的逻辑。需要隔离账号时，再在单个 Provider 上显式指定 `browser.profile` 覆盖默认值。

默认 Profile 使用 managed CDP：Runner 不再通过 Playwright `launchPersistentContext()` 创建浏览器，而是直接启动系统安装的 Google Chrome 进程，再通过 `connectOverCDP()` attach。人工登录发生在普通 Chrome 窗口中；平时检索仍由 Provider 自动操作任务页面。

## Runtime 选择

Provider 定义与执行机器是两个概念。默认情况下无需配置 `runtime`，Gateway 会要求目标 Runner 实际部署同一个 Provider ID，并匹配 Provider Type。只有需要固定机器或增加 placement 约束时，才配置 `runtime.nodeId` 或 `runtime.selector`。注意 Runner 的 `browser.defaultProfile` 不会自动成为 Gateway 调度条件；多 Runner 场景若依赖特定 Profile，应显式配置 `runtime.selector.profile`。

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

Provider 的执行配置属于 Runner。使用共享默认 Profile 时可以不重复声明 `browser.profile`：

```yaml
browser:
  defaultProfile: browser-main

providers:
  generic-browser:
    type: generic-browser
    options:
      timeoutMs: 30000
```

只有需要覆盖默认工作区时，才在该 Provider 下显式配置 `browser.profile`。

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

默认：普通 Chrome + managed CDP：

```yaml
browserProfiles:
  browser-main:
    browser: chrome
    mode: cdp
    persistent: true
    userDataDir: "D:\\Aylens\\profiles\\browser-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: true
    interactive: true
    maxConcurrency: 1
    args: []
```

`autoStart: true` 时，Runner 会先检查 `cdpEndpoint`。如果已有 Chrome 在监听就直接复用；否则从系统安装位置寻找 Google Chrome，以普通 OS 进程启动并带上独立 `userDataDir` 和 remote-debugging 参数。也可以通过 `CHROME_PATH` 或 `executablePath` 显式指定 Chrome。

只连接已有 Chrome：

```yaml
browserProfiles:
  chrome-external:
    browser: chrome
    mode: cdp
    userDataDir: "D:\\Aylens\\profiles\\browser-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: false
    maxConcurrency: 1
    interactive: true
```

旧的 Playwright launch 模式仍保留，适合无需人工站点登录的隔离抓取：

```yaml
browserProfiles:
  automation-only:
    browser: chrome
    mode: launch
    userDataDir: "D:\\Aylens\\profiles\\automation-only"
    headless: true
```

Browser Profile 可以指定 Runner-local Transport：

```yaml
browserProfiles:
  account-main:
    browser: chrome
    mode: cdp
    userDataDir: "D:\\Aylens\\profiles\\account-main"
    cdpEndpoint: "http://127.0.0.1:9222"
    autoStart: true
    transport: proxy-cn
```

`mode: launch` 时，BrowserHost 会把 Runtime-local Transport 映射为 Playwright 的浏览器代理配置；`mode: cdp + autoStart: true` 时，Runner 会把同一个 Transport 映射成普通 Chrome 的 `--proxy-server=...` 启动参数。

注意：CDP 模式的代理是在 **Chrome 进程启动时**确定的。修改 `transport` 后，如果 `cdpEndpoint` 上已经有旧 Chrome 在运行，Runner 会复用旧进程，新的代理参数不会动态生效。此时必须先彻底关闭该 `browser-main` Chrome，再重新触发登录/检查/搜索，让 Runner 用新配置重新启动。

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
